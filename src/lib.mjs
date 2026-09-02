import fs from "node:fs";

export function loadEnvFile(filePath, target = process.env) {
  if (!fs.existsSync(filePath)) return target;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (key && target[key] === undefined) target[key] = value;
  }
  return target;
}

export function normalizeTelegramId(value) {
  return String(value ?? "").trim().replace(/^@/, "");
}

export function parseAllowedSenders(raw) {
  return new Set(String(raw || "").split(",").map((v) => v.trim()).filter(Boolean).map((v) => v === "*" ? "*" : normalizeTelegramId(v)));
}

export function isAllowedSender(senderId, allowedSenders) {
  const id = normalizeTelegramId(senderId);
  return Boolean(id && allowedSenders?.size && (allowedSenders.has("*") || allowedSenders.has(id)));
}

export function toTelegramChatId(value) {
  const input = String(value ?? "").trim();
  if (!input) throw new Error("to is required");
  if (/^-?\d+$/.test(input) || /^@[A-Za-z][A-Za-z0-9_]{3,31}$/.test(input)) return input;
  throw new Error("to must be a Telegram numeric chat ID or @username");
}

export function splitMessage(text, limit = 3900) {
  const input = String(text || "").trim();
  if (!input) return [];
  const chunks = [];
  let rest = input;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < Math.floor(limit * 0.5)) cut = rest.lastIndexOf(" ", limit);
    if (cut < Math.floor(limit * 0.5)) cut = limit;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function guessMimeType(fileName) {
  const extension = String(fileName || "").trim().split(".").pop()?.toLowerCase();
  const types = { pdf: "application/pdf", txt: "text/plain", csv: "text/csv", json: "application/json", zip: "application/zip", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", mp3: "audio/mpeg", mp4: "video/mp4" };
  return types[extension] || "application/octet-stream";
}
