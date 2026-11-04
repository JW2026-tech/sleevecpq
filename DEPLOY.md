# CPQ op de planningsserver (Docker Compose)

De CPQ draait als één extra container op **SLT-NE-PRODPLAN01**, naast de planningstool.
Er verandert niets aan de planningstool of aan de Supabase op die server: de CPQ
gebruikt zijn eigen Supabase in de cloud.

```
internet ──443──▶ planningstool-caddy ──┬── planning.…  ──▶ planningstool-app:3000   (bestaand)
                                        └── cpq.…       ──▶ sleeve-cpq:3000          (nieuw)
```

De CPQ-container opent **geen** poort naar buiten (alleen `127.0.0.1:3100` om op de
server zelf te testen). Caddy stuurt het verkeer voor het CPQ-adres via een gedeeld
Docker-netwerk door; het certificaat regelt Caddy zelf.

## Wat er in de container zit

| Pad | Wat |
|---|---|
| `/` | de app (`cpq-configurator.html`), ook voor klantlinks `/?share=…` |
| `/api/odoo-contacts` | zoekt klanten en contactpersonen in Odoo (alleen lezen) |
| `/api/render-pdf` | maakt de PDF met de Chromium in de container |
| `/healthz` | voor de health check |

## Stappen

### 1. DNS
Maak een A-record `cpq.sleevetechnology.com` (of de naam die jullie kiezen) naar het
publieke IP van de VM. Zelfde IP als de planningstool.

### 2. Het netwerk van Caddy opzoeken
```bash
sudo docker inspect planningstool-caddy --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'
```
Die naam (bijvoorbeeld `planningstool_default`) komt in `.env` bij `PROXY_NETWORK`.
Staat Caddy op meerdere netwerken, neem dan het netwerk waar ook `planningstool-app` op staat.

### 3. Code en instellingen
```bash
sudo git clone https://github.com/JW2026-tech/sleevecpq.git /opt/sleeve-cpq
cd /opt/sleeve-cpq
sudo cp .env.example .env
sudo nano .env          # PROXY_NETWORK, APP_URL, SUPABASE_*, ODOO_*
sudo chmod 600 .env
```
De sleutels staan nu in de Vercel-omgeving (Project → Settings → Environment Variables);
Jeroen kan ze daar overnemen. `.env` komt nooit in git.

### 4. Bouwen en starten
```bash
sudo docker compose up -d --build
sudo docker compose ps                         # STATUS: healthy
curl -s http://127.0.0.1:3100/healthz          # {"ok":true}
curl -s "http://127.0.0.1:3100/api/render-pdf?check=1"   # kijkt of Supabase en de render-pagina antwoorden
```

### 5. Caddy
Voeg het blok uit `deploy/Caddyfile.cpq` toe aan de Caddyfile van de planningstool en
laad Caddy opnieuw (zonder herstart, de planningstool merkt er niets van):
```bash
sudo docker exec planningstool-caddy caddy reload --config /etc/caddy/Caddyfile
```
(pas het pad aan als de Caddyfile in die container ergens anders staat)

Daarna: `https://cpq.sleevetechnology.com` opent de app.

### 6. Firewall (Azure NSG)
- Inkomend alleen **443** en **80** (80 is nodig voor het certificaat en de doorverwijzing).
- **22/SSH** alleen vanaf het kantoor-IP of via VPN/Bastion.
- 3000, 3100, 5432, 8000 staan op `127.0.0.1` en zijn van buiten niet bereikbaar; laat dat zo.
- Advies: de **planningstool** alleen voor kantoor/VPN openzetten (zie het voorbeeld onderaan
  `deploy/Caddyfile.cpq`), want vanaf nu antwoordt deze server ook aan klanten.

### 7. Updates
```bash
cd /opt/sleeve-cpq
sudo git pull
sudo docker compose up -d --build
```
Dit vervangt alleen de CPQ-container. (Vercel zet bij een push automatisch live; hier
gebeurt dat pas na deze twee regels.)

## Om rekening mee te houden
- **Klantlinks die al verstuurd zijn** wijzen naar `cpq-configurator.vercel.app`. Laat Vercel
  draaien tot die verlopen zijn; links die op het nieuwe adres worden gemaakt, wijzen vanzelf
  naar het nieuwe adres.
- **Geheugen**: een PDF maken kost Chromium een paar honderd MB. De container mag maximaal 1 GB
  (`mem_limit` in `docker-compose.yml`).
- **Logboek**: `sudo docker compose logs -f cpq`
- Na het inloggen (Microsoft/Azure) moet het nieuwe adres ook als redirect-URL in Azure en in
  Supabase → Authentication → URL Configuration staan.
