#!/usr/bin/env bash
# Start a Pi session bound to one Telegram bot.
#
#   scripts/start-pi-session.sh <bot-name> <tmux-session> [extra pi args...]
#
# The Pi extension connects to the gateway WebSocket (方案 C) and registers as
# <bot-name>. No inbound HTTP port is needed; PI_TELEGRAM_BOT must be set so
# the extension knows which bot to register as.
set -euo pipefail

usage() {
  echo "usage: $0 <bot-name> <tmux-session> [pi args...]" >&2
  exit 64
}

[ "$#" -ge 2 ] || usage
bot="$1"
tmux_session="$2"
shift 2

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$repo_dir/.env"
[ -f "$env_file" ] || { echo "missing $env_file" >&2; exit 1; }

bot_upper="$(printf '%s' "$bot" | tr '[:lower:]' '[:upper:]')"
# 方案 C: no inbound URL/port — the extension derives the WS URL from TELEGRAM_HOST/PORT.
# We only verify that a per-bot inbound token exists so the session can authenticate.
inbound_token="$(sed -n "s/^TELEGRAM_BOT_${bot_upper}_INBOUND_TOKEN=//p" "$env_file" | tail -n 1)"
[ -n "$inbound_token" ] || {
  echo "TELEGRAM_BOT_${bot_upper}_INBOUND_TOKEN is not set in $env_file" >&2
  exit 1
}

echo "starting Pi for bot '$bot' (WS reverse-register → gateway, tmux session '$tmux_session')" >&2

export PI_TELEGRAM_BOT="$bot"
export PI_TG_TMUX_SS="$tmux_session"

exec pi --extension "$repo_dir/extensions/telegram-mirror.mjs" "$@"
