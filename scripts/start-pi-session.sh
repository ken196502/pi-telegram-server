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

for command in tmux pi; do
  command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 1; }
done

# Direct invocations should run Pi in the requested named tmux session. The
# multi-session launcher already creates that session and calls us inside it.
current_tmux_session=""
if [[ -n "${TMUX:-}" ]]; then
  if [[ -n "${TMUX_PANE:-}" ]]; then
    current_tmux_session="$(tmux display-message -p -t "$TMUX_PANE" '#{session_name}' 2>/dev/null || true)"
  else
    current_tmux_session="$(tmux display-message -p '#{session_name}' 2>/dev/null || true)"
  fi
fi
if [[ "$current_tmux_session" != "$tmux_session" ]]; then
  if tmux has-session -t "=$tmux_session" 2>/dev/null; then
    echo "tmux session '$tmux_session' already exists; inspect it with: tmux attach -t '$tmux_session'" >&2
    exit 1
  fi

  script_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  printf -v launch_command '%q ' env "PATH=$PATH" bash "$script_path" "$bot" "$tmux_session" "$@"
  tmux new-session -d -s "$tmux_session" -c "$PWD" "exec bash -c $(printf '%q' "$launch_command")"
  echo "Started Pi launcher in tmux session '$tmux_session'. Attach with: tmux attach -t '$tmux_session'" >&2
  exit 0
fi

echo "starting Pi for bot '$bot' (WS reverse-register → gateway, tmux session '$tmux_session')" >&2

export PI_TELEGRAM_BOT="$bot"
export PI_TG_TMUX_SS="$tmux_session"

exec pi --extension "$repo_dir/extensions/telegram-mirror.mjs" "$@"
