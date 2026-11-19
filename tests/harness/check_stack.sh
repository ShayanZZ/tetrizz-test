#!/usr/bin/env bash
# Brings the VPS stack up for real, checks it, backs up, restores, and takes it down again.
# Needs Docker with the compose plugin and a free working copy: it refuses to run if .env, data/ or
# backups/ exist, and it leaves data/ and backups/ behind (files owned by the containers' users;
# remove them with sudo). Run by CI; also fine on a Linux machine.
#
#   tests/harness/check_stack.sh lite|postgres|monitoring
set -Eeuo pipefail
variant=${1:?usage: check_stack.sh lite|postgres|monitoring}
cd "$(dirname "$0")/../.."
for path in .env data backups; do
  [[ ! -e $path ]] || {
    echo "$path exists; this check needs a clean working copy" >&2
    exit 1
  }
done

case $variant in
  lite) files=compose.yaml ;;
  postgres) files=compose.yaml:compose.postgres.yaml ;;
  monitoring) files=compose.yaml:compose.monitoring.yaml ;;
  *)
    echo "unknown variant: $variant" >&2
    exit 1
    ;;
esac
pw=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
cat >.env <<ENV
COMPOSE_FILE=$files
SITE_ADDRESS=:80
HTTP_PORT=18080
HTTPS_PORT=18443
GRAFANA_PORT=13000
POSTGRES_PASSWORD=$pw
GRAFANA_ADMIN_PASSWORD=$pw
ENV
site=http://127.0.0.1:18080
fail() {
  echo "FAIL: $*" >&2
  exit 1
}
step() { printf '\n== %s\n' "$*"; }
cleanup() {
  status=$?
  if ((status != 0)); then
    echo "--- container state and the last log lines ---"
    docker compose ps --all || true
    docker compose logs --tail=60 || true
  fi
  docker compose down -v --remove-orphans || true
  rm -f .env
  exit "$status"
}
trap cleanup EXIT

# shellcheck source=scripts/lib.sh
source scripts/lib.sh

step "build and start ($files)"
docker compose up -d --build
for service in $(docker compose config --services | grep -v '^init'); do
  wait_ready "$service" 300 || fail "$service did not become ready"
done

step "the front door"
curl -fsS "$site/healthz" | grep -q '"ok"' || fail "/healthz"
curl -fsS "$site/readyz" | grep -q '"database":"ok"' || fail "/readyz does not report the database as ok"
curl -fsS "$site/config.json" | grep -q '"url":"/"' || fail "/config.json must point the page at its own address"
curl -fsS "$site/" | grep -qi '<title>' || fail "the page is not served"
[[ $(curl -s -o /dev/null -w '%{http_code}' "$site/metrics") == 404 ]] || fail "/metrics must not be reachable through Caddy"
[[ $(curl -s -o /dev/null -w '%{http_code}' -H 'Upgrade: websocket' -H 'Connection: Upgrade' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Origin: http://evil.example' "$site/ws") == 403 ]] ||
  fail "a socket from a foreign origin must be refused with 403"

step "scripts/healthcheck.sh"
bash scripts/healthcheck.sh

step "backup, then restore it"
bash scripts/backup.sh
file=$(find backups/daily -type f -name 'tetrizz-*' | head -n 1)
[[ -s $file ]] || fail "no backup file"
bash scripts/restore.sh --yes "$file"
curl -fsS "$site/readyz" | grep -q '"database":"ok"' || fail "the database is not ok after the restore"
bash scripts/healthcheck.sh

if [[ $variant == monitoring ]]; then
  step "Prometheus scrapes the server"
  for _ in $(seq 1 30); do
    docker compose exec -T prometheus wget -qO- http://127.0.0.1:9090/api/v1/targets | grep -q '"health":"up"' && break
    sleep 3
  done
  targets=$(docker compose exec -T prometheus wget -qO- http://127.0.0.1:9090/api/v1/targets)
  grep -q '"job":"tetrizz"' <<<"$targets" || fail "no tetrizz target"
  [[ $(grep -o '"health":"up"' <<<"$targets" | wc -l) -ge 3 ]] || fail "targets are not all up: $targets"

  step "Grafana has the datasources and the three dashboards"
  g=http://127.0.0.1:13000
  auth="admin:$pw"
  curl -fsS -u "$auth" "$g/api/health" >/dev/null || fail "Grafana does not answer"
  [[ $(curl -fsS -u "$auth" "$g/api/search?type=dash-db" | grep -o '"uid":"tetrizz-' | wc -l) -eq 3 ]] || fail "the three dashboards are not provisioned"
  curl -fsS -u "$auth" "$g/api/datasources/uid/prometheus/health" | grep -q '"status":"OK"' || fail "Prometheus datasource"
  curl -fsS -u "$auth" "$g/api/datasources/uid/loki/health" | grep -q '"status":"OK"' || fail "Loki datasource"

  step "Alloy ships the logs to Loki"
  for _ in $(seq 1 30); do
    docker compose exec -T loki wget -qO- http://127.0.0.1:3100/loki/api/v1/label/service/values | grep -q '"server"' && break
    sleep 3
  done
  docker compose exec -T loki wget -qO- http://127.0.0.1:3100/loki/api/v1/label/service/values | grep -q '"server"' || fail "no logs of the server in Loki"

  step "Grafana's dashboards can query the server's metrics"
  q=$(curl -fsS -u "$auth" "$g/api/datasources/proxy/uid/prometheus/api/v1/query?query=tetrizz_db_up")
  grep -q '"value"' <<<"$q" || fail "tetrizz_db_up has no value: $q"
fi

step "all good ($variant)"
