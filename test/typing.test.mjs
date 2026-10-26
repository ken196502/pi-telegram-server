import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import telegramMirror from "../extensions/telegram-mirror.mjs";

// The typing keepalive must survive silent stretches of a live agent run (long thinking,
// silent tool calls) and must still be dropped when a dispatched message never starts a run.
const IDLE_MS = 60;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function setup(t) {
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
    PI_TG_TYPING_IDLE_MS: String(IDLE_MS),
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
  telegramMirror({
    registerTool() {},
    registerCommand() {},
    on(name, handler) { handlers.set(name, handler); },
  });
  const ctx = { cwd: process.cwd(), ui: { notify() {} } };
  const emit = (name, event = {}) => handlers.get(name)?.(event, ctx);
  return { requests, emit, handlers };
}

const actions = (requests) => requests.filter((r) => r.action).map((r) => r.action);

test("typing survives a silent stretch while the agent is running", async (t) => {
  const { requests, emit } = await setup(t);
  emit("agent_start");
  await wait(IDLE_MS * 3);
  assert.deepEqual(actions(requests), ["typing"], "no stop_typing while the run is active");

  emit("agent_end");
  await wait(20);
  assert.deepEqual(actions(requests), ["typing", "stop_typing"]);
});

test("a dispatched message that never starts a run still drops typing", async (t) => {
  const { requests, emit } = await setup(t);
  // turn_start fires for a queued message before/without agent_start (agentRunning stays false).
  emit("turn_start");
  await wait(20);
  assert.deepEqual(actions(requests), ["typing"]);
  await wait(IDLE_MS * 3);
  assert.deepEqual(actions(requests), ["typing", "stop_typing"], "idle watchdog releases the indicator");
});

test("assistant message_end keeps typing while the run continues", async (t) => {
  const { requests, emit } = await setup(t);
  emit("agent_start");
  await wait(20);
  await handlersMessageEnd(emit);
  assert.deepEqual(actions(requests), ["typing"], "no stop_typing between assistant message and tool call");

  emit("agent_settled");
  await wait(20);
  assert.deepEqual(actions(requests), ["typing", "stop_typing"]);
});

async function handlersMessageEnd(emit) {
  await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "stop" } });
}
