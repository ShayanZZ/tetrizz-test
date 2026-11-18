# Shared by backup.sh, restore.sh and healthcheck.sh (sourced, not run).
# shellcheck shell=bash

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() {
  log "ERROR: $*" >&2
  exit 1
}

# setting NAME DEFAULT: the environment wins, then the last NAME=value line of .env, then DEFAULT.
setting() {
  local name=$1 default=$2 value=${!1-}
  if [[ -z $value && -f .env ]]; then
    value=$(grep -E "^${name}=" .env | tail -n 1 | cut -d= -f2- || true)
    value=${value%%[[:space:]]#*}
    value=${value%\"}
    value=${value#\"}
    value=${value%\'}
    value=${value#\'}
  fi
  printf '%s' "${value:-$default}"
}

# Which database the stack uses: postgres when compose.postgres.yaml is part of it, otherwise sqlite.
detect_driver() {
  if docker compose config --services 2>/dev/null | grep -qx postgres; then
    printf 'postgres'
  else
    printf 'sqlite'
  fi
}

# abs_dir PATH: PATH made absolute against the repository folder.
abs_path() {
  case $1 in
    /*) printf '%s' "$1" ;;
    *) printf '%s/%s' "$ROOT" "${1#./}" ;;
  esac
}

# wait_ready SERVICE [SECONDS]: until the service is healthy (or running, when it has no health check).
# Used instead of `docker compose up --wait`, which does not cope well with one-shot services.
wait_ready() {
  local service=$1 limit=${2:-120} waited=0 line state health
  while ((waited < limit)); do
    line=$(docker compose ps --format '{{.State}} {{.Health}}' "$service" 2>/dev/null | head -n 1 || true)
    state=${line%% *}
    health=${line#"$state"}
    health=${health# }
    if [[ $state == running && ( -z $health || $health == healthy ) ]]; then return 0; fi
    sleep 2
    waited=$((waited + 2))
  done
  return 1
}
