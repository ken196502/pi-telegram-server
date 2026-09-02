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
```

## Pi extension and inbound bridge

Set `TELEGRAM_INBOUND_URL` and `INBOUND_WEBHOOK_TOKEN` in the service, plus `TELEGRAM_INBOUND_ALLOWED_SENDERS` (comma-separated Telegram user IDs). The gateway forwards allowed text/caption updates to Pi. Start Pi with:

```bash
pi --extension ./extensions/telegram-mirror.mjs
```

The extension listens locally for forwarded updates and mirrors complete assistant text to `PI_TELEGRAM_TO` through the outbound webhook. It never starts a second Pi process.

## Health and security

`GET /health` is unauthenticated and reports Bot API status and counters. Keep the service bound to loopback behind an HTTPS reverse proxy, use strong independent tokens, and keep `.env` out of version control. Telegram webhooks require a publicly reachable HTTPS URL (or Telegram's supported local-mode setup).
