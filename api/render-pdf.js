// Vercel serverless function — turns one quote into a PDF, reusing the CPQ
// app's own print layout instead of a separate template.
//
// The app is loaded headless with `?render=1`, which (see the render-mode
// hook in cpq-configurator.html) skips login/share and exposes a single
// `window.__cpqRenderQuote(payload)` hook. We hand the quote + catalogue to
// that hook via `page.evaluate(fn, data)` — never via a URL param or a
// client-side fetch — so the service-role key used to read Supabase here
// never reaches the rendered page.
//
// Required environment variables (set in the Vercel project, never in the
// HTML): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APP_URL.

const { createClient } = require('@supabase/supabase-js');
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }

  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const { quoteId, token } = req.body || {};

  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (!quoteId && !token) {
    res.status(400).json({ error: 'quoteId or token is required' });
    return;
  }

  let quoteData, quoteNumber, catalogueData;

  if (token) {
    // Customer downloading their own proposal from the share link — the
    // token itself is the credential, validated (and expiry/revoked-checked)
    // by the same RPC the share page uses, so no bearer is required here.
    const { data: shared, error: sharedErr } = await admin.rpc('get_shared_quote', { p_token: token });
    if (sharedErr || !shared || !shared.ok) {
      res.status(404).json({ error: 'This link is no longer active' });
      return;
    }
    quoteData = shared.quote;
    quoteNumber = shared.number;
    catalogueData = shared.catalogue;
  } else {
    // TEMPORARY TEST MODE: a missing/invalid bearer is allowed through so PDF
    // rendering can be tried before Microsoft/Azure sign-in is set up (see the
    // matching comment in cpq-configurator.html's btnEmailPdf handler and
    // supabase-schema-testmode.sql). Restore the hard 401s below — remove the
    // `if (bearer)` guard so a missing/invalid token always rejects — once
    // real sign-in is back.
    if (bearer) {
      const { data: userRes, error: authErr } = await admin.auth.getUser(bearer);
      if (authErr || !userRes || !userRes.user) {
        res.status(401).json({ error: 'Not signed in' });
        return;
      }
    }

    const { data: quoteRow, error: quoteErr } = await admin
      .from('quotes').select('data,number').eq('id', quoteId).single();
    if (quoteErr || !quoteRow) {
      res.status(404).json({ error: 'Quote not found' });
      return;
    }
    const { data: catRow, error: catErr } = await admin
      .from('catalogue_versions').select('data').order('version', { ascending: false }).limit(1).single();
    if (catErr || !catRow) {
      res.status(404).json({ error: 'No catalogue published yet' });
      return;
    }
    quoteData = quoteRow.data;
    quoteNumber = quoteRow.number;
    catalogueData = catRow.data;
  }

  const payload = { quote: quoteData, catalogue: catalogueData };

  let browser;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });
    const page = await browser.newPage();
    await page.goto(`${process.env.APP_URL}/?render=1`, { waitUntil: 'networkidle0' });
    await page.waitForFunction('typeof window.__cpqRenderQuote === "function"');
    await page.evaluate((p) => window.__cpqRenderQuote(p), payload);
    await page.waitForFunction('window.__cpqRenderReady === true', { timeout: 20000 });

    const pdf = await page.pdf({ format: 'A4', printBackground: true });
    res.status(200).json({
      ok: true,
      filename: `Quotation-${quoteNumber || 'draft'}.pdf`,
      pdfBase64: pdf.toString('base64'),
    });
  } catch (err) {
    res.status(500).json({ error: 'Rendering failed', detail: String(err && err.message || err) });
  } finally {
    if (browser) await browser.close();
  }
};
