# Plan — pi-telegram-server → Pi Super-Agent

Status: plan only, nothing implemented. Written 2026-11-12.

## 1. Source of the requirements

The task was requested over Telegram (sender 5971350987) and recorded in the Pi
session `~/.pi/agent/sessions/--mnt-share-VM-AIGC-pipeline--/2026-11-12T09-01-14-884Z_*.jsonl`.
Translated request:

1. Remove useless code, scripts and docs from `~/Pi/pi-telegram-server`.
2. Integrate `~/.pi/agent/APPEND_SYSTEM.md` into the repo, with the
   AIGC-pipeline-specific content removed and Kiro and CodeBuddy replaced by Codex.
3. Integrate the inspection shell script from the VM directory
   (`/mnt/share/VM/tmux-reminder.sh`, the script `APPEND_SYSTEM.md` names as the cron job).
4. Write a setup bash script that detects the system, installs Node.js, tmux and Pi,
   and starts the gateway and Pi in tmux. It must first ask the user for the
   **Telegram bot token and the Telegram user ID** (clarified in a follow-up message).
5. Rewrite the README entirely in English. It must present the project as a Super-Agent
   built on Pi, tmux and a Telegram bot: Pi is the superior agent that assigns work to
   other coding CLIs, monitors tmux state and updates a daily task document, and never
   writes code itself. It must say the example uses Codex and that this is customizable,
   e.g. Kiro (Opus) for planning and CodeBuddy (DeepSeek) for execution.
6. Push to git when done.

Rules that apply (from `~/.pi/agent/AGENTS.md` and `APPEND_SYSTEM.md`): no fallbacks that
hide problems, clean up test processes after testing, plan in `Docs/` before coding,
generated data in `.gitignore`, real exit codes (`set -o pipefail` + `PIPESTATUS`),
long-running work in named tmux sessions.

## 2. Current state (verified 2026-11-12)

- Branch `main`, in sync with `origin/main` (`https://github.com/ken196502/pi-telegram-server`), HEAD `f75a545`.
- Baseline: `npm test` → 91 tests, 91 pass, 0 fail.
- Uncommitted work that must be preserved (from earlier tasks: inspilot disable, agent-rule merge):
  - Modified: `README.md`, `scripts/restart-inbound-c.sh`, `scripts/restart_all_tmux_pi.sh`,
    `scripts/start-pi-session.sh`, `scripts/start-two-pi-sessions.sh`
  - Deleted: `config/AGENTS.md`
  - Untracked: `scripts/lib/bots.sh`, `Docs/Plan-Disable-Inspilot-Bot.md`,
    `Docs/Plan-Disable-Inspilot-Scripts.md`, `Docs/Plan-Merge-Agent-Rules.md`,
    `Docs/Start-Pi-Session-Gateway-Plan.md`
- Live runtime that must not be disrupted during implementation: tmux sessions `pi`
  (Pi TUI, pane `%203`) and `pi-telegram-gateway`; crontab `*/20 * * * * /mnt/share/VM/tmux-reminder.sh`.

### 2.1 Security finding (blocking for the push step)

`.commandcode/settings.json` is tracked, has been in history since the initial commit
(`f9463d6`), and contains the bot token that is **still the live token in `.env`**.
The origin is on GitHub, so the token should be treated as leaked.

- Deleting the file in a new commit does not remove it from history.
- Required user action: revoke/regenerate the token in @BotFather and update `.env`.
- Rewriting history (e.g. `git filter-repo` + force push) is destructive and is
  **not** part of this plan unless the user explicitly asks for it.

## 3. Target architecture

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

Single bot (`main`), single Pi session (`pi`). The code keeps multi-bot support in
`src/lib.mjs`; only the scripts and docs are simplified to one bot.

## 4. Work items

### Phase 0 — Preserve existing uncommitted work

1. Commit the pre-existing uncommitted changes listed in §2 **as they are**, in one
   commit (`chore: commit pending inspilot/agent-rule work before superagent cleanup`).
   Phase 1 deletes several of those files; committing first keeps their content in history.
2. Do not touch `.env`, `.env.bak-20261106-230030`, `node_modules/`, `.tmp/` or the
   live tmux sessions.

### Phase 1 — Remove unused code, scripts and docs

Delete (tracked, `git rm`):

| Path | Reason |
| --- | --- |
| `.commandcode/settings.json` | Another tool's local permission cache; contains the live bot token (§2.1) |
| `test.log`, `gateway.log.1793460259.bak`, `gateway.log.1793460276.bak` | Generated logs committed by mistake |
| `PLAN.md`, `DEV_PLAN.md`, `MENU_CAPTURE_PLAN.md`, `MENU_IMPLEMENTATION_SUMMARY.md`, `MENU_USAGE_GUIDE.md`, `SHOW_ALL_OPTIONS_PLAN.md`, `plan-fix-telegram-document-upload.md` | Completed historical plans/notes at repo root |
| `Docs/*.md` except this plan | Completed historical plans for one specific VM (inspilot bot, Mihomo egress, OpenCode Zen, virtiofs launcher, etc.) |
| `LinuxAgentSetup.sh` | Replaced by the new `setup.sh` (Phase 3); also depends on the deleted `config/AGENTS.md` and installs opencode, which the request does not include |
| `scripts/restart-inbound-c.sh` | One-off migration to 方案 C, already done |
| `scripts/start-two-pi-sessions.sh`, `scripts/restart_all_tmux_pi.sh`, `scripts/lib/bots.sh` | Multi-bot launcher with hardcoded `/mnt/share/VM` + virtiofs mount and Mihomo proxy auto-detection; replaced by `setup.sh` + `scripts/start.sh` |
| `launchd/`, `systemd/` | Service-manager units; the Super-Agent runs in tmux (see open question Q2) |

Keep: `src/*.mjs`, `extensions/telegram-mirror.mjs`, `test/*.test.mjs`,
`scripts/check-telegram-ready.mjs`, `scripts/start-pi-session.sh` (reworked in Phase 3),
`package.json`, `package-lock.json`, `LICENSE`, `.env.example`.

`src/send.mjs` (`npm run send`) stays: it is the documented CLI for outbound messages.

After deletion, grep for dangling references and fix them:
`grep -rn 'LinuxAgentSetup\|start-two-pi\|restart_all_tmux\|restart-inbound-c\|bots.sh\|config/AGENTS.md\|/mnt/share\|7890\|inspilot\|AIGC' --exclude-dir=node_modules --exclude-dir=.git .`

### Phase 2 — Integrate the agent prompt and the inspection script

**2a. `config/APPEND_SYSTEM.md`** (new, English), derived from `~/.pi/agent/APPEND_SYSTEM.md`:

- Keep: Pi never writes code itself; plan-then-execute; every coding task in a named
  tmux session `<cli>-<task>-coding` with output tee'd to `.tmp/<cli>-<task>-coding.log`;
  report attach/capture/kill commands; do not poll after dispatch; inspection is
  event-driven (cron reminder only); coding rules (no hiding fallbacks, clean up test
  processes, plan md in `Docs/`, generated data in `.gitignore`); real exit codes.
- Replace Kiro and CodeBuddy with Codex for both roles:
  - plan: `codex exec --sandbox workspace-write -C <workdir> "<prompt: write Docs/Plan-<Topic>.md, do not implement>"`
  - execute: `codex exec --sandbox workspace-write -C <workdir> "<prompt: implement Docs/Plan-<Topic>.md>"`
  - session prefix `codex-`. Exact flags are verified against `codex exec --help`
    (installed: codex-cli 0.166.0) during implementation.
- Remove AIGC-pipeline content: the `[supervisor] done` kill rule, xdev/xhot/flowTutor,
  `/mnt/share/VM` paths, manifest/pipeline specifics, the Kiro 429 retry rule.
  Keep a generic rule: do not kill a tmux session until its task has visibly finished
  (pane command is the idle shell/`sleep`, log shows the final `EXIT=`/`rc=` line).
- Add the daily task document rule: on each inspection, update
  `<workspace>/Docs/YYYYMMDD-daily-tasks.md` only when something changed, with evidence.
- Add a short "customizing the coding CLIs" section (Kiro Opus for planning, CodeBuddy
  DeepSeek for execution) as an example of what users can swap in.

`setup.sh` installs this file to `~/.pi/agent/APPEND_SYSTEM.md`. If the destination
exists and differs, setup stops with an error naming the file, unless `--force-prompt`
is given; with `--force-prompt` it writes a timestamped backup first. It never merges
silently. **This machine's live `~/.pi/agent/APPEND_SYSTEM.md` is not modified by the
implementation** (the live system still runs the AIGC pipelines with Kiro/CodeBuddy).

**2b. `scripts/tmux-inspect.sh`** (new), derived from `/mnt/share/VM/tmux-reminder.sh`:

- Keep: tmux snapshot appended to a bounded log, `/health` busy gate,
  `--dry-run`, `--force`, env overrides used by tests.
- Make it repo-relative: `.env` from the repo, log at `<repo>/.tmp/tmux-status.log`,
  no `/mnt/share/VM/AIGC-pipeline`.
- Replace the reminder text with a generic English prompt: inspect every tmux session,
  repair failures by dispatching the coding CLI (plan first, then execute), do not
  re-run tasks blocked by external causes, update the daily task document when
  something changed. Drop the pipeline names, pane `%203` and the `/clear` procedure
  (see open question Q4).
- No hiding fallbacks: remove the `tmux send-keys` delivery fallback; a failed webhook
  POST logs the HTTP code/error and exits non-zero. Keep the existing documented,
  logged "health unavailable → deliver anyway" behavior.
- Write temp files under `<repo>/.tmp/` instead of `/tmp/tmux-reminder.*`.
- Sender: `TELEGRAM_TO`; if empty, exit with an error instead of using `0`.

`/mnt/share/VM/tmux-reminder.sh` and the existing crontab entry are left untouched.

### Phase 3 — `setup.sh` and `scripts/start.sh`

**`setup.sh`** (new, repo root, `set -euo pipefail`, idempotent):

1. Prompt first, before installing anything:
   - Telegram bot token (read with `read -rs`, never echoed or logged); validate format
     `^[0-9]+:[A-Za-z0-9_-]+$`.
   - Telegram user ID; validate `^[0-9]+$`.
   - Non-interactive alternative: `PI_TG_BOT_TOKEN` / `PI_TG_USER_ID` env vars. Missing
     values with no TTY → error, never a default.
2. Detect the system (reuse the detection logic from `LinuxAgentSetup.sh`:
   apt/dnf/yum/pacman/zypper/apk; see Q1 for macOS). Unsupported → error.
3. Install only what is missing: tmux, Node.js ≥ 22.19 (same version gate as today),
   Pi via `https://pi.dev/install.sh`, then `npm ci` in the repo.
4. Verify the token with `getMe` before writing anything. Failure → stop with the
   Telegram error description.
5. Write `.env` (mode 600): `TELEGRAM_BOTS=main=<token>`, random
   `TELEGRAM_BOT_MAIN_INBOUND_TOKEN` and `WEBHOOK_TOKEN` (`openssl rand -hex 32`),
   `TELEGRAM_BOT_MAIN_ALLOWED_SENDERS=<uid>`, `TELEGRAM_TO=<uid>`,
   `TELEGRAM_POLLING=true` (no public URL is assumed), `TELEGRAM_HOST=127.0.0.1`,
   `TELEGRAM_PORT=3093`. Existing `.env` → stop unless `--force-env`, which backs it up first.
6. Install `config/APPEND_SYSTEM.md` (rules in 2a).
7. Check for `codex`; if absent, print a clear warning with the install command and the
   note that the default prompt depends on it (see Q3). It is not a silent skip.
8. Install the cron entry for `scripts/tmux-inspect.sh` only with `--with-cron`
   (interval flag `--cron-interval <min>`, default 20 to match the live crontab).
   Refuse to add a duplicate entry.
9. Run `scripts/start.sh`.
10. Flags: `--workspace <dir>` (Pi working directory, default `$HOME`), `--dry-run`,
    `--force-env`, `--force-prompt`, `--with-cron`, `--skip-packages`, `--help`.

**`scripts/start.sh`** (replaces the multi-bot launcher): start gateway in tmux
`pi-telegram-gateway` and Pi in tmux `pi` (via `scripts/start-pi-session.sh main pi`),
wait for `/health` to report the `main` bot connected, exit non-zero with the reason on
timeout. Leave already-running sessions alone and say so. Only explicit proxy env vars
are used; the Mihomo `127.0.0.1:7890` auto-detection in `start-pi-session.sh` is removed.

### Phase 4 — README (English, full rewrite)

Sections:
1. What it is: a Super-Agent built on Pi, tmux and a Telegram bot. Pi is the superior
   agent: it receives tasks over Telegram, dispatches coding CLIs into named tmux
   sessions, inspects tmux state on a cron reminder, updates the daily task document,
   and does not write code itself.
2. Architecture diagram (§3).
3. Quick start: `git clone …`, `./setup.sh` (prompts for bot token and user ID).
4. Coding CLIs: the example uses Codex; how to customize `config/APPEND_SYSTEM.md`,
   with the example of Kiro (Opus) for planning and CodeBuddy (DeepSeek) for execution.
5. Inspection: `scripts/tmux-inspect.sh`, `--dry-run`, cron install.
6. Operating: `tmux attach -t pi`, `tmux attach -t pi-telegram-gateway`, restart, logs.
7. Configuration reference: the `.env` keys from `.env.example`.
8. Gateway details kept from the current README that are still accurate (WebSocket
   inbound, outbound webhook, `npm run send`, typing indicator). Correct the claim that
   the gateway is webhook-only: polling is supported and is the setup default.
9. Security notes: `.env` is 600, allowed senders, never commit tokens.

Also update `package.json` `description`, `keywords`, `files` (remove `systemd/`,
`launchd/`; add `config/`, `setup.sh`), and trim `.env.example` to the single-bot keys
plus documented optional keys.

### Phase 5 — `.gitignore`

Add: `*.bak`, `.commandcode/`, `.env.bak*`. Existing entries already cover `.tmp/`,
`tmp/`, `*.log`, `.env`, `node_modules/`. Verify with `git status --ignored`.

### Phase 6 — Validation

All long commands run in a named tmux session (`codex-superagent-test-coding`) with
`set -o pipefail` and `rc=${PIPESTATUS[0]}`.

1. `npm run check` and `npm test` → 91/91 still pass (tests do not reference deleted files).
2. `bash -n` and `shellcheck` (if installed) on `setup.sh`, `scripts/*.sh`.
3. `./setup.sh --dry-run` with `PI_TG_BOT_TOKEN`/`PI_TG_USER_ID` set: prints every
   action, writes nothing, starts nothing. Invalid token/ID → non-zero with a message.
4. `setup.sh` in an isolated `HOME` (temp dir under `.tmp/`) with `--skip-packages`,
   a fake token, and `TMUX_TMPDIR` pointed at a private socket dir so no live tmux
   session is touched: confirm `getMe` failure stops setup before `.env` is written.
5. `scripts/tmux-inspect.sh --dry-run` with `TMUX_REMINDER_HEALTH_JSON` for BUSY, IDLE and
   malformed payloads; a webhook POST to a closed local port exits non-zero.
6. Reference grep from Phase 1 returns no hits outside this plan.
7. Cleanup: kill only the tmux sessions/sockets created by the test, remove the temp
   `HOME`, then confirm `pgrep -af 'node --test|tmux-inspect|setup.sh'` is empty and
   `tmux ls` still shows the live `pi` and `pi-telegram-gateway` unchanged.

Not validated here: a real install on a fresh machine and a live run against a new bot.
Those need a clean VM and a real token and are reported as not verified.

### Phase 7 — Commit and push

1. Commits: Phase 0 commit (already done), then `chore: remove obsolete scripts, docs and logs`,
   `feat: add setup.sh, start.sh, APPEND_SYSTEM template and tmux inspection`,
   `docs: rewrite README for the Pi Super-Agent`.
2. Stage files by name; no `git add -A`.
3. `git push origin main` (fast-forward only, no force).
4. Before pushing, report §2.1 to the user. The push does not add new exposure, but the
   token stays in history until the user decides on a rewrite.

## 5. Open questions (implementation uses the stated default unless the user answers)

- **Q1 — macOS support.** "Detect the system" could include macOS. Default: Linux only
  (the distros `LinuxAgentSetup.sh` supports today); macOS exits with "unsupported".
- **Q2 — `systemd/` and `launchd/` units.** Default: delete, because the Super-Agent
  needs Pi in tmux and these units only start the gateway.
- **Q3 — Install Codex in `setup.sh`?** The request lists only Node.js, tmux and Pi.
  Default: detect and warn, do not install.
- **Q4 — `/clear` after each inspection.** The live reminder makes Pi send `/clear` to
  its own pane. Default: not included in the generic prompt; documented in the README as
  an optional customization.
- **Q5 — Token in git history (§2.1).** Default: revoke the token, no history rewrite.

## 6. Rollback

Every step is a separate commit on `main`; `git revert <sha>` undoes it. Deleted files
remain in history. The live `~/.pi/agent/APPEND_SYSTEM.md`, `/mnt/share/VM/tmux-reminder.sh`,
crontab, `.env` and running tmux sessions are not modified by this work.
