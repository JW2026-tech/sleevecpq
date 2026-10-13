// Vercel serverless function — looks up customers and contact persons in Odoo
// for the Customer tab, read only.
//
// The Odoo API key is held here, in the environment of the Vercel project, and
// never in the page: the page is public, so anything in it is public. The
// browser asks this function and gets back only the fields the form fills in.
//
// Environment variables (set in the Vercel project, never in a file):
//   ODOO_API_KEY   required — an Odoo API key (Odoo 19, JSON-2 API)
//   ODOO_URL       optional — default https://american-sleeve-technology.odoo.com
//   ODOO_DB        optional — default american-sleeve-technology
//   APP_URL        optional — the address of the app, used to check where a
//                  request comes from
//
//   GET /api/odoo-contacts?q=<text>        companies and persons matching the text
//   GET /api/odoo-contacts?company=<id>    the contact persons of one company
//   GET /api/odoo-contacts?id=<id>         one customer or person

const ODOO_URL = (process.env.ODOO_URL || 'https://american-sleeve-technology.odoo.com').replace(/\/+$/, '');
const ODOO_DB = process.env.ODOO_DB || 'american-sleeve-technology';

const FIELDS = [
  'name', 'is_company', 'type', 'parent_id', 'commercial_company_name', 'function',
  'email', 'phone', 'street', 'street2', 'zip', 'city', 'country_id', 'vat',
];

async function odoo(model, method, body) {
  const r = await fetch(`${ODOO_URL}/json/2/${model}/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `bearer ${process.env.ODOO_API_KEY}`,
      'X-Odoo-Database': ODOO_DB,
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) {
    const err = new Error(`Odoo answered ${r.status}`);
    err.status = r.status;
    err.detail = text.slice(0, 200);
    throw err;
  }
  return JSON.parse(text);
}

// what the form needs, in the shape the form uses
function shape(p) {
  const f = v => (v === false || v == null ? '' : String(v));
  const parent = Array.isArray(p.parent_id) ? { id: p.parent_id[0], name: p.parent_id[1] } : null;
  return {
    id: p.id,
    name: f(p.name),
    isCompany: !!p.is_company,
    company: p.is_company ? f(p.name) : (parent ? parent.name : f(p.commercial_company_name)),
    companyId: p.is_company ? p.id : (parent ? parent.id : null),
    role: f(p.function),
    email: f(p.email),
    phone: f(p.phone),
    address: [f(p.street), f(p.street2)].filter(Boolean).join('\n'),
    city: [f(p.zip), f(p.city)].filter(Boolean).join(' '),
    country: Array.isArray(p.country_id) ? p.country_id[1] : '',
    vat: f(p.vat),
  };
}

// Where a request comes from. Not a lock — anyone can write these headers by
// hand — but it keeps the function from answering other websites' pages.
function allowedOrigin(req) {
  const origin = req.headers.origin || req.headers.referer || '';
  if (!origin) return true; // address typed into a browser, or a server call
  let host;
  try { host = new URL(origin).host; } catch (err) { return false; }
  const own = req.headers.host || '';
  let app = '';
  try { app = process.env.APP_URL ? new URL(process.env.APP_URL).host : ''; } catch (err) { /* ignore */ }
  return host === own || (app && host === app) || /^localhost(:\d+)?$/.test(host);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!allowedOrigin(req)) return res.status(403).json({ error: 'Not allowed from here' });
  if (!process.env.ODOO_API_KEY) {
    return res.status(503).json({ error: 'ODOO_API_KEY is not set in the Vercel project' });
  }

  const q = String((req.query || {}).q || '').trim();
  const company = parseInt((req.query || {}).company, 10);
  const id = parseInt((req.query || {}).id, 10);

  try {
    if (id > 0) {
      const rows = await odoo('res.partner', 'search_read', { domain: [['id', '=', id]], fields: FIELDS, limit: 1 });
      return res.status(200).json({ partner: rows[0] ? shape(rows[0]) : null });
    }
    if (company > 0) {
      const rows = await odoo('res.partner', 'search_read', {
        domain: [['parent_id', '=', company], ['is_company', '=', false]],
        fields: FIELDS, limit: 50, order: 'name',
      });
      return res.status(200).json({ persons: rows.map(shape) });
    }
    // a short text matches half the address book; three characters is a name
    if (q.length < 3) return res.status(200).json({ results: [] });
    const rows = await odoo('res.partner', 'search_read', {
      domain: ['|', '|', ['name', 'ilike', q], ['email', 'ilike', q], ['commercial_company_name', 'ilike', q]],
      fields: FIELDS, limit: 15, order: 'is_company desc, name',
    });
    return res.status(200).json({ results: rows.map(shape) });
  } catch (err) {
    const status = err.status === 401 || err.status === 403 ? 502 : 500;
    return res.status(status).json({
      error: err.status === 401 || err.status === 403
        ? 'Odoo did not accept the key'
        : 'Could not read Odoo',
    });
  }
};
