#!/usr/bin/env bash
# Restore drill: proves that the newest backup can actually be restored and that what comes back is the same data, isolated
# the same way. It never touches the live database: it restores into a scratch database on the same server and drops it again.
#
# Steps: check the file against its manifest -> decrypt with the age identity (streamed into pg_restore, so no plaintext file) ->
# restore into a scratch database -> verify:
#   1. migrations         : the restored _prisma_migrations ends at the manifest's version, none unfinished (the
#                           `prisma migrate status` equivalent: the schema the application expects is the schema restored)
#   2. row counts         : EVERY table's count equals the manifest (taken from the same snapshot as the dump), no table missing or extra
#   3. forced RLS         : every table with a tenant_id column has row-level security enabled AND forced; the count equals the manifest's
#   4. definer functions  : the SECURITY DEFINER functions equal the manifest's list and every one pins its search_path
#   5. tenant isolation   : as app_user (the application's role): with no tenant context a tenant table is EMPTY; with a tenant's
#                           context exactly that tenant's rows are visible; with another tenant's id nothing is
# Prints PASS or FAIL per check and `RESULT: PASS|FAIL`. Exit 0 only if every check passed. Always drops the scratch database.
#
# Usage: restore-drill.sh [path/to/orderloop-<stamp>.dump.age]      (default: the newest backup in BACKUP_DIR)
# Environment:
#   BACKUP_DIR (/backups)
#   BACKUP_AGE_IDENTITY_FILE   the age PRIVATE key file (never stored on the backup host; mount it for the drill)
#   PGHOST (postgres) PGPORT (5432) PGDATABASE (orderloop; only used to name the scratch database)
#   DRILL_ADMIN_USER (orderloop) DRILL_ADMIN_PASSWORD | _FILE      a superuser: creates and drops the scratch database
#   DRILL_APP_USER (app_user)    DRILL_APP_USER_PASSWORD | _FILE   the runtime role, for the isolation probe
#   DRILL_OWNER (app_migrator)   the role that owns the restored objects (must exist: created by the migrate job)
#   DRILL_ALLOW_EMPTY=1          accept a backup with no tenant rows at all (default: that FAILS, it is what a silently empty dump looks like)
set -Eeuo pipefail
OPS_SERVICE=restore-drill
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd psql pg_restore age jq sha256sum date

BACKUP_DIR=${BACKUP_DIR:-/backups}
export PGHOST=${PGHOST:-postgres} PGPORT=${PGPORT:-5432} PGCONNECT_TIMEOUT=10
SOURCE_DB=${PGDATABASE:-orderloop}
ADMIN_USER=${DRILL_ADMIN_USER:-orderloop}
ADMIN_PASSWORD=$(env_or_file DRILL_ADMIN_PASSWORD)
APP_USER=${DRILL_APP_USER:-app_user}
APP_PASSWORD=$(env_or_file DRILL_APP_USER_PASSWORD)
OWNER=${DRILL_OWNER:-app_migrator}
IDENTITY=${BACKUP_AGE_IDENTITY_FILE:-}
[[ -n $ADMIN_PASSWORD ]] || { log error drill.config "message=DRILL_ADMIN_PASSWORD (or _FILE) is not set"; exit 2; }
[[ -n $IDENTITY && -r $IDENTITY ]] || { log error drill.config "message=BACKUP_AGE_IDENTITY_FILE is not set or not readable: the drill needs the age private key"; exit 2; }

TMP=$(mktemp -d); chmod 700 "$TMP"
SCRATCH="${SOURCE_DB}_drill_$(date -u +%Y%m%d%H%M%S)"
CREATED=0
FAILS=0
admin() { PGUSER=$ADMIN_USER PGPASSWORD=$ADMIN_PASSWORD psql -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
pass() { printf '[PASS] %-22s %s\n' "$1" "$2"; log info drill.check "check=$1" "status=PASS"; }
failcheck() { printf '[FAIL] %-22s %s\n' "$1" "$2"; log error drill.check "check=$1" "status=FAIL" "detail=$2"; FAILS=$((FAILS + 1)); }
cleanup() {
  if [[ $CREATED -eq 1 ]]; then
    admin -d postgres -c "DROP DATABASE IF EXISTS \"$SCRATCH\" WITH (FORCE)" >/dev/null 2>&1 \
      && printf 'scratch database %s dropped\n' "$SCRATCH" \
      || printf 'WARNING: could not drop scratch database %s: drop it by hand\n' "$SCRATCH" >&2
  fi
  rm -rf "$TMP"
}
finish() {
  cleanup
  if [[ $FAILS -eq 0 ]]; then printf '\nRESULT: PASS\n'; log info drill.result "result=PASS"; exit 0; fi
  printf '\nRESULT: FAIL (%s check(s) failed)\n' "$FAILS"; log error drill.result "result=FAIL" "failed=$FAILS"; exit 1
}
trap 'failcheck "unexpected" "error at line $LINENO"; finish' ERR
trap 'failcheck "interrupted" "signal received"; finish' INT TERM

# ---- locate and verify the file -----------------------------------------------------------------------------------------
FILE=${1:-$(newest_backup "$BACKUP_DIR")}
[[ -n $FILE && -f $FILE ]] || { failcheck "backup file" "no backup found in $BACKUP_DIR"; finish; }
MANIFEST="${FILE%.dump.age}.manifest.json"
[[ -f $MANIFEST ]] || { failcheck "manifest" "$(basename "$MANIFEST") is missing"; finish; }
printf 'drill: %s  (backup made %s)\n' "$(basename "$FILE")" "$(jq -r .created_at "$MANIFEST")"
EXPECTED_SHA=$(jq -r .sha256 "$MANIFEST")
ACTUAL_SHA=$(sha256sum "$FILE" | cut -d' ' -f1)
if [[ $EXPECTED_SHA == "$ACTUAL_SHA" ]]; then pass "file checksum" "sha256 matches the manifest ($(stat -c %s "$FILE") bytes)"
else failcheck "file checksum" "sha256 differs from the manifest: the file is corrupt or was altered"; finish; fi

# ---- restore into a scratch database ------------------------------------------------------------------------------------
admin -d postgres -c "CREATE DATABASE \"$SCRATCH\" OWNER \"$OWNER\"" 2>"$TMP/err" || { failcheck "scratch database" "$(head -c 300 "$TMP/err")"; finish; }
CREATED=1
admin -d postgres -c "REVOKE ALL ON DATABASE \"$SCRATCH\" FROM PUBLIC" -c "GRANT CONNECT ON DATABASE \"$SCRATCH\" TO \"$APP_USER\"" >/dev/null
set +e; trap - ERR   # a failing pipeline is reported below as a named check, not as a generic error
age -d -i "$IDENTITY" "$FILE" 2>"$TMP/age.err" \
  | PGUSER=$ADMIN_USER PGPASSWORD=$ADMIN_PASSWORD pg_restore --exit-on-error --no-password -d "$SCRATCH" 2>"$TMP/restore.err"
STATUSES=("${PIPESTATUS[@]}")
set -e; trap 'failcheck "unexpected" "error at line $LINENO"; finish' ERR
if [[ ${STATUSES[0]} -ne 0 ]]; then failcheck "decrypt" "age could not decrypt the backup (wrong key, or the file is corrupt): $(head -c 300 "$TMP/age.err")"; finish; fi
if [[ ${STATUSES[1]} -ne 0 ]]; then failcheck "restore" "pg_restore failed: $(head -c 400 "$TMP/restore.err")"; finish; fi
pass "decrypt + restore" "restored into scratch database $SCRATCH"
q() { admin -d "$SCRATCH" "$@"; }

# ---- 1. migrations ------------------------------------------------------------------------------------------------------
IFS='|' read -r R_VERSION R_APPLIED R_UNFINISHED < <(q -c "SELECT coalesce(max(migration_name), '') || '|' || count(*) FILTER (WHERE finished_at IS NOT NULL) || '|' || count(*) FILTER (WHERE finished_at IS NULL) FROM _prisma_migrations")
M_VERSION=$(jq -r .migration_version "$MANIFEST"); M_APPLIED=$(jq -r .migrations_applied "$MANIFEST")
if [[ $R_VERSION == "$M_VERSION" && $R_APPLIED == "$M_APPLIED" && $R_UNFINISHED == 0 ]]; then
  pass "migrations" "$R_APPLIED applied, latest $R_VERSION, none unfinished"
else failcheck "migrations" "restored: $R_VERSION ($R_APPLIED applied, $R_UNFINISHED unfinished); manifest: $M_VERSION ($M_APPLIED applied)"; fi

# ---- 2. row counts ------------------------------------------------------------------------------------------------------
q -c "SELECT c.relname || '=' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname" | LC_ALL=C sort > "$TMP/counts.restored"
jq -r '.tables | to_entries[] | "\(.key)=\(.value)"' "$MANIFEST" | LC_ALL=C sort > "$TMP/counts.manifest"
TABLES=$(wc -l < "$TMP/counts.manifest" | tr -d ' ')
ROWS=$(jq '[.tables[]] | add' "$MANIFEST")
if diff -u "$TMP/counts.manifest" "$TMP/counts.restored" > "$TMP/counts.diff"; then
  pass "row counts" "all $TABLES tables match the manifest ($ROWS rows)"
else failcheck "row counts" "differences (- manifest, + restored): $(grep '^[-+][^-+]' "$TMP/counts.diff" | head -8 | tr '\n' ' ')"; fi

# ---- 3. forced row-level security ---------------------------------------------------------------------------------------
UNPROTECTED=$(q -c "SELECT string_agg(c.relname, ',' ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped) AND NOT (c.relrowsecurity AND c.relforcerowsecurity)")
FORCED=$(q -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity")
TENANT_TABLES=$(q -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)")
M_FORCED=$(jq -r .rls_forced_tables "$MANIFEST")
if [[ -z $UNPROTECTED && $FORCED == "$M_FORCED" && $TENANT_TABLES -gt 0 ]]; then
  pass "forced RLS" "$FORCED tables with forced row-level security (manifest: $M_FORCED); all $TENANT_TABLES tenant tables are covered"
else failcheck "forced RLS" "forced=$FORCED manifest=$M_FORCED tenant tables=$TENANT_TABLES without forced RLS: ${UNPROTECTED:-none}"; fi

# ---- 4. SECURITY DEFINER functions --------------------------------------------------------------------------------------
q -c "SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prosecdef ORDER BY 1" > "$TMP/definers.restored"
jq -r '.definer_functions[]' "$MANIFEST" > "$TMP/definers.manifest"
UNPINNED=$(q -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prosecdef AND NOT coalesce(p.proconfig::text ILIKE '%search_path=%', false)")
N_DEF=$(wc -l < "$TMP/definers.restored" | tr -d ' ')
if diff -q "$TMP/definers.manifest" "$TMP/definers.restored" >/dev/null && [[ $UNPINNED == 0 ]]; then
  pass "definer functions" "$N_DEF SECURITY DEFINER functions, same as the manifest, all with a pinned search_path"
else failcheck "definer functions" "restored $N_DEF, manifest $(wc -l < "$TMP/definers.manifest" | tr -d ' '), without search_path: $UNPINNED"; fi

# ---- 5. tenant isolation as the application's role ----------------------------------------------------------------------
if [[ -z $APP_PASSWORD ]]; then
  failcheck "tenant isolation" "DRILL_APP_USER_PASSWORD is not set: cannot connect as $APP_USER"
else
  app() { PGUSER=$APP_USER PGPASSWORD=$APP_PASSWORD psql -X -q -A -t -v ON_ERROR_STOP=1 -d "$SCRATCH" "$@"; }
  # The tenant table with the most rows (superuser view = ground truth).
  BEST=""; BEST_N=0
  for t in $(q -c "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped) ORDER BY 1"); do
    n=$(grep "^$t=" "$TMP/counts.restored" | cut -d= -f2)
    if [[ ${n:-0} -gt $BEST_N ]]; then BEST=$t; BEST_N=$n; fi
  done
  if [[ -z $BEST ]]; then
    if [[ ${DRILL_ALLOW_EMPTY:-0} == 1 ]]; then pass "tenant isolation" "SKIPPED: no tenant rows in this backup (DRILL_ALLOW_EMPTY=1)"
    else failcheck "tenant isolation" "the backup holds NO tenant rows: either the system is empty or the dump omitted them (row-level security). Set DRILL_ALLOW_EMPTY=1 only for a system that really has no data yet"; fi
  else
    TID=$(q -c "SELECT tenant_id FROM \"$BEST\" GROUP BY tenant_id ORDER BY count(*) DESC, tenant_id LIMIT 1")
    TOWN=$(q -c "SELECT count(*) FROM \"$BEST\" WHERE tenant_id = '$TID'")
    OTHER=$(q -c "SELECT gen_random_uuid()")
    NOCTX=$(app -c "SELECT count(*) FROM \"$BEST\"") || NOCTX="error"
    OWNCTX=$(app -c "BEGIN" -c "SELECT set_config('app.tenant_id', '$TID', true)" -c "SELECT count(*) FROM \"$BEST\"" -c "COMMIT" | tail -n1) || OWNCTX="error"
    OTHERCTX=$(app -c "BEGIN" -c "SELECT set_config('app.tenant_id', '$OTHER', true)" -c "SELECT count(*) FROM \"$BEST\"" -c "COMMIT" | tail -n1) || OTHERCTX="error"
    N_TENANTS=$(q -c "SELECT count(DISTINCT tenant_id) FROM \"$BEST\"")
    if [[ $NOCTX == 0 && $OWNCTX == "$TOWN" && $OTHERCTX == 0 ]]; then
      pass "tenant isolation" "as $APP_USER on $BEST ($BEST_N rows, $N_TENANTS tenant(s)): no context -> $NOCTX, own tenant -> $OWNCTX of $TOWN, another tenant -> $OTHERCTX"
    else failcheck "tenant isolation" "as $APP_USER on $BEST: no context -> $NOCTX (want 0), own tenant -> $OWNCTX (want $TOWN), another tenant -> $OTHERCTX (want 0)"; fi
  fi
fi

finish
