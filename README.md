# Pi Super-Agent

A Super-Agent built on [Pi](https://pi.dev), tmux and a Telegram bot.

Pi is the superior agent. It receives tasks over Telegram, dispatches coding
CLIs into named tmux sessions, inspects the tmux state on a cron reminder,
updates a daily task document, and reports back. **Pi does not write code
itself** — coding work is planned and executed by the CLI it dispatches.

The example configuration uses [Codex](https://github.com/openai/codex) for
both stages. Any coding CLI can be substituted; see
[Coding CLIs](#coding-clis).

## Architecture

```
Telegram user ──► Telegram Bot API ──► gateway (tmux: pi-telegram-gateway)
                                          │  WebSocket /inbound
                                          ▼
                                 Pi TUI (tmux: pi) + extensions/telegram-mirror.mjs
                                 system prompt: ~/.pi/agent/APPEND_SYSTEM.md
                                          │ dispatches, never codes itself
                                          ▼
                      coding CLI in named tmux sessions (default: codex exec)
cron ──► scripts/tmux-inspect.sh ──► gateway webhook ──► Pi: "inspect all tmux sessions"
                                          └► Pi updates <workspace>/Docs/YYYYMMDD-daily-tasks.md
```

The setup uses one bot named `main`, one gateway and one Pi session. The
gateway code still supports several bots; the setup scripts and this guide
describe the single-bot layout.

- The **gateway** speaks to the Telegram Bot API (polling by default, webhooks
  optional), forwards allowed updates to Pi over a WebSocket, and exposes an
  authenticated local API for outbound messages.
- **Pi** runs in the tmux session `pi` with `extensions/telegram-mirror.mjs`. It
  receives Telegram messages, dispatches coding work, and mirrors its replies
  back to Telegram.
- The **coding CLI** runs in a separate named tmux session per task, with output
  tee'd to `.tmp/<cli>-<task>-coding.log`. Pi never blocks on it.
- **Inspection** is event-driven. A cron job injects a reminder through the
  gateway; only then does Pi inspect every tmux session, repair what failed, and
  update the daily task document.

## Quick start

Requirements: a Linux machine with a supported package manager (apt, dnf, yum,
pacman, zypper or apk), `sudo` unless running as root, and a Telegram bot
created with [@BotFather](https://t.me/BotFather).

```bash
git clone https://github.com/ken196502/pi-telegram-server.git
cd pi-telegram-server
./setup.sh
```

`setup.sh` asks first for:

1. the **Telegram bot token** (input hidden, never echoed or logged), and
2. your **Telegram user ID** (numeric; send `/start` to the bot and use the ID
   reported by a bot such as `@userinfobot` if you do not know it).

It then detects the distribution and installs only what is missing: tmux,
Node.js >= 22.19, Pi, and the npm dependencies. It verifies the token with
`getMe` **before** writing `.env`, writes `.env` with mode 600, installs
`config/APPEND_SYSTEM.md` to `~/.pi/agent/APPEND_SYSTEM.md`, warns if `codex` is
missing, and starts the gateway and Pi in tmux.

Non-interactive:

```bash
PI_TG_BOT_TOKEN='123456:...' PI_TG_USER_ID='123456789' ./setup.sh
```

Missing credentials with no terminal is an error; there is no default token or
user ID.

### Options

| Option | Meaning |
| --- | --- |
| `--workspace <dir>` | Pi working directory (default `$HOME`) |
| `--dry-run` | Print every action; write and start nothing |
| `--force-env` | Replace an existing `.env` (timestamped backup first) |
| `--force-prompt` | Replace a differing `~/.pi/agent/APPEND_SYSTEM.md` (backup first) |
| `--with-cron` | Install the inspection cron entry |
| `--cron-interval <n>` | Inspection interval in minutes (default 20) |
| `--skip-packages` | Do not install tmux/Node.js/Pi/npm deps; fail if a command is missing |

A conflicting `.env` or prompt file stops setup instead of merging silently.

## Coding CLIs

The default prompt in `config/APPEND_SYSTEM.md` dispatches coding work to
`codex exec`, first for a plan and then for execution:

```bash
# plan
codex exec --sandbox workspace-write -C <workdir> \
  "<task> Write Docs/Plan-<Topic>.md. Do not implement it yet."

# execute
codex exec --sandbox workspace-write -C <workdir> \
  "Implement Docs/Plan-<Topic>.md and verify it."
```

Each dispatch runs in a named tmux session such as
`codex-refresh-auth-coding`, and output is tee'd to
`.tmp/codex-refresh-auth-coding.log`.

To use other CLIs, edit `config/APPEND_SYSTEM.md` and reinstall it with
`./setup.sh --force-prompt` (or copy it to `~/.pi/agent/APPEND_SYSTEM.md`
yourself). A common split is Kiro with Opus for planning and CodeBuddy with
DeepSeek for execution:

```bash
# plan with Kiro (Opus)
kiro-cli chat --model claude-opus-5.5 --no-interactive --trust-all-tools \
  "<task> Write Docs/Plan-<Topic>.md. Do not implement it yet."

# execute with CodeBuddy (DeepSeek)
codebuddy --model deepseek-v4.1-flash --dangerously-skip-permissions -p \
  "Implement Docs/Plan-<Topic>.md and verify it."
```

Keep the session prefix (`kiro-`, `codebuddy-`) and the same log convention so
inspection can tell which CLI owns a session.

`setup.sh` does not install Codex. It checks for it and prints the install
command when it is missing, because the default prompt depends on it.

## Inspection

`scripts/tmux-inspect.sh` appends a tmux snapshot to `.tmp/tmux-status.log`
(kept to the last 2000 lines) and injects a reminder into Pi through the
gateway webhook. The reminder asks Pi to inspect every tmux session, repair
failures by dispatching the coding CLI (plan first, then execute), avoid
re-running tasks blocked by external causes, and update the daily task document
only when something changed.

```bash
scripts/tmux-inspect.sh --dry-run   # snapshot, busy decision, target, payload
scripts/tmux-inspect.sh --force     # deliver even if Pi looks busy
scripts/tmux-inspect.sh             # normal cron invocation
```

A busy gate reads `GET /health` and skips the reminder while Pi is mid-turn, so
queued reminders do not pile up. If `/health` is unavailable or malformed, the
script logs the reason and delivers anyway — a redundant prompt is cheaper than
a dead inspection loop, and the log makes the drift visible.

A failed webhook POST is not hidden: the HTTP code and error are logged, the
script prints them, and it exits non-zero. There is no `tmux send-keys`
fallback.

Install the cron entry (refuses to add a duplicate):

```bash
./setup.sh --with-cron --cron-interval 20
```

The entry runs every 20 minutes by default:

```
*/20 * * * * /path/to/pi-telegram-server/scripts/tmux-inspect.sh >/dev/null 2>&1
```

## Operating

```bash
tmux attach -t pi                    # Pi TUI
tmux attach -t pi-telegram-gateway   # gateway console
tmux ls                              # all sessions, including coding tasks
curl -s http://127.0.0.1:3093/health # bot status, counters, inbound registration
tail -f gateway.log                  # gateway log
```

Restart or start both services with:

```bash
scripts/start.sh --workspace "$HOME"
```

`scripts/start.sh` starts the gateway in `pi-telegram-gateway` and Pi in `pi`,
waits up to 45 seconds for `/health` to report `main` connected, and exits
non-zero with the reason on timeout. It leaves already-running sessions alone
and says so. Only explicitly set proxy variables are passed to the gateway;
nothing is auto-detected.

Send an outbound message through the local API:

```bash
npm run send -- --to 123456789 --message 'hello'
npm run send -- --to 123456789 --file /tmp/report.pdf --message 'report'
```

## Configuration reference

`setup.sh` writes `.env` with mode 600:

| Key | Meaning |
| --- | --- |
| `TELEGRAM_BOTS` | Bot list, `main=<token>` in the generated file |
| `TELEGRAM_BOT_MAIN_INBOUND_TOKEN` | Shared secret for the Pi WebSocket registration |
| `WEBHOOK_TOKEN` | Bearer token for the local outbound API |
| `TELEGRAM_BOT_MAIN_ALLOWED_SENDERS` | Comma-separated Telegram user IDs allowed to reach Pi |
| `TELEGRAM_TO` | Chat ID for outbound messages and the inspection reminder |
| `TELEGRAM_POLLING` | `true` uses `getUpdates`; setup defaults to polling |
| `TELEGRAM_HOST` / `TELEGRAM_PORT` | Local bind address (default `127.0.0.1:3093`) |

Optional keys, documented in `.env.example`:

| Key | Meaning |
| --- | --- |
| `TELEGRAM_WEBHOOK_URL` | Public HTTPS URL; when set, the gateway registers a webhook instead of polling |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram `X-Telegram-Bot-Api-Secret-Token` value |
| `TELEGRAM_WEBHOOK_PATH` | Local webhook path (default `/telegram/webhook`) |
| `TELEGRAM_API_BASE_URL` | Bot API base URL override (proxy or compatible gateway) |
| `PI_TELEGRAM_BOT` | Bot the extension registers as; required when several bots are configured |
| `PI_TG_TMUX_SS` | tmux session the extension sends TUI input to (defaults to `$TMUX`, then `pi`) |
| `PI_TG_TYPING_IDLE_MS` | How long "typing…" lasts for a message that starts no agent run |
| `TELEGRAM_DEBUG_TYPING` | `1` logs typing signals and keepalives |
| `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` | Explicit proxy for the gateway |

## Gateway details

The gateway supports both update delivery modes:

- **Polling** (`TELEGRAM_POLLING=true`) is the setup default and needs no public
  URL.
- **Webhooks** use `TELEGRAM_WEBHOOK_URL`; Telegram delivers updates to
  `TELEGRAM_WEBHOOK_PATH`, and `TELEGRAM_WEBHOOK_SECRET` enables the secret
  header check.

Inbound flow: the gateway forwards allowed text and caption updates over a
WebSocket at `ws://<TELEGRAM_HOST>:<TELEGRAM_PORT>/inbound`. The Pi extension
connects and registers as its bot with `TELEGRAM_BOT_MAIN_INBOUND_TOKEN`; the
gateway pushes updates over that connection. This reverse registration is why
no inbound HTTP port is needed per Pi session.

Outbound flow: `POST /webhook` (also `/send`) requires
`Authorization: Bearer <WEBHOOK_TOKEN>` or `X-Webhook-Token`:

```json
{"to":"123456789","message":"hello"}
```

`to` is a numeric chat ID (including negative group IDs) or an `@username`.
Long text is split automatically. Send a local file as a Telegram document:

```json
{"to":"-1001234567890","filePath":"/tmp/report.pdf","message":"weekly report","fileName":"report.pdf","mimetype":"application/pdf"}
```

`npm run send` uses the same endpoint. The extension mirrors complete
assistant text to `TELEGRAM_TO`, keeps the "typing…" indicator alive through
long tool calls, and routes TUI commands and menu keys to the tmux session Pi
runs in. Telegram `/new` (alias `/clear`) starts a fresh conversation in the
same Pi process.

Several bots are still supported by `src/lib.mjs`: list them in
`TELEGRAM_BOTS` as `name=token` pairs, and each bot gets its own webhook path,
inbound token and allowed senders. With several bots configured, a request that
does not name a bot is rejected instead of falling back to the first one. The
setup scripts configure only `main`.

## Security notes

- `.env` contains the bot token and local API token. Keep it mode 600 and never
  commit it; `.gitignore` already excludes `.env`, `.env.bak*` and `*.bak`.
- `TELEGRAM_BOT_MAIN_ALLOWED_SENDERS` is the only gate for who can send tasks
  to Pi. Use numeric user IDs, not usernames.
- The local API and `/health` bind to `127.0.0.1` by default. Do not expose the
  gateway directly to the internet; put an HTTPS reverse proxy in front of the
  webhook path if you use webhooks.
- If a token is ever committed, deleting the file in a new commit does not
  remove it from git history. Revoke and regenerate the token in @BotFather,
  update `.env`, and treat the old token as leaked. Rewriting history is a
  separate, destructive decision.
