#!/usr/bin/env bash
# Container healthcheck: healthy while the newest backup (with its manifest) is younger than BACKUP_MAX_AGE_HOURS (default 26).
# A new container with no backup yet is healthy for BACKUP_START_GRACE_MINUTES (default 120) so the first run can finish.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
BACKUP_DIR=${BACKUP_DIR:-/backups}
MAX=$(( ${BACKUP_MAX_AGE_HOURS:-26} * 3600 ))
newest=$(newest_backup "$BACKUP_DIR")
now=$(date -u +%s)
if [[ -z $newest ]]; then
  started=$(cat /tmp/backup-loop.started 2>/dev/null || echo 0)
  if (( now - started < ${BACKUP_START_GRACE_MINUTES:-120} * 60 )); then echo "no backup yet (starting)"; exit 0; fi
  echo "unhealthy: no backup has ever completed"; exit 1
fi
age=$(( now - $(backup_epoch "$newest") ))
if (( age > MAX )); then echo "unhealthy: newest backup $(basename "$newest") is $((age / 3600)) h old (limit $((MAX / 3600)) h)"; exit 1; fi
echo "ok: newest backup $(basename "$newest") is $((age / 60)) min old"
