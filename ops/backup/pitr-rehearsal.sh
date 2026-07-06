#!/usr/bin/env bash
# PITR restore rehearsal — Phase 7. TASKS.md is explicit: "restore de PITR
# ensaiado de verdade, não só configurado". This script IS the rehearsal:
# restore the latest pgBackRest backup + WAL into a THROWAWAY container,
# recover to a point in time, and prove the data is there — without ever
# touching the live cluster. Run monthly (DEPLOYMENT.md §3.3) and after any
# change to backup config; a rehearsal that fails is a production incident
# caught for free.
#
# Usage: ./pitr-rehearsal.sh [--target-time "2026-07-06 03:00:00"]
#   Requires: docker, /etc/pgbackrest/pgbackrest.conf reachable from this host
#   (run it on the database box), and the SFTP key it references.
set -euo pipefail

TARGET_TIME="${2:-}"
REHEARSAL_DIR="$(mktemp -d /tmp/dalio-pitr-XXXXXX)"
CONTAINER="dalio-pitr-rehearsal"
PGB_IMAGE="pgbackrest/pgbackrest:latest"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  sudo rm -rf "$REHEARSAL_DIR"
}
trap cleanup EXIT

echo "==> [1/4] Restoring latest backup into $REHEARSAL_DIR (delta off, scratch dir)"
RESTORE_ARGS=(--stanza=dalio --pg1-path="$REHEARSAL_DIR/data" restore)
if [[ "${1:-}" == "--target-time" && -n "$TARGET_TIME" ]]; then
  RESTORE_ARGS+=(--type=time "--target=$TARGET_TIME" --target-action=promote)
  echo "    PITR target: $TARGET_TIME"
fi
docker run --rm \
  -v /etc/pgbackrest:/etc/pgbackrest:ro \
  -v "$REHEARSAL_DIR:$REHEARSAL_DIR" \
  "$PGB_IMAGE" "${RESTORE_ARGS[@]}"

echo "==> [2/4] Booting a throwaway postgres on the restored data dir"
docker run -d --name "$CONTAINER" \
  -v "$REHEARSAL_DIR/data:/var/lib/postgresql/data" \
  -e POSTGRES_PASSWORD=rehearsal \
  postgres:17-alpine

echo "==> [3/4] Waiting for recovery to finish"
for i in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -U dalio >/dev/null 2>&1; then break; fi
  sleep 2
  [[ $i == 60 ]] && { echo "recovery never finished"; exit 1; }
done

echo "==> [4/4] Verifying restored data (row counts per core table)"
docker exec "$CONTAINER" psql -U dalio -d dalio -Atc "
  select 'clinics: '       || count(*) from clinics
  union all select 'contacts: '     || count(*) from contacts
  union all select 'messages: '     || count(*) from messages
  union all select 'appointments: ' || count(*) from appointments;"

echo "PITR rehearsal PASSED — restored cluster served queries. Log the date in DEPLOYMENT.md §3.3."
