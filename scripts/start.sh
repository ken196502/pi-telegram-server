#!/usr/bin/env bash
# start.sh — start the Telegram gateway and the Pi session for the "main" bot.
#
#   scripts/start.sh [--workspace <dir>] [--dry-run]
#
# The gateway runs in the tmux session "pi-telegram-gateway"; Pi runs in "pi"
# with extensions/telegram-mirror.mjs loaded. Existing sessions are left alone.
# Only explicitly configured proxy variables are passed to the gateway.
set -euo pipefail

usage() {
  cat <<'EOF'
usage: scripts/start.sh [--workspace <dir>] [--dry-run]

  --workspace <dir>  Pi working directory (default: $HOME)
  --dry-run          print the resolved plan and start nothing
  -h, --help         show this help

Starts the gateway in tmux "pi-telegram-gateway" and Pi in tmux "pi", then
waits for /health to report the "main" bot connected. A timeout exits non-zero.
EOF
}

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
workspace="$HOME"
dry_run=0

while (( $# )); do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --dry-run) dry_run=1; shift ;;
    --workspace)
      [ "$#" -ge 2 ] || { echo "start.sh: --workspace needs a directory" >&2; exit 64; }
      workspace="$2"; shift 2 ;;
    *) echo "start.sh: unknown option: $1" >&2; usage >&2; exit 64 ;;
  esac
done

env_file="$repo_dir/.env"
[ -f "$env_file" ] || { echo "start.sh: missing $env_file; run ./setup.sh first" >&2; exit 1; }
[ -d "$workspace" ] || { echo "start.sh: workspace is not a directory: $workspace" >&2; exit 1; }

for command in tmux node; do
  command -v "$command" >/dev/null 2>&1 || { echo "start.sh: missing command: $command" >&2; exit 1; }
done

export PATH="$HOME/.pi/agent/bin:$HOME/.local/bin:$PATH"
command -v pi >/dev/null 2>&1 || {
  echo "start.sh: missing command: pi (install it with https://pi.dev/install.sh)" >&2
  exit 1
}

gateway_session="pi-telegram-gateway"
pi_session="pi"

# Explicit proxy settings only. Nothing is auto-detected or guessed.
gateway_env=()
for proxy_key in HTTPS_PROXY https_proxy HTTP_PROXY http_proxy ALL_PROXY all_proxy; do
  if [[ -n "${!proxy_key:-}" ]]; then
    gateway_env+=("$proxy_key=${!proxy_key}")
  fi
done

start_gateway=1
if tmux has-session -t "=$gateway_session" 2>/dev/null; then
  echo "start.sh: tmux session '$gateway_session' is already running; leaving it alone"
  start_gateway=0
elif node "$repo_dir/scripts/check-telegram-ready.mjs" listening; then
  echo "start.sh: a gateway is already listening outside tmux; leaving it alone"
  start_gateway=0
fi

if (( start_gateway )); then
  printf -v gateway_command '%q ' env "${gateway_env[@]}" node "$repo_dir/src/gateway.mjs"
  if (( dry_run )); then
    echo "dry-run: would start gateway in tmux '$gateway_session'"
    echo "dry-run: cd $repo_dir && exec $gateway_command >> gateway.log 2>&1"
  else
    tmux new-session -d -s "$gateway_session" -c "$repo_dir" \
      "exec $gateway_command >> $(printf '%q' "$repo_dir/gateway.log") 2>&1"
    echo "start.sh: started gateway in tmux '$gateway_session' (log: $repo_dir/gateway.log)"
  fi
fi

# start-pi-session.sh refuses to launch while the gateway session exists but its
# HTTP service is not up, so wait for /health before starting Pi.
if (( dry_run )); then
  echo "dry-run: would wait up to 45s for the gateway to listen on /health"
else
  gateway_listening=0
  for ((attempt = 1; attempt <= 45; attempt++)); do
    if node "$repo_dir/scripts/check-telegram-ready.mjs" listening; then
      gateway_listening=1
      break
    fi
    sleep 1
  done
  if (( ! gateway_listening )); then
    echo "start.sh: gateway did not start listening within 45s" >&2
    echo "  inspect: tmux attach -t $gateway_session" >&2
    echo "  log:     $repo_dir/gateway.log" >&2
    exit 1
  fi
fi

start_pi=1
if tmux has-session -t "=$pi_session" 2>/dev/null; then
  echo "start.sh: tmux session '$pi_session' is already running; leaving it alone"
  start_pi=0
fi

if (( start_pi )); then
  if (( dry_run )); then
    echo "dry-run: would start Pi for bot 'main' in tmux '$pi_session' (workspace: $workspace)"
  else
    ( cd "$workspace" && "$repo_dir/scripts/start-pi-session.sh" main "$pi_session" )
  fi
fi

if (( dry_run )); then
  echo "dry-run: would wait up to 45s for /health to report bot 'main' connected"
  exit 0
fi

ready=0
for ((attempt = 1; attempt <= 45; attempt++)); do
  if node "$repo_dir/scripts/check-telegram-ready.mjs" connected main; then
    ready=1
    break
  fi
  sleep 1
done

if (( ! ready )); then
  echo "start.sh: gateway did not report bot 'main' connected within 45s" >&2
  echo "  inspect: tmux attach -t $gateway_session ; tmux attach -t $pi_session" >&2
  echo "  health:  curl -s http://127.0.0.1:3093/health" >&2
  echo "  log:     $repo_dir/gateway.log" >&2
  exit 1
fi

echo "start.sh: bot 'main' is connected"
echo "  Pi:      tmux attach -t $pi_session"
echo "  gateway: tmux attach -t $gateway_session"
