#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import undici from "undici";
import { loadEnvFile, toTelegramChatId, splitMessage, guessMimeType, isAllowedSender, markdownToMarkdownV2, markdownToHtml, formatJsonForTelegram, extractReplyInfo, resolveBotConfigs, normalizeBotName, matchSensitiveFile } from "./lib.mjs";

const { FormData: UndiciFormData, ProxyAgent, fetch: undiciFetch } = undici;

loadEnvFile(path.resolve(".env"));
const config = {
  webhookToken: process.env.TELEGRAM_WEBHOOK_TOKEN || process.env.WEBHOOK_TOKEN || "",
  host: process.env.TELEGRAM_HOST || process.env.HTTP_HOST || "127.0.0.1",
  port: Number.parseInt(process.env.TELEGRAM_PORT || process.env.HTTP_PORT || "3093", 10),
};
if (!config.webhookToken) throw new Error("WEBHOOK_TOKEN is required");

const bots = new Map(resolveBotConfigs(process.env).map((botConfig) => [botConfig.name, {
  config: botConfig,
  status: "starting",
  sent: 0,
  received: 0,
  forwarded: 0,
  lastSentAt: null,
  lastReceivedAt: null,
  typing: new Map(),
}]));
const defaultBot = bots.values().next().value;
const startedAt = Date.now();
const seenUpdates = new Set();
const api = (bot, method) => bot.config.apiBase + "/bot" + bot.config.token + "/" + method;
function resolveBot(value) {
  const requested = value === undefined || value === null ? "" : String(value).trim();
  if (requested) {
    const bot = bots.get(normalizeBotName(requested));
    if (!bot) throw new Error("unknown bot: " + value + "; configured bots: " + [...bots.keys()].join(", "));
    return bot;
  }
  if (bots.size > 1) {
    throw new Error(
      "multiple bots configured (" + [...bots.keys()].join(", ") + "); " +
      "specify the bot in the request and set PI_TELEGRAM_BOT=<name> for this Pi session"
    );
  }
  return defaultBot;
}
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy;
const proxyAgent = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
const isLocalUrl = (url) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1])(:|\/)/i.test(url);
// Always use the undici package's fetch, which matches the UndiciFormData/ProxyAgent instances
// imported above. Node 24's global fetch no longer recognises a standalone-undici FormData and
// silently serialises it as text/plain ("[object FormData]"), which made Telegram reject uploads
// with "Bad Request: there is no document in the request". Attach the proxy dispatcher only when
// a proxy is configured and the target is not local.
const proxyFetch = (url, opts) => undiciFetch(url, proxyAgent && !isLocalUrl(url) ? { ...opts, dispatcher: proxyAgent } : opts);
function log(level, message, fields = {}) { const suffix = Object.keys(fields).length ? " " + JSON.stringify(fields) : ""; process.stderr.write(new Date().toISOString() + " " + level + " " + message + suffix + "\n"); }
function sendJson(res, code, body) { const payload = JSON.stringify(body); res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) }); res.end(payload); }
function readJson(req) { return new Promise((resolve, reject) => { let body = "", size = 0; req.setEncoding("utf8"); req.on("data", (chunk) => { size += Buffer.byteLength(chunk); if (size > 1024 * 1024) { reject(new Error("request body is too large")); req.destroy(); return; } body += chunk; }); req.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error("request body must be valid JSON")); } }); req.on("error", reject); }); }
function authorized(req) { const auth = String(req.headers.authorization || ""); const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : ""; return (bearer || String(req.headers["x-webhook-token"] || "")) === config.webhookToken; }
async function telegramRequest(bot, method, options = {}) {
  const response = await proxyFetch(api(bot, method), options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) throw new Error(body.description || "Telegram API HTTP " + response.status);
  return body.result;
}

function debugTyping() { return process.env.TELEGRAM_DEBUG_TYPING === "1"; }
// Never swallow typing failures silently: a broken indicator must be visible in the log.
function sendTypingAction(bot, chatId) {
  if (debugTyping()) log("debug", "typing signal", { bot: bot.config.name, to: chatId });
  return sendChatAction(bot, chatId, "typing").then((result) => {
    bot.lastTypingAt = new Date().toISOString();
    bot.typingErrors = 0;
    return result;
  }).catch((err) => {
    bot.typingErrors = (bot.typingErrors || 0) + 1;
    log("warn", "sendChatAction failed", { bot: bot.config.name, to: chatId, error: err.message, consecutive: bot.typingErrors });
    throw err;
  });
}

function startTypingKeepalive(bot, to) {
  const chatId = toTelegramChatId(to);
  let entry = bot.typing.get(chatId);
  if (!entry) {
    void sendTypingAction(bot, chatId).catch(() => {});
    const interval = setInterval(() => {
      void sendTypingAction(bot, chatId).catch(() => {});
    }, 4000);
    entry = { interval, timeout: null };
    bot.typing.set(chatId, entry);
    if (debugTyping()) log("debug", "typing keepalive started", { bot: bot.config.name, to: chatId });
  }
  // Refresh watchdog timeout on each typing signal
  if (entry.timeout) clearTimeout(entry.timeout);
  entry.timeout = setTimeout(() => {
    stopTypingKeepalive(bot, chatId);
  }, 120000);
}

function stopTypingKeepalive(bot, to) {
  const chatId = toTelegramChatId(to);
  const existing = bot.typing.get(chatId);
  if (existing) {
    clearInterval(existing.interval);
    if (existing.timeout) clearTimeout(existing.timeout);
    bot.typing.delete(chatId);
    if (debugTyping()) log("debug", "typing keepalive stopped", { bot: bot.config.name, to: chatId });
  }
}

async function sendText(bot, to, text) {
  const chatId = toTelegramChatId(to);
  stopTypingKeepalive(bot, chatId);
  const chunks = splitMessage(text, bot.config.messageLimit);
  if (!chunks.length) throw new Error("message is required");
  const messageIds = [];
  const useMdv2 = bot.config.parseMode === "MARKDOWNV2";
  for (const chunk of chunks) {
    const formatted = useMdv2 ? markdownToMarkdownV2(chunk) : markdownToHtml(chunk);
    const parseMode = useMdv2 ? "MarkdownV2" : "HTML";
    try {
      const result = await telegramRequest(bot, "sendMessage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: formatted, parse_mode: parseMode })
      });
      messageIds.push(result.message_id);
      bot.sent += 1;
      bot.lastSentAt = new Date().toISOString();
    } catch (err) {
      log("warn", parseMode + " sendMessage failed, falling back to plain text", { bot: bot.config.name, error: err.message });
      const result = await telegramRequest(bot, "sendMessage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: chunk })
      });
      messageIds.push(result.message_id);
      bot.sent += 1;
      bot.lastSentAt = new Date().toISOString();
    }
  }
  return { to: chatId, messageIds, bot: bot.config.name };
}
async function sendChatAction(bot, to, action = "typing") {
  const chatId = toTelegramChatId(to);
  const result = await telegramRequest(bot, "sendChatAction", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action }),
  });
  return { to: chatId, action, bot: bot.config.name, result };
}

async function sendDocument(bot, to, filePath, fileName, mimetype, caption) {
  const chatId = toTelegramChatId(to);
  stopTypingKeepalive(bot, chatId);
  if (typeof filePath !== "string" || !filePath.trim()) throw new Error("filePath is required");
  const resolved = path.resolve(filePath.trim()); let stat; try { stat = fs.statSync(resolved); } catch (e) { if (e.code === "ENOENT") throw new Error("filePath does not exist"); throw new Error("cannot read filePath: " + e.message); }
  if (!stat.isFile()) throw new Error("filePath must reference a regular file");
  try { fs.accessSync(resolved, fs.constants.R_OK); } catch { throw new Error("filePath is not readable"); }
  const blocked = matchSensitiveFile(resolved);
  if (blocked) {
    const err = new Error(`refusing to send sensitive credential file: ${path.basename(resolved)} (matched ${blocked})`);
    err.statusCode = 403;
    throw err;
  }
  const name = typeof fileName === "string" && fileName.trim() ? fileName.trim() : path.basename(resolved);
  const type = typeof mimetype === "string" && mimetype.trim() ? mimetype.trim() : guessMimeType(name);
  const form = new UndiciFormData(); form.append("chat_id", chatId); form.append("document", new File([fs.readFileSync(resolved)], name, { type }));
  if (typeof caption === "string" && caption.trim()) form.append("caption", caption.trim());
  const result = await telegramRequest(bot, "sendDocument", { method: "POST", body: form }); bot.sent += 1; bot.lastSentAt = new Date().toISOString();
  return { to: chatId, messageIds: result?.message_id ? [result.message_id] : [], fileName: name, mimetype: type, bot: bot.config.name };
}
async function handleOutbound(req, res, botName) {
  if (!authorized(req)) return sendJson(res, 401, { ok: false, error: "unauthorized" });
  let body; try { body = await readJson(req); } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  let bot;
  try { bot = resolveBot(botName ?? body?.bot ?? body?.botName); } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  const to = body?.to ?? body?.chatId ?? body?.recipient;
  const action = body?.action;
  if (action) {
    try {
      if (action === "typing") {
        startTypingKeepalive(bot, to);
        return sendJson(res, 200, { ok: true, bot: bot.config.name, to, action });
      }
      if (action === "stop_typing") {
        stopTypingKeepalive(bot, to);
        return sendJson(res, 200, { ok: true, bot: bot.config.name, to, action });
      }
      const result = await sendChatAction(bot, to, action);
      return sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      return sendJson(res, e?.statusCode || (bot.status === "connected" ? 400 : 503), { ok: false, error: e.message });
    }
  }

  const jsonPayload = body?.json ?? body?.data ?? body?.log;
  if (jsonPayload !== undefined) {
    try {
      let parsed = jsonPayload;
      if (typeof jsonPayload === "string") {
        try { parsed = JSON.parse(jsonPayload); } catch {}
      }
      const rawFormatted = formatJsonForTelegram(parsed, body?.options || {});
      if (rawFormatted.length <= bot.config.messageLimit) {
        const result = await sendText(bot, to, rawFormatted);
        return sendJson(res, 200, { ok: true, ...result });
      }
      // If JSON payload is very large, save to temporary file and send as a document attachment
      const tmpFile = path.resolve("/tmp/log-" + Date.now() + ".json");
      const rawText = typeof jsonPayload === "string" ? jsonPayload : JSON.stringify(jsonPayload, null, 2);
      fs.writeFileSync(tmpFile, rawText, "utf8");
      try {
        const caption = body?.caption || "📄 JSON Log (" + (Buffer.byteLength(rawText) / 1024).toFixed(1) + " KB)";
        const result = await sendDocument(bot, to, tmpFile, body?.fileName || "log-" + Date.now() + ".json", "application/json", caption);
        return sendJson(res, 200, { ok: true, ...result });
      } finally {
        try { fs.unlinkSync(tmpFile); } catch {}
      }
    } catch (e) {
      return sendJson(res, e?.statusCode || (bot.status === "connected" ? 400 : 503), { ok: false, error: e.message });
    }
  }

  const message = body?.message ?? body?.text ?? body?.body ?? ""; const filePath = body?.filePath ?? body?.file ?? body?.path;
  if ((typeof message !== "string" || !message.trim()) && (typeof filePath !== "string" || !filePath.trim())) return sendJson(res, 400, { ok: false, error: "message or filePath is required" });
  try { const result = filePath ? await sendDocument(bot, to, filePath, body?.fileName, body?.mimetype ?? body?.mimeType, message) : await sendText(bot, to, message); sendJson(res, 200, { ok: true, ...result }); }
  catch (e) { sendJson(res, e?.statusCode || (bot.status === "connected" ? 400 : 503), { ok: false, error: e.message }); }
}
async function forwardInbound(bot, payload) {
  if (!bot.config.inboundUrl || !bot.config.inboundToken) return;
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10000);
  try { const response = await proxyFetch(bot.config.inboundUrl, { method: "POST", headers: { authorization: "Bearer " + bot.config.inboundToken, "content-type": "application/json" }, body: JSON.stringify(payload), signal: controller.signal }); if (!response.ok) throw new Error("HTTP " + response.status + ": " + await response.text()); bot.forwarded += 1; } finally { clearTimeout(timer); }
}
function updateMessage(update) { return update?.message || update?.edited_message || update?.channel_post || update?.edited_channel_post || null; }
function processUpdate(bot, update) {
  const message = updateMessage(update); const text = String(message?.text || message?.caption || "").trim();
  const updateId = String(update?.update_id ?? ""); const seenKey = bot.config.name + ":" + updateId;
  if (updateId && seenUpdates.has(seenKey)) return;
  if (updateId) { seenUpdates.add(seenKey); while (seenUpdates.size > 1000) seenUpdates.delete(seenUpdates.values().next().value); }
  if (text) {
    const chatId = message?.chat?.id; const senderId = message?.from?.id ?? chatId;
    if (chatId !== undefined && isAllowedSender(senderId, bot.config.allowedSenders)) {
      bot.received += 1;
      bot.lastReceivedAt = new Date().toISOString();
      const canForward = Boolean(bot.config.inboundUrl && bot.config.inboundToken);
      if (canForward) startTypingKeepalive(bot, String(chatId));
      const replyTo = extractReplyInfo(message);
      void forwardInbound(bot, {
        type: "telegram_message",
        bot: bot.config.name,
        messageId: updateId + ":" + (message.message_id ?? ""),
        chatId: String(chatId),
        senderId: String(senderId),
        body: text,
        replyTo,
        timestamp: Number(message.date || Math.floor(Date.now() / 1000))
      }).catch((e) => {
        // The Pi session never received the message, so it cannot stop the indicator itself.
        stopTypingKeepalive(bot, String(chatId));
        log("warn", "inbound webhook failed", { bot: bot.config.name, error: e.message });
      });
    }
  }
}
async function handleTelegramWebhook(req, res, bot) {
  if (bot.config.webhookSecret && req.headers["x-telegram-bot-api-secret-token"] !== bot.config.webhookSecret) return sendJson(res, 401, { ok: false, error: "unauthorized" });
  let update; try { update = await readJson(req); } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  processUpdate(bot, update);
  sendJson(res, 200, { ok: true });
}
async function startPolling(bot) {
  let offset = 0;
  log("info", "Starting long-polling mode", { bot: bot.config.name });
  while (true) {
    try {
      const updates = await telegramRequest(bot, "getUpdates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ offset, timeout: 30, allowed_updates: ["message", "edited_message", "channel_post", "edited_channel_post"] }) });
      for (const update of updates) { processUpdate(bot, update); offset = update.update_id + 1; }
    } catch (e) {
      log("error", "Polling error", { bot: bot.config.name, error: e.message });
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
const webhookRoutes = new Map();
for (const bot of bots.values()) webhookRoutes.set(bot.config.webhookPath, bot);
for (const bot of bots.values()) {
  const alias = "/telegram/webhook/" + bot.config.name;
  if (!webhookRoutes.has(alias)) webhookRoutes.set(alias, bot);
}
function startHttp() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://" + config.host);
    if (req.method === "GET" && url.pathname === "/health") {
      const entries = [...bots.values()];
      const connected = entries.filter((b) => b.status === "connected").length;
      const latest = (field) => entries.map((b) => b[field]).filter(Boolean).sort().pop() || null;
      return sendJson(res, 200, {
        ok: true,
        service: "telegram",
        status: connected === entries.length ? "connected" : connected ? "degraded" : "disconnected",
        webhookPath: bots.size === 1 ? defaultBot.config.webhookPath : null,
        defaultBot: bots.size === 1 ? defaultBot.config.name : null,
        inboundEnabled: entries.some((b) => Boolean(b.config.inboundUrl && b.config.inboundToken)),
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        sent: entries.reduce((n, b) => n + b.sent, 0),
        received: entries.reduce((n, b) => n + b.received, 0),
        forwarded: entries.reduce((n, b) => n + b.forwarded, 0),
        lastSentAt: latest("lastSentAt"),
        lastReceivedAt: latest("lastReceivedAt"),
        bots: Object.fromEntries(entries.map((b) => [b.config.name, {
          status: b.status,
          webhookPath: b.config.webhookPath,
          inboundEnabled: Boolean(b.config.inboundUrl && b.config.inboundToken),
          sent: b.sent,
          received: b.received,
          forwarded: b.forwarded,
          lastSentAt: b.lastSentAt,
          lastReceivedAt: b.lastReceivedAt,
          typingActive: b.typing.size > 0,
          lastTypingAt: b.lastTypingAt || null,
          typingErrors: b.typingErrors || 0,
        }])),
      });
    }
    if (req.method === "GET" && url.pathname === "/") return sendJson(res, 200, { ok: true, service: "telegram", bots: [...bots.keys()], endpoints: { health: "GET /health", webhook: "POST /webhook", botWebhook: "POST /webhook/<bot>", telegramWebhook: [...new Set([...bots.values()].map((b) => "POST " + b.config.webhookPath))] } });
    const routeBot = req.method === "POST" ? webhookRoutes.get(url.pathname) : undefined;
    if (routeBot) return handleTelegramWebhook(req, res, routeBot);
    if (req.method === "POST" && ["/webhook", "/send", "/typing"].includes(url.pathname)) return handleOutbound(req, res, url.searchParams.get("bot"));
    const parts = url.pathname.split("/").filter(Boolean);
    if (req.method === "POST" && parts.length === 2 && ["webhook", "send", "typing"].includes(parts[0])) return handleOutbound(req, res, decodeURIComponent(parts[1]));
    sendJson(res, req.method === "POST" ? 404 : 405, { ok: false, error: "not found" });
  });
  if (bots.size > 1) {
  log("warn", "multiple bots configured; outbound requests must name a bot and each Pi session must set PI_TELEGRAM_BOT", { bots: [...bots.keys()] });
}

server.listen(config.port, config.host, () => log("info", "Telegram HTTP service listening", { host: config.host, port: config.port, bots: [...bots.keys()] }));
}
async function startBot(bot) {
  try {
    await telegramRequest(bot, "getMe");
    await telegramRequest(bot, "setMyCommands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commands: [
          { command: "new", description: "Start a fresh session" },
          { command: "compact", description: "Compact session context" },
          { command: "model", description: "Select or switch AI model" },
          { command: "status", description: "Show current model & token usage" },
          { command: "abort", description: "Abort current operation" },
          { command: "menu", description: "Interact with active terminal menu" },
          { command: "commands", description: "List all Pi slash commands" },
          { command: "help", description: "Show available bot commands" },
        ],
      }),
    }).catch((e) => log("warn", "Failed to register Telegram bot commands", { bot: bot.config.name, error: e.message }));
    if (bot.config.polling) {
      await telegramRequest(bot, "deleteWebhook");
      void startPolling(bot);
    } else if (bot.config.webhookUrl) {
      await telegramRequest(bot, "setWebhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: bot.config.webhookUrl,
          ...(bot.config.webhookSecret ? { secret_token: bot.config.webhookSecret } : {}),
        }),
      });
    }
    bot.status = "connected";
    log("info", "Telegram Bot API connected", { bot: bot.config.name, mode: bot.config.polling ? "polling" : "webhook" });
  } catch (e) {
    bot.status = "disconnected";
    log("error", "Telegram startup failed", { bot: bot.config.name, error: e.message });
  }
}
async function start() {
  startHttp();
  await Promise.all([...bots.values()].map(startBot));
}
process.on("SIGINT", () => process.exit(0)); process.on("SIGTERM", () => process.exit(0));
await start();

export { sendText, sendDocument, sendChatAction, handleTelegramWebhook, resolveBot };
