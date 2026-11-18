#!/usr/bin/env bash
# One line per check, exit code 0 only when everything is fine. Meant for cron and for pinging an
# uptime service, for example:
#   */5 * * * * cd /opt/tetrizz && scripts/healthcheck.sh >/dev/null && curl -fsS -m 10 https://hc-ping.com/<your-uuid>
# Checks: every container of the stack runs (and is healthy where it has a health check), the site
# answers /healthz through Caddy, and the disk holding ./data has room.
set -uo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

failed=0
fail() {
  printf 'FAIL  %s\n' "$*"
  failed=1
}
ok() { printf 'ok    %s\n' "$*"; }

# 1. containers
while IFS=$'\t' read -r service state health; do
  [[ -z $service ]] && continue
  if [[ $service == init* ]]; then continue; fi
  if [[ $state != running ]]; then
    fail "$service is $state"
  elif [[ -n $health && $health != healthy ]]; then
    fail "$service is $health"
  else
    ok "$service ${health:-running}"
  fi
done < <(docker compose ps --all --format '{{.Service}}\t{{.State}}\t{{.Health}}' 2>/dev/null)
[[ -n $(docker compose ps -q 2>/dev/null) ]] || fail "no containers (is the stack up?)"

# 2. the front door
site=$(setting SITE_ADDRESS ":80")
http_port=$(setting HTTP_PORT 80)
case $site in
  :*) url="http://127.0.0.1:${http_port}/healthz" ;;
  http://* | https://*) url="${site%/}/healthz" ;;
  *) url="https://${site}/healthz" ;;
esac
if curl -fsS -m 10 -o /dev/null "$url" 2>/dev/null; then ok "$url"; else fail "$url does not answer"; fi

# 3. disk
used=$(df -P "$ROOT" | awk 'NR==2 {gsub("%","",$5); print $5}')
if [[ -n $used ]] && ((used >= 90)); then fail "disk is ${used}% full"; else ok "disk ${used:-?}% full"; fi

exit "$failed"
