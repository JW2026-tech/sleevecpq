# CPQ op de planningsserver — Docker, eigen Supabase, Azure DevOps

De CPQ draait op **SLT-NE-PRODPLAN01** naast de planningstool, met eigen containers en een
eigen Supabase. Code staat in **Azure DevOps**; elke push naar `main` bouwt de CPQ-container
opnieuw op de server en herlaadt de Caddy van de CPQ.

## Twee ingangen, twee Caddy's

| Ingang | Voor | Publiek IP → intern | Caddy | Wat er bereikbaar is |
|---|---|---|---|---|
| `quote.sleevetechnology.com` | klanten (klantlinks) | tweede IP → **10.16.12.5**, open voor iedereen | `cpq-caddy` (nieuw, van de CPQ) | de app, en van de database alleen de 4 klantlink-functies |
| `cpq.sleevetechnology.com` | collega's | IP van de planningstool → **10.16.12.4**, alleen Sleeve | `planningstool-caddy` (bestaat al) | de app en de hele database |

```
klant   ─▶ quote.…      ─▶ 10.16.12.5 ─▶ cpq-caddy           ─┬─ /      ─▶ sleeve-cpq
                                                            └─ /sb/… ─▶ cpq-supabase-kong (4 functies)
collega ─▶ cpq.…        ─▶ 10.16.12.4 ─▶ planningstool-caddy ─┬─ /      ─▶ sleeve-cpq
                                                            ├─ /sb/… ─▶ cpq-supabase-kong
                                                            └─ planning… ─▶ planningstool-app (ongewijzigd)
```

**Belangrijk.** Elke Caddy luistert alleen op zijn eigen adres. Op 10.16.12.5 (open voor iedereen)
staat alleen `cpq-caddy`, en die kent alleen `quote.sleevetechnology.com`: de planningstool en
`cpq.sleevetechnology.com` zijn daar niet op te vragen. Daarvoor moet de Caddy van de planningstool van
`0.0.0.0:80/443` naar **`10.16.12.4:80/443`** (stap 2); anders bezet hij ook de poorten van
10.16.12.5 en start `cpq-caddy` niet.

| Bestand | Wat |
|---|---|
| `docker-compose.yml` | de CPQ (`sleeve-cpq`) en zijn Caddy (`cpq-caddy`, 10.16.12.5:80/443), op het netwerk `cpq-net` |
| `deploy/Caddyfile.cpq` | de Caddyfile van `cpq-caddy`: de klantingang |
| `deploy/Caddyfile.intern` | het blok voor de Caddy van de planningstool: de interne ingang + het Sleeve-slot |
| `supabase/` | de eigen Supabase: override, migratiescript en **STAPPENPLAN.md** |
| `azure-pipelines.yml` | bij een push naar `main`: de CPQ opnieuw bouwen, Caddyfile kopiëren en Caddy herladen |
| `.env.example` | instellingen van de CPQ; de echte `.env` staat alleen op de server |

---

## 1. Netwerk en mappen
```bash
docker network create cpq-net                     # eenmalig
sudo mkdir -p /opt/sleeve-cpq/caddy               # de Caddyfile van cpq-caddy (de pipeline zet hem erin)
sudo chown <agent-gebruiker>: /opt/sleeve-cpq/caddy
```

## 2. De bestaande Caddy (planningstool)
1. **Poorten**: in de compose van de planningstool, bij de Caddy,
   `"80:80"` / `"443:443"` (of `0.0.0.0:…`) vervangen door
   ```yaml
   ports:
     - "10.16.12.4:80:80"
     - "10.16.12.4:443:443"
   ```
   (staat er ook `443:443/udp`, die ook op `10.16.12.4` zetten).
2. **Netwerk**: bij die Caddy `networks: [default, cpq-net]`, en onderaan
   `networks: { cpq-net: { external: true } }` (bestaat er al een `networks:`-lijst, voeg `cpq-net` toe).
3. De inhoud van `deploy/Caddyfile.intern` in de Caddyfile van de planningstool zetten.
   **Let op:** verwijst die Caddyfile naar de eigen Supabase met de korte naam `kong:8000`, maak
   daar `supabase-kong:8000` (de containernaam) van. Op `cpq-net` heet de Kong van de CPQ ook `kong`,
   en dan komt het inloggen van de planningstool bij de CPQ terecht.
4. `docker compose up -d <caddy-service>` (nieuwe poorten en netwerk; de planningstool is dan
   een paar seconden weg) en controleren met `docker ps` dat er `10.16.12.4:80->80` staat.

Certificaten: beide Caddy's halen ze zelf via poort 80 (NSG-regel 130 staat open voor iedereen;
die moet ook voor **10.16.12.5** gelden). De certificaten van `cpq-caddy` staan in het volume
`sleeve-cpq_caddy_data`: niet weggooien.

## 3. DNS en NSG
- **DNS**: `quote.sleevetechnology.com` → tweede publiek IP (→ 10.16.12.5);
  `cpq.sleevetechnology.com` → publiek IP van de planningstool (→ 10.16.12.4).
- **NSG — één nieuwe inbound-regel**:

  | Prioriteit | Naam | Poort | Protocol | Bron | Bestemming | Actie |
  |---|---|---|---|---|---|---|
  | 125 | Allow-HTTPS-Any-CPQ | 443 | TCP | Any | **10.16.12.5** | Allow |

  Bestemming **10.16.12.5**, niet *Any*.
- **Let op**: komt er in de NSG een adres bij voor Sleeve (121–123), zet het ook in `alleen_sleeve` (`deploy/Caddyfile.intern`).
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
   `azure-pipelines.yml`. De eerste run bouwt en start `sleeve-cpq` en `cpq-caddy`
   (stap 1 en 2 eerst, anders zijn de poorten van 10.16.12.5 nog bezet).

Elke push naar `main` bouwt daarna `sleeve-cpq` opnieuw en herlaadt `cpq-caddy` met
`deploy/Caddyfile.cpq`. Wijzigt `deploy/Caddyfile.intern`, dan dat blok met de hand in de Caddyfile
van de planningstool bijwerken en die Caddy herladen.
Oude images ruimt de pipeline niet op: af en toe `docker image prune`.

## 7. Controleren
```bash
curl -s http://127.0.0.1:3100/healthz                                    # {"ok":true}
curl -s "http://127.0.0.1:3100/api/render-pdf?check=1"                   # database + render-pagina
# van buiten Sleeve (bv. telefoon zonder wifi):
#   https://quote.sleevetechnology.com                 → de app
#   https://quote.sleevetechnology.com/sb/rest/v1/     → 403
#   https://cpq.sleevetechnology.com          → 403
#   de planningstool via zijn naam                   → niet bereikbaar (zoals nu)
```
Daarna: een collega opent `https://cpq.sleevetechnology.com`, maakt een klantlink; die
begint met `https://quote.sleevetechnology.com/?share=…` en werkt van buiten.

## Om rekening mee te houden
- **Back-ups**: dagelijks, zie stap 11 van het stappenplan.
- **Oude klantlinks** (`cpq-configurator.vercel.app/?share=…`): na de overstap Vercel laten
  doorsturen naar `https://quote.sleevetechnology.com`.
- **Geheugen**: CPQ-app tot 1 GB (PDF), de Supabase-stack ongeveer 1–1,5 GB.
- **Inloggen (Azure)**: komt hierna, in de auth van de eigen Supabase (redirect-URL
  `https://cpq.sleevetechnology.com/sb/auth/v1/callback`). Daarna gaan de tabellen ook in de
  database zelf dicht voor de anon-sleutel.
- **Logboek**: `docker logs -f sleeve-cpq`, `docker logs -f cpq-caddy`, `docker logs -f planningstool-caddy`.

## Inloggen met Microsoft — de drie pipeline-variabelen

De app-registratie in Azure staat beschreven in `supabase/STAPPENPLAN.md` (Inloggen met Microsoft, stap a).
De drie waarden daaruit gaan **niet** in de repo, maar als geheime variabelen in de pipeline:
Azure DevOps → *Pipelines* → de CPQ-pipeline → *Edit* → *Variables* → *New variable*, elk met
**Keep this value secret** aangevinkt:

| Naam | Waarde |
|---|---|
| `AZURE_TENANT_ID` | Directory (tenant) ID |
| `AZURE_CLIENT_ID` | Application (client) ID |
| `AZURE_SECRET` | de *Value* van het client secret |

Bij elke run zet de pipeline ze in `/opt/sleeve-cpq/supabase/.env`, kopieert de override en start
alleen de inlogdienst opnieuw als er iets veranderde. Ontbreekt een van de drie, dan stopt de
pipeline vóór de app wordt bijgewerkt. Een nieuw secret (elke 24 maanden): de variabele aanpassen
en de pipeline opnieuw draaien.
