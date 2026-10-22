#!/usr/bin/env bash
# Encrypted, verifiable PostgreSQL backup. One run = one dump.
#
#   pg_dump -Fc (custom format) as a role that BYPASSES row-level security (default app_backup: BYPASSRLS + pg_read_all_data).
#   Why: every tenant table has FORCE ROW LEVEL SECURITY, so a dump taken as the table owner, or with --enable-row-security, is
#   silently EMPTY of tenant data (docs/operations/backup-and-restore.md). This script refuses to run as a role that would
#   produce such a dump.
#   The dump is read from ONE snapshot (pg_export_snapshot) together with the per-table row counts in the manifest, so the drill
#   can compare them exactly even while the system is being written to.
#   Encrypted with age to a PUBLIC recipient key: the backup host holds no key that can decrypt its own backups.
#
# Output in BACKUP_DIR:  orderloop-<UTC timestamp>.dump.age  and  orderloop-<UTC timestamp>.manifest.json
# Exit codes: 0 ok | 1 failed | 2 configuration | 3 dump is fine but the off-site upload failed (local copy kept).
# Logs one JSON object per line; on failure `backup.failed` goes to stderr.
#
# Environment (see deploy/.env.example):
#   PGHOST (postgres) PGPORT (5432) PGDATABASE (orderloop)
#   BACKUP_DB_USER (app_backup) BACKUP_DB_PASSWORD | BACKUP_DB_PASSWORD_FILE
#   BACKUP_AGE_RECIPIENT  age public key(s), space or comma separated (age1...)   [or BACKUP_AGE_RECIPIENTS_FILE]
#   BACKUP_DIR (/backups) BACKUP_KEEP_DAILY (7) BACKUP_KEEP_WEEKLY (4)
#   BACKUP_RCLONE_REMOTE  optional, e.g. "offsite:my-bucket/orderloop" (S3-compatible via RCLONE_CONFIG_OFFSITE_* variables)
#   REDIS_URL             optional: records the success time for the API's /metrics (orderloop_backup_last_success_...)
set -Eeuo pipefail
OPS_SERVICE=backup
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

STEP=init
STARTED=$(date +%s)
WORK=""
OUT_FILE=""
fail() { log error backup.failed "step=$STEP" "message=$1" "seconds=$(( $(date +%s) - STARTED ))"; cleanup; exit "${2:-1}"; }
cleanup() {
  [[ -n $WORK ]] && rm -rf "$WORK"
  [[ -n $OUT_FILE ]] && rm -f "$OUT_FILE.partial"
  if [[ -n ${PSQL_PID:-} ]]; then kill "$PSQL_PID" 2>/dev/null || true; fi
}
trap 'fail "unexpected error at line $LINENO"' ERR
trap 'fail "interrupted"' INT TERM

require_cmd pg_dump psql age sha256sum jq date
export PGHOST=${PGHOST:-postgres} PGPORT=${PGPORT:-5432} PGDATABASE=${PGDATABASE:-orderloop}
export PGUSER=${BACKUP_DB_USER:-app_backup} PGCONNECT_TIMEOUT=10
PGPASSWORD=$(env_or_file BACKUP_DB_PASSWORD); export PGPASSWORD
[[ -n $PGPASSWORD ]] || { STEP=config; fail "BACKUP_DB_PASSWORD (or _FILE) is not set" 2; }

BACKUP_DIR=${BACKUP_DIR:-/backups}
KEEP_DAILY=${BACKUP_KEEP_DAILY:-7}
KEEP_WEEKLY=${BACKUP_KEEP_WEEKLY:-4}
[[ $KEEP_DAILY =~ ^[0-9]+$ && $KEEP_WEEKLY =~ ^[0-9]+$ && $KEEP_DAILY -ge 1 ]] || { STEP=config; fail "BACKUP_KEEP_DAILY must be >= 1 and BACKUP_KEEP_WEEKLY a number" 2; }

RECIPIENTS=${BACKUP_AGE_RECIPIENT:-}
RECIPIENT_ARGS=()
if [[ -n ${BACKUP_AGE_RECIPIENTS_FILE:-} ]]; then
  [[ -r $BACKUP_AGE_RECIPIENTS_FILE ]] || { STEP=config; fail "BACKUP_AGE_RECIPIENTS_FILE is not readable" 2; }
  RECIPIENT_ARGS=(-R "$BACKUP_AGE_RECIPIENTS_FILE")
else
  for r in ${RECIPIENTS//,/ }; do
    [[ $r =~ ^age1[a-z0-9]{50,}$ ]] || { STEP=config; fail "BACKUP_AGE_RECIPIENT is not an age public key (age1...)" 2; }
    RECIPIENT_ARGS+=(-r "$r")
  done
fi
[[ ${#RECIPIENT_ARGS[@]} -gt 0 ]] || { STEP=config; fail "BACKUP_AGE_RECIPIENT is not set: refusing to write an unencrypted backup" 2; }
[[ -d $BACKUP_DIR && -w $BACKUP_DIR ]] || { STEP=config; fail "BACKUP_DIR $BACKUP_DIR is not a writable directory" 2; }

WORK=$(mktemp -d); chmod 700 "$WORK"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT_FILE="$BACKUP_DIR/orderloop-$STAMP.dump.age"
MANIFEST="$BACKUP_DIR/orderloop-$STAMP.manifest.json"

# ---- 1. the role must bypass row-level security -------------------------------------------------------------------------
STEP=preflight
BYPASS=$(psql -X -q -A -t -v ON_ERROR_STOP=1 -c "SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user" 2>"$WORK/err") \
  || fail "cannot connect to PostgreSQL as $PGUSER: $(head -c 300 "$WORK/err")"
[[ $BYPASS == t ]] || fail "role $PGUSER does not bypass row-level security: a dump by it would silently omit every tenant's rows. Use app_backup (BYPASSRLS) or a superuser."

# ---- 2. one snapshot for the row counts and the dump --------------------------------------------------------------------
STEP=snapshot
coproc PSQL { psql -X -q -A -t -v ON_ERROR_STOP=1 2>"$WORK/psql.err"; }
PSQL_PID=$PSQL_PID
send() { printf '%s\n' "$1" >&"${PSQL[1]}"; }
# Reads lines until the sentinel; the lines go to the file named by $1.
read_until_end() {
  local out=$1 line
  : > "$out"
  while IFS= read -r -t 600 line <&"${PSQL[0]}"; do
    [[ $line == '--END--' ]] && return 0
    printf '%s\n' "$line" >> "$out"
  done
  fail "PostgreSQL stopped answering: $(head -c 300 "$WORK/psql.err" 2>/dev/null)"
}
send "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;"
send "SELECT pg_export_snapshot();"
send "SELECT '--END--';"
read_until_end "$WORK/snapshot"
SNAPSHOT=$(head -n1 "$WORK/snapshot")
[[ $SNAPSHOT =~ ^[0-9A-F-]+$ ]] || fail "could not export a snapshot"

STEP=inventory
send "SELECT c.relname || '=' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname;"
send "SELECT '--END--';"
read_until_end "$WORK/counts"
[[ -s $WORK/counts ]] || fail "the database has no tables in schema public: nothing to back up (was the migrate job run?)"
send "SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prosecdef ORDER BY 1;"
send "SELECT '--END--';"
read_until_end "$WORK/definers"
send "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity;"
send "SELECT '--END--';"
read_until_end "$WORK/forced"
send "SELECT coalesce(max(migration_name), '') || '|' || count(*) FILTER (WHERE finished_at IS NOT NULL) || '|' || count(*) FILTER (WHERE finished_at IS NULL) FROM _prisma_migrations;"
send "SELECT '--END--';"
read_until_end "$WORK/migrations"
IFS='|' read -r MIGRATION_VERSION MIGRATIONS_APPLIED MIGRATIONS_UNFINISHED < "$WORK/migrations"
[[ -n $MIGRATION_VERSION ]] || fail "_prisma_migrations is empty: the schema was not created by the migrate job"
[[ $MIGRATIONS_UNFINISHED == 0 ]] || fail "$MIGRATIONS_UNFINISHED migration(s) are unfinished: the database is in a half-migrated state"
SERVER_VERSION=$(psql -X -q -A -t -c "SHOW server_version" | cut -d' ' -f1)

# ---- 3. dump -> age -----------------------------------------------------------------------------------------------------
STEP=dump
set +e; trap - ERR   # the pipeline's failure is handled below, with a specific message
pg_dump --format=custom --compress=6 --no-password --snapshot="$SNAPSHOT" --lock-wait-timeout=60000 2>"$WORK/dump.err" \
  | age "${RECIPIENT_ARGS[@]}" -o "$OUT_FILE.partial" 2>"$WORK/age.err"
STATUSES=("${PIPESTATUS[@]}")
set -e; trap 'fail "unexpected error at line $LINENO"' ERR
[[ ${STATUSES[0]} -eq 0 ]] || fail "pg_dump failed: $(head -c 400 "$WORK/dump.err")"
[[ ${STATUSES[1]} -eq 0 ]] || fail "age failed: $(head -c 400 "$WORK/age.err")"
send "COMMIT;"; send '\q'
wait "$PSQL_PID" 2>/dev/null || true; PSQL_PID=""
BYTES=$(stat -c %s "$OUT_FILE.partial")
[[ $BYTES -gt 2048 ]] || fail "the dump is implausibly small ($BYTES bytes)"
mv "$OUT_FILE.partial" "$OUT_FILE"
chmod 600 "$OUT_FILE"

# ---- 4. manifest --------------------------------------------------------------------------------------------------------
STEP=manifest
SHA256=$(sha256sum "$OUT_FILE" | cut -d' ' -f1)
RECIPIENT_FP=$(printf '%s' "${RECIPIENTS:-file}" | sha256sum | cut -c1-16)
jq -n \
  --arg created "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg file "$(basename "$OUT_FILE")" \
  --arg sha "$SHA256" \
  --arg db "$PGDATABASE" \
  --arg migration "$MIGRATION_VERSION" \
  --argjson applied "$MIGRATIONS_APPLIED" \
  --arg server "$SERVER_VERSION" \
  --arg dumpver "$(pg_dump --version | awk '{print $3}')" \
  --arg fp "$RECIPIENT_FP" \
  --argjson bytes "$BYTES" \
  --argjson forced "$(cat "$WORK/forced")" \
  --rawfile counts "$WORK/counts" \
  --rawfile definers "$WORK/definers" \
  '{
    manifest_version: 1,
    created_at: $created,
    database: $db,
    dump_file: $file,
    dump_bytes: $bytes,
    sha256: $sha,
    encryption: "age",
    recipients_fingerprint: $fp,
    format: "pg_dump custom (-Fc)",
    pg_dump_version: $dumpver,
    server_version: $server,
    migration_version: $migration,
    migrations_applied: $applied,
    rls_forced_tables: $forced,
    definer_functions: ($definers | split("\n") | map(select(length > 0))),
    tables: ($counts | split("\n") | map(select(length > 0) | split("=") | {key: .[0], value: (.[1] | tonumber)}) | from_entries)
  }' > "$MANIFEST.partial"
mv "$MANIFEST.partial" "$MANIFEST"; chmod 600 "$MANIFEST"
TABLES=$(jq '.tables | length' "$MANIFEST")
ROWS=$(jq '[.tables[]] | add' "$MANIFEST")

# ---- 5. optional off-site copy ------------------------------------------------------------------------------------------
UPLOAD=none
if [[ -n ${BACKUP_RCLONE_REMOTE:-} ]]; then
  STEP=upload
  require_cmd rclone
  if rclone copyto "$OUT_FILE" "$BACKUP_RCLONE_REMOTE/$(basename "$OUT_FILE")" 2>"$WORK/rclone.err" \
     && rclone copyto "$MANIFEST" "$BACKUP_RCLONE_REMOTE/$(basename "$MANIFEST")" 2>>"$WORK/rclone.err"; then
    UPLOAD=ok
  else
    log error backup.failed "step=upload" "message=off-site upload failed; the local copy $(basename "$OUT_FILE") is kept: $(head -c 300 "$WORK/rclone.err")" "seconds=$(( $(date +%s) - STARTED ))"
    cleanup; exit 3
  fi
fi

# ---- 6. retention: newest per day for KEEP_DAILY days, newest per ISO week for KEEP_WEEKLY weeks --------------------------
STEP=retention
REMOVED=0; KEPT=0
while IFS=' ' read -r verdict f; do
  if [[ $verdict == delete ]]; then rm -f "$f" "${f%.dump.age}.manifest.json"; REMOVED=$((REMOVED + 1)); else KEPT=$((KEPT + 1)); fi
done < <(retention_plan "$BACKUP_DIR" "$KEEP_DAILY" "$KEEP_WEEKLY" "$OUT_FILE")

# ---- 7. tell the API (best effort) --------------------------------------------------------------------------------------
STEP=report
if [[ -n ${REDIS_URL:-} ]] && command -v redis-cli >/dev/null 2>&1; then
  # redis-cli exits 0 even when Redis answers with an error, so the reply itself is checked.
  [[ $(redis_cmd SET backup:last_success "$(date -u +%Y-%m-%dT%H:%M:%SZ)" 2>&1) == OK ]] \
    || log warn backup.report_failed "message=could not record the backup time in Redis (the backup itself succeeded)"
fi

SECONDS_TOTAL=$(( $(date +%s) - STARTED ))
log info backup.completed "file=$(basename "$OUT_FILE")" "bytes=$BYTES" "sha256=$SHA256" "migration=$MIGRATION_VERSION" \
  "tables=$TABLES" "rows=$ROWS" "upload=$UPLOAD" "removed_old=$REMOVED" "kept=$KEPT" "seconds=$SECONDS_TOTAL"
cleanup
exit 0
