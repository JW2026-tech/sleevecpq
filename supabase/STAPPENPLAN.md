# Stappenplan: een eigen Supabase voor de CPQ

Doel: een tweede, losse Supabase op SLT-NE-PRODPLAN01, alleen voor de CPQ. Zelfde opzet als de
Supabase van de planningstool, maar met eigen containers, eigen geheimen, eigen data en geen
poorten naar buiten. De Supabase van de planningstool wordt **niet** aangeraakt.

Duur: ongeveer een uur, zonder de gegevensoverzet (stap 9).

---

### 1. Controleren wat er nodig is
```bash
docker compose version                 # 2.24 of nieuwer (nodig voor !override)
free -h                                # minstens ~2 GB vrij voor de tweede stack + de CPQ
docker network ls | grep cpq-net || docker network create cpq-net
```

### 2. De map van de Supabase van de planningstool opzoeken
```bash
docker inspect supabase-db --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}'
```
Dat is de map met `docker-compose.yml`, `.env` en `volumes/`. Hierna `<PLANNING_SB>`.

### 3. Kopiëren — zonder data
```bash
mkdir -p /opt/sleeve-cpq
rsync -a --exclude 'volumes/db/data' --exclude 'volumes/storage' <PLANNING_SB>/ /opt/sleeve-cpq/supabase/
cd /opt/sleeve-cpq/supabase
ls volumes/db                          # GEEN map 'data' — anders stoppen en verwijderen
```

### 4. De override van de CPQ ernaast zetten
```bash
cp <repo>/supabase/docker-compose.override.yml /opt/sleeve-cpq/supabase/
cp <repo>/supabase/migrate-from-cloud.sh /opt/sleeve-cpq/supabase/ && chmod +x /opt/sleeve-cpq/supabase/migrate-from-cloud.sh
```
De override geeft elke container een eigen naam (`cpq-supabase-db`, `cpq-supabase-kong`,
`cpq-supabase-auth`, `cpq-supabase-rest`, `realtime-dev.cpq-supabase-realtime`,
`cpq-supabase-meta`, `cpq-supabase-studio`), zet Kong op het netwerk `cpq-net` en haalt alle
poorten weg, behalve Postgres op `127.0.0.1:5433` en Studio op `127.0.0.1:3101`.

### 5. Eigen geheimen in `/opt/sleeve-cpq/supabase/.env`
Nooit die van de planningstool laten staan. Nieuw maken:
```bash
openssl rand -base64 36        # POSTGRES_PASSWORD
openssl rand -base64 48        # JWT_SECRET (minstens 32 tekens)
openssl rand -base64 24        # DASHBOARD_PASSWORD (Studio)
```
`ANON_KEY` en `SERVICE_ROLE_KEY` zijn JWT's die met de nieuwe `JWT_SECRET` ondertekend moeten
worden: zie de Supabase-docs *Self-Hosting with Docker → Securing your services → Generate API keys*
(daar staat een generator; vul de nieuwe `JWT_SECRET` in, maak beide sleutels).

Verder in dezelfde `.env`:
```
SITE_URL=https://cpq.sleevetechnology.com
API_EXTERNAL_URL=https://cpq.sleevetechnology.com/sb
SUPABASE_PUBLIC_URL=https://cpq.sleevetechnology.com/sb
ADDITIONAL_REDIRECT_URLS=https://quote.sleevetechnology.com
DISABLE_SIGNUP=true
```
Bewaar de nieuwe waarden in jullie wachtwoordkluis; `chmod 600 .env`.

### 6. Realtime-naam in Kong aanpassen
```bash
sed -i 's/realtime-dev\.supabase-realtime/realtime-dev.cpq-supabase-realtime/g' volumes/api/kong.yml
grep -n realtime volumes/api/kong.yml   # twee regels met de nieuwe naam
```

### 7. Starten — met een eigen projectnaam
```bash
cd /opt/sleeve-cpq/supabase
docker compose -p cpq-supabase up -d db kong auth rest realtime meta studio
docker compose -p cpq-supabase ps          # alles Up / healthy
docker ps --format '{{.Names}}' | grep supabase   # planningstool-containers ongewijzigd ernaast
```
`-p cpq-supabase` houdt netwerk en volumes los van de Supabase van de planningstool.
Gebruik die vlag bij **elk** compose-commando in deze map.

### 8. Controleren
```bash
# Kong antwoordt (van binnen het netwerk), met de nieuwe ANON_KEY:
docker run --rm --network cpq-net curlimages/curl -s \
  -H "apikey: <ANON_KEY>" http://cpq-supabase-kong:8000/rest/v1/ | head -c 200
# Studio: via een SSH-tunnel  ssh -L 3101:127.0.0.1:3101 admintcc@<server>  →  http://localhost:3101
```

### 9. De gegevens uit de cloud overzetten
Op een rustig moment (niemand werkt in de CPQ):
```bash
cd /opt/sleeve-cpq/supabase
CLOUD_DB_URL='postgresql://postgres.<ref>:<wachtwoord>@<host>:5432/postgres' ./migrate-from-cloud.sh
```
De verbinding staat in het cloud-project: *Project Settings → Database → Connection string*.
Het script leest alleen in de cloud, stopt als de nieuwe database niet leeg is, en toont aan het
eind de aantallen om met de cloud te vergelijken.

### 10. De CPQ aan deze Supabase koppelen
In `/opt/sleeve-cpq/.env` (die van de CPQ, niet die van Supabase):
```
PUBLIC_SUPABASE_URL=/sb
PUBLIC_SUPABASE_ANON_KEY=<ANON_KEY uit stap 5>
SUPABASE_URL=http://cpq-supabase-kong:8000
SUPABASE_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY uit stap 5>
```
en de CPQ opnieuw starten (`docker compose -p sleeve-cpq up -d cpq`).

### 11. Back-up inrichten
Dagelijks, naar een plek buiten de server:
```bash
docker exec cpq-supabase-db pg_dump -U postgres -d postgres --schema=public | gzip > /backup/cpq-$(date +%F).sql.gz
```

---

**Terug als er iets misgaat**: `docker compose -p cpq-supabase down` in
`/opt/sleeve-cpq/supabase` stopt alleen deze stack; de CPQ kan dan met de cloud-instellingen in
`.env` verder op de cloud-Supabase (die blijft tot de overstap gewoon draaien).
