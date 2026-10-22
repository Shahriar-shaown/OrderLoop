#!/usr/bin/env bash
# The `backup` container's main process: a cron-style loop around backup.sh (no cron daemon, no extra package).
#   BACKUP_AT            UTC time of the daily backup, HH:MM (default 02:30)
#   BACKUP_ON_START      if-missing (default: run at once if no backup is newer than BACKUP_MAX_AGE_HOURS) | always | never
#   BACKUP_RETRY_MINUTES after a failed run, try again after this long (default 30)
#   BACKUP_MAX_AGE_HOURS used by backup-health.sh and by the start-up decision (default 26)
# Also re-records the newest backup's time in Redis at start (Redis is not durable), so the API's backup-age metric survives a restart.
set -Eeuo pipefail
OPS_SERVICE=backup-loop
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_cmd date sleep jq

BACKUP_DIR=${BACKUP_DIR:-/backups}
AT=${BACKUP_AT:-02:30}
RETRY=${BACKUP_RETRY_MINUTES:-30}
MAX_AGE_H=${BACKUP_MAX_AGE_HOURS:-26}
ON_START=${BACKUP_ON_START:-if-missing}
[[ $AT =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || { log error loop.config "message=BACKUP_AT must be HH:MM (UTC)"; exit 2; }
date -u +%s > /tmp/backup-loop.started

STOP=0; SLEEP_PID=""
trap 'STOP=1; [[ -n $SLEEP_PID ]] && kill "$SLEEP_PID" 2>/dev/null; true' TERM INT

report_existing() {
  local newest created
  newest=$(newest_backup "$BACKUP_DIR")
  [[ -n $newest && -n ${REDIS_URL:-} ]] || return 0
  created=$(jq -r .created_at "${newest%.dump.age}.manifest.json" 2>/dev/null || true)
  [[ -n $created && $created != null ]] || return 0
  if [[ $(redis_cmd SET backup:last_success "$created" 2>&1) == OK ]]; then log info loop.reported "newest=$(basename "$newest")"
  else log warn loop.report_failed "message=could not reach Redis"; fi
}

run_backup() {
  local code=0
  "$(dirname "${BASH_SOURCE[0]}")/backup.sh" || code=$?
  return "$code"
}

nap() { # sleep $1 seconds, but wake for a stop signal
  sleep "$1" & SLEEP_PID=$!
  wait "$SLEEP_PID" 2>/dev/null || true
  SLEEP_PID=""
}

seconds_until_next() {
  local now target
  now=$(date -u +%s)
  target=$(date -u -d "$(date -u +%Y-%m-%d) $AT:00" +%s)
  [[ $target -gt $now ]] || target=$((target + 86400))
  echo $((target - now))
}

report_existing
newest=$(newest_backup "$BACKUP_DIR")
age_ok=0
if [[ -n $newest ]]; then
  age_s=$(( $(date -u +%s) - $(backup_epoch "$newest") ))
  [[ $age_s -lt $((MAX_AGE_H * 3600)) ]] && age_ok=1
fi
log info loop.started "at=$AT" "on_start=$ON_START" "retry_minutes=$RETRY" "recent_backup=$age_ok"
if [[ $ON_START == always || ( $ON_START == if-missing && $age_ok -eq 0 ) ]]; then
  until [[ $STOP -eq 1 ]]; do
    run_backup && break
    log error loop.retry "message=backup failed; retrying in $RETRY minutes"
    nap $((RETRY * 60))
  done
fi
while [[ $STOP -eq 0 ]]; do
  wait_s=$(seconds_until_next)
  log info loop.waiting "next_in_seconds=$wait_s"
  while [[ $wait_s -gt 0 && $STOP -eq 0 ]]; do
    step=$(( wait_s > 60 ? 60 : wait_s )); nap "$step"; wait_s=$((wait_s - step))
  done
  [[ $STOP -eq 1 ]] && break
  until [[ $STOP -eq 1 ]]; do
    run_backup && break
    log error loop.retry "message=backup failed; retrying in $RETRY minutes"
    nap $((RETRY * 60))
  done
done
log info loop.stopped
