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
  // A way to ask this function what is wrong with it. Every failure used to
  // read "Quote not found" or "This link is no longer active", whether the
  // quote was genuinely missing, the service key was wrong, or the function
  // was talking to another project altogether — and none of that can be seen
  // from the outside. GET ?check=1 answers with what it has (names and hosts,
  // never the keys) and whether the database actually answers.
  if (req.method === 'GET' && (req.query || {}).check) {
    const url = process.env.SUPABASE_URL || '';
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    const app = process.env.APP_URL || '';
    const out = {
      // which deployment is actually answering: an environment variable
      // only reaches a NEW build, so a stale alias looks exactly like a
      // value that was never saved
      deployment: { commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || '(unknown)',
                    environment: process.env.VERCEL_ENV || '(unknown)',
                    node: process.version },
      env: {
        SUPABASE_URL: url ? url.replace(/^https?:\/\//, '').split('.')[0] : '(missing)',
        SUPABASE_SERVICE_ROLE_KEY: key ? `set, ${key.length} characters` : '(missing)',
        APP_URL: app || '(missing)',
      },
      database: null, render_page: null,
    };
    if (url && key) {
      try {
        const probe = createClient(url, key);
        const { count, error } = await probe.from('quotes').select('id', { count: 'exact', head: true });
        out.database = error ? { ok: false, error: error.message } : { ok: true, quotes: count };
      } catch (err) { out.database = { ok: false, error: String(err && err.message || err) }; }
      // The library reports a refused key as an empty message, which says
      // nothing about WHY it was refused. The same request without the
      // library does say: the status and the answer PostgREST actually gave.
      // The key is never echoed back — only what the server said about it.
      try {
        const raw = await fetch(`${url}/rest/v1/quotes?select=id&limit=1`, {
          headers: { apikey: key, Authorization: `Bearer ${key}` },
        });
        out.database_raw = { status: raw.status, answer: (await raw.text()).slice(0, 200) };
      } catch (err) { out.database_raw = { error: String(err && err.message || err) }; }
      out.key_shape = { starts: key.slice(0, 10), dots: (key.match(/\./g) || []).length,
                        spaces: /\s/.test(key) };
    }
    if (app) {
      try {
        const r = await fetch(`${app}/?render=1`, { method: 'GET' });
        out.render_page = { ok: r.ok, status: r.status };
      } catch (err) { out.render_page = { ok: false, error: String(err && err.message || err) }; }
    }
    // The other half of the machine: a browser that has to start inside a
    // serverless function and print a page. It can fail on its own account
    // (no binary, too little memory, a page that never becomes ready) and
    // that has nothing to do with the database, so it can be asked on its
    // own too: ?check=render prints the app with no quote in it and reports
    // what came out. Nothing is read or written anywhere.
    if (String((req.query || {}).check) === 'render') {
      const t0 = Date.now();
      let browser;
      try {
        browser = await puppeteer.launch({
          args: chromium.args,
          executablePath: await chromium.executablePath(),
          headless: chromium.headless,
        });
        const page = await browser.newPage();
        await page.goto(`${process.env.APP_URL}/?render=1`, { waitUntil: 'networkidle0' });
        await page.waitForFunction('typeof window.__cpqRenderQuote === "function"', { timeout: 20000 });
        const pdf = await page.pdf({ format: 'A4', printBackground: true });
        out.browser = { ok: true, seconds: Math.round((Date.now() - t0) / 100) / 10,
                        pdf_kilobytes: Math.round(pdf.length / 1024) };
      } catch (err) {
        out.browser = { ok: false, seconds: Math.round((Date.now() - t0) / 100) / 10,
                        error: String(err && err.message || err).slice(0, 300) };
      } finally { if (browser) await browser.close(); }
    }
    res.status(200).json(out);
    return;
  }
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
      // the customer sees the sentence; the detail is for whoever is looking
      // into it, and says whether the link is dead or the server cannot reach
      // the database at all
      res.status(404).json({ error: 'This link is no longer active',
        detail: sharedErr ? `database: ${sharedErr.message}` : `link: ${(shared && shared.reason) || 'unknown'}` });
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
      res.status(404).json({ error: 'Quote not found',
        detail: quoteErr ? `database: ${quoteErr.message}` : 'no row with that id' });
      return;
    }
    const { data: catRow, error: catErr } = await admin
      .from('catalogue_versions').select('data').order('version', { ascending: false }).limit(1).single();
    if (catErr || !catRow) {
      res.status(404).json({ error: 'No catalogue published yet',
        detail: catErr ? `database: ${catErr.message}` : 'no published version' });
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
