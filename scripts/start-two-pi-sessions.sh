#!/usr/bin/env bash
# Launch the Telegram gateway and one bound Pi session per bot configured in .env.
#
# Bots come from TELEGRAM_BOTS (name=token,...); no bot name is hardcoded.
# Session mapping: 1st configured bot -> pi, 2nd -> pi2, 3rd -> pi3, ...
set -euo pipefail

usage() {
  echo "usage: $0 [--dry-run] [<bot> ...] [-- <pi args...>]" >&2
  echo "bots come from TELEGRAM_BOTS in .env; with no <bot> every configured bot starts" >&2
  echo "sessions: 1st bot -> pi, 2nd -> pi2, 3rd -> pi3 (TELEGRAM_BOTS order is the contract)" >&2
  echo "--dry-run prints the resolved bots and sessions and starts nothing" >&2
}

dry_run=0
requested=()
pi_args=()
while (( $# )); do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --dry-run) dry_run=1; shift ;;
    --) shift; pi_args=("$@"); break ;;
    *) requested+=("$1"); shift ;;
  esac
done

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/bots.sh
source "$repo_dir/scripts/lib/bots.sh"
bots_init "$repo_dir" || exit 1

# Select the bots to start: everything configured, or exactly the named ones.
selected=()
if (( ${#requested[@]} == 0 )); then
  selected=("${BOT_NAMES[@]}")
else
  for bot in "${requested[@]}"; do
    session_for_bot "$bot" >/dev/null || exit 1
    selected+=("${bot,,}")
  done
fi

if (( dry_run )); then
  echo "dry-run: ${#BOT_NAMES[@]} bot(s) configured in $repo_dir/.env: ${BOT_NAMES[*]}"
  for bot in "${selected[@]}"; do
    printf 'dry-run: bot %s -> tmux session %s\n' "$bot" "$(session_for_bot "$bot")"
  done
  printf 'dry-run: sessions:'
  for bot in "${selected[@]}"; do
    printf ' %s' "$(session_for_bot "$bot")"
  done
  printf '\n'
  echo "dry-run: no session started; a real run starts the gateway only if /health is unavailable"
  exit 0
fi

workspace_dir=/mnt/share/VM
mount_dir=/mnt/share
export PATH="$HOME/.pi/agent/bin:$HOME/.local/bin:$PATH"
for command in tmux pi mountpoint node; do
  command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 1; }
done

# Validate every binding before starting any session.
for bot in "${selected[@]}"; do
  bot_upper="$(printf '%s' "$bot" | tr '[:lower:]' '[:upper:]' | sed 's/[^A-Z0-9]/_/g')"
  inbound_token="$(sed -n "s/^TELEGRAM_BOT_${bot_upper}_INBOUND_TOKEN=//p" "$repo_dir/.env" | tail -n 1)"
  [[ -n "$inbound_token" ]] || {
    echo "set TELEGRAM_BOT_${bot_upper}_INBOUND_TOKEN in $repo_dir/.env (required for WS reverse-register)" >&2
    exit 1
  }
done

bots_warn_unmanaged_sessions

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

for bot in "${selected[@]}"; do
  start_session "$bot" "$(session_for_bot "$bot")" "${pi_args[@]}"
done

wait_ready() {
  local mode="$1" description="$2" bot session_list=""
  shift 2
  for ((attempt=0; attempt<45; attempt++)); do
    if node "$repo_dir/scripts/check-telegram-ready.mjs" "$mode" "$@"; then
      return 0
    fi
    sleep 1
  done
  for bot in "$@"; do
    session_list+="$(session_for_bot "$bot"), "
  done
  echo "Timed out waiting for $description. Inspect tmux sessions ${session_list%, } and $repo_dir/gateway.log." >&2
  return 1
}

if ! node "$repo_dir/scripts/check-telegram-ready.mjs" listening "${selected[@]}"; then
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
# WebSocket registration requires the gateway to be listening first. A session
# may exist even though Pi failed to load or authenticate its extension.
wait_ready inbound "inbound connections for: ${selected[*]}" "${selected[@]}"
wait_ready connected "Telegram connection for: ${selected[*]}" "${selected[@]}"
echo "Pi sessions ready: ${selected[*]}"
for bot in "${selected[@]}"; do
  echo "  $bot -> tmux attach -t $(session_for_bot "$bot")"
done
