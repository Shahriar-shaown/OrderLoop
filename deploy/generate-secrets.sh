#!/usr/bin/env bash
# Creates deploy/.env from deploy/.env.example with every secret generated. NOTHING SECRET IS PRINTED: the values go straight into
# files created with mode 600 (umask 077); the terminal shows only file names and the NAMES of what was generated.
#
#   ./deploy/generate-secrets.sh [--force] [--env-file PATH]
#
# Generates: the six database/Redis passwords, METRICS_TOKEN, GRAFANA_ADMIN_PASSWORD, META_WEBHOOK_VERIFY_TOKEN, the JWT key pair
# (Ed25519, base64 PEM, the format the API expects), COURIER_CREDENTIALS_KEY (32 random bytes, base64) and an age key pair for backups.
# The age PRIVATE key goes to deploy/backup-age-identity.txt (mode 600): move it OFF this host and keep it safe, together with the
# COURIER_CREDENTIALS_KEY. The .env keeps only the public half, so a stolen backup volume cannot be decrypted from this host.
# It refuses to overwrite an existing file unless --force. You still choose DOMAIN, ACME_EMAIL, SMTP, REGISTRATION_* and META_MODE.
# Needs: openssl, base64, awk; age-keygen (or the orderloop-ops image, built by `docker compose build backup`).
set -euo pipefail
umask 077

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
template="$here/.env.example"
target="$here/.env"
identity="$here/backup-age-identity.txt"
force=0
while [[ $# -gt 0 ]]; do
  case $1 in
    --force) force=1 ;;
    --env-file) shift; target=${1:?--env-file needs a path}; identity="$(dirname "$target")/backup-age-identity.txt" ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 2; }
if [[ -e $target && $force -ne 1 ]]; then echo "$target already exists; refusing to overwrite (use --force)" >&2; exit 1; fi
if [[ -e $identity && $force -ne 1 ]]; then echo "$identity already exists; refusing to overwrite (use --force)" >&2; exit 1; fi

work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
b64() { openssl base64 -A; }
hex() { openssl rand -hex "$1"; }

# --- age key pair for backups -------------------------------------------------------------------------------------------------
if command -v age-keygen >/dev/null 2>&1; then
  age-keygen -o "$work/age.txt" 2>/dev/null
elif command -v docker >/dev/null 2>&1 && docker image inspect "orderloop-ops:${IMAGE_TAG:-local}" >/dev/null 2>&1; then
  docker run --rm --entrypoint age-keygen "orderloop-ops:${IMAGE_TAG:-local}" > "$work/age.txt" 2>/dev/null
else
  echo "age-keygen not found. Install age (brew install age | apt install age) or build the ops image first:" >&2
  echo "  docker compose -f deploy/docker-compose.yml build backup   (needs a deploy/.env: copy .env.example for this)" >&2
  exit 2
fi
recipient=$(grep -o 'age1[a-z0-9]*' "$work/age.txt" | head -n1)
[[ -n $recipient ]] || { echo "could not read the generated age public key" >&2; exit 1; }

# --- values -------------------------------------------------------------------------------------------------------------------
openssl genpkey -algorithm ed25519 -out "$work/jwt.pem" 2>/dev/null
openssl pkey -in "$work/jwt.pem" -pubout -out "$work/jwt.pub" 2>/dev/null
{
  printf 'POSTGRES_PASSWORD=%s\n' "$(hex 24)"
  printf 'DATABASE_APP_PASSWORD=%s\n' "$(hex 24)"
  printf 'DATABASE_MIGRATOR_PASSWORD=%s\n' "$(hex 24)"
  printf 'DATABASE_BACKUP_PASSWORD=%s\n' "$(hex 24)"
  printf 'DATABASE_MONITOR_PASSWORD=%s\n' "$(hex 24)"
  printf 'REDIS_PASSWORD=%s\n' "$(hex 24)"
  printf 'METRICS_TOKEN=%s\n' "$(hex 24)"
  printf 'GRAFANA_ADMIN_PASSWORD=%s\n' "$(hex 16)"
  printf 'META_WEBHOOK_VERIFY_TOKEN=%s\n' "$(hex 24)"
  printf 'JWT_PRIVATE_KEY=%s\n' "$(b64 < "$work/jwt.pem")"
  printf 'JWT_PUBLIC_KEY=%s\n' "$(b64 < "$work/jwt.pub")"
  printf 'COURIER_CREDENTIALS_KEY=%s\n' "$(openssl rand -base64 32 | tr -d '\n')"
  printf 'BACKUP_AGE_RECIPIENT=%s\n' "$recipient"
} > "$work/values"

# Replace each `NAME=CHANGE_ME` line of the template with the generated value; any other line is kept as is.
awk -v valuesfile="$work/values" '
  BEGIN { while ((getline line < valuesfile) > 0) { i = index(line, "="); v[substr(line, 1, i - 1)] = substr(line, i + 1) } }
  /^[A-Z0-9_]+=CHANGE_ME$/ { name = substr($0, 1, index($0, "=") - 1); if (name in v) { print name "=" v[name]; next } }
  { print }
' "$template" > "$work/env"
if grep -q '=CHANGE_ME$' "$work/env"; then
  echo "warning: these still need a value from you: $(grep '=CHANGE_ME$' "$work/env" | cut -d= -f1 | tr '\n' ' ')" >&2
fi

install -m 600 "$work/env" "$target"
install -m 600 "$work/age.txt" "$identity"
echo "wrote $target (mode 600): generated $(wc -l < "$work/values" | tr -d ' ') values, none shown here:"
cut -d= -f1 "$work/values" | sed 's/^/  - /'
echo "wrote $identity (mode 600): the backup PRIVATE key. Move it off this host; without it no backup can be restored."
echo "next: edit $target (DOMAIN, ACME_EMAIL, SMTP_*, REGISTRATION_ALLOWED_EMAILS, META_MODE), then back up COURIER_CREDENTIALS_KEY separately."
