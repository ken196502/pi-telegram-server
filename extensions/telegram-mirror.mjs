#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toTelegramChatId } from "../src/lib.mjs";

function readDotEnv(cwd) { const values = {}; const files = [...new Set([path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env"), path.resolve(cwd, ".env")])]; for (const file of files) { try { for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) { const t = line.trim(), i = t.indexOf("="); if (!t || t.startsWith("#") || i < 0) continue; const key = t.slice(0, i).trim(); let value = t.slice(i + 1).trim(); if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1); if (key && values[key] === undefined) values[key] = value; } } catch {} } return values; }
function textOf(message) { if (message?.role !== "assistant" || !Array.isArray(message.content)) return ""; return message.content.filter((p) => p?.type === "text").map((p) => p.text || "").join("").trim(); }
function extractFilePaths(text) { const paths = []; const regex = /(?:^|\s)(\/[^\s]+\.(?:pdf|doc|docx|txt|csv|json|xml|html|md|zip|tar|gz|png|jpg|jpeg|gif|mp3|mp4|wav|py|js|ts|sh|bash|log))/gmi; let match; while ((match = regex.exec(text)) !== null) { paths.push(match[1].trim()); } return paths; }
function post(urlValue, body, token) { const url = new URL(urlValue), payload = JSON.stringify(body), transport = url.protocol === "https:" ? import("node:https") : import("node:http"); return transport.then((module) => new Promise((resolve, reject) => { const request = module.request(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, (response) => { let raw = ""; response.setEncoding("utf8"); response.on("data", (c) => { raw += c; }); response.on("end", () => resolve({ status: response.statusCode || 0, raw })); }); request.setTimeout(15000, () => request.destroy(new Error("webhook request timed out"))); request.on("error", reject); request.end(payload); })); }
async function mirror(message, settings) { const response = await post(settings.url, { to: settings.to, message }, settings.token); if (response.status < 200 || response.status >= 300) throw new Error(response.raw || `HTTP ${response.status}`); }
async function sendFile(filePath, settings, caption) { const payload = { to: settings.to, filePath, message: caption || "" }; const response = await post(settings.url, payload, settings.token); if (response.status < 200 || response.status >= 300) throw new Error(response.raw || `HTTP ${response.status}`); return JSON.parse(response.raw); }
async function sendTyping(chatId, token, apiBase) { const url = `${apiBase}/bot${token}/sendChatAction`; const payload = JSON.stringify({ chat_id: chatId, action: "typing" }); const transport = url.startsWith("https") ? import("node:https") : import("node:http"); return transport.then((module) => new Promise((resolve, reject) => { const request = module.request(url, { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, (response) => { let raw = ""; response.on("data", (c) => { raw += c; }); response.on("end", () => resolve({ status: response.statusCode || 0, raw })); }); request.on("error", reject); request.end(payload); })); }
function readJson(req) { return new Promise((resolve, reject) => { let body = ""; req.setEncoding("utf8"); req.on("data", (c) => { body += c; if (body.length > 1024 * 1024) reject(new Error("request body is too large")); }); req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { reject(new Error("request body must be valid JSON")); } }); req.on("error", reject); }); }
export default function telegramMirror(pi) { let settings; let server; let typingInterval = null; const seen = new Set(); const get = (cwd) => { if (settings) return settings; const env = { ...readDotEnv(cwd), ...process.env }; settings = { url: env.PI_TELEGRAM_WEBHOOK_URL || env.TELEGRAM_WEBHOOK_URL || `http://${env.TELEGRAM_HOST || "127.0.0.1"}:${env.TELEGRAM_PORT || "3093"}/webhook`, token: env.PI_TELEGRAM_WEBHOOK_TOKEN || env.TELEGRAM_WEBHOOK_TOKEN || env.WEBHOOK_TOKEN || "", to: env.PI_TELEGRAM_TO || env.TELEGRAM_TO || "", botToken: env.TELEGRAM_BOT_TOKEN || "", apiBase: (env.TELEGRAM_API_BASE_URL || "https://api.telegram.org").replace(/\/$/, ""), inboundHost: env.PI_TELEGRAM_INBOUND_HOST || "127.0.0.1", inboundPort: Number(env.PI_TELEGRAM_INBOUND_PORT || "3094"), inboundPath: env.PI_TELEGRAM_INBOUND_PATH || "/telegram/inbound", inboundToken: env.PI_TELEGRAM_INBOUND_TOKEN || env.INBOUND_WEBHOOK_TOKEN || "" }; return settings; };
  pi.registerTool({
    name: "send_telegram_file",
    label: "Send Telegram file",
    description: "Send a file to Telegram chat. Use this to send files, logs, documents, or any file to the user via Telegram.",
    // A plain JSON schema keeps this standalone extension dependency-free.
    parameters: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Absolute path to the file to send" },
        caption: { type: "string", description: "Optional caption message to include with the file" },
      },
      required: ["filePath"],
      additionalProperties: false,
    },
    async execute(_toolCallId, { filePath, caption }, _signal, _onUpdate, ctx) {
      const s = get(ctx?.cwd || process.cwd());
      if (!s.to || !s.token) {
        return {
          content: [{ type: "text", text: "Telegram not configured: set PI_TELEGRAM_TO and PI_TELEGRAM_WEBHOOK_TOKEN" }],
          details: { success: false },
        };
      }
      try {
        const result = await sendFile(filePath, s, caption || "");
        return {
          content: [{ type: "text", text: `Sent ${filePath} to Telegram.` }],
          details: { success: true, ...result },
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Telegram file send failed: ${e.message}` }],
          details: { success: false, error: e.message },
        };
      }
    },
  });
  function startTyping() { const s = settings; if (!s.botToken || !s.to) return; stopTyping(); const chatId = toTelegramChatId(s.to); sendTyping(chatId, s.botToken, s.apiBase).catch(() => {}); typingInterval = setInterval(() => { sendTyping(chatId, s.botToken, s.apiBase).catch(() => {}); }, 5000); }
  function stopTyping() { if (typingInterval) { clearInterval(typingInterval); typingInterval = null; } }
  pi.on("session_start", (_event, ctx) => { const s = get(ctx.cwd); if (!s.inboundToken) return ctx.ui.notify("Telegram inbound is disabled: set PI_TELEGRAM_INBOUND_TOKEN or INBOUND_WEBHOOK_TOKEN", "warning"); server = http.createServer(async (req, res) => { const url = new URL(req.url || "/", `http://${s.inboundHost}`); if (req.method !== "POST" || url.pathname !== s.inboundPath) { res.writeHead(404); return res.end(); } const auth = String(req.headers.authorization || ""); const token = auth.startsWith("Bearer ") ? auth.slice(7) : String(req.headers["x-webhook-token"] || ""); if (token !== s.inboundToken) { res.writeHead(401); return res.end(); } try { const message = await readJson(req); if (message.messageId && seen.has(message.messageId)) return res.end('{"ok":true}'); if (message.messageId) seen.add(message.messageId); if (!message.body?.trim()) throw new Error("body is required"); await pi.sendUserMessage(`[Telegram ${message.senderId || message.chatId || "unknown"}]\n${message.body}`, { deliverAs: "followUp" }); res.end('{"ok":true}'); } catch (e) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e.message })); } }); server.listen(s.inboundPort, s.inboundHost, () => ctx.ui.notify(`Telegram inbound listener: http://${s.inboundHost}:${s.inboundPort}${s.inboundPath}`)); });
  pi.on("session_shutdown", () => { stopTyping(); server?.close(); server = undefined; });
  pi.on("message_start", () => { startTyping(); });
  pi.on("message_end", (event, ctx) => { stopTyping(); const message = textOf(event.message), s = get(ctx.cwd); if (!message) return; if (!s.to || !s.token) return ctx.ui.notify("Telegram mirror is not configured: set PI_TELEGRAM_TO and PI_TELEGRAM_WEBHOOK_TOKEN", "warning"); const filePaths = extractFilePaths(message); if (filePaths.length > 0) { for (const filePath of filePaths) { void sendFile(filePath, s, `File from Pi: ${path.basename(filePath)}`).catch((e) => ctx.ui.notify(`Telegram file send failed: ${e.message}`, "error")); } } void mirror(message, s).catch((e) => ctx.ui.notify(`Telegram mirror failed: ${e.message}`, "error")); });
}
export { textOf, textOf as getText, mirror };
