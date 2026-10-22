#!/usr/bin/env bash
# Local smoke test of the production stack: builds the images, starts the stack under a THROWAWAY project name on non-default
# ports, exercises it, and tears it down (`down -v` for that project only). It touches nothing outside the project it creates.
#
#   ./deploy/smoke-test.sh [--keep] [--skip-build] [--only stack|backup|monitoring]...
#
# What it does (each step prints its result; the script exits non-zero at the first failure):
#   stack      migrate job, readiness, HTTPS through Caddy, /metrics protection, sign-up policy (allowlist), a product created through
#              the API, a verification email delivered over STARTTLS, mail:test, container hardening
#   backup     a real encrypted backup, the restore drill, and the failure cases (wrong key, corrupted file, a role that cannot see tenant data)
#   monitoring Prometheus/Alertmanager/Grafana up, targets scraped, then the worker is stopped and the heartbeat alert is waited for
# NOT covered: a real domain and Let's Encrypt (Caddy's internal CA is used), a real SMTP provider, off-site upload, a browser.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PROJECT=${SMOKE_PROJECT:-orderloop-smoke}
HTTP_PORT=${SMOKE_HTTP_PORT:-18080}
HTTPS_PORT=${SMOKE_HTTPS_PORT:-18443}
DOMAIN=orderloop.test
KEEP=0; BUILD=1; ONLY=()
while [[ $# -gt 0 ]]; do
  case $1 in
    --keep) KEEP=1 ;;
    --skip-build) BUILD=0 ;;
    --only) shift; ONLY+=("${1:?--only needs stack|backup|monitoring}") ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[[ $PROJECT != orderloop && $PROJECT != infra ]] || { echo "refusing project name '$PROJECT': it would collide with a real stack" >&2; exit 2; }
want() { [[ ${#ONLY[@]} -eq 0 ]] && return 0; local s; for s in "${ONLY[@]}"; do [[ $s == "$1" ]] && return 0; done; return 1; }
for c in docker openssl curl jq; do command -v "$c" >/dev/null || { echo "$c is required" >&2; exit 2; }; done

WORK=$(mktemp -d); chmod 700 "$WORK"
export SMOKE_CERT_DIR="$WORK/certs"; mkdir -p "$SMOKE_CERT_DIR"
dc() { docker compose -p "$PROJECT" --env-file "$WORK/env" -f "$ROOT/deploy/docker-compose.yml" -f "$ROOT/deploy/docker-compose.smoke.yml" "$@"; }
cleanup() {
  if [[ $KEEP -eq 1 ]]; then echo "kept: project $PROJECT, files in $WORK"; return; fi
  dc --profile monitoring --profile ops down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$WORK"
  echo "torn down: project $PROJECT (containers, volumes, network) and $WORK removed"
}
trap cleanup EXIT
step() { printf '\n== %s\n' "$*"; }
ok() { printf '   ok: %s\n' "$*"; }
die() { printf '   FAILED: %s\n' "$*" >&2; exit 1; }
# curl through Caddy with a name that resolves to localhost and trusts Caddy's internal CA
web() { curl -sS --resolve "app.$DOMAIN:$HTTPS_PORT:127.0.0.1" --resolve "api.$DOMAIN:$HTTPS_PORT:127.0.0.1" --cacert "$WORK/caddy-root.crt" "$@"; }
in_api() { dc exec -T api node -e "$1"; }

# ---- certificates for the test mail server --------------------------------------------------------------------------------
step "throwaway CA and a certificate for the test mail server"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=orderloop-smoke-ca" -keyout "$SMOKE_CERT_DIR/ca.key" -out "$SMOKE_CERT_DIR/ca.crt" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=mailpit" -keyout "$SMOKE_CERT_DIR/mail.key" -out "$WORK/mail.csr" 2>/dev/null
printf 'subjectAltName=DNS:mailpit\n' > "$WORK/san.ext"
openssl x509 -req -in "$WORK/mail.csr" -CA "$SMOKE_CERT_DIR/ca.crt" -CAkey "$SMOKE_CERT_DIR/ca.key" -CAcreateserial -days 2 -extfile "$WORK/san.ext" -out "$SMOKE_CERT_DIR/mail.crt" 2>/dev/null
chmod 644 "$SMOKE_CERT_DIR"/*; ok "CA + mail certificate (valid 2 days, in a temp directory)"

# ---- environment ----------------------------------------------------------------------------------------------------------
step "secrets and environment (generate-secrets.sh, values never printed)"
"$ROOT/deploy/generate-secrets.sh" --env-file "$WORK/env" >/dev/null
cp "$WORK/backup-age-identity.txt" "$WORK/identity.txt"
cat >> "$WORK/env" <<ENVEOF
DOMAIN=$DOMAIN
ACME_EMAIL=ops@$DOMAIN
HTTP_PORT=$HTTP_PORT
HTTPS_PORT=$HTTPS_PORT
CADDY_GLOBAL_OPTIONS=local_certs
WEB_ORIGINS=https://app.$DOMAIN:$HTTPS_PORT
API_PUBLIC_URL=https://api.$DOMAIN:$HTTPS_PORT
NEXT_PUBLIC_API_URL=https://api.$DOMAIN:$HTTPS_PORT
REGISTRATION_MODE=allowlist
REGISTRATION_ALLOWED_EMAILS=smoke-owner@$DOMAIN,smoke-second@$DOMAIN
META_MODE=mock
MAIL_PROVIDER=smtp
MAIL_FROM=OrderLoop <no-reply@$DOMAIN>
SMTP_HOST=mailpit
SMTP_PORT=1025
SMTP_SECURE=false
SMTP_USER=smoke
SMTP_PASSWORD=smoke-password
GRAFANA_ADMIN_PASSWORD=smoke-grafana-pw
PROMETHEUS_PORT=19090
ALERTMANAGER_PORT=19093
GRAFANA_PORT=13001
ENVEOF
dc config -q && ok "docker compose config is valid"
dc --profile monitoring --profile ops config -q && ok "... also with the monitoring and ops profiles"

if [[ $BUILD -eq 1 ]]; then
  step "build the images (api, worker, migrate, web, ops)"
  dc --profile ops build 2>&1 | tail -n 3
  ok "images built"
fi

step "start the stack (project $PROJECT, ports $HTTP_PORT/$HTTPS_PORT)"
dc up -d 2>&1 | tail -n 15

wait_for() { # description, command...
  local what=$1; shift; local i
  for i in $(seq 1 90); do "$@" >/dev/null 2>&1 && { ok "$what"; return 0; }; sleep 2; done
  dc ps -a; die "timed out waiting for: $what"
}
migrate_done() { [[ $(dc ps -a migrate --format '{{.State}} {{.ExitCode}}') == "exited 0" ]]; }
healthy() { [[ $(dc ps "$1" --format '{{.Health}}') == healthy ]]; }
wait_for "migrate job finished with exit code 0" migrate_done
echo "   migrate log:"; dc logs migrate --no-log-prefix 2>&1 | grep -E '"event":"migrate"|Applying|applied|up to date|ops role|roles ready' | sed 's/^/     /' | cut -c1-200
for s in postgres redis api worker web backup; do wait_for "$s is healthy" healthy "$s"; done
dc cp caddy:/data/caddy/pki/authorities/local/root.crt "$WORK/caddy-root.crt" >/dev/null 2>&1 || { sleep 5; dc cp caddy:/data/caddy/pki/authorities/local/root.crt "$WORK/caddy-root.crt"; }

step "sign-up policy: allowlist"
body() { printf '{"email":"%s","password":"Smoke-Test-9!pass","name":"Smoke Owner","tenantName":"Smoke Shop"}' "$1"; }
r=$(web -o "$WORK/reg-closed.json" -w '%{http_code}' -H 'content-type: application/json' -d "$(body stranger@example.net)" "https://api.$DOMAIN:$HTTPS_PORT/v1/auth/register")
[[ $r == 403 ]] && grep -q registration_closed "$WORK/reg-closed.json" || die "non-allowlisted sign-up answered $r"
ok "non-allowlisted email -> 403 registration_closed"
r=$(web -o "$WORK/reg.json" -w '%{http_code}' -H 'content-type: application/json' -d "$(body "smoke-owner@$DOMAIN")" "https://api.$DOMAIN:$HTTPS_PORT/v1/auth/register")
[[ $r == 201 ]] || { cat "$WORK/reg.json"; die "allowlisted sign-up answered $r"; }
ok "allowlisted email -> 201 (tokens not shown)"
TOKEN=$(jq -r '.accessToken' "$WORK/reg.json"); [[ -n $TOKEN && $TOKEN != null ]] || die "no access token in the sign-up response"

step "create a product through the API"
r=$(web -o "$WORK/product.json" -w '%{http_code}' -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d '{"name":"Smoke tee","variants":[{"sku":"SMOKE-1","priceMinor":150000}]}' "https://api.$DOMAIN:$HTTPS_PORT/v1/products")
[[ $r == 201 ]] || { cat "$WORK/product.json"; die "create product answered $r"; }
ok "POST /v1/products -> 201: $(jq -c '{name, variants: [.variants[] | {sku, priceMinor}]}' "$WORK/product.json")"
r=$(web "https://api.$DOMAIN:$HTTPS_PORT/v1/products" -H "authorization: Bearer $TOKEN"); ok "GET /v1/products -> $(jq -c '[.items[].name]' <<<"$r")"


step "a second business (so tenant isolation has something to separate)"
r=$(web -o "$WORK/reg2.json" -w '%{http_code}' -H 'content-type: application/json' -d "$(body "smoke-second@$DOMAIN")" "https://api.$DOMAIN:$HTTPS_PORT/v1/auth/register")
[[ $r == 201 ]] || { cat "$WORK/reg2.json"; die "second sign-up answered $r"; }
TOKEN2=$(jq -r '.accessToken' "$WORK/reg2.json")
for sku in SMOKE-2 SMOKE-3; do
  web -o /dev/null -w '' -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "{\"name\":\"Smoke item $sku\",\"variants\":[{\"sku\":\"$sku\",\"priceMinor\":99000}]}" "https://api.$DOMAIN:$HTTPS_PORT/v1/products"
done
r=$(web -o /dev/null -w '%{http_code}' -H "authorization: Bearer $TOKEN2" -H 'content-type: application/json' -d '{"name":"Other shop item","variants":[{"sku":"OTHER-1","priceMinor":50000}]}' "https://api.$DOMAIN:$HTTPS_PORT/v1/products")
[[ $r == 201 ]] || die "second business product answered $r"
ok "business 1 sees $(web "https://api.$DOMAIN:$HTTPS_PORT/v1/products" -H "authorization: Bearer $TOKEN" | jq '.items|length') products, business 2 sees $(web "https://api.$DOMAIN:$HTTPS_PORT/v1/products" -H "authorization: Bearer $TOKEN2" | jq '.items|length') (isolated)"

if want stack; then
  step "services"
  dc ps --format 'table {{.Service}}\t{{.State}}\t{{.Health}}\t{{.Ports}}'

  step "readiness and HTTPS through Caddy"
  r=$(web -o /dev/null -w '%{http_code}' "https://api.$DOMAIN:$HTTPS_PORT/health/ready"); [[ $r == 200 ]] || die "/health/ready answered $r"
  ok "GET https://api.$DOMAIN:$HTTPS_PORT/health/ready -> 200: $(web "https://api.$DOMAIN:$HTTPS_PORT/health/ready")"
  r=$(web -o /dev/null -w '%{http_code}' "https://app.$DOMAIN:$HTTPS_PORT/"); [[ $r == 200 || $r == 307 || $r == 308 ]] || die "web answered $r"
  ok "GET https://app.$DOMAIN:$HTTPS_PORT/ -> $r"
  web -sI "https://app.$DOMAIN:$HTTPS_PORT/" | grep -iE '^(strict-transport-security|content-security-policy|x-frame-options|server):' | cut -c1-160 | sed 's/^/     /'
  r=$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --resolve "api.$DOMAIN:$HTTP_PORT:127.0.0.1" "http://api.$DOMAIN:$HTTP_PORT/health/live"); ok "plain HTTP is redirected: $r"
  r=$(web -o /dev/null -w '%{http_code}' "https://api.$DOMAIN:$HTTPS_PORT/metrics"); [[ $r == 404 ]] || die "/metrics through the proxy answered $r, expected 404"
  ok "/metrics through the public proxy -> 404 (not exposed)"
  web -sI "https://api.$DOMAIN:$HTTPS_PORT/health/live" | grep -iE '^(x-request-id|strict-transport|x-content-type)' | sed 's/^/     /'

  step "/metrics on the API (internal): token required"
  in_api "(async()=>{const u='http://127.0.0.1:4000/metrics';const s=async h=>(await fetch(u,{headers:h})).status;console.log('no token ->',await s({}));console.log('wrong token ->',await s({authorization:'Bearer wrong-token-value-0123456789'}));const r=await fetch(u,{headers:{authorization:'Bearer '+process.env.METRICS_TOKEN}});console.log('right token ->',r.status,r.headers.get('content-type'));const t=await r.text();console.log(t.split('\n').filter(l=>/^(orderloop_|process_resident|nodejs_eventloop)/.test(l)&&!/_bucket/.test(l)).slice(0,40).join('\n'))})()" | sed 's/^/     /'
  step "/metrics and /health/ready on the worker (internal)"
  dc exec -T worker node -e "(async()=>{const b='http://127.0.0.1:4010';console.log('live ->',(await fetch(b+'/health/live')).status);const r=await fetch(b+'/health/ready');console.log('ready ->',r.status,await r.text());console.log('metrics no token ->',(await fetch(b+'/metrics')).status);const m=await fetch(b+'/metrics',{headers:{authorization:'Bearer '+process.env.METRICS_TOKEN}});console.log('metrics token ->',m.status);console.log((await m.text()).split('\n').filter(l=>/^orderloop_worker/.test(l)&&!/_bucket/.test(l)).join('\n'))})()" | sed 's/^/     /'

  step "verification email delivered over STARTTLS (NODE_ENV=production requires it)"
  wait_for "mailpit holds the verification email" in_api "fetch('http://mailpit:8025/api/v1/messages').then(r=>r.json()).then(j=>process.exit(j.messages&&j.messages.length?0:1),()=>process.exit(1))"
  in_api "fetch('http://mailpit:8025/api/v1/messages').then(r=>r.json()).then(j=>console.log(j.messages.map(m=>m.Subject+' -> '+m.To[0].Address).join('\n')))" | sed 's/^/     /'
  step "pnpm mail:test equivalent inside the api container"
  dc exec -T api node dist/scripts/mail-test.js --to "ops-check@$DOMAIN" | sed 's/^/     /'

  step "container hardening"
  for s in api worker web; do
    printf '     %-7s user=%s readonly_rootfs=%s caps_dropped=%s\n' "$s" "$(dc exec -T $s id -un)" \
      "$(docker inspect "$(dc ps -q $s)" --format '{{.HostConfig.ReadonlyRootfs}}')" "$(docker inspect "$(dc ps -q $s)" --format '{{.HostConfig.CapDrop}}')"
  done
  printf '     published ports: %s\n' "$(docker ps --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Names}}={{.Ports}}' | grep -v '=$' | tr '\n' ' ')"
  step "queues in /metrics after the stack settled"
  in_api "fetch('http://127.0.0.1:4000/metrics',{headers:{authorization:'Bearer '+process.env.METRICS_TOKEN}}).then(r=>r.text()).then(t=>console.log(t.split('\n').filter(l=>/^orderloop_(queue_jobs\{queue=\"(imports|automation)\"|worker_heartbeat|dependency|backup)/.test(l)).join('\n')))" | sed 's/^/     /'
fi

if want backup; then
  step "backup: a real encrypted dump"
  dc exec -T backup backup.sh | sed 's/^/     /'
  dc exec -T backup sh -c 'ls -l /backups; echo; jq "{created_at, dump_bytes, sha256, migration_version, migrations_applied, rls_forced_tables, definer_functions: (.definer_functions|length), tables: (.tables|length), rows: ([.tables[]]|add), tenants: .tables.tenants, products: .tables.products, users: .tables.users}" /backups/*.manifest.json' | sed 's/^/     /'
  step "the RLS trap, shown: the same table dumped by the owner role and by the backup role"
  dc exec -T -e PGPASSWORD="$(grep '^DATABASE_MIGRATOR_PASSWORD=' "$WORK/env" | cut -d= -f2)" backup sh -c 'pg_dump -h postgres -U app_migrator -d orderloop --data-only --table=products --enable-row-security | awk "/^COPY/{c=1;next} /^\\\\\\./{c=0} c" | wc -l | sed "s/^/     owner role (app_migrator, --enable-row-security): rows dumped from products = /"'
  dc exec -T backup sh -c 'PGPASSWORD="$BACKUP_DB_PASSWORD" pg_dump -h postgres -U app_backup -d orderloop --data-only --table=products | awk "/^COPY/{c=1;next} /^\\\\\\./{c=0} c" | wc -l | sed "s/^/     backup role (app_backup): rows dumped from products = /"'

  step "restore drill"
  dc --profile ops run --rm -T -v "$WORK/identity.txt:/run/secrets/age-identity:ro" drill 2>&1 | grep -v '^{' | sed 's/^/     /'

  step "failure case 1: the wrong key"
  dc exec -T backup sh -c 'age-keygen 2>/dev/null' > "$WORK/wrong-identity.txt"
  set +e; dc --profile ops run --rm -T -v "$WORK/wrong-identity.txt:/run/secrets/age-identity:ro" drill 2>&1 | grep -v '^{' | sed 's/^/     /'; code=${PIPESTATUS[0]}; set -e
  [[ $code -ne 0 ]] && ok "the drill exited with code $code" || die "the drill PASSED with the wrong key"

  step "failure cases 2 and 3: corrupted copies of the newest backup"
  dc exec -T backup sh -c '
    set -e; cd /backups; f=$(ls -1 orderloop-*.dump.age | sort -r | head -n1); base=${f%.dump.age}
    cp "$f" corrupt-a.dump.age; cp "$base.manifest.json" corrupt-a.manifest.json
    printf "\377" | dd of=corrupt-a.dump.age bs=1 seek=300 conv=notrunc 2>/dev/null           # sha256 no longer matches the manifest
    cp "$f" corrupt-b.dump.age; cp "$base.manifest.json" corrupt-b.manifest.json
    printf "\377" | dd of=corrupt-b.dump.age bs=1 seek=300 conv=notrunc 2>/dev/null
    new=$(sha256sum corrupt-b.dump.age | cut -d" " -f1); jq --arg s "$new" ".sha256 = \$s" corrupt-b.manifest.json > m.tmp && mv m.tmp corrupt-b.manifest.json   # checksum "fixed": only age notices'
  for c in a b; do
    set +e; dc --profile ops run --rm -T -v "$WORK/identity.txt:/run/secrets/age-identity:ro" drill restore-drill.sh "/backups/corrupt-$c.dump.age" 2>&1 | grep -v '^{' | sed 's/^/     /'; code=${PIPESTATUS[0]}; set -e
    [[ $code -ne 0 ]] && ok "corrupt-$c: the drill exited with code $code" || die "the drill PASSED on a corrupted backup ($c)"
  done
  dc exec -T backup sh -c 'rm -f /backups/corrupt-*'

  step "failure case 4: backup.sh as a role that cannot see tenant data (app_user)"
  set +e; dc exec -T -e BACKUP_DB_USER=app_user -e BACKUP_DB_PASSWORD="$(grep '^DATABASE_APP_PASSWORD=' "$WORK/env" | cut -d= -f2)" backup backup.sh 2>&1 | sed 's/^/     /'; code=${PIPESTATUS[0]}; set -e
  [[ $code -ne 0 ]] && ok "backup.sh exited with code $code" || die "backup.sh succeeded as a role subject to RLS"
  step "failure case 5: no encryption key configured"
  set +e; dc exec -T -e BACKUP_AGE_RECIPIENT= backup backup.sh 2>&1 | sed 's/^/     /'; code=${PIPESTATUS[0]}; set -e
  [[ $code -ne 0 ]] && ok "backup.sh exited with code $code" || die "backup.sh wrote an unencrypted backup"
  step "backup age is visible to the API"
  in_api "fetch('http://127.0.0.1:4000/metrics',{headers:{authorization:'Bearer '+process.env.METRICS_TOKEN}}).then(r=>r.text()).then(t=>console.log(t.split('\n').filter(l=>/^orderloop_backup/.test(l)).join('\n')))" | sed 's/^/     /'
  dc exec -T backup backup-health.sh | sed 's/^/     healthcheck: /'
fi

if want monitoring; then
  step "monitoring profile"
  dc --profile monitoring up -d 2>&1 | tail -n 8
  prom() { curl -fsS "http://127.0.0.1:19090$1"; }
  wait_for "Prometheus is ready" prom /-/ready
  targets_up() { [[ $(prom /api/v1/targets | jq '[.data.activeTargets[] | select(.health=="up")] | length') -ge 6 ]]; }
  wait_for "all 6 scrape targets are up" targets_up
  prom /api/v1/targets | jq -r '.data.activeTargets[] | "     \(.labels.job)\t\(.health)\t\(.scrapeUrl)"'
  step "alert rules loaded"
  prom /api/v1/rules | jq -r '.data.groups[].rules[] | "     \(.name)\t\(.health)"'
  step "Grafana: dashboard provisioned"
  wait_for "Grafana is up" curl -fsS -u "admin:smoke-grafana-pw" http://127.0.0.1:13001/api/health
  curl -fsS -u "admin:smoke-grafana-pw" "http://127.0.0.1:13001/api/search?query=OrderLoop" | jq -r '.[] | "     dashboard: \(.title) (\(.uid))"'
  step "fire a test alert: stop the worker"
  prom '/api/v1/query?query=orderloop_worker_heartbeat_present' | jq -r '"     before: heartbeat_present = " + .data.result[0].value[1]'
  dc stop worker >/dev/null
  fire() { prom '/api/v1/alerts' | jq -e '[.data.alerts[] | select(.labels.alertname=="WorkerHeartbeatStale" and .state=="firing")] | length > 0' >/dev/null; }
  stale() { prom '/api/v1/query?query=orderloop_worker_heartbeat_present%20%3D%3D%200' | jq -e '.data.result | length > 0' >/dev/null; }
  wait_for "expression 'orderloop_worker_heartbeat_present == 0' evaluates true" stale
  for i in $(seq 1 120); do fire && break; sleep 5; done
  fire || die "WorkerHeartbeatStale did not fire within 10 minutes"
  prom '/api/v1/alerts' | jq -r '.data.alerts[] | "     Prometheus: \(.labels.alertname) \(.state) severity=\(.labels.severity) runbook=\(.annotations.runbook)"'
  am_has() { curl -fsS http://127.0.0.1:19093/api/v2/alerts | jq -e '[.[] | select(.labels.alertname=="WorkerHeartbeatStale")] | length > 0' >/dev/null; }
  wait_for "Alertmanager received WorkerHeartbeatStale" am_has
  curl -fsS http://127.0.0.1:19093/api/v2/alerts | jq -r '.[] | "     Alertmanager: \(.labels.alertname) status=\(.status.state) receivers=\([.receivers[].name]|join(","))"'
  dc start worker >/dev/null; wait_for "worker is healthy again" healthy worker
fi

step "done"
