#!/usr/bin/env bash
# Nightly copy of the CPQ's database (quotations, versions, links, catalogue,
# history), as cpqagent from cron. The pipeline installs this and the cron line.
#
#   /opt/sleeve-cpq/backups/cpq-YYYYMMDD-HHMM.sql.gz   kept 30 days
#
# The public schema only: that is all the CPQ's own data. Sign-ins live in
# Microsoft; after a restore a colleague simply signs in again.
#
# Restore into an EMPTY public schema (as with the move from the cloud):
#   gunzip -c cpq-….sql.gz | docker exec -i cpq-supabase-db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1
#
# These copies sit on the same server: they guard against a mistake in the
# data, not against losing the server. Copy one elsewhere now and then, or
# have the VM itself backed up in Azure.
set -euo pipefail
DIR=/opt/sleeve-cpq/backups
mkdir -p "$DIR"
F="$DIR/cpq-$(date +%Y%m%d-%H%M).sql.gz"
docker exec cpq-supabase-db pg_dump -U supabase_admin -d postgres --schema=public --no-owner --quote-all-identifiers \
  | gzip > "$F.tmp"
# a copy that is suspiciously small is not trusted as a backup
if [ "$(stat -c %s "$F.tmp")" -lt 100000 ]; then
  echo "$(date -Is) backup too small ($(stat -c %s "$F.tmp") bytes), kept as $F.failed"
  mv "$F.tmp" "$F.failed"; exit 1
fi
mv "$F.tmp" "$F"
find "$DIR" -name 'cpq-*.sql.gz' -mtime +30 -delete
echo "$(date -Is) ok $F ($(du -h "$F" | cut -f1))"
