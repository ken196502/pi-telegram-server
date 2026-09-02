#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import undici from "undici";
import { loadEnvFile, toTelegramChatId, splitMessage, guessMimeType, parseAllowedSenders, isAllowedSender } from "./lib.mjs";

const { FormData: UndiciFormData, ProxyAgent, fetch: undiciFetch } = undici;

loadEnvFile(path.resolve(".env"));
const config = {
  token: process.env.TELEGRAM_BOT_TOKEN || "",
  apiBase: (process.env.TELEGRAM_API_BASE_URL || "https://api.telegram.org").replace(/\/$/, ""),
  webhookToken: process.env.TELEGRAM_WEBHOOK_TOKEN || process.env.WEBHOOK_TOKEN || "",
  host: process.env.TELEGRAM_HOST || process.env.HTTP_HOST || "127.0.0.1",
  port: Number.parseInt(process.env.TELEGRAM_PORT || process.env.HTTP_PORT || "3093", 10),
  webhookPath: `/${String(process.env.TELEGRAM_WEBHOOK_PATH || "/telegram/webhook").replace(/^\/+/, "")}`,
  webhookUrl: process.env.TELEGRAM_WEBHOOK_URL || "",
  webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || "",
  messageLimit: Number.parseInt(process.env.TELEGRAM_MESSAGE_LIMIT || "3900", 10),
  inboundUrl: process.env.TELEGRAM_INBOUND_URL || "",
  inboundToken: process.env.INBOUND_WEBHOOK_TOKEN || "",
  allowedSenders: parseAllowedSenders(process.env.TELEGRAM_INBOUND_ALLOWED_SENDERS || ""),
  polling: String(process.env.TELEGRAM_POLLING || "").toLowerCase() === "true",
};
if (!config.token) throw new Error("TELEGRAM_BOT_TOKEN is required");
if (!config.webhookToken) throw new Error("WEBHOOK_TOKEN is required");
if (!Number.isInteger(config.messageLimit) || config.messageLimit < 1) throw new Error("TELEGRAM_MESSAGE_LIMIT must be a positive integer");

let status = "starting", sent = 0, received = 0, forwarded = 0, lastSentAt = null, lastReceivedAt = null;
const startedAt = Date.now();
const seenUpdates = new Set();
const api = (method) => `${config.apiBase}/bot${config.token}/${method}`;
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy;
const proxyAgent = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
const isLocalUrl = (url) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1])(:|\/)/i.test(url);
const proxyFetch = (url, opts) => proxyAgent && !isLocalUrl(url) ? undiciFetch(url, { ...opts, dispatcher: proxyAgent }) : fetch(url, opts);
function log(level, message, fields = {}) { const suffix = Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : ""; process.stderr.write(`${new Date().toISOString()} ${level} ${message}${suffix}\n`); }
function sendJson(res, code, body) { const payload = JSON.stringify(body); res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) }); res.end(payload); }
function readJson(req) { return new Promise((resolve, reject) => { let body = "", size = 0; req.setEncoding("utf8"); req.on("data", (chunk) => { size += Buffer.byteLength(chunk); if (size > 1024 * 1024) { reject(new Error("request body is too large")); req.destroy(); return; } body += chunk; }); req.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error("request body must be valid JSON")); } }); req.on("error", reject); }); }
function authorized(req) { const auth = String(req.headers.authorization || ""); const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : ""; return (bearer || String(req.headers["x-webhook-token"] || "")) === config.webhookToken; }
async function telegramRequest(method, options = {}) {
  const response = await proxyFetch(api(method), options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) throw new Error(body.description || `Telegram API HTTP ${response.status}`);
  return body.result;
}
async function sendText(to, text) {
  const chatId = toTelegramChatId(to); const chunks = splitMessage(text, config.messageLimit); if (!chunks.length) throw new Error("message is required");
  const messageIds = [];
  for (const chunk of chunks) { const result = await telegramRequest("sendMessage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text: chunk }) }); messageIds.push(result.message_id); sent += 1; lastSentAt = new Date().toISOString(); }
  return { to: chatId, messageIds };
}
async function sendDocument(to, filePath, fileName, mimetype, caption) {
  const chatId = toTelegramChatId(to); if (typeof filePath !== "string" || !filePath.trim()) throw new Error("filePath is required");
  const resolved = path.resolve(filePath.trim()); let stat; try { stat = fs.statSync(resolved); } catch (e) { if (e.code === "ENOENT") throw new Error("filePath does not exist"); throw new Error(`cannot read filePath: ${e.message}`); }
  if (!stat.isFile()) throw new Error("filePath must reference a regular file");
  try { fs.accessSync(resolved, fs.constants.R_OK); } catch { throw new Error("filePath is not readable"); }
  const name = typeof fileName === "string" && fileName.trim() ? fileName.trim() : path.basename(resolved);
  const type = typeof mimetype === "string" && mimetype.trim() ? mimetype.trim() : guessMimeType(name);
  const form = new UndiciFormData(); form.append("chat_id", chatId); form.append("document", new Blob([fs.readFileSync(resolved)], { type }), name);
  if (typeof caption === "string" && caption.trim()) form.append("caption", caption.trim());
  const result = await telegramRequest("sendDocument", { method: "POST", body: form }); sent += 1; lastSentAt = new Date().toISOString();
  return { to: chatId, messageIds: result?.message_id ? [result.message_id] : [], fileName: name, mimetype: type };
}
async function handleOutbound(req, res) {
  if (!authorized(req)) return sendJson(res, 401, { ok: false, error: "unauthorized" });
  let body; try { body = await readJson(req); } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  const to = body?.to ?? body?.chatId ?? body?.recipient; const message = body?.message ?? body?.text ?? body?.body ?? ""; const filePath = body?.filePath ?? body?.file ?? body?.path;
  if ((typeof message !== "string" || !message.trim()) && (typeof filePath !== "string" || !filePath.trim())) return sendJson(res, 400, { ok: false, error: "message or filePath is required" });
  try { const result = filePath ? await sendDocument(to, filePath, body?.fileName, body?.mimetype ?? body?.mimeType, message) : await sendText(to, message); sendJson(res, 200, { ok: true, ...result }); }
  catch (e) { sendJson(res, status === "connected" ? 400 : 503, { ok: false, error: e.message }); }
}
async function forwardInbound(payload) {
  if (!config.inboundUrl || !config.inboundToken) return;
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10000);
  try { const response = await proxyFetch(config.inboundUrl, { method: "POST", headers: { authorization: `Bearer ${config.inboundToken}`, "content-type": "application/json" }, body: JSON.stringify(payload), signal: controller.signal }); if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`); forwarded += 1; } finally { clearTimeout(timer); }
}
function updateMessage(update) { return update?.message || update?.edited_message || update?.channel_post || update?.edited_channel_post || null; }
function processUpdate(update) {
  const message = updateMessage(update); const text = String(message?.text || message?.caption || "").trim();
  const updateId = String(update?.update_id ?? ""); if (updateId && seenUpdates.has(updateId)) return;
  if (updateId) { seenUpdates.add(updateId); while (seenUpdates.size > 1000) seenUpdates.delete(seenUpdates.values().next().value); }
  if (text) {
    const chatId = message?.chat?.id; const senderId = message?.from?.id ?? chatId;
    if (chatId !== undefined && isAllowedSender(senderId, config.allowedSenders)) { received += 1; lastReceivedAt = new Date().toISOString(); void forwardInbound({ type: "telegram_message", messageId: `${updateId}:${message.message_id ?? ""}`, chatId: String(chatId), senderId: String(senderId), body: text, timestamp: Number(message.date || Math.floor(Date.now() / 1000)) }).catch((e) => log("warn", "inbound webhook failed", { error: e.message })); }
  }
}
async function handleTelegramWebhook(req, res) {
  if (config.webhookSecret && req.headers["x-telegram-bot-api-secret-token"] !== config.webhookSecret) return sendJson(res, 401, { ok: false, error: "unauthorized" });
  let update; try { update = await readJson(req); } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  processUpdate(update);
  sendJson(res, 200, { ok: true });
}
async function startPolling() {
  let offset = 0;
  log("info", "Starting long-polling mode");
  while (true) {
    try {
      const updates = await telegramRequest("getUpdates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ offset, timeout: 30, allowed_updates: ["message", "edited_message", "channel_post", "edited_channel_post"] }) });
      for (const update of updates) { processUpdate(update); offset = update.update_id + 1; }
    } catch (e) {
      log("error", "Polling error", { error: e.message });
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
function startHttp() { const server = http.createServer(async (req, res) => { const url = new URL(req.url || "/", `http://${config.host}`); if (req.method === "GET" && url.pathname === "/health") return sendJson(res, 200, { ok: true, service: "telegram", status, webhookPath: config.webhookPath, inboundEnabled: Boolean(config.inboundUrl && config.inboundToken), uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000), sent, received, forwarded, lastSentAt, lastReceivedAt }); if (req.method === "GET" && url.pathname === "/") return sendJson(res, 200, { ok: true, service: "telegram", endpoints: { health: "GET /health", webhook: "POST /webhook", telegramWebhook: `POST ${config.webhookPath}` } }); if (req.method === "POST" && ["/webhook", "/send"].includes(url.pathname)) return handleOutbound(req, res); if (req.method === "POST" && url.pathname === config.webhookPath) return handleTelegramWebhook(req, res); sendJson(res, req.method === "POST" ? 404 : 405, { ok: false, error: "not found" }); }); server.listen(config.port, config.host, () => log("info", "Telegram HTTP service listening", { host: config.host, port: config.port })); }
async function start() { startHttp(); try { await telegramRequest("getMe"); if (config.polling) { await telegramRequest("deleteWebhook"); void startPolling(); } else if (config.webhookUrl) { await telegramRequest("setWebhook", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: config.webhookUrl, ...(config.webhookSecret ? { secret_token: config.webhookSecret } : {}) }) }); } status = "connected"; log("info", "Telegram Bot API connected", { mode: config.polling ? "polling" : "webhook" }); } catch (e) { status = "disconnected"; log("error", "Telegram startup failed", { error: e.message }); } }
process.on("SIGINT", () => process.exit(0)); process.on("SIGTERM", () => process.exit(0));
await start();

export { sendText, sendDocument, handleTelegramWebhook };
