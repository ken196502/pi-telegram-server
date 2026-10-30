import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { loadEnvFile, resolveBotConfigs } from "../src/lib.mjs";

loadEnvFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env"));
const [mode, ...names] = process.argv.slice(2);
try {
  if (mode === "proxy") {
    process.exitCode = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"].some(k => process.env[k]) ? 0 : 1;
  } else if (mode === "inbound") {
    for (const name of names) {
      const bot = resolveBotConfigs().find(b => b.name === name.toLowerCase());
      if (!bot?.inboundUrl || !bot.inboundToken) throw new Error(`Missing inbound configuration for ${name}`);
      const url = new URL(bot.inboundUrl);
      await new Promise((resolve, reject) => {
        const socket = net.connect(Number(url.port), url.hostname);
        socket.setTimeout(1000);
        socket.once("connect", () => { socket.destroy(); resolve(); });
        socket.once("error", reject);
        socket.once("timeout", () => { socket.destroy(); reject(new Error("Listener timeout")); });
      });
    }
  } else {
    const host = process.env.TELEGRAM_HOST || process.env.HTTP_HOST || "127.0.0.1";
    const port = process.env.TELEGRAM_PORT || process.env.HTTP_PORT || "3093";
    const response = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(1500) });
    const health = await response.json();
    if (!response.ok || health.service !== "telegram") throw new Error("Gateway unavailable");
    for (const name of names) {
      const bot = health.bots?.[name.toLowerCase()];
      if (!bot || (mode === "connected" && (bot.status !== "connected" || !bot.inboundEnabled))) throw new Error(`Bot ${name} is not ready`);
    }
  }
} catch {
  process.exitCode = 1;
}
