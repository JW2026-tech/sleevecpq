# Sleeve Technology CPQ — the page, the Odoo lookup and the PDF renderer in one container.
# See DEPLOY.md for how it sits behind the Caddy that is already on the server.
FROM node:20-bookworm-slim

# Chromium prints the PDFs; the fonts are what it prints them in
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-core ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3000 \
    CHROME_PATH=/usr/bin/chromium \
    RENDER_URL=http://127.0.0.1:3000 \
    PUPPETEER_SKIP_DOWNLOAD=true

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js cpq-configurator.html ./
COPY api ./api

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
