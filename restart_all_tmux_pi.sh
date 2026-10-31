#!/usr/bin/env bash
# Restart the Pi sessions managed by scripts/start-two-pi-sessions.sh.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${1:-}" == --help || "${1:-}" == -h || $# == 1 ]]; then
  exec "$repo_dir/scripts/start-two-pi-sessions.sh" "$@"
fi

if ! command -v tmux >/dev/null 2>&1; then
  echo "missing command: tmux" >&2
  exit 1
fi

for session in pi pi2; do
  if tmux has-session -t "=$session" 2>/dev/null; then
    echo "stopping tmux session '$session'"
    tmux kill-session -t "=$session"
  else
    echo "tmux session '$session' is not running"
  fi
done

exec "$repo_dir/scripts/start-two-pi-sessions.sh" "$@"
