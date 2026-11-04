# CPQ op de planningsserver — Docker, eigen Supabase, Azure DevOps

De CPQ draait op **SLT-NE-PRODPLAN01** naast de planningstool, met een eigen IP-adres, een eigen
Caddy en een eigen Supabase. Code staat in **Azure DevOps**; elke push naar `main` bouwt de CPQ
opnieuw op de server.

## Twee ingangen

| Ingang | Voor | Publiek IP → intern | Wat er bereikbaar is |
|---|---|---|---|
| `cpq.sleevetechnology.com` | klanten (klantlinks) | IP van de CPQ → 10.16.12.5 (`sleeve-cpq-caddy`) | de app, en van de database alleen de 4 klantlink-functies |
| `cpq-intern.sleevetechnology.com` | collega's | IP van de planningstool (alleen vanuit Sleeve) → 10.16.12.4 (`planningstool-caddy`) | de app en de hele database |

```
klant   ─▶ cpq.…        ─▶ sleeve-cpq-caddy    ─┬─ /      ─▶ sleeve-cpq
                                                └─ /sb/…  ─▶ cpq-supabase-kong  (alleen klantlink-functies)
collega ─▶ cpq-intern.… ─▶ planningstool-caddy ─┬─ /      ─▶ sleeve-cpq
                                                └─ /sb/…  ─▶ cpq-supabase-kong  (alles)
```
We onderscheiden op **ingang**, niet op IP-adres: Caddy ziet achter de Azure-doorsturing niet
wie er werkelijk belt. Klantlinks krijgen altijd het publieke adres (`PUBLIC_SHARE_URL`), ook als
een collega ze via de interne ingang maakt.

| Bestand | Wat |
|---|---|
| `docker-compose.yml` | `cpq` (de app) en `caddy` (publieke ingang op 10.16.12.5) |
| `deploy/Caddyfile` | de publieke ingang |
| `deploy/Caddyfile.intern` | het blok voor de interne ingang, in de Caddy van de planningstool |
| `supabase/` | de eigen Supabase: override, migratiescript en **STAPPENPLAN.md** |
| `azure-pipelines.yml` | bij een push naar `main`: opnieuw bouwen op de server |
| `.env.example` | alle instellingen; de echte `.env` staat alleen op de server |

---

## 1. De planningstool-Caddy alleen op 10.16.12.4
Nu luistert `planningstool-caddy` op `0.0.0.0:80/443`. In de compose van de planningstool:
```yaml
    ports:
      - "10.16.12.4:80:80"
      - "10.16.12.4:443:443"
      - "10.16.12.4:443:443/udp"
```
Controle na herstart van die Caddy: `sudo ss -tlnp | grep -E ':(80|443) '` → alleen 10.16.12.4.

## 2. De interne ingang in de planningstool-Caddy
1. `sudo docker network create cpq-net` (eenmalig, als die er nog niet is).
2. In de compose van de planningstool, bij de Caddy: `networks: [default, cpq-net]`, en onderaan
   `networks: { cpq-net: { external: true } }`. (Heeft die compose al een eigen `networks:`-lijst,
   dan `cpq-net` daaraan toevoegen.)
3. Het blok uit `deploy/Caddyfile.intern` in de Caddyfile van de planningstool zetten.
4. `sudo docker compose up -d <caddy-service>` en `caddy reload`.
5. DNS: `cpq-intern.sleevetechnology.com` → het publieke IP van de **planningstool**. Het certificaat
   gaat zoals dat van de planningstool zelf.

## 3. DNS en Azure voor de publieke ingang
- **DNS**: `cpq.sleevetechnology.com` → het tweede publieke IP, dat naar **10.16.12.5** gaat.
- **NSG — één nieuwe inbound-regel**:

  | Prioriteit | Naam | Poort | Protocol | Bron | Bestemming | Actie |
  |---|---|---|---|---|---|---|
  | 125 | Allow-HTTPS-Any-CPQ | 443 | TCP | Any | **10.16.12.5** | Allow |

  Bestemming **10.16.12.5**, niet *Any*: met *Any* staat ook de planningstool (10.16.12.4) voor de
  hele wereld open op 443. De NSG kijkt naar het interne adres na het publieke IP.
- Wat al goed staat: 443 vanuit Sleeve / Ted Spaik / TCC Tilburg (121–123) geldt voor beide adressen,
  dus de interne ingang `cpq-intern.…` is alleen voor hen bereikbaar; 80 open voor iedereen (130),
  nodig voor de certificaten van beide Caddy's.
- **Let op**: `deploy/Caddyfile.intern` laat dezelfde drie adressen toe als regels 121–123 (een tweede
  slot achter de NSG). Komt er in de NSG een adres bij voor de interne ingang, zet het daar ook bij.
- **Uitgaand**: 443 naar `*.odoo.com` (en tijdens de overstap `*.supabase.co`).

## 4. De eigen Supabase
Volg **`supabase/STAPPENPLAN.md`** (kopie van de opzet van de planningstool, eigen namen en
geheimen, starten, controleren, gegevens overzetten, back-up).

## 5. Instellingen van de CPQ
```bash
cd /opt/sleeve-cpq
sudo cp <repo>/.env.example .env && sudo nano .env && sudo chmod 600 .env
```
- `PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`: uit stap 5 van het stappenplan
- `ODOO_API_KEY`: uit de Vercel-instellingen (Jeroen)

## 6. Azure DevOps
1. **Repo**: *Repos → Import repository* → `https://github.com/JW2026-tech/sleevecpq.git`.
2. **Agent op de server**: *Pipelines → Environments → New environment* `cpq-prod` →
   *Add resource → Virtual machines → Linux* → het getoonde script op de server draaien.
   De agent-gebruiker moet `sudo docker` zonder wachtwoord mogen (of in de groep `docker`).
3. **Pipeline**: *Pipelines → New pipeline → Azure Repos Git → de repo → Existing YAML* →
   `azure-pipelines.yml`. De eerste run bouwt en start `sleeve-cpq` en `sleeve-cpq-caddy`.

Daarna zet elke push naar `main` de nieuwe versie live (alleen de CPQ-containers).

## 7. Controleren
```bash
curl -s http://127.0.0.1:3100/healthz                                    # {"ok":true}
curl -s "http://127.0.0.1:3100/api/render-pdf?check=1"                   # database + render-pagina
curl -s -o /dev/null -w "%{http_code}\n" https://cpq.sleevetechnology.com/sb/rest/v1/quotes         # 403
curl -s -o /dev/null -w "%{http_code}\n" https://cpq-intern.sleevetechnology.com/sb/rest/v1/        # 401 (geen sleutel) — dus bereikbaar
```
Daarna: een collega opent `https://cpq-intern.sleevetechnology.com`, maakt een klantlink; die link
begint met `https://cpq.sleevetechnology.com/?share=…` en werkt van buiten.

## Om rekening mee te houden
- **Back-ups**: dagelijks, zie stap 11 van het stappenplan.
- **Oude klantlinks** (`cpq-configurator.vercel.app/?share=…`): na de overstap Vercel laten
  doorsturen naar `https://cpq.sleevetechnology.com`, dan werken ze tegen de nieuwe database.
- **Geheugen**: CPQ-app tot 1 GB (PDF), de Supabase-stack ongeveer 1–1,5 GB.
- **Inloggen (Azure)**: komt hierna, in de auth van deze Supabase (Azure-provider in
  `supabase/.env`, redirect-URL `https://cpq-intern.sleevetechnology.com/sb/auth/v1/callback`).
  Daarna gaan de tabellen ook in de database zelf dicht voor de anon-sleutel.
- **Logboek**: `sudo docker logs -f sleeve-cpq`, `sudo docker logs -f sleeve-cpq-caddy`.
