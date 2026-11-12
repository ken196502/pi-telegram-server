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

for command in tmux node pi; do
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

# A standalone Pi launch must bring up the shared gateway before the extension
# attempts its WebSocket registration.
if ! node "$repo_dir/scripts/check-telegram-ready.mjs" listening "$bot"; then
  if tmux has-session -t '=pi-telegram-gateway' 2>/dev/null; then
    echo "Gateway tmux session exists but its HTTP service is unavailable; inspect it with: tmux attach -t pi-telegram-gateway" >&2
    exit 1
  fi

  gateway_env=()
  for proxy_key in HTTPS_PROXY https_proxy HTTP_PROXY http_proxy ALL_PROXY all_proxy; do
    if [[ -n "${!proxy_key:-}" ]]; then
      gateway_env+=("$proxy_key=${!proxy_key}")
    fi
  done
  if ! node "$repo_dir/scripts/check-telegram-ready.mjs" proxy &&
     (exec 3<>/dev/tcp/127.0.0.1/7890) 2>/dev/null; then
    gateway_env+=(HTTPS_PROXY=http://127.0.0.1:7890)
    echo "Using local Telegram proxy at 127.0.0.1:7890" >&2
  fi

  printf -v gateway_command '%q ' env "${gateway_env[@]}" node "$repo_dir/src/gateway.mjs"
  printf -v gateway_log '%q' "$repo_dir/gateway.log"
  tmux new-session -d -s pi-telegram-gateway -c "$repo_dir" "exec $gateway_command >>$gateway_log 2>&1"
  echo "Started Telegram gateway in tmux session 'pi-telegram-gateway' (log: $repo_dir/gateway.log)" >&2
fi

gateway_ready=0
for ((attempt=0; attempt<45; attempt++)); do
  if node "$repo_dir/scripts/check-telegram-ready.mjs" listening "$bot"; then
    gateway_ready=1
    break
  fi
  sleep 1
done
if (( ! gateway_ready )); then
  echo "Gateway did not become ready. Inspect with: tmux attach -t pi-telegram-gateway (log: $repo_dir/gateway.log)" >&2
  exit 1
fi

echo "starting Pi for bot '$bot' (WS reverse-register → gateway, tmux session '$tmux_session')" >&2

export PI_TELEGRAM_BOT="$bot"
export PI_TELEGRAM_INBOUND_TOKEN="$inbound_token"
export PI_TG_TMUX_SS="$tmux_session"

exec pi --extension "$repo_dir/extensions/telegram-mirror.mjs" "$@"
