# CPQ op de planningsserver — Docker, eigen Supabase, Azure DevOps

De CPQ draait op **SLT-NE-PRODPLAN01** naast de planningstool, maar deelt er niets mee:
eigen IP-adres, eigen Caddy, eigen Supabase. Code staat in **Azure DevOps**; elke push naar
`main` bouwt de CPQ opnieuw op de server.

```
                         ┌──────────────────────── 10.16.12.5 ─────────────────────────┐
internet ─443─▶ sleeve-cpq-caddy ─┬─ /        ─▶ sleeve-cpq:3000  (app, Odoo, PDF)
                                  └─ /sb/…    ─▶ cpq-supabase-kong ─▶ db, auth, rest, realtime
                                       (van buiten alleen de 4 klantlink-functies)
                         └──────────────────────────────────────────────────────────────┘
10.16.12.4 ─▶ planningstool-caddy ─▶ planningstool-app + eigen Supabase   (ongewijzigd, intern)
```

| Map / bestand | Wat |
|---|---|
| `docker-compose.yml` | `cpq` (de app) en `caddy` (https op 10.16.12.5) |
| `deploy/Caddyfile` | routes: app, en de database onder `/sb/` met toegangsregels |
| `supabase/` | de eigen Supabase van de CPQ (override + migratiescript) |
| `azure-pipelines.yml` | bij een push naar `main`: opnieuw bouwen op de server |
| `.env.example` | alle instellingen; de echte `.env` staat alleen op de server |

---

## 1. De planningstool-Caddy alleen op 10.16.12.4
Nu luistert `planningstool-caddy` op `0.0.0.0:80/443`. Zet in de compose van de planningstool:
```yaml
    ports:
      - "10.16.12.4:80:80"
      - "10.16.12.4:443:443"
      - "10.16.12.4:443:443/udp"
```
en herstart alleen die Caddy (`sudo docker compose up -d <servicenaam>`). Controle:
`sudo ss -tlnp | grep -E ':(80|443) '` → alleen 10.16.12.4.

## 2. DNS en Azure
- **DNS**: `cpq.sleevetechnology.com` → het publieke IP dat naar **10.16.12.5** gaat.
- **Inkomend**: 443 en 80 → `10.16.12.5` (80 voor het certificaat). 10.16.12.4 niet van buiten.
- **Uitgaand**: 443 naar `*.odoo.com` (en tijdens de overstap `*.supabase.co`).
- **Intern DNS (aanrader)**: laat `cpq.sleevetechnology.com` binnen het netwerk naar 10.16.12.5
  wijzen. Collega's komen dan van een privé-adres binnen en mogen de hele database-API gebruiken
  (`STAFF_IPS=private_ranges`); van buiten alleen de klantlinks. Werkt iemand van buiten zonder VPN,
  zet dan het kantooradres erbij in `STAFF_IPS`.

## 3. Eenmalig op de server
```bash
sudo mkdir -p /opt/sleeve-cpq && cd /opt/sleeve-cpq
sudo docker network create cpq-net
```
Docker Compose **2.24 of nieuwer** is nodig (`docker compose version`), voor `!override` in de
Supabase-override.

## 4. De eigen Supabase van de CPQ
Gebruik dezelfde opzet als de Supabase van de planningstool (die draait al met precies deze
zeven services), in een eigen map:
```bash
sudo cp -r <map van de Supabase van de planningstool> /opt/sleeve-cpq/supabase
cd /opt/sleeve-cpq/supabase
sudo rm -rf volumes/db/data              # NIET de data van de planningstool meenemen
sudo cp <repo>/supabase/docker-compose.override.yml .
```
Dan in `/opt/sleeve-cpq/supabase/.env` **nieuwe** geheimen (niet die van de planningstool):
- `POSTGRES_PASSWORD`, `JWT_SECRET` (minstens 32 tekens), en daarmee nieuwe `ANON_KEY` en
  `SERVICE_ROLE_KEY` (Supabase-docs: *Self-hosting with Docker → Generate API keys*);
- `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` voor Studio;
- `SITE_URL=https://cpq.sleevetechnology.com`, `API_EXTERNAL_URL=https://cpq.sleevetechnology.com/sb`,
  `SUPABASE_PUBLIC_URL=https://cpq.sleevetechnology.com/sb`.

In `volumes/api/kong.yml` de realtime-upstream laten wijzen naar de nieuwe naam:
`realtime-dev.supabase-realtime` → `realtime-dev.cpq-supabase-realtime` (twee keer).

Starten (alleen de services die de CPQ gebruikt):
```bash
sudo docker compose -p cpq-supabase up -d db kong auth rest realtime meta studio
sudo docker compose -p cpq-supabase ps          # alles healthy
```
Studio (beheer) is alleen op de server zelf bereikbaar: `http://127.0.0.1:3101`
(via een SSH-tunnel), Postgres op `127.0.0.1:5433`.

## 5. De gegevens overzetten uit de cloud
Op een rustig moment (niemand werkt in de CPQ):
```bash
cd /opt/sleeve-cpq/supabase
sudo chmod +x migrate-from-cloud.sh        # uit de repo gekopieerd
CLOUD_DB_URL='postgresql://…' ./migrate-from-cloud.sh
```
De verbinding staat in het cloud-project onder *Project Settings → Database → Connection string*.
Het script leest alleen in de cloud, zet alles over, en toont de aantallen om te vergelijken.

## 6. Instellingen van de CPQ
```bash
cd /opt/sleeve-cpq
sudo cp <repo>/.env.example .env && sudo nano .env && sudo chmod 600 .env
```
- `PUBLIC_SUPABASE_ANON_KEY` = de **ANON_KEY** uit stap 4
- `SUPABASE_SERVICE_ROLE_KEY` = de **SERVICE_ROLE_KEY** uit stap 4
- `ODOO_API_KEY` = uit de Vercel-instellingen (Jeroen)

## 7. Azure DevOps
1. **Repo**: in DevOps *Repos → Import repository* → `https://github.com/JW2026-tech/sleevecpq.git`
   (of Jeroen pusht naar de nieuwe DevOps-repo).
2. **Agent op de server**: *Pipelines → Environments → New environment* `cpq-prod` →
   *Add resource → Virtual machines → Linux* → het getoonde script op de server draaien.
   De agent-gebruiker moet `sudo docker` zonder wachtwoord mogen (of in de groep `docker`).
3. **Pipeline**: *Pipelines → New pipeline → Azure Repos Git → de repo → Existing YAML* →
   `azure-pipelines.yml`. Eerste run: bouwt en start `sleeve-cpq` en `sleeve-cpq-caddy`.

Daarna zet elke push naar `main` de nieuwe versie live (alleen de CPQ-containers; Supabase en de
planningstool blijven staan). Met de hand kan het ook:
`sudo docker compose -p sleeve-cpq up -d --build cpq caddy` in een checkout met de `.env` erbij.

## 8. Controleren
```bash
curl -s http://127.0.0.1:3100/healthz                          # {"ok":true}
curl -s "http://127.0.0.1:3100/api/render-pdf?check=1"         # database en render-pagina
curl -s -o /dev/null -w "%{http_code}\n" https://cpq.sleevetechnology.com/sb/rest/v1/quotes   # van buiten: 403
```
Een klantlink openen moet werken; vanaf een adres buiten `STAFF_IPS` hoort `/sb/rest/v1/…`
(behalve de vier klantlink-functies) een **403** te geven.

## Om rekening mee te houden
- **Back-ups**: zelf hosten betekent zelf back-uppen. Minstens dagelijks
  `docker exec cpq-supabase-db pg_dump -U postgres -d postgres --schema=public > …` naar een
  andere plek dan de server.
- **Oude klantlinks** (`cpq-configurator.vercel.app/?share=…`): na de overstap Vercel laten
  doorsturen naar het nieuwe adres, dan werken ze tegen de nieuwe database.
- **Geheugen**: CPQ-app tot 1 GB (PDF), de Supabase-stack ongeveer 1–1,5 GB.
- **Inloggen (Azure)**: komt hierna, in de auth van deze Supabase (Azure-provider in `supabase/.env`,
  redirect-URL `https://cpq.sleevetechnology.com/sb/auth/v1/callback`). Daarna gaan de tabellen dicht
  voor de anon-sleutel; tot dan houdt Caddy de database van buiten dicht.
- **Logboek**: `sudo docker logs -f sleeve-cpq`, `sudo docker logs -f sleeve-cpq-caddy`.
