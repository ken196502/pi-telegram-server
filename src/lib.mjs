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

const MDV2_SPECIAL = /[_*\[\]()~`>#+\-=|{}.!\\]/g;

export function escapeMarkdownV2(text) {
  return text.replace(MDV2_SPECIAL, "\\$&");
}

export function markdownToMarkdownV2(text) {
  if (!text) return "";
  const result = [];
  let i = 0;

  while (i < text.length) {
    if (text[i] === "\\" && i + 1 < text.length) {
      result.push(escapeMarkdownV2(text[i + 1]));
      i += 2;
      continue;
    }

    if (text.slice(i, i + 3) === "```") {
      const end = text.indexOf("```", i + 3);
      if (end !== -1) {
        const block = text.slice(i + 3, end);
        const newlineIdx = block.indexOf("\n");
        if (newlineIdx !== -1) {
          const lang = block.slice(0, newlineIdx).trim();
          const code = block.slice(newlineIdx + 1);
          result.push("```" + escapeMarkdownV2(lang) + "\n" + escapeMarkdownV2(code) + "```");
        } else {
          result.push("```" + escapeMarkdownV2(block) + "```");
        }
        i = end + 3;
        continue;
      }
    }

    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        const code = text.slice(i + 1, end);
        result.push("`" + escapeMarkdownV2(code) + "`");
        i = end + 1;
        continue;
      }
    }

    const linkMatch = text.slice(i).match(/^\[([^\]]*)\]\(([^)]+)\)/);
    if (linkMatch) {
      const [full, label, url] = linkMatch;
      result.push("[" + escapeMarkdownV2(label) + "](" + escapeMarkdownV2(url) + ")");
      i += full.length;
      continue;
    }

    const strikethroughMatch = text.slice(i).match(/^~~(.+?)~~/);
    if (strikethroughMatch) {
      const [full, inner] = strikethroughMatch;
      result.push("~" + escapeMarkdownV2(inner) + "~");
      i += full.length;
      continue;
    }

    const boldMatch = text.slice(i).match(/^\*\*(.+?)\*\*/);
    if (boldMatch) {
      const [full, inner] = boldMatch;
      result.push("*" + escapeMarkdownV2(inner) + "*");
      i += full.length;
      continue;
    }

    if (text[i] === "*") {
      const end = text.indexOf("*", i + 1);
      if (end !== -1) {
        const inner = text.slice(i + 1, end);
        result.push("*" + escapeMarkdownV2(inner) + "*");
        i = end + 1;
        continue;
      }
    }

    if (text[i] === "_") {
      const end = text.indexOf("_", i + 1);
      if (end !== -1) {
        const inner = text.slice(i + 1, end);
        result.push("_" + escapeMarkdownV2(inner) + "_");
        i = end + 1;
        continue;
      }
    }

    result.push(escapeMarkdownV2(text[i]));
    i++;
  }

  return result.join("");
}

export function guessMimeType(fileName) {
  const extension = String(fileName || "").trim().split(".").pop()?.toLowerCase();
  const types = { pdf: "application/pdf", txt: "text/plain", csv: "text/csv", json: "application/json", zip: "application/zip", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", mp3: "audio/mpeg", mp4: "video/mp4" };
  return types[extension] || "application/octet-stream";
}
