import fs from "node:fs";
import path from "node:path";

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

export function stripMarkdownFormatting(text) {
  return String(text || "")
    .replace(/\*\*\*(.*?)\*\*\*/g, "$1")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/_(.*?)_/g, "$1")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1");
}

export function stringDisplayWidth(str) {
  const plain = stripMarkdownFormatting(str);
  let width = 0;
  for (const ch of plain) {
    const code = ch.codePointAt(0) || 0;
    // CJK unified ideographs, CJK extensions, fullwidth forms, emoji symbols count as 2 width units
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x20000 && code <= 0x2a6df) ||
      (code >= 0xff00 && code <= 0xffef) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0x2e80 && code <= 0x2eff) ||
      code >= 0x1f000
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

export function padCell(text, targetWidth, align = "left") {
  const currentWidth = stringDisplayWidth(text);
  const diff = Math.max(0, targetWidth - currentWidth);
  if (align === "right") {
    return " ".repeat(diff) + text;
  }
  if (align === "center") {
    const left = Math.floor(diff / 2);
    const right = diff - left;
    return " ".repeat(left) + text + " ".repeat(right);
  }
  return text + " ".repeat(diff);
}

export function parseRowCells(rowStr) {
  let s = rowStr.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

export function isTableDelimiter(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed.includes("-") || !trimmed.includes("|")) return false;
  const inner = trimmed.replace(/^\||\|$/g, "").trim();
  const parts = inner.split("|").map((p) => p.trim());
  if (parts.length < 1) return false;
  return parts.every((p) => /^:?-+:?$/.test(p));
}

export function formatMarkdownTable(tableLines, options = {}) {
  const { mode = "html", style = process.env.TELEGRAM_TABLE_STYLE || "adaptive" } = options;
  if (!Array.isArray(tableLines) || tableLines.length < 2) {
    return Array.isArray(tableLines) ? tableLines.join("\n") : "";
  }

  const headerCells = parseRowCells(tableLines[0]);
  const delimCells = parseRowCells(tableLines[1]);
  const dataRows = tableLines.slice(2).map(parseRowCells);
  const colCount = Math.max(headerCells.length, ...dataRows.map((r) => r.length));

  // Adaptive Mobile Card Layout:
  // Telegram mobile clients do not have horizontal scrolling in message bubbles and force-wrap long monospace lines on spaces.
  // When a table has 3+ columns (or style === "card"), convert each row into a structured mobile card.
  if (style === "card" || (style === "adaptive" && colCount >= 3)) {
    if (mode === "html") {
      const cards = dataRows.map((row, rowIdx) => {
        const primary = escapeHtml(row[0] || `项 ${rowIdx + 1}`);
        const fields = [];
        for (let c = 1; c < colCount; c++) {
          const label = escapeHtml(headerCells[c] || `列 ${c + 1}`);
          const val = escapeHtml(row[c] || "—");
          fields.push(`  • ${label}: <code>${val}</code>`);
        }
        return `🔹 <b>${primary}</b>\n${fields.join("\n")}`;
      });
      return cards.join("\n\n");
    }
    if (mode === "markdownv2") {
      const cards = dataRows.map((row, rowIdx) => {
        const primary = escapeMarkdownV2(row[0] || `项 ${rowIdx + 1}`);
        const fields = [];
        for (let c = 1; c < colCount; c++) {
          const label = escapeMarkdownV2(headerCells[c] || `列 ${c + 1}`);
          const val = escapeMarkdownV2(row[c] || "—");
          fields.push(`  • ${label}: \`${val}\``);
        }
        return `*${primary}*\n${fields.join("\n")}`;
      });
      return cards.join("\n\n");
    }
  }

  // Grid Layout (Monospace <pre>):
  // Used for 2-column key-value tables or when style === "grid"
  const alignments = delimCells.map((c) => {
    const hasLeft = c.startsWith(":");
    const hasRight = c.endsWith(":");
    if (hasLeft && hasRight) return "center";
    if (hasRight) return "right";
    return "left";
  });

  const allRows = [headerCells, ...dataRows];
  const colWidths = Array(colCount).fill(0);

  for (const row of allRows) {
    for (let c = 0; c < colCount; c++) {
      const cellText = row[c] || "";
      colWidths[c] = Math.max(colWidths[c], stringDisplayWidth(cellText));
    }
  }

  const formattedHeader = Array.from({ length: colCount }, (_, i) =>
    padCell(headerCells[i] || "", colWidths[i], alignments[i] || "left")
  ).join(" │ ");

  const divider = colWidths.map((w) => "─".repeat(Math.max(w, 1))).join("─┼─");

  const formattedData = dataRows.map((row) =>
    Array.from({ length: colCount }, (_, i) =>
      padCell(row[i] || "", colWidths[i], alignments[i] || "left")
    ).join(" │ ")
  );

  const tableText = [formattedHeader, divider, ...formattedData].join("\n");

  if (mode === "markdownv2") {
    return "```\n" + tableText + "\n```";
  }

  const escaped = escapeHtml(tableText);
  const isExpandable = dataRows.length > 6;
  const preBlock = `<pre><code>${escaped}</code></pre>`;
  return isExpandable ? `<blockquote expandable>${preBlock}</blockquote>` : preBlock;
}

export function renderHtmlTableDocument(markdownTable, options = {}) {
  const title = options.title || "数据表格";
  const desc = options.description || "已冻结表头与首列，支持横向和纵向流畅滚动";
  const lines = (Array.isArray(markdownTable) ? markdownTable : String(markdownTable || "").trim().split(/\r?\n/))
    .map((l) => l.trim())
    .filter((l) => l.includes("|"));

  if (lines.length < 2) return "";

  const headerCells = parseRowCells(lines[0]);
  const delimCells = parseRowCells(lines[1]);
  const dataRows = lines.slice(2).map(parseRowCells);

  const alignments = delimCells.map((c) => {
    const hasLeft = c.startsWith(":");
    const hasRight = c.endsWith(":");
    if (hasLeft && hasRight) return "center";
    if (hasRight) return "right";
    return "left";
  });

  function cellHtml(val, isHeader = false, colIdx = 0) {
    const tag = isHeader ? "th" : "td";
    const align = alignments[colIdx] || "left";
    const cleanVal = escapeHtml(stripMarkdownFormatting(val || ""));
    let content = cleanVal;

    if (/^(✅|支持|推荐|正常|active|ready|ok|success|true|yes)$/i.test(cleanVal)) {
      content = `<span class="badge badge-ok">${cleanVal}</span>`;
    } else if (/^(❌|不支持|下线|异常|fail|failed|error|false|no)$/i.test(cleanVal)) {
      content = `<span class="badge badge-error">${cleanVal}</span>`;
    } else if (/\b(token|tokens|k|m|b|gb|mb|%|ms|s)\b/i.test(cleanVal) && /^\d/.test(cleanVal)) {
      content = `<span class="badge badge-info">${cleanVal}</span>`;
    } else if (isHeader) {
      content = cleanVal;
    } else if (/^[a-zA-Z0-9_.-]+$/.test(cleanVal) && cleanVal.length > 3) {
      content = `<code>${cleanVal}</code>`;
    }

    return `<${tag} style="text-align: ${align}">${content}</${tag}>`;
  }

  const theadHtml = `<tr>${headerCells.map((h, i) => cellHtml(h, true, i)).join("")}</tr>`;
  const tbodyHtml = dataRows
    .map((row) => `<tr>${row.map((c, i) => cellHtml(c, false, i)).join("")}</tr>`)
    .join("\n        ");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --border: #334155;
      --primary: #38bdf8;
      --row-hover: #273549;
    }
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 16px;
      -webkit-font-smoothing: antialiased;
    }
    .header { margin-bottom: 14px; }
    h2 { font-size: 1.2rem; margin: 0 0 4px 0; color: var(--primary); }
    .desc { font-size: 0.82rem; color: var(--text-muted); margin: 0; }
    .table-container {
      overflow: auto;
      max-height: 85vh;
      background: var(--card-bg);
      border-radius: 10px;
      border: 1px solid var(--border);
      position: relative;
      -webkit-overflow-scrolling: touch;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
    }
    table {
      border-collapse: separate;
      border-spacing: 0;
      width: 100%;
      font-size: 0.88rem;
      white-space: nowrap;
    }
    th {
      position: sticky;
      top: 0;
      z-index: 2;
      background: #182234;
      color: var(--text-muted);
      font-weight: 600;
      padding: 12px 16px;
      border-bottom: 2px solid var(--border);
    }
    th:first-child {
      position: sticky;
      left: 0;
      top: 0;
      z-index: 4;
      background: #182234;
      box-shadow: 2px 0 6px rgba(0, 0, 0, 0.35);
    }
    td {
      padding: 11px 16px;
      border-bottom: 1px solid var(--border);
      color: var(--text);
    }
    td:first-child {
      position: sticky;
      left: 0;
      z-index: 1;
      background: var(--card-bg);
      font-weight: 500;
      box-shadow: 2px 0 6px rgba(0, 0, 0, 0.35);
    }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: var(--row-hover); }
    tr:hover td:first-child { background: var(--row-hover); }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.85em;
      background: rgba(255, 255, 255, 0.08);
      padding: 2px 6px;
      border-radius: 4px;
    }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 600;
      line-height: 1.4;
    }
    .badge-ok {
      background: rgba(34, 197, 94, 0.15);
      color: #4ade80;
      border: 1px solid rgba(34, 197, 94, 0.3);
    }
    .badge-error {
      background: rgba(239, 68, 68, 0.15);
      color: #f87171;
      border: 1px solid rgba(239, 68, 68, 0.3);
    }
    .badge-info {
      background: rgba(56, 189, 248, 0.15);
      color: #38bdf8;
      border: 1px solid rgba(56, 189, 248, 0.3);
    }
  </style>
</head>
<body>
  <div class="header">
    <h2>📊 ${escapeHtml(title)}</h2>
    <p class="desc">${escapeHtml(desc)}</p>
  </div>
  <div class="table-container">
    <table>
      <thead>
        ${theadHtml}
      </thead>
      <tbody>
        ${tbodyHtml}
      </tbody>
    </table>
  </div>
</body>
</html>`;
}

export function extractMarkdownTables(text) {
  const lines = String(text || "").split(/\r?\n/);
  const tables = [];
  let recentTitle = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      recentTitle = headingMatch[1].trim().replace(/\*\*/g, "");
      continue;
    }

    if (i + 1 < lines.length && isTableDelimiter(lines[i + 1]) && line.includes("|")) {
      const tableLines = [line, lines[i + 1]];
      let j = i + 2;
      while (j < lines.length && lines[j].trim() && lines[j].includes("|")) {
        tableLines.push(lines[j]);
        j++;
      }
      tables.push({
        title: recentTitle || "数据表格",
        lines: tableLines,
        tableMd: tableLines.join("\n"),
        rowCount: tableLines.length - 2,
      });
      i = j - 1;
      recentTitle = "";
    }
  }

  return tables;
}

export function exportMarkdownTablesToHtmlFile(text, options = {}) {
  const tables = extractMarkdownTables(text);
  if (tables.length === 0) return null;

  const targetTable = tables[0];
  const htmlContent = renderHtmlTableDocument(targetTable.tableMd, {
    title: options.title || targetTable.title || "数据表格",
    description: options.description || "已冻结表头与首列，支持横向和纵向流畅滚动",
  });

  const outDir = options.outputDir || "/tmp";
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const fileName = options.fileName || `table-${Date.now()}.html`;
  const filePath = path.join(outDir, fileName);
  fs.writeFileSync(filePath, htmlContent, "utf8");
  return filePath;
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

  // 2. Markdown tables: | header | ...
  {
    const scanLines = src.split(/\r?\n/);
    const intermediate = [];
    for (let i = 0; i < scanLines.length; i++) {
      const cur = scanLines[i];
      const nxt = scanLines[i + 1];
      if (nxt !== undefined && isTableDelimiter(nxt) && cur.includes("|") && !cur.includes("\x00TOK")) {
        const tableLines = [cur, nxt];
        let j = i + 2;
        while (
          j < scanLines.length &&
          scanLines[j].trim() &&
          scanLines[j].includes("|") &&
          !scanLines[j].includes("\x00TOK")
        ) {
          tableLines.push(scanLines[j]);
          j++;
        }
        const formattedTable = formatMarkdownTable(tableLines, { mode: "html" });
        intermediate.push(pushToken(formattedTable));
        i = j - 1;
      } else {
        intermediate.push(cur);
      }
    }
    src = intermediate.join("\n");
  }

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

  // 2. Markdown tables
  {
    const scanLines = src.split(/\r?\n/);
    const intermediate = [];
    for (let i = 0; i < scanLines.length; i++) {
      const cur = scanLines[i];
      const nxt = scanLines[i + 1];
      if (nxt !== undefined && isTableDelimiter(nxt) && cur.includes("|") && !cur.includes("\x00TOK")) {
        const tableLines = [cur, nxt];
        let j = i + 2;
        while (
          j < scanLines.length &&
          scanLines[j].trim() &&
          scanLines[j].includes("|") &&
          !scanLines[j].includes("\x00TOK")
        ) {
          tableLines.push(scanLines[j]);
          j++;
        }
        const formattedTable = formatMarkdownTable(tableLines, { mode: "markdownv2" });
        intermediate.push(pushToken(formattedTable));
        i = j - 1;
      } else {
        intermediate.push(cur);
      }
    }
    src = intermediate.join("\n");
  }

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

/**
 * Extracts replied-to or quoted message metadata from a Telegram Message object.
 */
export function extractReplyInfo(message) {
  const reply = message?.reply_to_message;
  if (!reply) return null;

  const sender = reply.from;
  const senderName = sender?.username
    ? `@${sender.username}`
    : [sender?.first_name, sender?.last_name].filter(Boolean).join(" ") || (sender?.is_bot ? "Assistant" : "User");

  // Check if user specifically quoted a portion (Telegram quote feature)
  let text = String(message?.quote?.text || reply.text || reply.caption || "").trim();

  if (!text) {
    if (reply.document) {
      text = `[Document: ${reply.document.file_name || "file"}]`;
    } else if (reply.photo && reply.photo.length > 0) {
      text = "[Photo]";
    } else if (reply.video) {
      text = "[Video]";
    } else if (reply.voice) {
      text = "[Voice Message]";
    } else if (reply.audio) {
      text = "[Audio]";
    } else if (reply.sticker) {
      text = `[Sticker ${reply.sticker.emoji || ""}]`.trim();
    } else if (reply.poll) {
      text = `[Poll: ${reply.poll.question || ""}]`.trim();
    }
  }

  return {
    messageId: reply.message_id,
    senderId: sender?.id ? String(sender.id) : undefined,
    senderName,
    isBot: Boolean(sender?.is_bot),
    text,
    isQuote: Boolean(message?.quote?.text),
  };
}

/**
 * Formats user message text with a blockquote representation of the replied-to message.
 */
export function formatReplyPrompt(bodyText, replyInfo, options = {}) {
  const cleanBody = String(bodyText || "").trim();
  if (!replyInfo || !replyInfo.text) {
    return cleanBody;
  }

  const maxQuoteLength = options.maxQuoteLength || 1000;
  let quoteText = String(replyInfo.text).trim();
  if (quoteText.length > maxQuoteLength) {
    quoteText = quoteText.slice(0, maxQuoteLength) + " ...[truncated]";
  }

  const sender = replyInfo.senderName || (replyInfo.isBot ? "Assistant" : "User");
  const quoteHeader = `[Replying to ${sender}]:`;
  const quoteLines = quoteText
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");

  if (!cleanBody) {
    return `${quoteHeader}\n${quoteLines}`;
  }

  return `${quoteHeader}\n${quoteLines}\n\n${cleanBody}`;
}

/**
 * Translates inbound Telegram slash commands that conflict with Pi's built-in interactive commands
 * to non-conflicting extension commands.
 *
 * - /new -> /clear
 * - /compact -> /compact_session
 */
export function translateInboundSlashCommand(commandText) {
  if (typeof commandText !== "string") return commandText;
  const trimmed = commandText.trim();
  if (!trimmed.startsWith("/")) return commandText;
  if (trimmed === "/new" || trimmed.startsWith("/new ")) {
    return "/clear" + trimmed.slice(4);
  }
  if (trimmed === "/compact" || trimmed.startsWith("/compact ")) {
    return "/compact_session" + trimmed.slice(8);
  }
  return trimmed;
}

/**
 * Checks if a model's display name is redundant with its ID and provider.
 * E.g. name: "Gemini 3.8 Flash (Antigravity)", id: "gemini-3.8-flash", provider: "antigravity" -> true
 */
export function isRedundantName(name, id, provider = "") {
  if (!name || typeof name !== "string") return true;
  const clean = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const cleanName = clean(name);
  const cleanId = clean(id);
  const cleanProv = clean(provider);

  if (!cleanName || cleanName === cleanId) return true;
  if (cleanProv) {
    if (cleanName === cleanId + cleanProv || cleanName === cleanProv + cleanId) return true;
    const strippedName = cleanName.replace(cleanProv, "");
    const strippedId = cleanId.replace(cleanProv, "");
    if (strippedName === strippedId) return true;
  }
  return false;
}

