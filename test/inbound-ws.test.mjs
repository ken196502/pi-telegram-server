import assert from "node:assert/strict";
import http from "node:http";
import { describe, it, before, after } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { createInboundHub, connectInboundClient, resolveInboundWsUrl } from "../src/inbound-ws.mjs";

const TOKEN_MAIN = "main-secret";
const TOKEN_PILOT = "pilot-secret";

function makeHub() {
  const tokens = { main: TOKEN_MAIN, inspilot: TOKEN_PILOT };
  const logs = [];
  const log = (level, message, fields = {}) => logs.push({ level, message, fields });
  const hub = createInboundHub({
    resolveBotToken: (name) => tokens[name],
    log,
  });
  return { hub, logs };
}

function startGateway(hub) {
  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  const wss = hub.attachToServer(server, "/inbound");
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, wss, port: server.address().port }));
  });
}

function wsUrl(port) {
  return `ws://127.0.0.1:${port}/inbound`;
}

describe("InboundHub register", () => {
  let gateway, hub, logs;

  before(async () => {
    const made = makeHub();
    hub = made.hub; logs = made.logs;
    gateway = await startGateway(hub);
  });
  after(async () => {
    hub.closeAll();
    await new Promise((r) => gateway.server.close(r));
  });

  it("accepts a valid register and confirms", async () => {
    const ws = new WebSocket(wsUrl(gateway.port));
    const received = [];
    ws.on("message", (raw) => received.push(JSON.parse(raw.toString())));
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "register", bot: "main", token: TOKEN_MAIN }));
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(received.map((m) => m.type), ["registered"]);
    assert.equal(hub.hasBot("main"), true);
    ws.close();
  });

  it("rejects unknown bot", async () => {
    const ws = new WebSocket(wsUrl(gateway.port));
    const received = [];
    ws.on("message", (raw) => received.push(JSON.parse(raw.toString())));
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "register", bot: "ghost", token: "x" }));
    await new Promise((r) => ws.on("close", r));
    const err = received.find((m) => m.type === "error");
    assert.ok(err);
    assert.equal(err.code, "unknown_bot");
    assert.equal(hub.hasBot("ghost"), false);
  });

  it("rejects bad token", async () => {
    const ws = new WebSocket(wsUrl(gateway.port));
    const received = [];
    ws.on("message", (raw) => received.push(JSON.parse(raw.toString())));
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "register", bot: "main", token: "wrong" }));
    await new Promise((r) => ws.on("close", r));
    const err = received.find((m) => m.type === "error");
    assert.ok(err);
    assert.equal(err.code, "bad_token");
  });

  it("rejects missing fields", async () => {
    const ws = new WebSocket(wsUrl(gateway.port));
    const received = [];
    ws.on("message", (raw) => received.push(JSON.parse(raw.toString())));
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "register", bot: "main" }));
    await new Promise((r) => ws.on("close", r));
    const err = received.find((m) => m.type === "error");
    assert.ok(err);
    assert.equal(err.code, "missing_fields");
  });
});

describe("InboundHub send", () => {
  let gateway, hub;

  before(async () => {
    const made = makeHub();
    hub = made.hub;
    gateway = await startGateway(hub);
  });
  after(async () => {
    hub.closeAll();
    await new Promise((r) => gateway.server.close(r));
  });

  it("delivers to a registered connection and returns true", async () => {
    const ws = new WebSocket(wsUrl(gateway.port));
    const messages = [];
    ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "register", bot: "inspilot", token: TOKEN_PILOT }));
    await new Promise((r) => setTimeout(r, 50));
    const ok = hub.send("inspilot", { type: "telegram_message", body: "hi" });
    assert.equal(ok, true);
    await new Promise((r) => setTimeout(r, 50));
    const push = messages.find((m) => m.type === "telegram_message");
    assert.ok(push);
    assert.equal(push.body, "hi");
    ws.close();
  });

  it("returns false when no connection registered", () => {
    const ok = hub.send("nobody", { type: "telegram_message", body: "hi" });
    assert.equal(ok, false);
  });

  it("returns false for a known bot with no live connection", () => {
    const ok = hub.send("main", { type: "telegram_message", body: "hi" });
    assert.equal(ok, false);
  });
});

describe("InboundHub registeredBots", () => {
  let gateway, hub;

  before(async () => {
    const made = makeHub();
    hub = made.hub;
    gateway = await startGateway(hub);
  });
  after(async () => {
    hub.closeAll();
    await new Promise((r) => gateway.server.close(r));
  });

  it("lists registered bots and removes on disconnect", async () => {
    const ws = new WebSocket(wsUrl(gateway.port));
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "register", bot: "main", token: TOKEN_MAIN }));
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(hub.registeredBots(), ["main"]);
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(hub.registeredBots(), []);
  });
});

describe("connectInboundClient", () => {
  let gateway, hub;

  before(async () => {
    const made = makeHub();
    hub = made.hub;
    gateway = await startGateway(hub);
  });
  after(async () => {
    hub.closeAll();
    await new Promise((r) => gateway.server.close(r));
  });

  it("connects, registers, and receives pushed messages", async () => {
    const opened = [];
    const messages = [];
    const client = connectInboundClient({
      url: wsUrl(gateway.port),
      bot: "main",
      token: TOKEN_MAIN,
      onMessage: (m) => messages.push(m),
      onOpen: () => opened.push(true),
      WsImpl: WebSocket,
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(opened.length, 1);
    assert.equal(hub.hasBot("main"), true);
    hub.send("main", { type: "telegram_message", body: "hello from gateway" });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].body, "hello from gateway");
    client.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  it("does not reconnect on fatal registration error (bad token)", async () => {
    const closed = [];
    const client = connectInboundClient({
      url: wsUrl(gateway.port),
      bot: "main",
      token: "definitely-wrong",
      onClose: (reason) => closed.push(reason),
      WsImpl: WebSocket,
    });
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(closed.length >= 1, "should have closed with error reason");
    client.close();
  });

  it("still reports unexpected disconnects", async (t) => {
    const socketReady = new Promise((resolve) => gateway.wss.once("connection", resolve));
    let registered;
    const ready = new Promise((resolve) => { registered = resolve; });
    let disconnected;
    const closed = new Promise((resolve) => { disconnected = resolve; });
    const client = connectInboundClient({
      url: wsUrl(gateway.port), bot: "main", token: TOKEN_MAIN,
      onOpen: registered, onClose: disconnected, WsImpl: WebSocket,
    });
    t.after(() => client.close());
    await ready;
    const socket = await socketReady;
    socket.close(1001, "gateway restart");
    assert.match(await closed, /connection closed/);
    assert.equal(client.isOpen, false);
  });

  it("ignores late socket events after intentional close", () => {
    let socket;
    const callbacks = [];
    class DelayedSocket {
      constructor() { socket = this; this.OPEN = 1; this.readyState = 0; }
      close() { this.readyState = 3; }
      send() { callbacks.push("send"); }
    }
    const client = connectInboundClient({
      url: "ws://test/inbound", bot: "main", token: TOKEN_MAIN,
      onMessage: () => callbacks.push("message"), onOpen: () => callbacks.push("open"),
      onClose: () => callbacks.push("close"), log: () => {}, WsImpl: DelayedSocket,
    });
    client.close();
    socket.readyState = socket.OPEN;
    socket.onopen();
    socket.onmessage({ data: JSON.stringify({ type: "registered" }) });
    socket.onmessage({ data: JSON.stringify({ type: "telegram_message", body: "late" }) });
    socket.onerror(new Error("late error"));
    socket.onclose({ code: 1000 });
    assert.deepEqual(callbacks, []);
    assert.equal(client.isOpen, false);
  });
});

describe("resolveInboundWsUrl", () => {
  it("uses explicit PI_TELEGRAM_INBOUND_WS_URL", () => {
    assert.equal(resolveInboundWsUrl({ PI_TELEGRAM_INBOUND_WS_URL: "ws://gw:9999/inbound" }), "ws://gw:9999/inbound");
  });
  it("derives from TELEGRAM_HOST and TELEGRAM_PORT", () => {
    assert.equal(resolveInboundWsUrl({ TELEGRAM_HOST: "127.0.0.1", TELEGRAM_PORT: "3093" }), "ws://127.0.0.1:3093/inbound");
  });
  it("uses defaults for port when only host is set", () => {
    assert.equal(resolveInboundWsUrl({ TELEGRAM_HOST: "127.0.0.1" }), "ws://127.0.0.1:3093/inbound");
  });
  it("throws when host is empty", () => {
    assert.throws(() => resolveInboundWsUrl({ TELEGRAM_HOST: "", TELEGRAM_PORT: "3093" }), /TELEGRAM_HOST is empty/);
    assert.throws(() => resolveInboundWsUrl({}), /TELEGRAM_HOST is empty/);
  });
});
