#!/usr/bin/env bash
# Shared helpers for the ops scripts. Sourced, not executed.

# One JSON object per line: log <level> <event> [key=value ...]. Integers stay numbers, everything else is a string.
# Errors go to stderr, the rest to stdout. Never pass a secret here.
json_str() {
  local s=$1
  s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/\\n}; s=${s//$'\r'/}; s=${s//$'\t'/\\t}
  printf '%s' "$s"
}
log() {
  local level=$1 event=$2; shift 2
  local out kv key val
  out="{\"time\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"level\":\"$level\",\"service\":\"orderloop-${OPS_SERVICE:-ops}\",\"event\":\"$event\""
  for kv in "$@"; do
    key=${kv%%=*}; val=${kv#*=}
    if [[ $val =~ ^-?[0-9]+$ ]]; then out+=",\"$key\":$val"; else out+=",\"$key\":\"$(json_str "$val")\""; fi
  done
  out+="}"
  if [[ $level == error ]]; then printf '%s\n' "$out" >&2; else printf '%s\n' "$out"; fi
}

# Value of VAR, or the contents of the file named by VAR_FILE (Docker/Kubernetes secrets style).
env_or_file() {
  local name=$1 file_var="${1}_FILE"
  if [[ -n ${!name:-} ]]; then printf '%s' "${!name}"
  elif [[ -n ${!file_var:-} && -r ${!file_var} ]]; then tr -d '\r\n' < "${!file_var}"
  fi
}

require_cmd() {
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || { log error config_error "message=required command not found: $c"; exit 2; }
  done
}

# Epoch seconds of a backup file's timestamp, from its name orderloop-YYYYmmddTHHMMSSZ.dump.age (UTC).
backup_epoch() {
  local base=${1##*/} ts
  ts=${base#*-}; ts=${ts%%.*}
  date -u -d "${ts:0:4}-${ts:4:2}-${ts:6:2} ${ts:9:2}:${ts:11:2}:${ts:13:2}" +%s
}

# Newest backup (path of the .dump.age) in a directory that also has its manifest; empty if none.
newest_backup() {
  local dir=$1 f
  for f in $(ls -1 "$dir"/orderloop-*.dump.age 2>/dev/null | sort -r); do
    [[ -f ${f%.dump.age}.manifest.json ]] && { printf '%s' "$f"; return 0; }
  done
  return 0
}

# redis_cmd <redis-cli arguments...>: runs redis-cli against REDIS_URL (redis:// or rediss://, optional password). The URL is parsed here
# because `redis-cli -u redis://:password@host` sends an empty user name, which Redis 7 refuses; the password goes in REDISCLI_AUTH, not argv.
redis_cmd() {
  local url=${REDIS_URL:-} re='^(redis|rediss)://(([^:@]*):([^@]*)@)?([^:/@]+)(:([0-9]+))?(/([0-9]+))?$'
  [[ $url =~ $re ]] || { echo "REDIS_URL is not a redis:// or rediss:// URL" >&2; return 2; }
  local args=(-h "${BASH_REMATCH[5]}" -p "${BASH_REMATCH[7]:-6379}" -n "${BASH_REMATCH[9]:-0}")
  [[ ${BASH_REMATCH[1]} == rediss ]] && args+=(--tls)
  if [[ -n ${BASH_REMATCH[4]} ]]; then
    local user=${BASH_REMATCH[3]}
    [[ -n $user ]] && args+=(--user "$user")
    REDISCLI_AUTH=${BASH_REMATCH[4]} redis-cli --no-auth-warning "${args[@]}" "$@"
  else
    redis-cli "${args[@]}" "$@"
  fi
}

# retention_plan <dir> <keep_daily> <keep_weekly> <always_keep_path>: prints "keep <file>" or "delete <file>" for every backup in the
# directory. Kept: the newest backup of each of the last <keep_daily> distinct UTC days that have one, plus the newest of each of the last
# <keep_weekly> distinct ISO weeks, plus <always_keep_path> (the one just written). A file without its manifest is never touched.
retention_plan() {
  local dir=$1 keep_daily=$2 keep_weekly=$3 always=$4 f e day week days=0 weeks=0
  local -A keep=() seen_day=() seen_week=()
  local -a all=()
  mapfile -t all < <(ls -1 "$dir"/orderloop-*.dump.age 2>/dev/null | sort -r)
  for f in "${all[@]}"; do
    [[ -f ${f%.dump.age}.manifest.json ]] || { keep[$f]=1; continue; }
    e=$(backup_epoch "$f")
    day=$(date -u -d "@$e" +%Y%m%d); week=$(date -u -d "@$e" +%G-W%V)
    if [[ -z ${seen_day[$day]:-} && $days -lt $keep_daily ]]; then seen_day[$day]=1; keep[$f]=1; days=$((days + 1)); fi
    if [[ -z ${seen_week[$week]:-} && $weeks -lt $keep_weekly ]]; then seen_week[$week]=1; keep[$f]=1; weeks=$((weeks + 1)); fi
  done
  keep[$always]=1
  for f in "${all[@]}"; do
    if [[ -n ${keep[$f]:-} ]]; then echo "keep $f"; else echo "delete $f"; fi
  done
}
