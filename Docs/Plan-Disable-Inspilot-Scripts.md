# Plan — Make the Pi session scripts follow `.env` after inspilot is disabled

Status: implemented and verified (2026-11-06)
Date: 2026-11-06
Scope: `scripts/start-two-pi-sessions.sh`, `scripts/restart-inbound-c.sh`,
`scripts/restart_all_tmux_pi.sh`, new `scripts/lib/bots.sh`, and the launch
section of `README.md`. No gateway source, no `.env` edit, no restart of the
running gateway (`pi-telegram-gateway`) or of any Pi session.

## Goal

The gateway now serves exactly one bot (`main`), because `.env` lists only
`main` in `TELEGRAM_BOTS`. Three operator scripts still hardcode the old
two-bot topology and would launch a Pi session for a bot the gateway no longer
serves. They must derive the bot list from `.env` so the number of sessions
always matches the number of configured bots.

## Current state

- `.env:11` — `TELEGRAM_BOTS=main=…` (one entry). The `inspilot` per-bot
  overrides are commented out at `.env:17-21`.
- `scripts/start-two-pi-sessions.sh:19-20` — `first_bot=main`,
  `second_bot=inspilot`; `:78-79` always starts `pi` and `pi2`; `:118-121`
  waits for "both" bots and prints `tmux attach -t pi2`.
- `scripts/restart-inbound-c.sh:51,56` — prints "重启 pi (main) 和 pi2
  (inspilot)" and loops `for ss in pi pi2`; `:70` tells the operator to
  `tmux attach -t pi2`.
- `scripts/restart_all_tmux_pi.sh:16` — `for session in pi pi2`.
- `scripts/start-pi-session.sh` already takes `<bot> <session>` and validates
  `TELEGRAM_BOT_<NAME>_INBOUND_TOKEN`; it needs no change.
- `scripts/check-telegram-ready.mjs` already accepts a variable number of bot
  names, so it needs no change.
- Running tmux sessions right now: `pi-telegram-gateway` only (plus the
  operator's `pi2-scripts-coding`, which is not a managed session and must not
  be touched).

## Decisions

### 1. Session mapping is positional

| index in `TELEGRAM_BOTS` | tmux session |
| ------------------------ | ------------ |
| 1st                      | `pi`         |
| 2nd                      | `pi2`        |
| 3rd                      | `pi3`        |
| nth                      | `pi<n>`      |

`main` is expected to stay first, which keeps the documented contract
`main -> pi`. Choosing `pi2` for the second entry (instead of a name-derived
`pi-<name>`) means a rollback to two bots reproduces the old layout exactly:
same `pi`/`pi2` names, same attach commands, and no chance of leaving a stale
`pi2` running an old session next to a newly named one.

Trade-off, documented in the usage text: **the order of `TELEGRAM_BOTS` is part
of the contract** — reordering entries renames sessions.

Rejected alternatives:

- `pi-<botname>` for non-`main` bots — order-independent, but renames the
  second session and would leave a pre-existing `pi2` running unattended,
  double-registering the same bot against the gateway.
- Keeping an explicit `inspilot -> pi2` alias — still hardcodes the bot that
  was just disabled, and would keep a dead mapping forever.

### 2. One shared resolver

New `scripts/lib/bots.sh`, sourced (not executed) by the three scripts:

- `bots_init <repo_dir>` — reads the **first active** `TELEGRAM_BOTS=` line from
  `<repo_dir>/.env` (same first-wins rule as `loadEnvFile()` in `src/lib.mjs`),
  splits on `,`, accepts `name=token` and `name:token`, lowercases names, and
  fills `BOT_NAMES[]` / `SESSIONS[]` in `.env` order.
- `session_for_bot <name>` — prints the session or fails with
  `no session mapping for bot 'x' (configured bots: …)`.
- `bots_warn_unmanaged_sessions` — warns (stderr, non-destructive) about a
  running `pi<N>` session that no configured bot maps to, so a leftover `pi2`
  is visible instead of silently ignored.

Only names are ever parsed and printed; token values are never echoed, so no
secret can reach logs or docs.

### 3. Failure matrix (all exit 1, all before any tmux/mount action)

| condition | message |
| --- | --- |
| `.env` missing | `missing /path/.env` |
| `TELEGRAM_BOTS` absent, empty or whitespace | `TELEGRAM_BOTS is empty in …; expected name=token[,name=token]` |
| entry without `=`/`:` or empty name/token | `TELEGRAM_BOTS entry #n is malformed; expected name=token` |
| name outside `[A-Za-z0-9_-]` | `invalid bot name in TELEGRAM_BOTS entry #n (allowed: letters, digits, _ and -)` |
| duplicate name | `duplicate bot name in TELEGRAM_BOTS: <name>` |
| bot argument not configured | `no session mapping for bot '<arg>' (configured bots: …)` |

No fallback starts a session for an unlisted bot, and no argument silently
becomes a Pi argument.

### 4. CLI changes

- `start-two-pi-sessions.sh [--dry-run] [<bot> ...] [-- <pi args...>]`
  - no bot arguments → every bot in `TELEGRAM_BOTS` starts (the old default);
  - explicit bots must be configured, otherwise the `no session mapping` error
    above (this is the replacement for the removed `main inspilot` default);
  - `--` separates bot names from Pi arguments (previously the third positional
    argument started Pi args; that is now ambiguous with a variable bot count).
- `restart_all_tmux_pi.sh [--dry-run]` — resolves sessions from `.env`, stops
  only those, then delegates to the launcher. Unknown arguments are a usage
  error instead of being forwarded blindly.
- `restart-inbound-c.sh [all|gateway] [--dry-run]` — resolves sessions from
  `.env`; in dry-run it prints the kill/start plan without killing, without
  `sleep 3`, without rotating `gateway.log` and without touching the gateway.

### 5. Unchanged behaviour

Gateway startup command, proxy selection, `/health` readiness loops, mount
handling, per-bot `TELEGRAM_BOT_<NAME>_INBOUND_TOKEN` validation and the
"leave an existing session running" rule are all preserved. `--dry-run` exits
before any command checks, so it is safe to run anywhere and starts nothing.

## Verification

1. `bash -n` on all four scripts (three changed + the new library).
2. `scripts/start-two-pi-sessions.sh --dry-run` with the current single-bot
   `.env` → exactly `main -> pi`, sessions list is `pi`, no `pi2` anywhere.
3. `scripts/restart_all_tmux_pi.sh --dry-run` and
   `scripts/restart-inbound-c.sh --dry-run` → same resolution, no kill/start.
4. Two-bot behaviour checked against a throwaway `.env` in `.tmp/` (no real
   tokens): `main` -> `pi`, `inspilot` -> `pi2`.
5. Negative paths: missing `.env`, empty `TELEGRAM_BOTS`, malformed entry,
   unknown bot argument → each fails with the specific message above; output is
   checked to contain no token text.
6. `tmux ls` and `pgrep -f src/gateway.mjs` compared before/after; no session
   started, stopped or restarted, no leftover test processes.

## Verification results

- `bash -n` clean on `scripts/lib/bots.sh`,
  `scripts/start-two-pi-sessions.sh`, `scripts/restart-inbound-c.sh`,
  `scripts/restart_all_tmux_pi.sh`. `shellcheck` is not installed here.
- Single-bot `.env` (current):
  - `start-two-pi-sessions.sh --dry-run` → `1 bot(s) configured …: main`,
    `bot main -> tmux session pi`, `sessions: pi`;
  - `restart_all_tmux_pi.sh --dry-run` → `tmux session 'pi' (bot main) is not
    running` + the same resolution;
  - `restart-inbound-c.sh --dry-run` → `配置: main -> pi`, one kill candidate
    (`pi`), `启动 1 个会话`; `gateway --dry-run` prints the gateway plan only;
  - across all three dry-runs, occurrences of `pi2`: **0**; every line of the
    launcher dry-run starts with `dry-run:`, so no config value other than the
    validated names can appear.
- Two-bot fixture (throwaway `.env` under `.tmp/`, fake tokens): `main -> pi`,
  `inspilot -> pi2`, `sessions: pi pi2`; `restart_all` and `restart-inbound`
  resolve the same pair. Fixture removed afterwards.
- Also exercised: quoted `TELEGRAM_BOTS="alpha=…,beta:…"` (colon form) →
  `alpha -> pi`, `beta -> pi2`.
- Negative paths, all exit 1 with the specific message and no token text:
  missing `.env`; empty `TELEGRAM_BOTS`; `TELEGRAM_BOTS=main` (malformed);
  duplicate names (`main`, `MAIN`); invalid name (`second.bot`); unknown bot
  argument (`start-two-pi-sessions.sh --dry-run inspilot` →
  `no session mapping for bot 'inspilot' (configured bots: main)`);
  Pi args without `--` (`--model` → same mapping error).
- Usage guards: `restart-inbound-c.sh bogus` → exit 64;
  `restart_all_tmux_pi.sh bogus` → exit 64; `restart_all_tmux_pi.sh --help`
  forwards to the launcher's usage (exit 0).
- Unchanged runtime: `tmux ls` before and after is identical
  (`pi-telegram-gateway`, `pi2-scripts-coding`); gateway PID unchanged; no
  `pi`/`pi2` session created; `gateway.log` mtime unchanged (no rotation).
  No test process or fixture left behind.

## Risks / notes

- A pre-existing `pi2` from the old two-bot setup is **not** killed by these
  scripts (killing unknown sessions is unsafe — `pi2-scripts-coding` exists).
  It is reported as unmanaged so the operator can stop it deliberately.
- `README.md` documents the old `alpha beta [pi args...]` invocation and the
  inspilot example; the launch section is updated to the `.env`-driven
  interface so it does not advertise a command that now fails.

## Rollback

`git checkout -- scripts/ README.md` and delete `scripts/lib/bots.sh`; the
scripts then hardcode `pi`/`pi2` again. Nothing in `.env` or the gateway is
touched by this change, so no gateway restart is involved in rollback either.
