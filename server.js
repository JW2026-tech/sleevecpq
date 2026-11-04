// Runs the CPQ outside Vercel (Docker on our own VM): serves the page and the two
// functions in api/, unchanged. Vercel calls those as (req, res) with a few
// helpers of its own — req.query, req.body, res.status(), res.json(),
// res.send() — and this gives them the same, so one code base runs on both.
//
// Environment: PORT (default 3000) and everything api/ reads — see .env.example.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = +process.env.PORT || 3000;
const ROOT = __dirname;
const PAGE = path.join(ROOT, 'cpq-configurator.html');

// the functions, loaded on first use so a missing dependency of one does not stop the other
const API = {
  '/api/odoo-contacts': './api/odoo-contacts.js',
  '/api/render-pdf': './api/render-pdf.js',
};
const loaded = {};

function withHelpers(res) {
  res.status = code => { res.statusCode = code; return res; };
  res.json = obj => {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
    return res;
  };
  res.send = body => {
    if (Buffer.isBuffer(body) || typeof body === 'string') res.end(body);
    else res.json(body);
    return res;
  };
  return res;
}

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const parts = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('Body too large')); req.destroy(); } else parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  withHelpers(res);
  const url = new URL(req.url, 'http://localhost');
  try {
    // for the container's health check
    if (url.pathname === '/healthz') return res.status(200).json({ ok: true });

    if (API[url.pathname]) {
      req.query = Object.fromEntries(url.searchParams);
      if (req.method === 'POST' || req.method === 'PUT') {
        const raw = await readBody(req);
        try { req.body = raw ? JSON.parse(raw) : {}; } catch (err) { req.body = raw; }
      }
      const fn = loaded[url.pathname] || (loaded[url.pathname] = require(API[url.pathname]));
      return await fn(req, res);
    }

    // the app itself; every other path is the app too, as on Vercel ("/" -> the page)
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).json({ error: 'Not allowed' });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(PAGE).on('error', () => res.status(500).end('Page missing')).pipe(res);
  } catch (err) {
    console.error(new Date().toISOString(), req.method, url.pathname, err);
    if (!res.headersSent) res.status(500).json({ error: 'Server error' });
    else res.end();
  }
});

server.listen(PORT, () => console.log(`CPQ listening on port ${PORT}`));
