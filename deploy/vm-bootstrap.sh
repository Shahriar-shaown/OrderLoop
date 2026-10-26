#!/usr/bin/env bash
# Prepares a FRESH Ubuntu 22.04 or 24.04 VM (x86_64 or arm64: for example an Oracle Cloud Always Free instance) to run OrderLoop
# with deploy/docker-compose.yml. Read docs/operations/free-deployment.md first: it explains the free options, what to create by hand
# (the VM, the DNS name) and what this script does. It has NOT been run on a real VM by the project: run it on a machine you can throw
# away, and read the output.
#
#   Step 1, on the VM, as a user that can sudo, from a clone of the repository:
#     ./deploy/vm-bootstrap.sh --domain my-shop.duckdns.org --email you@example.com --owner you@example.com
#   It installs Docker, adds swap if the VM is small, opens ports 80 and 443, checks that app.<domain> and api.<domain> point at this
#   VM, and creates deploy/.env with every secret generated (nothing secret is printed). Then it STOPS: it needs mail settings from you.
#   Step 2: edit deploy/.env (MAIL_FROM, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD), then:
#     ./deploy/vm-bootstrap.sh --start
#   which builds the images, starts the stack, waits for it and checks https://api.<domain>/health/ready.
#
# Options: --domain D   --email E (Let's Encrypt notices)   --owner E (the one email allowed to sign up)   --skip-dns-check
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/.." && pwd)
env_file="$here/.env"
domain="" email="" owner="" start=0 skip_dns=0
while [[ $# -gt 0 ]]; do
  case $1 in
    --domain) shift; domain=${1:?--domain needs a value} ;;
    --email) shift; email=${1:?--email needs a value} ;;
    --owner) shift; owner=${1:?--owner needs a value} ;;
    --start) start=1 ;;
    --skip-dns-check) skip_dns=1 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

compose() { sudo docker compose --env-file "$env_file" -f "$here/docker-compose.yml" "$@"; }

# Sets KEY=VALUE in deploy/.env (replacing the line whether or not it is commented out). The value is never printed.
set_env() {
  local key=$1 value=$2 tmp
  tmp=$(mktemp)
  KEY="$key" VALUE="$value" awk '
    BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VALUE"]; done = 0 }
    $0 ~ "^#? ?" k "=" && !done { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$env_file" > "$tmp"
  cat "$tmp" > "$env_file"; rm -f "$tmp"
}
get_env() { grep -E "^$1=" "$env_file" | head -1 | cut -d= -f2-; }

if [[ $start -eq 1 ]]; then
  [[ -f $env_file ]] || { echo "deploy/.env does not exist: run step 1 first" >&2; exit 1; }
  if grep -Eq '^(SMTP_HOST=smtp\.example\.com|MAIL_FROM=.*@example\.com)' "$env_file"; then
    echo "deploy/.env still has the placeholder mail settings (MAIL_FROM / SMTP_HOST). The server refuses to start in production without real mail." >&2
    exit 3
  fi
  domain=$(get_env DOMAIN)
  echo "==> building the images (the first build takes several minutes on a small VM)"
  compose build
  echo "==> starting"
  compose up -d
  echo "==> waiting for https://api.$domain/health/ready (certificates are issued on the first request: up to a minute or two)"
  for _ in $(seq 1 60); do
    if curl -fsS --max-time 10 "https://api.$domain/health/ready" >/dev/null 2>&1; then
      echo "READY: https://app.$domain  (API: https://api.$domain)"
      echo "Next: sign up with $(get_env REGISTRATION_ALLOWED_EMAILS | cut -d, -f1) (the only email allowed to register)."
      exit 0
    fi
    sleep 5
  done
  echo "not ready after 5 minutes. Look at: sudo docker compose --env-file deploy/.env -f deploy/docker-compose.yml ps / logs" >&2
  exit 1
fi

[[ -n $domain && -n $email && -n $owner ]] || { echo "step 1 needs --domain, --email and --owner (see --help)" >&2; exit 2; }
[[ $domain =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || { echo "--domain must look like my-shop.duckdns.org (no https://, no app. prefix)" >&2; exit 2; }
[[ -r /etc/os-release ]] && . /etc/os-release
[[ ${ID:-} == ubuntu ]] || echo "warning: this script is written for Ubuntu; you are on ${PRETTY_NAME:-an unknown system}"

echo "==> installing Docker, git and openssl (apt)"
sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io docker-compose-v2 git openssl curl ca-certificates iptables-persistent
sudo systemctl enable --now docker

mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if [[ $mem_mb -lt 4000 && $(swapon --show --noheadings | wc -l) -eq 0 ]]; then
  echo "==> only ${mem_mb} MB of memory: adding a 2 GB swap file (building the web app needs it)"
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "==> opening ports 80 and 443 on this VM (the cloud provider's own firewall must allow them too: see the guide)"
for p in 80 443; do
  sudo iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 1 -p tcp --dport "$p" -j ACCEPT
done
sudo netfilter-persistent save >/dev/null 2>&1 || true

if [[ $skip_dns -ne 1 ]]; then
  my_ip=$(curl -fsS --max-time 10 https://api.ipify.org || true)
  for host in "app.$domain" "api.$domain"; do
    got=$(getent ahostsv4 "$host" | awk 'NR==1 {print $1}' || true)
    if [[ -z $my_ip || $got != "$my_ip" ]]; then
      echo "DNS: $host resolves to '${got:-nothing}' but this VM's public address is '${my_ip:-unknown}'." >&2
      echo "Point both names at this VM (a wildcard or two records), wait a minute, then run this step again. --skip-dns-check overrides." >&2
      exit 1
    fi
  done
  echo "==> DNS ok: app.$domain and api.$domain point at this VM ($my_ip)"
fi

echo "==> creating deploy/.env with generated secrets (nothing secret is printed)"
"$here/generate-secrets.sh"
set_env DOMAIN "$domain"
set_env ACME_EMAIL "$email"
set_env REGISTRATION_MODE allowlist
set_env REGISTRATION_ALLOWED_EMAILS "$owner"
set_env META_MODE mock
set_env TIKTOK_MODE mock
set_env NEXT_PUBLIC_PRIVACY_CONTACT "$email"
chmod 600 "$env_file"

cat <<EOF

Step 1 done. The one thing left is mail (sign-up and password-reset emails need a real SMTP server).
A free option: Brevo (300 emails/day) or Gmail with an app password. Edit $env_file and set:
    MAIL_FROM=OrderLoop <you@your-domain>
    SMTP_HOST=...   SMTP_PORT=587   SMTP_USER=...   SMTP_PASSWORD=...
Then run:   ./deploy/vm-bootstrap.sh --start

Keep deploy/backup-age-identity.txt and COURIER_CREDENTIALS_KEY OFF this VM too (they decrypt backups and stored credentials).
Meta and TikTok stay in MOCK mode until you follow "Turning on real Meta and TikTok on the VM" in docs/operations/free-deployment.md.
EOF
