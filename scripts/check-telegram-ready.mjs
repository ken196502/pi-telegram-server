import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile, resolveBotConfigs } from "../src/lib.mjs";

loadEnvFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env"));
const [mode, ...names] = process.argv.slice(2);
try {
  if (mode === "proxy") {
    process.exitCode = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"].some(k => process.env[k]) ? 0 : 1;
  } else {
    // All modes now query the gateway /health endpoint. The `inbound` mode (R3)
    // checks that each bot has a registered WebSocket connection, replacing the
    // old TCP-connect probe that could not distinguish a real Pi session from
    // any other service bound to the port.
    const host = process.env.TELEGRAM_HOST || process.env.HTTP_HOST || "127.0.0.1";
    const port = process.env.TELEGRAM_PORT || process.env.HTTP_PORT || "3093";
    const response = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(1500) });
    const health = await response.json();
    if (!response.ok || health.service !== "telegram") throw new Error("Gateway unavailable");
    for (const name of names) {
      const botName = name.toLowerCase();
      const bot = health.bots?.[botName];
      if (!bot) throw new Error(`Bot ${name} is not configured`);
      if (mode === "inbound") {
        // R3: the bot must have a live registered WebSocket connection.
        if (!health.inboundRegistered?.includes(botName)) throw new Error(`Bot ${name} has no registered inbound connection`);
      } else if (mode === "connected") {
        if (bot.status !== "connected" || !bot.inboundEnabled) throw new Error(`Bot ${name} is not ready`);
      } else if (mode === "listening") {
        // Gateway is up and the bot is configured; inbound registration is optional here
        // (used to decide whether to start the gateway itself).
      }
    }
  }
} catch {
  process.exitCode = 1;
}
