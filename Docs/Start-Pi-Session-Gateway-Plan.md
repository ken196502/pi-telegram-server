# Start Pi Session — Shared Gateway Bring-Up Plan

Status: **FINALIZED** — plan only. `scripts/start-pi-session.sh` is NOT modified in this step.
Scope: `scripts/start-pi-session.sh`, with supporting helpers `scripts/check-telegram-ready.mjs`
and `src/gateway.mjs` (read-only references).

## Goal

Make `scripts/start-pi-session.sh` guarantee the shared Telegram gateway
(`src/gateway.mjs`) is up and healthy in a named tmux session
`pi-telegram-gateway` **before** it launches Pi — including when the script is
run standalone (not from `start-two-pi-sessions.sh`). Under 方案 C the Pi
extension reverse-registers to the gateway over WebSocket, so the gateway must
exist and be listening first or registration silently has nothing to connect to.

Concretely, the script must:

1. Probe gateway readiness via `scripts/check-telegram-ready.mjs`.
2. Start the gateway in the named tmux session `pi-telegram-gateway` only when
   it is absent.
3. Forward any already-configured proxy env vars into the gateway process, and
   fall back to the local Mihomo/Clash proxy at `127.0.0.1:7890` when (and only
   when) no proxy is configured and that port is reachable.
4. Wait for readiness with a bounded timeout.
5. Fail with an actionable message (how to attach, where the log is) on any
   unrecoverable condition, instead of launching Pi against a dead gateway.

This follows `config/AGENTS.md`: long-lived processes run in a **named tmux
session**; failures are **surfaced, never silently degraded**; and the user is
always told the attach/view/kill commands.

## Current State (reference)

As of this plan the logic already exists in `scripts/start-pi-session.sh`. This
document finalizes and records the intended design so future edits stay aligned;
it is not a request to rewrite working code. The sections below describe the
agreed behavior and the contracts it depends on.

## Dependencies & Contracts

### `scripts/check-telegram-ready.mjs`
A single Node probe with these relevant modes (all driven off the gateway
`GET /health` endpoint except `proxy`):

- `listening <bot>` — gateway HTTP is up and `<bot>` is a configured bot.
  Inbound WS registration is **not** required. This is the mode used to decide
  whether the gateway needs starting and to wait for it to come up. It must not
  depend on Pi having registered yet, otherwise startup would deadlock (gateway
  waits for Pi, Pi waits for gateway).
- `inbound <bot>` — stricter: `<bot>` must appear in `health.inboundRegistered`
  (a live reverse-registered WS connection exists). **Not** used for gateway
  bring-up; reserved for post-launch verification.
- `connected <bot>` — bot `status === "connected"` and `inboundEnabled`.
- `proxy` — exit 0 if **any** of `HTTPS_PROXY https_proxy HTTP_PROXY http_proxy
  ALL_PROXY all_proxy` is set, else exit 1. Used to detect "a proxy is already
  configured, don't inject the local one."

Exit code convention: `0` = ready/true, non-zero = not ready/false.

### `src/gateway.mjs` `GET /health`
Returns `{ ok, service: "telegram", status, bots, inboundEnabled,
inboundRegistered, ... }`. The readiness helper treats the gateway as valid only
when `response.ok` and `service === "telegram"`, which prevents mistaking any
other process on the port for the gateway.

### Host / port
`TELEGRAM_HOST` (default `127.0.0.1`) and `TELEGRAM_PORT` (default `3093`) from
`.env`. The probe reads them; the script does not need to.

## Finalized Flow

### Preconditions (before touching the gateway)
1. Usage: `start-pi-session.sh <bot-name> <tmux-session> [pi args...]`;
   require at least the two positional args.
2. Resolve `repo_dir` from the script location; require `repo_dir/.env`.
3. Require a per-bot inbound token
   `TELEGRAM_BOT_<BOT_UPPER>_INBOUND_TOKEN` in `.env` (read via `sed`), so the
   extension can authenticate its WS `register` frame. Fail fast if missing —
   no global-token fallback (R4 / "no fallbacks to hide problems").
4. Require `tmux` and `node` on `PATH`.

### Gateway bring-up (only if not already ready)
```
if ! node check-telegram-ready.mjs listening "$bot"; then
    # (a) existing-but-unhealthy guard
    if tmux has-session -t '=pi-telegram-gateway'; then
        echo "Gateway tmux session exists but its HTTP service is unavailable;
              inspect it with: tmux attach -t pi-telegram-gateway" >&2
        exit 1            # do NOT spawn a duplicate; surface the problem
    fi

    # (b) assemble proxy env for the gateway process
    gateway_env=()
    for key in HTTPS_PROXY https_proxy HTTP_PROXY http_proxy ALL_PROXY all_proxy; do
        [ -n "${!key:-}" ] && gateway_env+=("$key=${!key}")
    done

    # (c) local Mihomo/Clash fallback ONLY when no proxy configured AND port open
    if ! node check-telegram-ready.mjs proxy \
       && (exec 3<>/dev/tcp/127.0.0.1/7890) 2>/dev/null; then
        gateway_env+=(HTTPS_PROXY=http://127.0.0.1:7890)
        echo "Using local Telegram proxy at 127.0.0.1:7890" >&2
    fi

    # (d) start in the NAMED tmux session, logging to repo_dir/gateway.log
    tmux new-session -d -s pi-telegram-gateway -c "$repo_dir" \
        "exec env <gateway_env> node src/gateway.mjs >> gateway.log 2>&1"
    echo "Started Telegram gateway in tmux session 'pi-telegram-gateway'
          (log: $repo_dir/gateway.log)" >&2
fi
```

Design decisions baked in:
- **Exact-name tmux match** (`-t '=pi-telegram-gateway'`) so a session whose
  name merely contains that string is not mistaken for ours.
- **Existing-but-unhealthy is terminal**: if the session exists yet `/health`
  is not answering, the script refuses to start a second gateway and tells the
  user how to inspect it. Spawning a duplicate would race on port `3093`.
- **Proxy precedence**: already-configured proxy env always wins and is
  forwarded verbatim; the `127.0.0.1:7890` fallback is injected only when no
  proxy is set and the port accepts a TCP connection (probed with a bash
  `/dev/tcp` open that is immediately closed). This avoids forcing Telegram
  traffic through a proxy that isn't there.
- **Quoting**: build the launched command with `printf %q` so the env
  assignments, node path, and log path survive the `tmux ... "exec ..."` shell
  layer without word-splitting.

### Readiness wait (bounded)
```
for attempt in 1..45:
    if node check-telegram-ready.mjs listening "$bot": ready; break
    sleep 1
if not ready:
    echo "Gateway did not become ready. Inspect with:
          tmux attach -t pi-telegram-gateway (log: $repo_dir/gateway.log)" >&2
    exit 1
```
- ~45s budget (45 × 1s) covers Node start + Telegram `getMe`/webhook setup on a
  slow or proxied link, while still failing in bounded time.
- On timeout the script exits non-zero with the attach command and log path —
  it never proceeds to launch Pi against a non-ready gateway.

### Launch Pi (only after gateway is ready)
```
export PI_TELEGRAM_BOT="$bot"
export PI_TG_TMUX_SS="$tmux_session"
exec pi --extension "$repo_dir/extensions/telegram-mirror.mjs" "$@"
```
The extension derives its WS URL from `TELEGRAM_HOST`/`TELEGRAM_PORT` and
reverse-registers as `$bot`; no inbound port/URL is passed on the command line
(方案 C).

## Failure Modes & Messages (all actionable)

| Condition | Action | Message includes |
|---|---|---|
| Missing `.env` | exit 1 | path of expected `.env` |
| Missing per-bot inbound token | exit 1 | exact env var name to set |
| Missing `tmux`/`node` | exit 1 | which command is missing |
| Gateway session exists but unhealthy | exit 1 | `tmux attach -t pi-telegram-gateway` |
| Gateway never becomes ready | exit 1 | attach command + `gateway.log` path |

No path silently continues to `exec pi` unless the gateway answered
`listening "$bot"`.

## Idempotency & Interaction with `start-two-pi-sessions.sh`

- If the gateway is already healthy, the script leaves the existing
  `pi-telegram-gateway` session untouched and skips straight to the readiness
  wait (which passes immediately), then launches Pi. Running it for a second bot
  therefore reuses the one shared gateway rather than starting another.
- Two concurrent invocations could in principle both see "not ready" and race to
  create the session; the second `tmux new-session -d -s pi-telegram-gateway`
  fails because the name is taken, and the readiness loop then converges on the
  single surviving gateway. (If stricter mutual exclusion is ever needed, add an
  `flock` on a lockfile around the bring-up block — noted as a future option,
  not required now.)

## Verification (plan-only; no persistent processes)

Because this step produces only the plan, verification is static:

1. `bash -n scripts/start-pi-session.sh` — syntax check (no execution).
2. Trace the branch table above against the script to confirm every failure path
   emits an actionable message and exits non-zero before `exec pi`.
3. Confirm the readiness helper modes used here (`listening`, `proxy`) match the
   contract in `scripts/check-telegram-ready.mjs` and the `/health` fields in
   `src/gateway.mjs`.

Do **not** launch Pi or leave a `pi-telegram-gateway` session running as part of
verification. If a gateway is started for an interactive manual test, tear it
down afterward:

```
tmux kill-session -t pi-telegram-gateway   # view first: tmux attach -t pi-telegram-gateway
```

## Out of Scope

- No changes to `src/gateway.mjs`, the extension, or the WS inbound protocol.
- No message persistence/replay for windows where the gateway is down.
- No cross-host remote Pi support (方案 C allows it; not introduced here).
