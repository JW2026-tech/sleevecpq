# CPQ op de planningsserver — Docker, eigen Supabase, Azure DevOps

De CPQ draait op **SLT-NE-PRODPLAN01** naast de planningstool, met een eigen container en een
eigen Supabase. HTTPS doet de **Caddy die er al staat** (`planningstool-caddy`). Code staat in
**Azure DevOps**; elke push naar `main` bouwt de CPQ-container opnieuw op de server.

## Twee ingangen, één Caddy

| Ingang | Voor | Publiek IP → intern | Wat er bereikbaar is |
|---|---|---|---|
| `cpq.sleevetechnology.com` | klanten (klantlinks) | tweede IP → 10.16.12.5, open voor iedereen | de app, en van de database alleen de 4 klantlink-functies |
| `cpq-intern.sleevetechnology.com` | collega's | IP van de planningstool → 10.16.12.4 | de app en de hele database — alleen Sleeve |

```
klant   ─▶ cpq.…        ─┐                         ┌─ /      ─▶ sleeve-cpq
                         ├─▶ planningstool-caddy ─┤
collega ─▶ cpq-intern.… ─┘   (beide adressen)      └─ /sb/…  ─▶ cpq-supabase-kong
                                                    planning… ─▶ planningstool-app (ongewijzigd)
```

**Belangrijk.** Eén Caddy beantwoordt elke naam op elk adres. Zodra 10.16.12.5 voor iedereen open
staat, kan iemand via dat adres ook om de planningstool of om `cpq-intern` vragen; de NSG houdt dat
dan niet meer tegen. Daarom zitten de drie Sleeve-adressen (NSG-regels 121–123) óók in Caddy:
het fragment `alleen_sleeve` in `deploy/Caddyfile.cpq`, op `cpq-intern` én op de planningstool.

| Bestand | Wat |
|---|---|
| `docker-compose.yml` | de CPQ-container (`sleeve-cpq`), op het netwerk `cpq-net` |
| `deploy/Caddyfile.cpq` | de blokken voor de bestaande Caddy (beide ingangen + het Sleeve-slot) |
| `supabase/` | de eigen Supabase: override, migratiescript en **STAPPENPLAN.md** |
| `azure-pipelines.yml` | bij een push naar `main`: de CPQ-container opnieuw bouwen |
| `.env.example` | instellingen van de CPQ; de echte `.env` staat alleen op de server |

---

## 1. Netwerk
```bash
docker network create cpq-net        # eenmalig
```
De Caddy van de planningstool blijft op `0.0.0.0:80/443` luisteren (beide adressen) — niets aan
de poorten veranderen.

## 2. De bestaande Caddy
1. In de compose van de planningstool, bij de Caddy: `networks: [default, cpq-net]`, en onderaan
   `networks: { cpq-net: { external: true } }` (bestaat er al een `networks:`-lijst, voeg `cpq-net` toe).
2. De inhoud van `deploy/Caddyfile.cpq` in de Caddyfile van de planningstool zetten.
3. In het blok van de **planningstool** zelf als eerste regel: `import alleen_sleeve`.
4. `docker compose up -d <caddy-service>` (voor het netwerk) en daarna
   `docker exec planningstool-caddy caddy reload --config /etc/caddy/Caddyfile`.

Certificaten: Caddy haalt ze zelf via poort 80 (NSG-regel 130 staat open voor iedereen).

## 3. DNS en NSG
- **DNS**: `cpq.sleevetechnology.com` → tweede publiek IP (→ 10.16.12.5);
  `cpq-intern.sleevetechnology.com` → publiek IP van de planningstool (→ 10.16.12.4).
- **NSG — één nieuwe inbound-regel**:

  | Prioriteit | Naam | Poort | Protocol | Bron | Bestemming | Actie |
  |---|---|---|---|---|---|---|
  | 125 | Allow-HTTPS-Any-CPQ | 443 | TCP | Any | **10.16.12.5** | Allow |

  Bestemming **10.16.12.5**, niet *Any*.
- **Let op**: komt er in de NSG een adres bij voor Sleeve (121–123), zet het ook in `alleen_sleeve`.
- **Uitgaand**: 443 naar `*.odoo.com` (en tijdens de overstap `*.supabase.co`).

## 4. De eigen Supabase
Volg **`supabase/STAPPENPLAN.md`**.

## 5. Instellingen van de CPQ
```bash
cd /opt/sleeve-cpq
sudo cp <repo>/.env.example .env && sudo nano .env
sudo chown <agent-gebruiker>: .env && sudo chmod 600 .env   # de pipeline draait als die gebruiker en moet .env kunnen lezen
```
- `PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`: uit stap 5 van het stappenplan
- `ODOO_API_KEY`: uit de Vercel-instellingen (Jeroen)

## 6. Azure DevOps
1. **Repo**: staat al in `SleeveTechnologyNL/CPQ` (Jeroen pusht naar GitHub en DevOps tegelijk).
2. **Agent op de server**: *Pipelines → Environments → New environment* `cpq-prod` →
   *Add resource → Virtual machines → Linux* → het getoonde script op de server draaien.
   De agent draait onder een eigen gebruiker in de groep `docker`; de pipeline gebruikt geen `sudo`.
   Die gebruiker moet `/opt/sleeve-cpq/.env` kunnen lezen (stap 5).
3. **Pipeline**: *Pipelines → New pipeline → Azure Repos Git → CPQ → Existing YAML* →
   `azure-pipelines.yml`. De eerste run bouwt en start `sleeve-cpq`.

Elke push naar `main` bouwt daarna alleen `sleeve-cpq` opnieuw. Wijzigt `deploy/Caddyfile.cpq`,
dan dat blok met de hand in de Caddyfile van de planningstool bijwerken en Caddy herladen.
Oude images ruimt de pipeline niet op: af en toe `docker image prune`.

## 7. Controleren
```bash
curl -s http://127.0.0.1:3100/healthz                                    # {"ok":true}
curl -s "http://127.0.0.1:3100/api/render-pdf?check=1"                   # database + render-pagina
# van buiten Sleeve (bv. telefoon zonder wifi):
#   https://cpq.sleevetechnology.com                 → de app
#   https://cpq.sleevetechnology.com/sb/rest/v1/     → 403
#   https://cpq-intern.sleevetechnology.com          → 403
#   de planningstool via zijn naam                   → 403 / niet bereikbaar
```
Daarna: een collega opent `https://cpq-intern.sleevetechnology.com`, maakt een klantlink; die
begint met `https://cpq.sleevetechnology.com/?share=…` en werkt van buiten.

## Om rekening mee te houden
- **Back-ups**: dagelijks, zie stap 11 van het stappenplan.
- **Oude klantlinks** (`cpq-configurator.vercel.app/?share=…`): na de overstap Vercel laten
  doorsturen naar `https://cpq.sleevetechnology.com`.
- **Geheugen**: CPQ-app tot 1 GB (PDF), de Supabase-stack ongeveer 1–1,5 GB.
- **Inloggen (Azure)**: komt hierna, in de auth van de eigen Supabase (redirect-URL
  `https://cpq-intern.sleevetechnology.com/sb/auth/v1/callback`). Daarna gaan de tabellen ook in de
  database zelf dicht voor de anon-sleutel.
- **Logboek**: `docker logs -f sleeve-cpq`, `docker logs -f planningstool-caddy`.
