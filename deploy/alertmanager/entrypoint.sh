#!/bin/sh
# Starts Alertmanager with a configuration made from the stack's settings, so .env is the one place
# that says where alerts go (docs/DOCKER.md, "Alerts"). Runs under busybox sh in the Alertmanager
# image. The secrets are written to files in a memory-only folder and handed to Alertmanager as
# files; nothing secret reaches the disk or the image.
#
#   ALERT_TELEGRAM_BOT_TOKEN, ALERT_TELEGRAM_CHAT_ID   both or neither
#   ALERT_DISCORD_WEBHOOK_URL
#   ALERT_HEARTBEAT_URL                                pinged once a minute while everything is alive
#
# With none of them set, alerts are still evaluated and visible in Prometheus and Alertmanager, and
# delivered nowhere. ALERTMANAGER_RENDER_ONLY=1 writes the configuration and stops (used by the checks).
set -eu

run_dir=${ALERTMANAGER_RUN_DIR:-/run/alertmanager}
source_dir=${ALERTMANAGER_SOURCE_DIR:-/etc/alertmanager}
config="$run_dir/alertmanager.yml"

die() {
  echo "alertmanager: $*" >&2
  exit 1
}

token=${ALERT_TELEGRAM_BOT_TOKEN:-}
chat=${ALERT_TELEGRAM_CHAT_ID:-}
discord=${ALERT_DISCORD_WEBHOOK_URL:-}
heartbeat=${ALERT_HEARTBEAT_URL:-}

if [ -n "$token" ] && [ -z "$chat" ]; then die "ALERT_TELEGRAM_BOT_TOKEN is set but ALERT_TELEGRAM_CHAT_ID is not"; fi
if [ -z "$token" ] && [ -n "$chat" ]; then die "ALERT_TELEGRAM_CHAT_ID is set but ALERT_TELEGRAM_BOT_TOKEN is not"; fi
digits=${chat#-}
case $digits in
  '') [ -z "$chat" ] || die "ALERT_TELEGRAM_CHAT_ID must be a number (a group's starts with a minus sign)" ;;
  *[!0-9]*) die "ALERT_TELEGRAM_CHAT_ID must be a number (a group's starts with a minus sign)" ;;
esac
case $discord in '' | https://*) ;; *) die "ALERT_DISCORD_WEBHOOK_URL must start with https://" ;; esac
case $heartbeat in '' | https://* | http://*) ;; *) die "ALERT_HEARTBEAT_URL must start with https:// or http://" ;; esac

umask 077
mkdir -p "$run_dir"

# keep NAME VALUE: the secret in a file of its own (no trailing newline).
keep() {
  printf '%s' "$2" >"$run_dir/$1"
}

{
  cat "$source_dir/routes.yml"
  echo
  echo "receivers:"
  echo "  - name: owner"
  if [ -n "$token" ]; then
    keep telegram-token "$token"
    echo "    telegram_configs:"
    echo "      - bot_token_file: $run_dir/telegram-token"
    echo "        chat_id: $chat"
    echo "        parse_mode: HTML"
  fi
  if [ -n "$discord" ]; then
    keep discord-webhook "$discord"
    echo "    discord_configs:"
    echo "      - webhook_url_file: $run_dir/discord-webhook"
  fi
  echo "  - name: heartbeat"
  if [ -n "$heartbeat" ]; then
    keep heartbeat-url "$heartbeat"
    echo "    webhook_configs:"
    echo "      - url_file: $run_dir/heartbeat-url"
    echo "        send_resolved: false"
  fi
} >"$config"

echo "alertmanager: alerts go to:$([ -n "$token" ] && echo ' telegram')$([ -n "$discord" ] && echo ' discord')$([ -n "$token$discord" ] || echo ' (nowhere: no Telegram or Discord settings)'); heartbeat: $([ -n "$heartbeat" ] && echo on || echo off)"

if [ "${ALERTMANAGER_RENDER_ONLY:-}" = 1 ]; then exit 0; fi
exec /bin/alertmanager "$@"
