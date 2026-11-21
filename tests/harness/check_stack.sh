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
ALERT_HEARTBEAT_URL=http://heartbeat-sink:8080/ping
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
    echo "--- container state, health check output and the last log lines ---"
    docker compose ps --all || true
    for id in $(docker compose ps -q 2>/dev/null); do
      docker inspect -f '{{.Name}} health: {{json .State.Health}}' "$id" 2>/dev/null | cut -c1-700 || true
    done
    docker compose logs --tail=30 --no-log-prefix 2>&1 | cut -c1-300 || true
  fi
  docker rm -f heartbeat-sink >/dev/null 2>&1 || true
  docker compose down -v --remove-orphans || true
  rm -f .env
  exit "$status"
}
trap cleanup EXIT

# check_body PATTERN MESSAGE CURL_ARGS...: fetches the whole answer first and looks in it afterwards.
# Never `curl | grep -q`: under pipefail that fails when grep stops reading early (curl exit 23, seen in
# CI on the page's index.html, which is bigger than a pipe buffer).
check_body() {
  local pattern=$1 message=$2 text
  shift 2
  text=$(curl -fsS "$@") || fail "$message (the request failed)"
  grep -qF -- "$pattern" <<<"$text" || fail "$message"
}
# count PATTERN TEXT: how many times the pattern occurs (0 is a fine answer).
count() { { grep -o -- "$1" <<<"$2" || true; } | wc -l; }
# inside URL: a GET made from inside a container that has wget (Prometheus's image), because
# the Loki image has no shell or wget to ask with.
inside() { docker compose exec -T prometheus wget -qO- "$1"; }

# shellcheck source=scripts/lib.sh
source scripts/lib.sh

step "build and start ($files)"
docker compose up -d --build
for service in $(docker compose config --services | grep -v '^init'); do
  wait_ready "$service" 300 || fail "$service did not become ready"
done

step "the front door"
check_body '"ok"' "/healthz" "$site/healthz"
check_body '"database":"ok"' "/readyz does not report the database as ok" "$site/readyz"
check_body '"url":"/"' "/config.json must point the page at its own address" "$site/config.json"
check_body '<title>' "the page is not served" "$site/"
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
check_body '"database":"ok"' "the database is not ok after the restore" "$site/readyz"
bash scripts/healthcheck.sh

if [[ $variant == monitoring ]]; then
  step "Prometheus scrapes the server, the machine and the logging and alerting parts"
  targets=""
  for _ in $(seq 1 40); do
    targets=$(inside http://127.0.0.1:9090/api/v1/targets 2>/dev/null) || targets=""
    up=$(count '"health":"up"' "$targets")
    all=$(count '"health":"' "$targets")
    if ((all >= 6 && up == all)); then break; fi
    sleep 3
  done
  for job in tetrizz node prometheus loki alloy alertmanager; do
    grep -qF "\"job\":\"$job\"" <<<"$targets" || fail "no $job target: $targets"
  done
  ((up == all)) || fail "targets are not all up: $targets"
  grep -qF 'alertmanager:9093' <<<"$(inside http://127.0.0.1:9090/api/v1/alertmanagers)" || fail "Prometheus does not know Alertmanager"

  step "Loki is ready"
  for _ in $(seq 1 40); do
    [[ $(inside http://loki:3100/ready 2>/dev/null || true) == *ready* ]] && break
    sleep 3
  done
  [[ $(inside http://loki:3100/ready 2>/dev/null || true) == *ready* ]] || fail "Loki does not report ready"

  step "Grafana has the datasources and the three dashboards"
  g=http://127.0.0.1:13000
  auth="admin:$pw"
  check_body '"database"' "Grafana does not answer" -u "$auth" "$g/api/health"
  [[ $(curl -fsS -u "$auth" "$g/api/search?type=dash-db" | grep -o '"uid":"tetrizz-' | wc -l) -eq 3 ]] || fail "the three dashboards are not provisioned"
  check_body '"status":"OK"' "Prometheus datasource" -u "$auth" "$g/api/datasources/uid/prometheus/health"
  check_body '"status":"OK"' "Loki datasource" -u "$auth" "$g/api/datasources/uid/loki/health"

  step "Alloy ships the logs to Loki"
  for _ in $(seq 1 40); do
    [[ $(inside http://loki:3100/loki/api/v1/label/service/values 2>/dev/null || true) == *'"server"'* ]] && break
    sleep 3
  done
  [[ $(inside http://loki:3100/loki/api/v1/label/service/values 2>/dev/null || true) == *'"server"'* ]] || fail "no logs of the server in Loki"

  step "Grafana's dashboards can query the server's metrics"
  q=$(curl -fsS -u "$auth" "$g/api/datasources/proxy/uid/prometheus/api/v1/query?query=tetrizz_db_up")
  grep -qF '"value"' <<<"$q" || fail "tetrizz_db_up has no value: $q"

  step "the Watchdog alert travels Prometheus -> Alertmanager -> the heartbeat address"
  net=$(docker network ls --filter label=com.docker.compose.project=tetrizz --format '{{.Name}}' | head -n 1)
  [[ -n $net ]] || fail "no compose network"
  # A sink that reads the whole request. (A busybox `nc -l` loop answered, closed and cut the body off
  # after the headers, so the check never saw the Watchdog even though Alertmanager logged success.)
  # Node is already in the server image that was just built, so nothing else is pulled.
  docker run -d --name heartbeat-sink --network "$net" --entrypoint node tetrizz-server:local -e '
    const http = require("http"), fs = require("fs");
    http.createServer((q, s) => {
      let b = "";
      q.on("data", (c) => { b += c; });
      q.on("end", () => { fs.appendFileSync("/tmp/hits", q.method + " " + q.url + "\n" + b + "\n"); s.end("ok"); });
    }).listen(8080);' >/dev/null
  hits=""
  for _ in $(seq 1 60); do
    hits=$(docker exec heartbeat-sink cat /tmp/hits 2>/dev/null || true)
    grep -qF 'Watchdog' <<<"$hits" && break
    sleep 3
  done
  grep -qF 'POST /ping' <<<"$hits" || fail "the heartbeat address got no POST (alerts do not reach Alertmanager's webhook): $hits"
  grep -qF 'Watchdog' <<<"$hits" || fail "the heartbeat request is not the Watchdog alert: $hits"
  failed=$(inside http://alertmanager:9093/metrics 2>/dev/null | grep -F 'alertmanager_notifications_failed_total{integration="webhook"' | awk '{n += $NF} END {print n + 0}' || true)
  echo "webhook deliveries failed so far: ${failed:-?} (the first tries fail while the sink starts)"
fi

step "all good ($variant)"
