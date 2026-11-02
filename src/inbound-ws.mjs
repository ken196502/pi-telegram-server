/**
 * Inbound WebSocket hub + client — 方案 C（反向注册）。
 *
 * Pi 不再监听 HTTP 端口，而是主动连 gateway 的 WebSocket（路径 /inbound），
 * 首帧声明身份（bot 名 + per-bot token）。gateway 按 bot 名把 Telegram update
 * 推给已注册的连接。
 *
 * 协议（JSON 文本帧）：
 *   client → server: {type:"register", bot:"main", token:"<per-bot inbound token>"}
 *   server → client: {type:"registered", bot:"main"}
 *                 或 {type:"error", code:"unknown_bot"|"bad_token"|"missing_fields", message:"..."}  然后 close(4001)
 *   server → client: {type:"telegram_message", bot:"main", body:"...", ...}   （update 推送）
 *   双向 ping/pong（WS 协议层，非应用帧）每 25s 一次
 */
import { WebSocketServer } from "ws";

const PING_INTERVAL_MS = 25000;
const PONG_TIMEOUT_MS = 60000;

/**
 * Gateway-side hub: manages per-bot WebSocket connections and pushes updates.
 *
 * @param {object} opts
 * @param {function} opts.resolveBotToken  (botName) => token string | undefined
 * @param {function} opts.log              (level, message, fields) => void
 * @returns {InboundHub}
 */
export function createInboundHub({ resolveBotToken, log = () => {} }) {
  // botName -> Set<ws>
  const connections = new Map();
  // ws -> { bot, lastPongAt }
  const meta = new WeakMap();
  let pingTimer = null;

  function startPings() {
    if (pingTimer) return;
    pingTimer = setInterval(() => {
      const now = Date.now();
      for (const [botName, set] of connections) {
        for (const ws of set) {
          const m = meta.get(ws);
          if (!m) continue;
          if (now - m.lastPongAt > PONG_TIMEOUT_MS) {
            log("warn", "inbound ws stale: no pong, closing", { bot: botName });
            try { ws.terminate(); } catch {}
            continue;
          }
          try { ws.ping(); } catch {}
        }
      }
    }, PING_INTERVAL_MS);
    pingTimer.unref?.();
  }

  function stopPings() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  }

  function register(ws, { bot, token }) {
    const botName = String(bot || "").trim().toLowerCase();
    if (!botName || !token) {
      sendJson(ws, { type: "error", code: "missing_fields", message: "register frame requires bot and token" });
      try { ws.close(4001, "missing_fields"); } catch {}
      return;
    }
    const expected = resolveBotToken(botName);
    if (expected === undefined) {
      sendJson(ws, { type: "error", code: "unknown_bot", message: `unknown bot: ${botName}` });
      try { ws.close(4001, "unknown_bot"); } catch {}
      return;
    }
    if (token !== expected) {
      sendJson(ws, { type: "error", code: "bad_token", message: `bad inbound token for bot: ${botName}` });
      try { ws.close(4001, "bad_token"); } catch {}
      return;
    }
    let set = connections.get(botName);
    if (!set) { set = new Set(); connections.set(botName, set); }
    set.add(ws);
    meta.set(ws, { bot: botName, lastPongAt: Date.now() });
    sendJson(ws, { type: "registered", bot: botName });
    log("info", "inbound ws registered", { bot: botName, connections: set.size });
  }

  function unregister(ws) {
    const m = meta.get(ws);
    if (!m) return;
    const set = connections.get(m.bot);
    if (set) {
      set.delete(ws);
      if (set.size === 0) connections.delete(m.bot);
      log("info", "inbound ws unregistered", { bot: m.bot, remaining: set ? set.size : 0 });
    }
    meta.delete(ws);
  }

  function send(botName, payload) {
    const name = String(botName || "").trim().toLowerCase();
    const set = connections.get(name);
    if (!set || set.size === 0) return false;

    // A single bot maps to a single active session in Pi. If multiple connections exist
    // (e.g. from session replacements or reconnect timing), deliver only to the most
    // recently registered open connection to avoid executing slash commands or prompts twice.
    const openSockets = [];
    for (const ws of set) {
      if (ws.readyState === ws.OPEN) {
        openSockets.push(ws);
      }
    }
    if (openSockets.length === 0) return false;

    const targetWs = openSockets[openSockets.length - 1];
    try {
      targetWs.send(JSON.stringify(payload));
      return true;
    } catch (err) {
      log("warn", "inbound ws send failed", { bot: name, error: err.message });
      return false;
    }
  }

  function registeredBots() {
    return [...connections.keys()];
  }

  function hasBot(botName) {
    const name = String(botName || "").trim().toLowerCase();
    const set = connections.get(name);
    return Boolean(set && set.size > 0);
  }

  function closeAll() {
    for (const set of connections.values()) {
      for (const ws of set) {
        try { ws.close(1001, "shutting down"); } catch {}
      }
    }
    connections.clear();
    stopPings();
  }

  function attachToServer(httpServer, path = "/inbound") {
    const wss = new WebSocketServer({ noServer: true });
    httpServer.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url || "/", "http://dummy");
      if (url.pathname !== path) return; // let other upgrade handlers deal with it
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    });
    wss.on("connection", (ws) => {
      startPings();
      ws.isAlive = true;
      ws.on("pong", () => {
        const m = meta.get(ws);
        if (m) m.lastPongAt = Date.now();
        ws.isAlive = true;
      });
      ws.on("message", (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch {
          sendJson(ws, { type: "error", code: "bad_json", message: "message must be valid JSON" });
          return;
        }
        if (msg?.type === "register") {
          register(ws, { bot: msg.bot, token: msg.token });
        } else {
          sendJson(ws, { type: "error", code: "unexpected", message: `unexpected message type: ${msg?.type}` });
        }
      });
      ws.on("close", () => unregister(ws));
      ws.on("error", (err) => {
        log("warn", "inbound ws error", { error: err.message });
        unregister(ws);
      });
    });
    return wss;
  }

  return { attachToServer, register, unregister, send, registeredBots, hasBot, closeAll };
}

function sendJson(ws, obj) {
  if (ws.readyState !== ws.OPEN) return;
  try { ws.send(JSON.stringify(obj)); } catch {}
}

/**
 * Pi-side client: connects to gateway WS, registers, auto-reconnects.
 *
 * @param {object} opts
 * @param {string} opts.url          ws(s)://host:port/inbound
 * @param {string} opts.bot          bot name to register as
 * @param {string} opts.token        per-bot inbound token
 * @param {function} opts.onMessage  (payload) => void  — called for each pushed update
 * @param {function} [opts.onOpen]   () => void — registered successfully
 * @param {function} [opts.onClose]  (reason) => void — connection lost / closed
 * @param {function} [opts.log]      (level, message, fields) => void
 * @param {class} [opts.WsImpl]      WebSocket class (defaults to global WebSocket)
 * @returns {InboundClient}
 */
export function connectInboundClient({ url, bot, token, onMessage, onOpen, onClose, log = () => {}, WsImpl }) {
  const WS = WsImpl || (typeof WebSocket !== "undefined" ? WebSocket : null);
  if (!WS) throw new Error("no WebSocket implementation available; Node 22+ or the ws package is required");

  let ws = null;
  let stopped = false;
  let reconnectDelay = 1000;
  let reconnectTimer = null;
  let pingTimer = null;
  let registrationConfirmed = false;

  function scheduleReconnect() {
    if (stopped) return;
    if (reconnectTimer) return;
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!stopped) connect();
    }, reconnectDelay);
    reconnectTimer.unref?.();
  }

  function startPing() {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === ws.OPEN) {
        try { ws.ping?.(); } catch {}
      }
    }, PING_INTERVAL_MS);
    pingTimer.unref?.();
  }

  function stopPing() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  }

  function connect() {
    if (stopped) return;
    log("info", "inbound ws connecting", { url, bot });
    try {
      ws = new WS(url);
    } catch (err) {
      log("error", "inbound ws construct failed", { error: err.message });
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      if (stopped) {
        try { ws.close(); } catch {}
        return;
      }
      reconnectDelay = 1000;
      startPing();
      // Send register frame immediately.
      sendRaw(ws, { type: "register", bot, token });
    };

    ws.onmessage = (event) => {
      if (stopped) return;
      let payload;
      try {
        const data = typeof event.data === "string" ? event.data : event.data.toString();
        payload = JSON.parse(data);
      } catch {
        log("warn", "inbound ws bad json", {});
        return;
      }
      if (payload.type === "registered") {
        registrationConfirmed = true;
        log("info", "inbound ws registered", { bot });
        onOpen?.();
      } else if (payload.type === "error") {
        log("error", "inbound ws error from gateway", { code: payload.code, message: payload.message });
        onClose?.(payload.message);
        // Registration errors are fatal — don't hammer the gateway.
        if (payload.code === "unknown_bot" || payload.code === "bad_token") {
          stopped = true;
          stopPing();
          try { ws.close(); } catch {}
          return;
        }
      } else {
        // Update push.
        onMessage(payload);
      }
    };

    ws.onclose = (event) => {
      stopPing();
      if (stopped) return;
      if (registrationConfirmed) {
        registrationConfirmed = false;
        onClose?.(`connection closed (code ${event?.code})`);
      }
      scheduleReconnect();
    };

    ws.onerror = (err) => {
      if (stopped) return;
      log("warn", "inbound ws socket error", { error: err?.message || String(err) });
      // onclose will fire and schedule reconnect.
    };

    // ws package uses .on("pong"); browser WebSocket has no pong event.
    ws.on?.("pong", () => { /* keepalive handled by ping */ });
  }

  function sendRaw(socket, obj) {
    const data = JSON.stringify(obj);
    if (socket.readyState !== socket.OPEN) return;
    try { socket.send(data); } catch (err) {
      log("warn", "inbound ws send failed", { error: err.message });
    }
  }

  function close() {
    stopped = true;
    registrationConfirmed = false;
    stopPing();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) {
      try { ws.close(1000, "client closing"); } catch {}
    }
  }

  connect();
  return { close, get isOpen() { return Boolean(ws && ws.readyState === ws.OPEN && registrationConfirmed); } };
}

/**
 * Resolve the inbound WebSocket URL from environment.
 *
 * Priority:
 *   1. PI_TELEGRAM_INBOUND_WS_URL (explicit ws:// or wss:// URL)
 *   2. derived from TELEGRAM_HOST / TELEGRAM_PORT → ws://<host>:<port>/inbound
 *
 * @param {object} env
 * @returns {string}
 */
export function resolveInboundWsUrl(env = process.env) {
  const explicit = String(env.PI_TELEGRAM_INBOUND_WS_URL || "").trim();
  if (explicit) return explicit;
  const rawHost = String(env.TELEGRAM_HOST || env.HTTP_HOST || "").trim();
  const port = String(env.TELEGRAM_PORT || env.HTTP_PORT || "3093").trim();
  if (!rawHost) throw new Error("cannot derive inbound WS URL: TELEGRAM_HOST is empty");
  if (!port) throw new Error("cannot derive inbound WS URL: TELEGRAM_PORT is empty");
  return `ws://${rawHost}:${port}/inbound`;
}
