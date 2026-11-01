import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import telegramMirror from "../extensions/telegram-mirror.mjs";
import { createInboundHub } from "../src/inbound-ws.mjs";

test("session_start authenticates each selected bot and shuts down cleanly", async (t) => {
  const tokens = { main: "main-inbound-test", inspilot: "inspilot-inbound-test", default: "single-inbound-test" };
  const hub = createInboundHub({ resolveBotToken: (bot) => tokens[bot] });
  const server = http.createServer();
  const wss = hub.attachToServer(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    hub.closeAll();
    for (const ws of wss.clients) ws.terminate();
    await new Promise((resolve) => server.close(resolve));
  });

  for (const scenario of ["main", "inspilot", "default", "explicit-token", "missing-token"]) {
    await t.test(scenario, async (t) => {
      const bot = scenario.endsWith("-token") ? "main" : scenario;
      const env = {
        TELEGRAM_BOTS: bot === "default" ? "" : "main=test-main,inspilot=test-inspilot",
        TELEGRAM_BOT_TOKEN: "test-single",
        TELEGRAM_BOT_MAIN_INBOUND_TOKEN: scenario === "missing-token" ? "" : scenario === "explicit-token" ? "wrong-bot-token" : tokens.main,
        TELEGRAM_BOT_INSPILOT_INBOUND_TOKEN: tokens.inspilot,
        TELEGRAM_BOT_DEFAULT_INBOUND_TOKEN: "",
        PI_TELEGRAM_BOT: bot.toUpperCase(),
        PI_TELEGRAM_INBOUND_WS_URL: `ws://127.0.0.1:${server.address().port}/inbound`,
        PI_TELEGRAM_INBOUND_TOKEN: scenario === "explicit-token" ? tokens.main : "",
        INBOUND_WEBHOOK_TOKEN: bot === "default" ? tokens.default : "wrong-shared-token",
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
      telegramMirror({ registerTool() {}, registerCommand() {}, on(name, handler) { handlers.set(name, handler); } });
      t.after(() => handlers.get("session_shutdown")());
      let registered;
      const ready = new Promise((resolve) => { registered = resolve; });
      let contextInvalidated = false;
      handlers.get("session_start")({}, {
        cwd: process.cwd(),
        get ui() {
          assert.equal(contextInvalidated, false, "must not use a replaced session's UI context");
          return { notify(message, level) {
          notifications.push({ message, level });
          if (message.includes("inbound connected")) registered();
          } };
        },
      });
      if (scenario === "missing-token") {
        assert.equal(notifications.length, 1);
        assert.match(notifications[0].message, /inbound is disabled: set TELEGRAM_BOT_MAIN_INBOUND_TOKEN/);
        assert.equal(notifications[0].level, "warning");
        return;
      }
      await Promise.race([ready, new Promise((_, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Registration timed out: ${JSON.stringify(notifications)}`)), 2000);
        timeout.unref();
        t.after(() => clearTimeout(timeout));
      })]);
      assert.equal(hub.hasBot(bot), true);
      assert.equal(notifications.some((n) => n.level === "warning" || n.level === "error"), false);
      assert.doesNotThrow(() => handlers.get("session_shutdown")());
      contextInvalidated = true;
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(notifications.length, 1, "intentional close must not notify the invalidated context");
    });
  }
});

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
    TELEGRAM_BOTS: "",
    TELEGRAM_BOT_TOKEN: "test-bot-token",
    PI_TELEGRAM_BOT: "",
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
