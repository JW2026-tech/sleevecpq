# Sleeve CPQ

CPQ (Configure Price Quote) configurator for Sleeve Technology — a single
framework-less HTML file (`cpq-configurator.html`) plus a small Vercel
serverless function (`api/render-pdf.js`) that renders a quote to PDF.

## Deploy

Connected to Vercel for auto-deploy on every push to `main`.

## Backend

Supabase project `tyjlhxrfgvqblfjmdxeq` — see the SQL files and
`Supabase-en-Vercel-plan.md` in `S:\Sales\CPQ` for schema and setup notes.

Required Vercel environment variables (Production + Preview):
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `APP_URL`.
