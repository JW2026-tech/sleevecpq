# CPQ op de planningsserver (Docker Compose)

De CPQ draait op **SLT-NE-PRODPLAN01**, naast de planningstool, maar met een **eigen IP-adres**
en een **eigen Caddy**. Ze delen niets: geen config, geen certificaat, geen netwerk.
De CPQ gebruikt zijn eigen Supabase in de cloud; de Supabase op deze server blijft erbuiten.

```
10.16.12.4 :80/:443 ──▶ planningstool-caddy ──▶ planningstool-app      (bestaand, alleen intern)
10.16.12.5 :80/:443 ──▶ sleeve-cpq-caddy    ──▶ sleeve-cpq:3000        (nieuw, ook voor klanten)
```

## Wat er in de CPQ-container zit

| Pad | Wat |
|---|---|
| `/` | de app (`cpq-configurator.html`), ook voor klantlinks `/?share=…` |
| `/api/odoo-contacts` | zoekt klanten en contactpersonen in Odoo (alleen lezen, uitgaand naar `*.odoo.com`) |
| `/api/render-pdf` | maakt de PDF met de Chromium in de container |
| `/healthz` | voor de health check |

## Stappen

### 1. De planningstool-Caddy alleen op 10.16.12.4
Nu luistert `planningstool-caddy` op `0.0.0.0:80/443`, dus op beide adressen. Zet in de
`docker-compose.yml` van de planningstool de poorten van die Caddy op het eigen adres:
```yaml
    ports:
      - "10.16.12.4:80:80"
      - "10.16.12.4:443:443"
      - "10.16.12.4:443:443/udp"
```
en start alleen die container opnieuw (de planningstool is een paar seconden weg):
```bash
cd <map van de planningstool>
sudo docker compose up -d planningstool-caddy    # of de servicenaam van die Caddy
sudo ss -tlnp | grep -E ':(80|443) '             # 80/443 nu alleen op 10.16.12.4
```

### 2. DNS en Azure
- **DNS**: `cpq.sleevetechnology.com` (of de gekozen naam) → het publieke IP dat naar **10.16.12.5** wijst.
- **Azure (NSG / firewall / NAT)**: publiek **443** en **80** → `10.16.12.5`. Poort 80 is nodig zodat
  Caddy het certificaat kan halen en http doorstuurt naar https.
- De planningstool (`10.16.12.4`) niet vanaf internet openzetten.
- **Uitgaand** 443 naar `*.supabase.co` en `*.odoo.com` moet open staan (meestal al zo).
- SSH alleen vanaf kantoor/VPN/Bastion.

### 3. Code en instellingen
```bash
sudo git clone https://github.com/JW2026-tech/sleevecpq.git /opt/sleeve-cpq
cd /opt/sleeve-cpq
sudo cp .env.example .env
sudo nano .env          # CPQ_BIND_IP, CPQ_DOMAIN, APP_URL, SUPABASE_*, ODOO_*
sudo chmod 600 .env
```
De sleutels staan nu in de Vercel-omgeving (Project → Settings → Environment Variables);
Jeroen kan ze daar overnemen. `.env` komt nooit in git.

### 4. Bouwen en starten
```bash
sudo docker compose up -d --build
sudo docker compose ps                         # beide: Up, cpq: healthy
curl -s http://127.0.0.1:3100/healthz          # {"ok":true}
curl -s "http://127.0.0.1:3100/api/render-pdf?check=1"   # kijkt of Supabase en de render-pagina antwoorden
sudo docker compose logs caddy | grep -i certificate     # certificaat binnen?
```
Daarna: `https://cpq.sleevetechnology.com` opent de app.

### 5. Updates
```bash
cd /opt/sleeve-cpq
sudo git pull
sudo docker compose up -d --build
```
Dit vervangt alleen de CPQ-containers; de planningstool merkt er niets van. (Vercel zet bij
een push automatisch live; hier gebeurt dat pas na deze twee regels.)

## Om rekening mee te houden
- **Certificaat**: Caddy haalt het zelf bij Let's Encrypt via poort 80 van `10.16.12.5`. Komt het
  verkeer via Azure Front Door of een Application Gateway die zelf https afhandelt, laat het dan weten:
  dan wordt `deploy/Caddyfile` een gewone http-doorgifte.
- **Klantlinks die al verstuurd zijn** wijzen naar `cpq-configurator.vercel.app`. Laat Vercel
  draaien tot die verlopen zijn; links die op het nieuwe adres worden gemaakt, wijzen vanzelf
  naar het nieuwe adres.
- **Geheugen**: een PDF maken kost Chromium een paar honderd MB. De container mag maximaal 1 GB
  (`mem_limit` in `docker-compose.yml`).
- **Logboek**: `sudo docker compose logs -f cpq` en `sudo docker compose logs -f caddy`
- Na het inloggen (Microsoft/Azure) moet het nieuwe adres ook als redirect-URL in Azure en in
  Supabase → Authentication → URL Configuration staan.
