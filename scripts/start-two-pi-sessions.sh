#!/usr/bin/env bash
# Launch the Telegram gateway and two bound Pi sessions in detached tmux sessions.
set -euo pipefail

usage() {
  echo "usage: $0 [<first-bot> <second-bot> [pi args...]]" >&2
  echo "defaults: main -> pi, inspilot -> pi2; starts the gateway automatically" >&2
}

if [[ "${1:-}" == --help || "${1:-}" == -h ]]; then
  usage
  exit 0
fi
if (( $# == 1 )); then
  usage
  exit 64
fi

first_bot=main
second_bot=inspilot
if (( $# >= 2 )); then
  first_bot="$1"
  second_bot="$2"
  shift 2
fi

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
workspace_dir=/mnt/share/VM
mount_dir=/mnt/share
export PATH="$HOME/.pi/agent/bin:$HOME/.local/bin:$PATH"
for command in tmux pi mountpoint node; do
  command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 1; }
done
[[ -f "$repo_dir/.env" ]] || { echo "missing $repo_dir/.env" >&2; exit 1; }

# Validate both bindings before starting either session.
ports=()
for bot in "$first_bot" "$second_bot"; do
  [[ "$bot" =~ ^[a-zA-Z0-9_]+$ ]] || { echo "invalid bot name: $bot" >&2; exit 1; }
  bot_upper="$(printf '%s' "$bot" | tr '[:lower:]' '[:upper:]')"
  inbound_url="$(sed -n "s/^TELEGRAM_BOT_${bot_upper}_INBOUND_URL=//p" "$repo_dir/.env" | tail -n 1)"
  port="$(printf '%s' "$inbound_url" | sed -n 's#^[^:]*://[^:/]*:\([0-9][0-9]*\).*$#\1#p')"
  [[ -n "$port" ]] || {
    echo "set TELEGRAM_BOT_${bot_upper}_INBOUND_URL with an explicit port in $repo_dir/.env" >&2
    exit 1
  }
  ports+=("$port")
done
[[ "${ports[0]}" != "${ports[1]}" ]] || {
  echo "the two bots must use different inbound ports" >&2
  exit 1
}

# The host's virtiofs share is not mounted automatically after reboot.
if ! mountpoint -q "$mount_dir"; then
  echo "Mounting virtiofs share at $mount_dir (sudo may ask for your password)"
  if (( EUID == 0 )); then
    mkdir -p "$mount_dir"
    mount -t virtiofs share "$mount_dir"
  else
    command -v sudo >/dev/null || { echo "missing command: sudo" >&2; exit 1; }
    sudo mkdir -p "$mount_dir"
    sudo mount -t virtiofs share "$mount_dir"
  fi
fi
mountpoint -q "$mount_dir" || { echo "$mount_dir is not mounted" >&2; exit 1; }
[[ -d "$workspace_dir" && -r "$workspace_dir" && -w "$workspace_dir" && -x "$workspace_dir" ]] || {
  echo "workspace must exist and be accessible for reading and writing: $workspace_dir" >&2
  exit 1
}

start_session() {
  local bot="$1" session="$2" launch_command
  shift 2
  if tmux has-session -t "=$session" 2>/dev/null; then
    echo "tmux session '$session' already exists; leaving it running"
    return
  fi
  # tmux runs a shell command; quote each argument to preserve spaces and literals.
  printf -v launch_command '%q ' env "PATH=$PATH" bash "$repo_dir/scripts/start-pi-session.sh" "$bot" "$session" "$@"
  tmux new-session -d -s "$session" -c "$workspace_dir" "exec bash -c $(printf '%q' "$launch_command")"
  echo "started bot '$bot' in tmux session '$session'"
}

start_session "$first_bot" pi "$@"
start_session "$second_bot" pi2 "$@"

wait_ready() {
  local mode="$1" description="$2"
  for ((attempt=0; attempt<45; attempt++)); do
    if node "$repo_dir/scripts/check-telegram-ready.mjs" "$mode" "$first_bot" "$second_bot"; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for $description. Inspect tmux sessions pi, pi2 and $repo_dir/gateway.log." >&2
  return 1
}

# A session may exist even though Pi failed to load its extension.
wait_ready inbound "both Pi inbound listeners"

if ! node "$repo_dir/scripts/check-telegram-ready.mjs" listening "$first_bot" "$second_bot"; then
  if tmux has-session -t '=pi-telegram-gateway' 2>/dev/null; then
    echo "Gateway tmux session exists but its HTTP service is unavailable; inspect it with tmux attach -t pi-telegram-gateway" >&2
    exit 1
  fi
  # Respect explicit proxy configuration; otherwise use the local Mihomo HTTP
  # proxy when available. Pass it explicitly instead of relying on tmux's env.
  gateway_env=()
  for proxy_key in HTTPS_PROXY https_proxy HTTP_PROXY http_proxy ALL_PROXY all_proxy; do
    if [[ -n "${!proxy_key:-}" ]]; then
      gateway_env+=("$proxy_key=${!proxy_key}")
    fi
  done
  if ! node "$repo_dir/scripts/check-telegram-ready.mjs" proxy &&
     (exec 3<>/dev/tcp/127.0.0.1/7890) 2>/dev/null; then
    gateway_env+=(HTTPS_PROXY=http://127.0.0.1:7890)
    echo "Using local Telegram proxy at 127.0.0.1:7890"
  fi
  printf -v gateway_command '%q ' env "${gateway_env[@]}" node "$repo_dir/src/gateway.mjs"
  printf -v gateway_log '%q' "$repo_dir/gateway.log"
  tmux new-session -d -s pi-telegram-gateway -c "$repo_dir" "exec $gateway_command >>$gateway_log 2>&1"
  echo "Started Telegram gateway (log: $repo_dir/gateway.log)"
fi
wait_ready connected "both bots to connect to Telegram"
echo "Both Pi sessions and Telegram bots are ready."
echo "Attach with: tmux attach -t pi  (or: tmux attach -t pi2)"
