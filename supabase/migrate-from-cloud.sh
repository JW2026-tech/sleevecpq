#!/usr/bin/env bash
# Copies the CPQ's database from the cloud Supabase into its own Supabase on this
# server: the tables, functions, triggers, policies and rights of the public
# schema, and all their rows (quotations, versions, catalogue, links, history).
#
#   CLOUD_DB_URL='postgresql://postgres.<ref>:<password>@<host>:5432/postgres' ./migrate-from-cloud.sh
#
# The cloud address is in the cloud project under Project Settings → Database →
# Connection string (Session pooler or Direct). Run it once, while nobody edits;
# it stops at the first error and changes nothing in the cloud.
set -euo pipefail

: "${CLOUD_DB_URL:?Set CLOUD_DB_URL to the cloud database connection string}"
DB=${DB_CONTAINER:-cpq-supabase-db}
DUMP=cpq-cloud-$(date +%Y%m%d-%H%M%S).sql

echo "1/4  Reading the cloud database (public schema) ..."
# pg_dump 17 (a throwaway container): the cloud may run a newer Postgres than this
# server, and an older pg_dump refuses to read it. Owners are left out (they differ
# here), rights to anon/authenticated/service_role are kept. The one setting
# Postgres 17 writes that an older server does not know is taken out again.
docker run --rm -e PGCONNECT_TIMEOUT=15 postgres:17-alpine \
  pg_dump "$CLOUD_DB_URL" --schema=public --no-owner --quote-all-identifiers > "$DUMP"
sed -i '/^SET transaction_timeout/d' "$DUMP"
echo "     saved as $DUMP ($(du -h "$DUMP" | cut -f1))"

echo "2/4  The public schema here must still be empty ..."
COUNT=$(docker exec "$DB" psql -U postgres -d postgres -tAc \
  "select count(*) from information_schema.tables where table_schema='public'")
if [ "$COUNT" != "0" ]; then
  echo "     The public schema here already has $COUNT tables — stopping, nothing changed."
  exit 1
fi

echo "3/4  Writing it into $DB ..."
docker exec -i "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < "$DUMP"

echo "4/4  Live updates for the shared catalogue, and the counts to compare ..."
docker exec "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -c \
  "do \$\$ begin
     if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='catalogue_draft')
     then alter publication supabase_realtime add table public.catalogue_draft; end if;
   end \$\$;"
docker exec "$DB" psql -U postgres -d postgres -c \
  "select 'quotes' as table, count(*) from public.quotes
   union all select 'quote_versions', count(*) from public.quote_versions
   union all select 'quote_shares', count(*) from public.quote_shares
   union all select 'catalogue_versions', count(*) from public.catalogue_versions
   union all select 'catalogue_draft', count(*) from public.catalogue_draft;"
echo "Done. Compare these counts with the cloud (Table editor) before switching over."
