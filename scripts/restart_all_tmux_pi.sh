#!/usr/bin/env bash
# Restart the Pi sessions managed by scripts/start-two-pi-sessions.sh.
#
# Sessions come from TELEGRAM_BOTS in .env (1st bot -> pi, 2nd -> pi2, ...);
# no session name is hardcoded, so a bot that is no longer configured is never
# stopped or started.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/bots.sh
source "$repo_dir/scripts/lib/bots.sh"

usage() {
  echo "usage: $0 [--dry-run]" >&2
  echo "stops every tmux session mapped from TELEGRAM_BOTS in .env, then runs start-two-pi-sessions.sh" >&2
  echo "--dry-run prints the resolved sessions and the stop/start plan, and changes nothing" >&2
}

dry_run=0
for arg in "$@"; do
  case "$arg" in
    -h|--help) exec "$repo_dir/scripts/start-two-pi-sessions.sh" --help ;;
    --dry-run) dry_run=1 ;;
    *) usage; exit 64 ;;
  esac
done

bots_init "$repo_dir" || exit 1

if ! command -v tmux >/dev/null 2>&1; then
  echo "missing command: tmux" >&2
  exit 1
fi

bots_warn_unmanaged_sessions

if (( dry_run )); then
  for i in "${!BOT_NAMES[@]}"; do
    session="${SESSIONS[$i]}"
    if tmux has-session -t "=$session" 2>/dev/null; then
      echo "dry-run: would stop tmux session '$session' (bot ${BOT_NAMES[$i]})"
    else
      echo "dry-run: tmux session '$session' (bot ${BOT_NAMES[$i]}) is not running"
    fi
  done
  exec "$repo_dir/scripts/start-two-pi-sessions.sh" --dry-run
fi

for session in "${SESSIONS[@]}"; do
  if tmux has-session -t "=$session" 2>/dev/null; then
    echo "stopping tmux session '$session'"
    tmux kill-session -t "=$session"
  else
    echo "tmux session '$session' is not running"
  fi
done

exec "$repo_dir/scripts/start-two-pi-sessions.sh" "$@"
