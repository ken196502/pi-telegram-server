# Telegram Service

A small Telegram Bot API gateway for Pi. It is webhook-only: the process never polls `getUpdates`. Telegram delivers updates to the configured webhook path, while an authenticated local webhook sends text and files through `sendMessage`/`sendDocument`.

## Setup

```bash
npm install
cp .env.example .env
```

Create a bot with BotFather and set `TELEGRAM_BOT_TOKEN` and a random `WEBHOOK_TOKEN`. To receive messages, expose the service over HTTPS and set `TELEGRAM_WEBHOOK_URL`; startup registers it with Telegram. If a reverse proxy terminates TLS, proxy that URL to the local `TELEGRAM_WEBHOOK_PATH` (default `/telegram/webhook`). `TELEGRAM_WEBHOOK_SECRET` enables Telegram's `X-Telegram-Bot-Api-Secret-Token` check.

```bash
npm start
```

## Multiple bots

One gateway process can serve several bots. List them in `TELEGRAM_BOTS` as `name=token` pairs (or `name:token`), keeping `WEBHOOK_TOKEN` as the single local API token:

```bash
TELEGRAM_BOTS=alpha=123456:token-a,beta=654321:token-b
TELEGRAM_WEBHOOK_URL=https://bot.example.com/telegram/webhook
```

Each bot gets its own webhook path (`/telegram/webhook/alpha`, `/telegram/webhook/beta`), inbound forwarding, allowed senders, parse mode, message limit and polling flag. Global `TELEGRAM_*` values are defaults; override any of them per bot with `TELEGRAM_BOT_<NAME>_<FIELD>` (for example `TELEGRAM_BOT_BETA_ALLOWED_SENDERS=222` or `TELEGRAM_BOT_BETA_WEBHOOK_SECRET=...`). With a single `TELEGRAM_BOT_TOKEN` and no `TELEGRAM_BOTS`, the bot is named `default` and keeps the original `/telegram/webhook` path.

Outbound requests choose a bot with the `bot` field, the `X-Telegram-Bot` header, `?bot=name`, or the `/webhook/<name>` path. The first configured bot is the default:

```json
{"bot":"beta","to":"123456789","message":"hello from beta"}
```

Forwarded inbound updates include `"bot":"<name>"` so a Pi extension can filter on it. `GET /health` reports aggregate counters plus a `bots` object with per-bot status.

## Outbound API

`POST /webhook` (also `/send`) requires `Authorization: Bearer <WEBHOOK_TOKEN>` or `X-Webhook-Token`.

```json
{"to":"123456789","message":"hello"}
```

`to` is a numeric chat ID (including negative group IDs) or an `@username`. Long text is split automatically. Send a local file as a Telegram document:

```json
{"to":"-1001234567890","filePath":"/tmp/report.pdf","message":"weekly report","fileName":"report.pdf","mimetype":"application/pdf"}
```

The CLI uses the same endpoint:

```bash
npm run send -- --to 123456789 --message 'hello'
npm run send -- --to 123456789 --file /tmp/report.pdf --message 'report'
npm run send -- --bot beta --to 123456789 --message 'hello from beta'
```

## Pi extension and inbound bridge

Set `TELEGRAM_INBOUND_URL` and `INBOUND_WEBHOOK_TOKEN` in the service, plus `TELEGRAM_INBOUND_ALLOWED_SENDERS` (comma-separated Telegram user IDs). The gateway forwards allowed text/caption updates to Pi. Start Pi with:

```bash
pi --extension ./extensions/telegram-mirror.mjs
```

The extension listens locally for forwarded updates and mirrors complete assistant text to `PI_TELEGRAM_TO` through the outbound webhook. When several bots are configured, set `PI_TELEGRAM_BOT` to the bot this Pi session should use; the extension sends that name with every outbound call and ignores forwarded updates addressed to other bots. It never starts a second Pi process.

## Health and security

`GET /health` is unauthenticated and reports Bot API status and counters. Keep the service bound to loopback behind an HTTPS reverse proxy, use strong independent tokens, and keep `.env` out of version control. Telegram webhooks require a publicly reachable HTTPS URL (or Telegram's supported local-mode setup).
