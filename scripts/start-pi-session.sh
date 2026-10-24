#!/usr/bin/env bash
# Start a Pi session bound to one Telegram bot.
#
#   scripts/start-pi-session.sh <bot-name> <tmux-session> [extra pi args...]
#
# The inbound port is read from TELEGRAM_BOT_<NAME>_INBOUND_URL in .env, so a
# session can never silently start without PI_TELEGRAM_BOT (the extension
# refuses to run in multi-bot mode without it).
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
inbound_url="$(sed -n "s/^TELEGRAM_BOT_${bot_upper}_INBOUND_URL=//p" "$env_file" | tail -n 1)"
[ -n "$inbound_url" ] || {
  echo "TELEGRAM_BOT_${bot_upper}_INBOUND_URL is not set in $env_file" >&2
  exit 1
}

inbound_port="$(printf '%s' "$inbound_url" | sed -n 's#^[^:]*://[^:/]*:\([0-9][0-9]*\).*$#\1#p')"
[ -n "$inbound_port" ] || {
  echo "cannot read an explicit port from $inbound_url" >&2
  exit 1
}

echo "starting Pi for bot '$bot' on 127.0.0.1:$inbound_port (tmux session '$tmux_session')" >&2

export PI_TELEGRAM_BOT="$bot"
export PI_TELEGRAM_INBOUND_PORT="$inbound_port"
export PI_TG_TMUX_SS="$tmux_session"

exec pi --extension "$repo_dir/extensions/telegram-mirror.mjs" "$@"
