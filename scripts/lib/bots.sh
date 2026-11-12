#!/usr/bin/env bash
# scripts/lib/bots.sh — resolve the bot list from .env and map bots to tmux
# sessions. Sourced, not executed.
#
# TELEGRAM_BOTS is read exactly like loadEnvFile() in src/lib.mjs: the first
# active assignment wins, values may be quoted, and "name=token" / "name:token"
# entries are split on the first separator. Only bot names are kept; token
# values are never printed, so they cannot leak into logs.
#
# Session mapping (documented contract):
#   1st configured bot -> pi, 2nd -> pi2, 3rd -> pi3, nth -> pi<n>
# The order of TELEGRAM_BOTS is therefore part of the contract.

# Print the raw TELEGRAM_BOTS value (may contain tokens) to stdout for the
# caller to parse. Never echo this value anywhere else.
_bots_raw_definition() {
  local env_file="$1"
  awk '
    { sub(/\r$/, "") }
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*TELEGRAM_BOTS[[:space:]]*=/ {
      line = $0
      sub(/^[[:space:]]*TELEGRAM_BOTS[[:space:]]*=/, "", line)
      sub(/^[[:space:]]+/, "", line)
      sub(/[[:space:]]+$/, "", line)
      if (line ~ /^".*"$/ || line ~ /^\047.*\047$/) line = substr(line, 2, length(line) - 2)
      print line
      exit
    }
  ' "$env_file"
}

# bots_init <repo-dir>
# Fills BOT_NAMES[] and SESSIONS[] in .env order. Returns non-zero with a
# specific message on any configuration problem; callers must stop.
bots_init() {
  local repo_dir="$1" env_file raw entry trimmed name_part token_part index n bot existing
  local -a entries

  BOT_NAMES=()
  SESSIONS=()

  env_file="$repo_dir/.env"
  if [[ ! -f "$env_file" ]]; then
    echo "missing $env_file" >&2
    return 1
  fi

  raw="$(_bots_raw_definition "$env_file")"
  if [[ -z "${raw//[[:space:]]/}" ]]; then
    echo "TELEGRAM_BOTS is empty in $env_file; expected name=token[,name=token]" >&2
    echo "  (the legacy single-bot TELEGRAM_BOT_TOKEN mode has no bot list; these scripts need TELEGRAM_BOTS)" >&2
    return 1
  fi

  IFS=',' read -r -a entries <<< "$raw"
  index=0
  for entry in "${entries[@]}"; do
    index=$((index + 1))
    trimmed="${entry#"${entry%%[![:space:]]*}"}"
    trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
    # The gateway skips empty entries (for example a trailing comma).
    [[ -n "$trimmed" ]] || continue

    if [[ "$trimmed" == *=* ]]; then
      name_part="${trimmed%%=*}"
      token_part="${trimmed#*=}"
    elif [[ "$trimmed" == *:* ]]; then
      name_part="${trimmed%%:*}"
      token_part="${trimmed#*:}"
    else
      echo "TELEGRAM_BOTS entry #$index is malformed; expected name=token" >&2
      return 1
    fi

    name_part="${name_part#"${name_part%%[![:space:]]*}"}"
    name_part="${name_part%"${name_part##*[![:space:]]}"}"
    token_part="${token_part#"${token_part%%[![:space:]]*}"}"
    token_part="${token_part%"${token_part##*[![:space:]]}"}"

    if [[ -z "$name_part" || -z "$token_part" ]]; then
      echo "TELEGRAM_BOTS entry #$index is malformed; expected name=token" >&2
      return 1
    fi
    if [[ ! "$name_part" =~ ^[A-Za-z0-9_-]+$ ]]; then
      echo "invalid bot name in TELEGRAM_BOTS entry #$index (allowed: letters, digits, _ and -)" >&2
      return 1
    fi

    bot="${name_part,,}"
    for existing in "${BOT_NAMES[@]}"; do
      if [[ "$existing" == "$bot" ]]; then
        echo "duplicate bot name in TELEGRAM_BOTS: $bot" >&2
        return 1
      fi
    done

    n=${#BOT_NAMES[@]}
    if (( n == 0 )); then
      SESSIONS+=("pi")
    else
      SESSIONS+=("pi$((n + 1))")
    fi
    BOT_NAMES+=("$bot")
  done

  if (( ${#BOT_NAMES[@]} == 0 )); then
    echo "TELEGRAM_BOTS in $env_file contains no bot definitions" >&2
    return 1
  fi
}

# session_for_bot <bot-name>
# Prints the tmux session for a configured bot, or fails with a specific error.
session_for_bot() {
  local wanted="${1,,}" i
  for i in "${!BOT_NAMES[@]}"; do
    if [[ "${BOT_NAMES[$i]}" == "$wanted" ]]; then
      printf '%s\n' "${SESSIONS[$i]}"
      return 0
    fi
  done
  echo "no session mapping for bot '$1' (configured bots: ${BOT_NAMES[*]:-none})" >&2
  return 1
}

# bots_warn_unmanaged_sessions
# Warn about a running pi<N> session that no configured bot maps to. Never
# kills anything: an unknown session may belong to someone else.
bots_warn_unmanaged_sessions() {
  local session managed
  command -v tmux >/dev/null 2>&1 || return 0
  while IFS= read -r session; do
    [[ -n "$session" ]] || continue
    [[ "$session" =~ ^pi[0-9]+$ ]] || continue
    for managed in "${SESSIONS[@]}"; do
      [[ "$managed" == "$session" ]] && continue 2
    done
    echo "warning: tmux session '$session' is not managed by the current TELEGRAM_BOTS (${BOT_NAMES[*]}); leaving it untouched" >&2
  done < <(tmux list-sessions -F '#{session_name}' 2>/dev/null)
}
