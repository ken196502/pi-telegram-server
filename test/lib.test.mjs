import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import {
  escapeHtml,
  escapeMarkdownV2,
  formatJsonForTelegram,
  formatMarkdownTable,
  renderHtmlTableDocument,
  extractMarkdownTables,
  exportMarkdownTablesToHtmlFile,
  stringDisplayWidth,
  isTableDelimiter,
  guessMimeType,
  isAllowedSender,
  markdownToHtml,
  markdownToMarkdownV2,
  normalizeTelegramId,
  parseAllowedSenders,
  splitMessage,
  toTelegramChatId,
  extractReplyInfo,
  formatReplyPrompt,
  translateInboundSlashCommand,
  isRedundantName,
} from "../src/lib.mjs";

describe("Telegram helpers", () => {
  it("normalizes and filters sender IDs", () => { assert.equal(normalizeTelegramId("@alice"), "alice"); const allowed = parseAllowedSenders("123, @alice"); assert.equal(isAllowedSender("alice", allowed), true); assert.equal(isAllowedSender("999", allowed), false); });
  it("validates chat IDs", () => { assert.equal(toTelegramChatId("-100123"), "-100123"); assert.equal(toTelegramChatId("@alice"), "@alice"); assert.throws(() => toTelegramChatId(""), /to is required/); assert.throws(() => toTelegramChatId("hello"), /numeric chat ID/); });
  it("splits text and guesses MIME", () => { assert.deepEqual(splitMessage("a b c", 3), ["a b", "c"]); assert.equal(guessMimeType("x.PDF"), "application/pdf"); });
});

describe("HTML converter", () => {
  it("escapes raw HTML entities", () => {
    assert.equal(escapeHtml("a < b & c > d"), "a &lt; b &amp; c &gt; d");
  });

  it("converts headings to bold", () => {
    assert.equal(markdownToHtml("# Heading 1"), "<b>Heading 1</b>");
    assert.equal(markdownToHtml("### 🤖 **Pi Assistant**"), "<b>🤖 Pi Assistant</b>");
  });

  it("converts lists and dividers", () => {
    assert.equal(markdownToHtml("- Item 1\n- Item 2"), "• Item 1\n• Item 2");
    assert.equal(markdownToHtml("  * Sub item"), "  • Sub item");
    assert.equal(markdownToHtml("---"), "───────────────");
  });

  it("converts code blocks and inline code safely", () => {
    const code = "```python\ndef foo(x):\n    return x < 5 && x > 0\n```";
    const converted = markdownToHtml(code);
    assert.match(converted, /<pre><code class="language-python">def foo\(x\):\n {4}return x &lt; 5 &amp;&amp; x &gt; 0<\/code><\/pre>/);

    const inline = "Use `const x = a < b;` here";
    assert.equal(markdownToHtml(inline), "Use <code>const x = a &lt; b;</code> here");
  });

  it("converts inline bold, italic, and links", () => {
    assert.equal(markdownToHtml("This is **bold** and *italic*"), "This is <b>bold</b> and <i>italic</i>");
    assert.equal(markdownToHtml("[Telegram](https://telegram.org)"), '<a href="https://telegram.org">Telegram</a>');
    assert.equal(markdownToHtml("> Blockquote text"), "<blockquote>Blockquote text</blockquote>");
  });
});

describe("JSON beautifier for Telegram", () => {
  it("formats object with summary header and expandable code block", () => {
    const logObj = {
      level: "error",
      timestamp: "2026-09-18T00:30:15Z",
      service: "api-server",
      message: "Database connection failed",
      details: { host: "127.0.0.1", retries: 3 }
    };
    const formatted = formatJsonForTelegram(logObj);
    assert.match(formatted, /🔴 <b>\[ERROR\]<\/b>/);
    assert.match(formatted, /⏰ <code>2026-09-18T00:30:15Z<\/code>/);
    assert.match(formatted, /📦 <code>api-server<\/code>/);
    assert.match(formatted, /💬 <b>Database connection failed<\/b>/);
    assert.match(formatted, /<blockquote expandable><pre><code class="language-json">/);
  });

  it("handles raw JSON string input and truncates overly long strings", () => {
    const raw = JSON.stringify({ key: "x".repeat(600) });
    const formatted = formatJsonForTelegram(raw, { maxStringLength: 50 });
    assert.match(formatted, /\[truncated 550 chars\]/);
  });

  it("handles non-expandable short JSON", () => {
    const short = { a: 1 };
    const formatted = formatJsonForTelegram(short);
    assert.ok(!formatted.includes("<blockquote expandable>"));
    assert.match(formatted, /<pre><code class="language-json">/);
  });

  it("beautifies json code blocks in markdownToHtml", () => {
    const md = '```json\n{"a":1,"b":[2,3],"c":4,"d":5,"e":6}\n```';
    const converted = markdownToHtml(md);
    assert.match(converted, /<blockquote expandable><pre><code class="language-json">/);
    assert.match(converted, /"b": \[\n {4}2,\n {4}3\n {2}\]/);
  });
});

describe("Markdown Table renderer for Telegram", () => {
  it("computes visual display width with CJK and emojis", () => {
    assert.equal(stringDisplayWidth("hello"), 5);
    assert.equal(stringDisplayWidth("你好世界"), 8);
    assert.equal(stringDisplayWidth("**bold**"), 4);
    assert.equal(stringDisplayWidth("`code`"), 4);
  });

  it("detects table delimiters accurately and rejects dividers", () => {
    assert.equal(isTableDelimiter("|:---|:---:|---:|"), true);
    assert.equal(isTableDelimiter("|---|---|"), true);
    assert.equal(isTableDelimiter("--- | ---"), true);
    assert.equal(isTableDelimiter("---"), false);
    assert.equal(isTableDelimiter("| header | text |"), false);
  });

  it("formats markdown table into aligned monospace HTML pre block in grid mode", () => {
    const tableMd = [
      "| Model | Context | Status |",
      "| :--- | :---: | ---: |",
      "| gemini-3.8-flash | 1.0M | Active |",
      "| claude-sonnet-4-6 | 200K | Ready |"
    ];
    const formatted = formatMarkdownTable(tableMd, { mode: "html", style: "grid" });
    assert.match(formatted, /^<pre><code>/);
    assert.match(formatted, /<\/code><\/pre>$/);
    assert.match(formatted, /Model\s+│\s+Context\s+│\s+Status/);
    assert.match(formatted, /─┼─/);
    assert.match(formatted, /gemini-3\.8-flash/);
  });

  it("formats 3+ column tables into mobile cards in adaptive mode", () => {
    const tableMd = [
      "| Model | Context | Status |",
      "| :--- | :--- | :--- |",
      "| gemini-3.8-flash | 1.0M | Active |",
      "| claude-sonnet-4-6 | 200K | Ready |"
    ];
    const formatted = formatMarkdownTable(tableMd, { mode: "html", style: "adaptive" });
    assert.match(formatted, /🔹 <b>gemini-3\.8-flash<\/b>/);
    assert.match(formatted, /• Context: <code>1\.0M<\/code>/);
    assert.match(formatted, /• Status: <code>Active<\/code>/);
  });

  it("renders tables inside markdownToHtml seamlessly", () => {
    const input = [
      "### Model List",
      "",
      "| Provider | Model | State |",
      "| :--- | :--- | :--- |",
      "| antigravity | gemini-3.8-flash | 正常 |",
      "| antigravity | claude-sonnet-4-6 | 正常 |",
      "",
      "Other notes below."
    ].join("\n");

    const html = markdownToHtml(input);
    assert.match(html, /<b>Model List<\/b>/);
    assert.match(html, /🔹 <b>antigravity<\/b>/);
    assert.match(html, /• Model: <code>gemini-3\.8-flash<\/code>/);
    assert.match(html, /Other notes below\./);
  });

  it("formats 2-column tables into monospace pre block and makes >6 rows expandable", () => {
    const longTable = [
      "| ID | Name |",
      "| --- | --- |",
      "| 1 | Row 1 |",
      "| 2 | Row 2 |",
      "| 3 | Row 3 |",
      "| 4 | Row 4 |",
      "| 5 | Row 5 |",
      "| 6 | Row 6 |",
      "| 7 | Row 7 |"
    ];
    const formatted = formatMarkdownTable(longTable, { mode: "html", style: "grid" });
    assert.match(formatted, /^<blockquote expandable><pre><code>/);
  });

  it("renders table in markdownToMarkdownV2 mode", () => {
    const input = [
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |"
    ].join("\n");
    const mdv2 = markdownToMarkdownV2(input);
    assert.match(mdv2, /```\nA\s+│\s+B\n─+┼─+\n1\s+│\s+2\n```/);
  });

  it("renders standalone HTML document with frozen header and first column", () => {
    const tableMd = [
      "| Model | Context | Status |",
      "| :--- | :--- | :--- |",
      "| gemini-3.8-flash | 1.0M | 推荐 |"
    ].join("\n");
    const html = renderHtmlTableDocument(tableMd, { title: "测试表格" });
    assert.match(html, /<!DOCTYPE html>/);
    assert.match(html, /<h2>📊 测试表格<\/h2>/);
    assert.match(html, /th:first-child\s*\{\s*position:\s*sticky;\s*left:\s*0;\s*top:\s*0;\s*z-index:\s*4;/);
    assert.match(html, /td:first-child\s*\{\s*position:\s*sticky;\s*left:\s*0;\s*z-index:\s*1;/);
    assert.match(html, /th\s*\{\s*position:\s*sticky;\s*top:\s*0;\s*z-index:\s*2;/);
    assert.match(html, /<span class="badge badge-ok">推荐<\/span>/);
  });

  it("extracts markdown tables and exports to HTML file", () => {
    const text = [
      "## 模型汇总",
      "",
      "| Provider | Model |",
      "| --- | --- |",
      "| Google | Gemini |",
      "",
      "End of response."
    ].join("\n");

    const tables = extractMarkdownTables(text);
    assert.equal(tables.length, 1);
    assert.equal(tables[0].title, "模型汇总");
    assert.equal(tables[0].rowCount, 1);

    const filePath = exportMarkdownTablesToHtmlFile(text, { outputDir: "/tmp", fileName: "test-table.html" });
    assert.ok(filePath && filePath.endsWith("test-table.html"));
    const content = fs.readFileSync(filePath, "utf8");
    assert.match(content, /Google/);
    assert.match(content, /Gemini/);
    fs.unlinkSync(filePath);
  });
});

describe("Reply & Quote formatting", () => {
  it("returns null when message has no reply_to_message", () => {
    assert.equal(extractReplyInfo(null), null);
    assert.equal(extractReplyInfo({}), null);
    assert.equal(extractReplyInfo({ text: "hello" }), null);
  });

  it("extracts text and author from reply_to_message", () => {
    const msg = {
      message_id: 100,
      text: "I agree with this",
      reply_to_message: {
        message_id: 99,
        from: { id: 12345, username: "alice_dev", first_name: "Alice" },
        text: "Should we refactor the gateway?",
      },
    };

    const info = extractReplyInfo(msg);
    assert.ok(info);
    assert.equal(info.messageId, 99);
    assert.equal(info.senderId, "12345");
    assert.equal(info.senderName, "@alice_dev");
    assert.equal(info.isBot, false);
    assert.equal(info.text, "Should we refactor the gateway?");
    assert.equal(info.isQuote, false);
  });

  it("uses Assistant when replying to a bot", () => {
    const msg = {
      message_id: 102,
      text: "Yes, please do",
      reply_to_message: {
        message_id: 101,
        from: { id: 8696700404, is_bot: true, first_name: "PiBot" },
        text: "Task completed successfully.",
      },
    };

    const info = extractReplyInfo(msg);
    assert.ok(info);
    assert.equal(info.senderName, "PiBot");
    assert.equal(info.isBot, true);
    assert.equal(info.text, "Task completed successfully.");
  });

  it("prioritizes Telegram quote feature text over entire message text", () => {
    const msg = {
      message_id: 105,
      text: "Fix this specific part",
      quote: {
        text: "Error: ECONNREFUSED 127.0.0.1:3093",
      },
      reply_to_message: {
        message_id: 104,
        from: { id: 555, first_name: "Bob" },
        text: "Full log output:\nError: ECONNREFUSED 127.0.0.1:3093\nEnd of log",
      },
    };

    const info = extractReplyInfo(msg);
    assert.ok(info);
    assert.equal(info.text, "Error: ECONNREFUSED 127.0.0.1:3093");
    assert.equal(info.isQuote, true);
  });

  it("handles media messages in reply without text", () => {
    const docMsg = {
      reply_to_message: {
        message_id: 10,
        from: { id: 1, first_name: "DocSender" },
        document: { file_name: "architecture.pdf" },
      },
    };
    assert.equal(extractReplyInfo(docMsg).text, "[Document: architecture.pdf]");

    const photoMsg = {
      reply_to_message: {
        message_id: 11,
        from: { id: 1, first_name: "PhotoSender" },
        photo: [{ file_id: "abc" }],
      },
    };
    assert.equal(extractReplyInfo(photoMsg).text, "[Photo]");
  });

  it("formats reply prompt with markdown blockquote", () => {
    const replyInfo = {
      senderName: "@alice",
      text: "First line of quoted message\nSecond line of quoted message",
    };

    const formatted = formatReplyPrompt("My reply to Alice", replyInfo);
    assert.equal(
      formatted,
      "[Replying to @alice]:\n> First line of quoted message\n> Second line of quoted message\n\nMy reply to Alice"
    );
  });

  it("truncates overly long quote text gracefully", () => {
    const longText = "A".repeat(1500);
    const replyInfo = {
      senderName: "Assistant",
      text: longText,
    };

    const formatted = formatReplyPrompt("Follow up", replyInfo, { maxQuoteLength: 100 });
    assert.ok(formatted.includes("...[truncated]"));
    assert.ok(formatted.includes("[Replying to Assistant]:"));
    assert.ok(formatted.includes("Follow up"));
  });

  it("returns clean body when replyInfo is missing or has no text", () => {
    assert.equal(formatReplyPrompt("Just text", null), "Just text");
    assert.equal(formatReplyPrompt("Just text", { text: "" }), "Just text");
  });
});

describe("Inbound Slash Command Translation", () => {
  it("translates /new to /clear to avoid built-in interactive command conflict", () => {
    assert.equal(translateInboundSlashCommand("/new"), "/clear");
    assert.equal(translateInboundSlashCommand("  /new  "), "/clear");
  });

  it("translates /compact to /compact_session to avoid built-in interactive command conflict", () => {
    assert.equal(translateInboundSlashCommand("/compact"), "/compact_session");
    assert.equal(translateInboundSlashCommand("/compact summarize context"), "/compact_session summarize context");
  });

  it("leaves non-conflicting slash commands untouched", () => {
    assert.equal(translateInboundSlashCommand("/clear"), "/clear");
    assert.equal(translateInboundSlashCommand("/abort"), "/abort");
    assert.equal(translateInboundSlashCommand("/stop"), "/stop");
    assert.equal(translateInboundSlashCommand("/status"), "/status");
    assert.equal(translateInboundSlashCommand("/help"), "/help");
    assert.equal(translateInboundSlashCommand("/custom args"), "/custom args");
  });

  it("leaves non-command text untouched", () => {
    assert.equal(translateInboundSlashCommand("hello world"), "hello world");
    assert.equal(translateInboundSlashCommand("new idea"), "new idea");
    assert.equal(translateInboundSlashCommand(null), null);
    assert.equal(translateInboundSlashCommand(undefined), undefined);
  });
});

describe("Model Name Redundancy Check", () => {
  it("identifies redundant model names correctly", () => {
    assert.equal(isRedundantName("Gemini 3.8 Flash (Antigravity)", "gemini-3.8-flash", "antigravity"), true);
    assert.equal(isRedundantName("Gemini 3.8 Flash", "gemini-3.8-flash", "google"), true);
    assert.equal(isRedundantName("Claude Opus 4.6 (Antigravity)", "claude-opus-4-6", "antigravity"), true);
    assert.equal(isRedundantName("GPT-4o (OpenAI)", "gpt-4o", "openai"), true);
    assert.equal(isRedundantName("gpt-4o", "gpt-4o", "openai"), true);
    assert.equal(isRedundantName("", "gpt-4o", "openai"), true);
    assert.equal(isRedundantName(null, "gpt-4o", "openai"), true);
  });

  it("preserves non-redundant custom model names", () => {
    assert.equal(isRedundantName("Coding Specialist Llama", "llama-3-8b", "ollama"), false);
    assert.equal(isRedundantName("Production Reasoning Agent", "deepseek-r1-distill", "local"), false);
  });
});
