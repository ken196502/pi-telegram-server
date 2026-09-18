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

export function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlAttr(text) {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

export function formatJsonForTelegram(input, options = {}) {
  const {
    indent = 2,
    expandable = true,
    maxStringLength = 500,
    summary = true,
  } = options;

  let obj;
  if (typeof input === "string") {
    try {
      obj = JSON.parse(input.trim());
    } catch {
      return escapeHtml(input);
    }
  } else if (typeof input === "object" && input !== null) {
    obj = input;
  } else {
    return escapeHtml(String(input));
  }

  function truncateStrings(val) {
    if (typeof val === "string") {
      if (maxStringLength && val.length > maxStringLength) {
        return val.slice(0, maxStringLength) + `… [truncated ${val.length - maxStringLength} chars]`;
      }
      return val;
    }
    if (Array.isArray(val)) {
      return val.map(truncateStrings);
    }
    if (val && typeof val === "object") {
      const res = {};
      for (const [k, v] of Object.entries(val)) {
        res[k] = truncateStrings(v);
      }
      return res;
    }
    return val;
  }

  const sanitized = truncateStrings(obj);
  const jsonStr = JSON.stringify(sanitized, null, indent);
  const lineCount = jsonStr.split("\n").length;
  const escapedJson = escapeHtml(jsonStr);

  let summaryHeader = "";
  if (summary && typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
    const parts = [];
    const level = obj.level || obj.severity || obj.status;
    const time = obj.timestamp || obj.time || obj.date;
    const msg = obj.message || obj.msg || obj.error || obj.title;
    const service = obj.service || obj.app || obj.name;

    if (level) {
      const levelUpper = String(level).toUpperCase();
      let icon = "ℹ️";
      if (["ERROR", "FATAL", "CRITICAL"].includes(levelUpper)) icon = "🔴";
      else if (["WARN", "WARNING"].includes(levelUpper)) icon = "🟡";
      else if (["SUCCESS", "OK"].includes(levelUpper)) icon = "🟢";
      else if (["DEBUG", "TRACE"].includes(levelUpper)) icon = "🔍";
      parts.push(`${icon} <b>[${escapeHtml(levelUpper)}]</b>`);
    }

    if (time) {
      parts.push(`⏰ <code>${escapeHtml(String(time))}</code>`);
    }

    if (service) {
      parts.push(`📦 <code>${escapeHtml(String(service))}</code>`);
    }

    let headerLine = parts.join(" • ");
    if (msg) {
      headerLine = (headerLine ? headerLine + "\n" : "") + `💬 <b>${escapeHtml(String(msg))}</b>`;
    }

    if (headerLine) {
      summaryHeader = headerLine + "\n\n";
    }
  }

  const isExpandable = expandable && lineCount > 4;
  const codeBlock = `<pre><code class="language-json">${escapedJson}</code></pre>`;
  const formattedBlock = isExpandable
    ? `<blockquote expandable>${codeBlock}</blockquote>`
    : codeBlock;

  return summaryHeader + formattedBlock;
}

export function markdownToHtml(text) {
  if (!text) return "";

  const tokens = [];
  function pushToken(html) {
    const id = tokens.length;
    tokens.push(html);
    return `\x00TOK${id}\x00`;
  }

  // 1. Multi-line code blocks: ```lang\ncode```
  let src = String(text).replace(/```([a-zA-Z0-9_+-]*)\r?\n([\s\S]*?)```/g, (_match, lang, code) => {
    const cleanLang = (lang || "").trim().toLowerCase();
    const cleanCode = code.endsWith("\n") ? code.slice(0, -1) : code;

    // Prettify JSON code blocks and wrap in expandable blockquote if multiline
    if (cleanLang === "json") {
      try {
        const parsed = JSON.parse(cleanCode);
        const pretty = JSON.stringify(parsed, null, 2);
        const escaped = escapeHtml(pretty);
        const lineCount = pretty.split("\n").length;
        if (lineCount > 4) {
          return pushToken(`<blockquote expandable><pre><code class="language-json">${escaped}</code></pre></blockquote>`);
        }
        return pushToken(`<pre><code class="language-json">${escaped}</code></pre>`);
      } catch {}
    }

    const escaped = escapeHtml(cleanCode);
    if (cleanLang) {
      return pushToken(`<pre><code class="language-${escapeHtmlAttr(cleanLang)}">${escaped}</code></pre>`);
    }
    return pushToken(`<pre><code>${escaped}</code></pre>`);
  });

  // Single-line code block: ```code```
  src = src.replace(/```([\s\S]*?)```/g, (_match, code) => {
    const trimmed = code.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed);
        const pretty = JSON.stringify(parsed, null, 2);
        const escaped = escapeHtml(pretty);
        const lineCount = pretty.split("\n").length;
        if (lineCount > 4) {
          return pushToken(`<blockquote expandable><pre><code class="language-json">${escaped}</code></pre></blockquote>`);
        }
        return pushToken(`<pre><code class="language-json">${escaped}</code></pre>`);
      } catch {}
    }
    return pushToken(`<pre><code>${escapeHtml(code)}</code></pre>`);
  });

  // Helper for inline formatting
  function formatInline(inlineText) {
    const inlineTokens = [];

    // Inline code: `code`
    let s = inlineText.replace(/`([^`\r\n]+)`/g, (_m, c) => {
      const idx = inlineTokens.length;
      inlineTokens.push(`<code>${escapeHtml(c)}</code>`);
      return `\x01INL${idx}\x01`;
    });

    // Links: [label](url)
    s = s.replace(/\[([^\]]+)\]\(((?:https?:\/\/|tg:\/\/|mailto:)[^\s)]+)\)/g, (_m, label, url) => {
      const idx = inlineTokens.length;
      const cleanLabel = escapeHtml(label);
      const cleanUrl = escapeHtmlAttr(url);
      inlineTokens.push(`<a href="${cleanUrl}">${cleanLabel}</a>`);
      return `\x01INL${idx}\x01`;
    });

    // Escape raw HTML entities in remaining text
    s = escapeHtml(s);

    // Bold-italic: ***text*** or ___text___
    s = s.replace(/\*\*\*(.+?)\*\*\*/g, "<b><i>$1</i></b>");
    s = s.replace(/___(.+?)___/g, "<b><i>$1</i></b>");

    // Bold: **text** or __text__
    s = s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    s = s.replace(/__(.+?)__/g, "<b>$1</b>");

    // Italic: *text* or _text_
    s = s.replace(/(^|[^\w*])\*([^*\r\n]+?)\*(?!\*)/g, "$1<i>$2</i>");
    s = s.replace(/(^|[^\w_])_([^_]+?)_(?![\w_])/g, "$1<i>$2</i>");

    // Strikethrough: ~~text~~
    s = s.replace(/~~(.+?)~~/g, "<s>$1</s>");

    // Spoiler: ||text||
    s = s.replace(/\|\|(.+?)\|\|/g, "<tg-spoiler>$1</tg-spoiler>");

    // Restore inline tokens
    s = s.replace(/\x01INL(\d+)\x01/g, (_m, id) => inlineTokens[Number(id)]);
    return s;
  }

  // 2. Line by line processing
  const lines = src.split(/\r?\n/);
  const resultLines = [];
  let blockquoteBuffer = [];

  function flushBlockquote() {
    if (blockquoteBuffer.length > 0) {
      resultLines.push(`<blockquote>${blockquoteBuffer.join("\n")}</blockquote>`);
      blockquoteBuffer = [];
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^\x00TOK\d+\x00$/.test(line.trim())) {
      flushBlockquote();
      resultLines.push(line);
      continue;
    }

    // Blockquote: > text
    const bqMatch = line.match(/^>\s?(.*)$/);
    if (bqMatch) {
      blockquoteBuffer.push(formatInline(bqMatch[1]));
      continue;
    } else {
      flushBlockquote();
    }

    // Horizontal rule: ---, ***, ___ (3 or more)
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      resultLines.push("───────────────");
      continue;
    }

    // Headings: # Title, ## Title, etc.
    const headingMatch = line.match(/^(\s*)#{1,6}\s+(.+)$/);
    if (headingMatch) {
      const indent = headingMatch[1];
      let content = headingMatch[2].trim().replace(/\*\*/g, "");
      resultLines.push(`${indent}<b>${formatInline(content)}</b>`);
      continue;
    }

    // Unordered lists: - item, * item, + item
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (ulMatch) {
      resultLines.push(`${ulMatch[1]}• ${formatInline(ulMatch[2])}`);
      continue;
    }

    // Ordered lists: 1. item
    const olMatch = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (olMatch) {
      resultLines.push(`${olMatch[1]}${olMatch[2]}. ${formatInline(olMatch[3])}`);
      continue;
    }

    resultLines.push(formatInline(line));
  }
  flushBlockquote();

  let output = resultLines.join("\n");
  output = output.replace(/\x00TOK(\d+)\x00/g, (_m, id) => tokens[Number(id)]);
  return output;
}

const MDV2_SPECIAL = /[_*\[\]()~`>#+\-=|{}.!\\]/g;

export function escapeMarkdownV2(text) {
  return String(text ?? "").replace(MDV2_SPECIAL, "\\$&");
}

export function markdownToMarkdownV2(text) {
  if (!text) return "";

  const tokens = [];
  function pushToken(md) {
    const id = tokens.length;
    tokens.push(md);
    return `\x00TOK${id}\x00`;
  }

  function escapeCode(str) {
    return String(str ?? "").replace(/\\/g, "\\\\").replace(/`/g, "\\`");
  }

  // 1. Code blocks: ```lang\ncode```
  let src = String(text).replace(/```([a-zA-Z0-9_+-]*)\r?\n([\s\S]*?)```/g, (_match, lang, code) => {
    const cleanLang = (lang || "").trim();
    const cleanCode = code.endsWith("\n") ? code.slice(0, -1) : code;
    return pushToken("```" + escapeCode(cleanLang) + "\n" + escapeCode(cleanCode) + "```");
  });

  src = src.replace(/```([\s\S]*?)```/g, (_match, code) => {
    return pushToken("```" + escapeCode(code) + "```");
  });

  function formatInline(inlineText) {
    const inlineTokens = [];

    let s = inlineText.replace(/`([^`\r\n]+)`/g, (_m, c) => {
      const idx = inlineTokens.length;
      inlineTokens.push("`" + escapeCode(c) + "`");
      return `\x01INL${idx}\x01`;
    });

    s = s.replace(/\[([^\]]+)\]\(((?:https?:\/\/|tg:\/\/)[^\s)]+)\)/g, (_m, label, url) => {
      const idx = inlineTokens.length;
      const cleanLabel = escapeMarkdownV2(label);
      const cleanUrl = url.replace(/\\/g, "\\\\").replace(/\)/g, "\\)");
      inlineTokens.push("[" + cleanLabel + "](" + cleanUrl + ")");
      return `\x01INL${idx}\x01`;
    });

    s = s.replace(/\*\*\*(.+?)\*\*\*/g, (_m, inner) => {
      const idx = inlineTokens.length;
      inlineTokens.push("*_" + escapeMarkdownV2(inner) + "_*");
      return `\x01INL${idx}\x01`;
    });

    s = s.replace(/\*\*(.+?)\*\*/g, (_m, inner) => {
      const idx = inlineTokens.length;
      inlineTokens.push("*" + escapeMarkdownV2(inner) + "*");
      return `\x01INL${idx}\x01`;
    });

    s = s.replace(/(^|[^\w*])\*([^*\r\n]+?)\*(?!\*)/g, (_m, prefix, inner) => {
      const idx = inlineTokens.length;
      inlineTokens.push(prefix + "_" + escapeMarkdownV2(inner) + "_");
      return `\x01INL${idx}\x01`;
    });

    s = s.replace(/~~(.+?)~~/g, (_m, inner) => {
      const idx = inlineTokens.length;
      inlineTokens.push("~" + escapeMarkdownV2(inner) + "~");
      return `\x01INL${idx}\x01`;
    });

    s = s.replace(/\|\|(.+?)\|\|/g, (_m, inner) => {
      const idx = inlineTokens.length;
      inlineTokens.push("||" + escapeMarkdownV2(inner) + "||");
      return `\x01INL${idx}\x01`;
    });

    s = escapeMarkdownV2(s);
    s = s.replace(/\x01INL(\d+)\x01/g, (_m, id) => inlineTokens[Number(id)]);
    return s;
  }

  const lines = src.split(/\r?\n/);
  const resultLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^\x00TOK\d+\x00$/.test(line.trim())) {
      resultLines.push(line);
      continue;
    }

    const bqMatch = line.match(/^>\s?(.*)$/);
    if (bqMatch) {
      resultLines.push(">" + formatInline(bqMatch[1]));
      continue;
    }

    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      resultLines.push("───────────────");
      continue;
    }

    const headingMatch = line.match(/^(\s*)#{1,6}\s+(.+)$/);
    if (headingMatch) {
      const indent = headingMatch[1];
      let content = headingMatch[2].trim().replace(/\*\*/g, "");
      resultLines.push(escapeMarkdownV2(indent) + "*" + escapeMarkdownV2(content) + "*");
      continue;
    }

    const ulMatch = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (ulMatch) {
      resultLines.push(escapeMarkdownV2(ulMatch[1]) + "• " + formatInline(ulMatch[2]));
      continue;
    }

    const olMatch = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (olMatch) {
      resultLines.push(escapeMarkdownV2(olMatch[1]) + olMatch[2] + "\\. " + formatInline(olMatch[3]));
      continue;
    }

    resultLines.push(formatInline(line));
  }

  let output = resultLines.join("\n");
  output = output.replace(/\x00TOK(\d+)\x00/g, (_m, id) => tokens[Number(id)]);
  return output;
}

export function guessMimeType(fileName) {
  const extension = String(fileName || "").trim().split(".").pop()?.toLowerCase();
  const types = { pdf: "application/pdf", txt: "text/plain", csv: "text/csv", json: "application/json", zip: "application/zip", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", mp3: "audio/mpeg", mp4: "video/mp4" };
  return types[extension] || "application/octet-stream";
}
