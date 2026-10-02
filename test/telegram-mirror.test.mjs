import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import telegramMirror from "../extensions/telegram-mirror.mjs";

test("message_end forwards provider errors through the webhook", async (t) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const env = {
    PI_TELEGRAM_WEBHOOK_URL: `http://127.0.0.1:${server.address().port}/webhook`,
    PI_TELEGRAM_WEBHOOK_TOKEN: "test-token",
    PI_TELEGRAM_TO: "123",
  };
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  const handlers = new Map();
  const notifications = [];
  telegramMirror({
    registerTool() {},
    registerCommand() {},
    on(name, handler) { handlers.set(name, handler); },
  });
  const ctx = { cwd: process.cwd(), ui: { notify: (...args) => notifications.push(args) } };
  const emit = (message) => handlers.get("message_end")({ message }, ctx);
  const errorMessage = '429: {"code":"AccountQuotaExceeded","message":"You have exceeded the 5-hour usage quota. It will reset at 2026-10-02 14:27:10 +0800 CST. Request id: 021790916423319b79d8748f7bc7d5b56cf6863add8bd06584b3d","param":"","type":"TooManyRequests"}';

  await emit({ role: "assistant", content: [], stopReason: "error", errorMessage });
  assert.deepEqual(requests.pop(), { to: "123", message: `❌ Pi error:\n${errorMessage}` });

  await emit({ role: "assistant", content: [{ type: "text", text: "Partial answer" }], stopReason: "error", errorMessage });
  assert.equal(requests.pop().message, `Partial answer\n\n❌ Pi error:\n${errorMessage}`);

  await emit({ role: "assistant", stopReason: "error" });
  assert.match(requests.pop().message, /Unknown error/);

  await emit({ role: "assistant", content: [{ type: "text", text: "Normal answer" }], stopReason: "stop" });
  assert.equal(requests.pop().message, "Normal answer");

  await emit({ role: "user", content: [], errorMessage });
  await emit({ role: "toolResult", content: [], errorMessage });
  await emit({ role: "assistant", content: [], stopReason: "aborted" });
  await emit({ role: "assistant", content: [{ type: "thinking", thinking: "private" }] });
  assert.equal(requests.length, 0);
  assert.deepEqual(notifications, []);
});
