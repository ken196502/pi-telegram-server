#!/usr/bin/env bash
# tmux-inspect.sh — inject the "inspect all tmux sessions" reminder into the
# live Pi session and append a tmux snapshot to .tmp/tmux-status.log.
#
# Delivery goes through the gateway webhook: the Pi session is registered to the
# gateway over WebSocket, so a synthetic Telegram update reaches Pi through the
# extension. There is no tmux send-keys fallback: if the webhook fails, this
# script logs the HTTP code and the error and exits non-zero.
#
# Installed via crontab (every 20 minutes by default). It never kills anything.
#
# Busy gate: the gateway queues injected updates while Pi is mid-turn and
# replays them afterwards, which produced duplicate reminders. Before POSTing we
# ask GET /health whether Pi is busy and skip when it is.
#
#   usage: tmux-inspect.sh [--dry-run] [--force]
#
#     --dry-run   print the snapshot, the busy-check decision, the POST target
#                 and the payload; write no log and deliver nothing
#     --force     bypass the busy check (manual runs must always deliver)
#
# Config (env):
#   BUSY_WINDOW_SEC             busy if lastTypingAt is newer than this (default 120)
#   TMUX_REMINDER_BOT           bot entry under bots.<name> (default main)
#   TMUX_REMINDER_HEALTH_URL    health endpoint override (tests)
#   TMUX_REMINDER_WEBHOOK_URL   webhook override (tests; keeps tests off the real chat)
#   TMUX_REMINDER_LOG           log file override (tests)
#   TMUX_REMINDER_HEALTH_JSON   if set, parse this instead of fetching /health (tests)
set -uo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$repo_dir/.env"
LOG="${TMUX_REMINDER_LOG:-$repo_dir/.tmp/tmux-status.log}"
REMINDER="Inspect every tmux session and repair what is needed. Read each pane and its tee'd log before deciding a task failed. Repair code or logic failures by dispatching the coding CLI in a named tmux session: write a plan first, then execute it. Do not re-run a task blocked by an external cause (credentials, authorization, a third-party service, a missing mount); record the exact reason and leave it until the blocking condition changes. Do not dispatch a task that is already running. Update <workspace>/Docs/YYYYMMDD-daily-tasks.md only when something changed, and record the evidence (session, log line, exit code). Report what you changed and what remains blocked."
BOT="${TMUX_REMINDER_BOT:-main}"
BUSY_WINDOW_SEC="${BUSY_WINDOW_SEC:-120}"
DRY_RUN=0
FORCE=0

usage() {
  echo "usage: $0 [--dry-run] [--force]" >&2
}

for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    --dry-run) DRY_RUN=1 ;;
    --force)   FORCE=1 ;;
    *) echo "tmux-inspect: unknown argument: $arg" >&2; usage; exit 2 ;;
  esac
done

[ -f "$ENV_FILE" ] || { echo "tmux-inspect: missing $ENV_FILE" >&2; exit 1; }

mkdir -p "$repo_dir/.tmp"

tmp_files=()
cleanup() {
  local file
  for file in "${tmp_files[@]}"; do
    [ -n "$file" ] && rm -f "$file"
  done
}
trap cleanup EXIT

# Sets TMP_FILE in the current shell (no command substitution) so cleanup sees it.
make_tmp() {
  TMP_FILE="$(mktemp "$repo_dir/.tmp/tmux-inspect.XXXXXX")" || {
    echo "tmux-inspect: cannot create a temporary file under $repo_dir/.tmp" >&2
    exit 1
  }
  tmp_files+=("$TMP_FILE")
}

log_line() {
  printf '%s %s\n' "$(date -Is)" "$*" >> "$LOG"
}

# ── 1. tmux snapshot (context for the reminder, never destructive) ──
snapshot() {
  echo "=== $(date -Is) ==="
  if ! command -v tmux >/dev/null 2>&1; then
    echo "tmux is not installed"
    return
  fi
  if ! tmux ls >/dev/null 2>&1; then
    echo "no tmux sessions running"
    return
  fi
  tmux ls
  while IFS=: read -r name _rest; do
    name="${name%% *}"
    [ -z "$name" ] && continue
    last=$(tmux display-message -p -t "$name" '#{session_activity}' 2>/dev/null || echo 0)
    now=$(date +%s)
    idle=$(( now - ${last:-0} ))
    printf '  %-32s idle=%ss\n' "$name" "$idle"
  done < <(tmux ls 2>/dev/null)
  echo
}

if (( DRY_RUN )); then
  snapshot
else
  snapshot >> "$LOG"
  # Keep the log bounded (last 2000 lines).
  tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

# ── 2. resolve gateway coordinates ──
env_get() { sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | tail -n 1; }

HOST="$(env_get TELEGRAM_HOST)"; HOST="${HOST:-127.0.0.1}"
PORT="$(env_get TELEGRAM_PORT)"; PORT="${PORT:-3093}"

SENDER="$(env_get TELEGRAM_TO)"
if [ -z "$SENDER" ]; then
  echo "tmux-inspect: TELEGRAM_TO is not set in $ENV_FILE; refusing to deliver with a placeholder sender" >&2
  exit 1
fi
if [[ ! "$SENDER" =~ ^[0-9]+$ ]]; then
  echo "tmux-inspect: TELEGRAM_TO must be a numeric Telegram user ID (got '$SENDER')" >&2
  exit 1
fi

WEBHOOK_URL="${TMUX_REMINDER_WEBHOOK_URL:-http://$HOST:$PORT/telegram/webhook/$BOT}"
HEALTH_URL="${TMUX_REMINDER_HEALTH_URL:-http://$HOST:$PORT/health}"

# ── 3. busy gate ──
# typingActive alone is not enough: it drops to false between tool calls inside one
# long turn. So: busy if typingActive == true OR lastTypingAt is within BUSY_WINDOW_SEC.
#
# DELIBERATE NON-FATAL PATH: if /health is unreachable, malformed, or has no entry for
# this bot, we do NOT guess "busy" — that would silently disable every future
# inspection for as long as the gateway is down or the payload shape drifts. We log
# the reason and deliver anyway. A redundant prompt is cheaper than a dead safety net,
# and the logged reason makes the drift visible.
busy_state=""
busy_reason=""
busy_detail=""

if [ "$FORCE" = "1" ]; then
  busy_state="FORCED"
else
  make_tmp; health_file="$TMP_FILE"
  make_tmp; health_err="$TMP_FILE"

  if [ -n "${TMUX_REMINDER_HEALTH_JSON:-}" ]; then
    printf '%s' "$TMUX_REMINDER_HEALTH_JSON" > "$health_file"
  else
    hc=$(curl -sS -m 5 -o "$health_file" -w '%{http_code}' "$HEALTH_URL" 2>"$health_err")
    if [ "$hc" != "200" ]; then
      errmsg=$(tr '\n' ' ' < "$health_err" 2>/dev/null | head -c 200)
      busy_state="UNAVAILABLE"
      busy_reason="http=${hc:-000} ${errmsg:-no response} from $HEALTH_URL"
    fi
  fi

  if [ -z "$busy_state" ]; then
    if ! command -v python3 >/dev/null 2>&1; then
      busy_state="UNAVAILABLE"
      busy_reason="no python3 available for json parsing"
    else
      # Prints exactly one line:
      #   BUSY|typingActive=false, lastTypingAt=2026-11-07T08:49:10.658Z age=37s
      #   IDLE|...   UNAVAILABLE|reason=...
      decision=$(python3 - "$health_file" "$BOT" "$BUSY_WINDOW_SEC" <<'PY'
import sys, json, datetime

path, bot, window_raw = sys.argv[1], sys.argv[2], sys.argv[3]

try:
    window = int(window_raw)
    if window < 0:
        raise ValueError
except ValueError:
    print("UNAVAILABLE|reason=invalid BUSY_WINDOW_SEC=%s" % window_raw)
    sys.exit(0)

try:
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        doc = json.load(fh)
except Exception as exc:
    print("UNAVAILABLE|reason=invalid json (%s)" % str(exc).splitlines()[0])
    sys.exit(0)

if not isinstance(doc, dict):
    print("UNAVAILABLE|reason=health payload is not an object")
    sys.exit(0)

bots = doc.get("bots")
if not isinstance(bots, dict):
    print("UNAVAILABLE|reason=health payload has no bots object")
    sys.exit(0)

entry = bots.get(bot)
if not isinstance(entry, dict):
    print("UNAVAILABLE|reason=no bot entry '%s'" % bot)
    sys.exit(0)

typing_active = entry.get("typingActive")
last_typing = entry.get("lastTypingAt")

if not isinstance(typing_active, bool) and not isinstance(last_typing, str):
    print("UNAVAILABLE|reason=bot entry '%s' has neither typingActive nor lastTypingAt" % bot)
    sys.exit(0)

age = None
if isinstance(last_typing, str) and last_typing.strip():
    try:
        raw = last_typing.strip()
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        stamp = datetime.datetime.fromisoformat(raw)
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=datetime.timezone.utc)
        now = datetime.datetime.now(datetime.timezone.utc)
        age = int((now - stamp).total_seconds())
        if age < 0:
            age = 0  # small clock skew: a future stamp counts as "just now"
    except Exception:
        print("UNAVAILABLE|reason=unparsable lastTypingAt=%s" % last_typing)
        sys.exit(0)
elif last_typing is not None and not isinstance(last_typing, str):
    print("UNAVAILABLE|reason=unparsable lastTypingAt=%s" % last_typing)
    sys.exit(0)

typing_txt = "true" if typing_active is True else ("false" if typing_active is False else "null")
last_txt = last_typing.strip() if isinstance(last_typing, str) and last_typing.strip() else "none"
age_txt = "n/a" if age is None else "%ds" % age

busy = (typing_active is True) or (age is not None and age <= window)
state = "BUSY" if busy else "IDLE"
print("%s|typingActive=%s, lastTypingAt=%s age=%s" % (state, typing_txt, last_txt, age_txt))
PY
)
      prc=$?
      if [ "$prc" -ne 0 ] || [ -z "$decision" ]; then
        busy_state="UNAVAILABLE"
        busy_reason="parser failed (rc=$prc)"
      else
        busy_state="${decision%%|*}"
        busy_detail="${decision#*|}"
        [ "$busy_state" = "$decision" ] && busy_detail=""
        if [ "$busy_state" = "UNAVAILABLE" ]; then
          busy_reason="${busy_detail#reason=}"
          busy_detail=""
        fi
      fi
    fi
  fi
fi

case "$busy_state" in
  FORCED)
    if [ "$DRY_RUN" = "1" ]; then
      echo "busy-check: BYPASSED (--force)"
    fi
    ;;
  BUSY)
    if [ "$DRY_RUN" = "1" ]; then
      echo "busy-check: SKIP — Pi busy ($busy_detail)"
      exit 0
    fi
    log_line "reminder skipped: Pi busy ($busy_detail)"
    exit 0
    ;;
  IDLE)
    if [ "$DRY_RUN" = "1" ]; then
      echo "busy-check: DELIVER — Pi idle ($busy_detail)"
    fi
    ;;
  UNAVAILABLE)
    if [ "$DRY_RUN" = "1" ]; then
      echo "busy-check: UNAVAILABLE ($busy_reason) — would deliver anyway"
    else
      log_line "reminder busy-check unavailable ($busy_reason)"
    fi
    ;;
  *)
    # Never silently deliver on an unknown state; log it as the reason.
    if [ "$DRY_RUN" = "1" ]; then
      echo "busy-check: UNAVAILABLE (unexpected state '${busy_state}') — would deliver anyway"
    else
      log_line "reminder busy-check unavailable (unexpected state '${busy_state}')"
    fi
    ;;
esac

# ── 4. deliver the reminder into the running Pi session ──
json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  printf '%s' "$value"
}

now=$(date +%s)
payload=$(printf '{"update_id":%s,"message":{"message_id":%s,"date":%s,"chat":{"id":%s,"type":"private"},"from":{"id":%s,"is_bot":false},"text":"%s"}}' \
  "$now" "$now" "$now" "$SENDER" "$SENDER" "$(json_escape "$REMINDER")")

if [ "$DRY_RUN" = "1" ]; then
  echo "POST $WEBHOOK_URL"
  echo "$payload"
  exit 0
fi

make_tmp; out_file="$TMP_FILE"
make_tmp; err_file="$TMP_FILE"
code=$(curl -sS -m 15 -o "$out_file" -w '%{http_code}' \
  -X POST "$WEBHOOK_URL" \
  -H 'content-type: application/json' \
  --data "$payload" 2>"$err_file")
curl_rc=$?

if [ "$code" = "200" ] && [ "$curl_rc" -eq 0 ]; then
  log_line "reminder delivered to Pi via gateway ($BOT)"
  exit 0
fi

response_body=$(tr '\n' ' ' < "$out_file" 2>/dev/null | head -c 300)
curl_error=$(tr '\n' ' ' < "$err_file" 2>/dev/null | head -c 300)
log_line "reminder webhook failed (http=${code:-none} curl_rc=$curl_rc body=${response_body:-none} error=${curl_error:-none})"
echo "tmux-inspect: reminder webhook failed (http=${code:-none} curl_rc=$curl_rc): ${curl_error:-$response_body}" >&2
exit 1
