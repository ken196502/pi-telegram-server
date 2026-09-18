import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  escapeHtml,
  escapeMarkdownV2,
  formatJsonForTelegram,
  guessMimeType,
  isAllowedSender,
  markdownToHtml,
  markdownToMarkdownV2,
  normalizeTelegramId,
  parseAllowedSenders,
  splitMessage,
  toTelegramChatId,
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
