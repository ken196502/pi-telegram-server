# Plan — Disable the inspilot Telegram Bot

Status: implemented and verified (2026-11-06 23:01 EST)
Date: 2026-11-06
Scope: `.env` (runtime config), gateway process in tmux session `pi-telegram-gateway`.
No source changes: `src/lib.mjs` and `src/gateway.mjs` are read-only references here.

## Goal

Stop the `inspilot` bot from being served by the shared Telegram gateway while
keeping the `main` bot byte-identical and fully working. The gateway has no
runtime reload endpoint — `resolveBotConfigs()` runs once at process start — so
the change only takes effect after a restart.

## Current State

- `.env` defines `TELEGRAM_BOTS` with two entries: `main=…,inspilot=…`.
- Per-bot overrides for inspilot exist: `TELEGRAM_BOT_INSPILOT_INBOUND_TOKEN`
  and `TELEGRAM_BOT_INSPILOT_ALLOWED_SENDERS` (values not reproduced here).
- `src/lib.mjs:77` `resolveBotConfigs()` splits `TELEGRAM_BOTS` on `,`; each
  entry becomes one bot. Dropping the entry drops the bot entirely.
- `src/gateway.mjs:19` builds the bot map once at startup; `/health` reports
  `bots` from that map. `src/gateway.mjs:330` builds webhook routes from it.
- With one bot remaining, `bots.size === 1`, so `/health` reports
  `webhookPath`/`defaultBot` for that bot and `resolveBot()` no longer demands
  an explicit bot name on outbound calls.
- The gateway currently runs as `node src/gateway.mjs` (PID in tmux session
  `pi-telegram-gateway`), logging to `gateway.log` in the repo root.

## Changes

1. **Backup** — copy `.env` to `.env.bak-<timestamp>` before any edit. Never
   echo or cat the file; secret values must not reach logs, docs or output.
2. **`TELEGRAM_BOTS`** — remove the `inspilot` entry, leaving the `main` entry
   byte-identical (same token, same order, no reformatting of the remaining
   value).
3. **Per-bot overrides** — comment out, do not delete,
   `TELEGRAM_BOT_INSPILOT_INBOUND_TOKEN` and
   `TELEGRAM_BOT_INSPILOT_ALLOWED_SENDERS`, with a dated comment explaining why.
   Commenting keeps rollback readable and leaves the secrets recoverable in place.
4. **Restart** — the gateway must run inside a named tmux session, never
   `nohup` or a bare `&`:
   - stop the running `node src/gateway.mjs` and retire the old tmux session so
     the name is free;
   - `tmux new-session -d -s pi-telegram-gateway -c /home/piagent/Pi/pi-telegram-server "node src/gateway.mjs 2>&1 | tee .tmp/gateway.log; echo EXIT=$?; sleep 600"`
     — `tee` keeps the log visible, `echo EXIT=$?` records an unexpected exit
     instead of hiding it, `sleep 600` keeps the pane from vanishing so the log
     can be read after a crash.

## Verification

1. `GET /health` → HTTP 200; `bots` contains **only** `main`;
   `bots.main.inboundConnected === true`; `status === "connected"`.
2. `GET /` → HTTP 200 and lists only `main`.
3. `/mnt/share/VM/AIGC-pipeline/scripts/tmux-reminder.sh --dry-run` → still
   prints a POST to `http://127.0.0.1:3093/telegram/webhook/main`. The alias
   route `/telegram/webhook/<name>` remains registered for the single bot, so
   the reminder keeps reaching the main bot's Pi session.
4. Inspect `.tmp/gateway.log` for startup errors; confirm no token text appears
   in any log or doc written during this change.
5. Confirm no leftover test processes or ad-hoc tmux sessions were created.

## Verification Results

- Backup `.env.bak-20261106-230030` written, byte-identical to the original
  (`cmp` clean, mode 600).
- Parsed config check: `TELEGRAM_BOTS` names = `["main"]`; the `main` entry is
  byte-identical to the original first entry; no active `*INSPILOT*` keys;
  no other key changed.
- `GET /health` → 200, `status: connected`, `bots` = `{main}`,
  `main.status: connected`, `main.inboundConnected: true`.
- `GET /` → 200, `bots: ["main"]`.
- `POST /telegram/webhook/main` with an empty update → 200 `{"ok":true}`
  (nothing forwarded, so the live Pi session was not disturbed).
- `POST /telegram/webhook/inspilot` → 404 — the inspilot route no longer exists.
- `tmux-reminder.sh --dry-run` → still prints
  `POST http://127.0.0.1:3093/telegram/webhook/main`, i.e. it targets the main bot.
- `.tmp/gateway.log`: no error lines; no token/secret strings in the new log or
  in this document.

## Rollback

```sh
cp -p .env.bak-<timestamp> .env      # restore the two-bot configuration
```

then restart exactly as above (kill the current gateway, recreate the
`pi-telegram-gateway` tmux session). After rollback `/health` must again list
both `main` and `inspilot`.

## Risks / Notes

- Requests that name `bot=inspilot` will now fail with
  `unknown bot: inspilot; configured bots: main` — an explicit error, not a
  silent fallback to `main`. Any client still configured for inspilot will
  surface that error and must be updated.
- `scripts/start-two-pi-sessions.sh` and `scripts/restart-inbound-c.sh` still
  reference an `inspilot`/`pi2` session. They are not part of this change and
  are not used by the gateway restart; they would fail loudly if run, which is
  the intended behavior until they are revised or retired.
- The restart command follows the operator's instruction and does not set a
  proxy. Direct egress to `api.telegram.org` was confirmed reachable before the
  restart; if the gateway reports `disconnected`, that is surfaced in
  verification rather than papered over with a proxy fallback.
