#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exportMarkdownTablesToHtmlFile, extractMarkdownTables, formatReplyPrompt, translateInboundSlashCommand } from "../src/lib.mjs";
import { 
  tmuxSessionExists, 
  captureTmuxPane, 
  sendTmuxKey,
  parseMenuItems, 
  detectMenu, 
  captureMenuByNavigation, 
  collectMenuFromScreen,
  formatMenuForTelegram, 
  findMenuItemIndex, 
  selectMenuItem,
  handleMenuSelection
} from "../src/tmux-utils.mjs";

function readDotEnv(cwd) {
  const values = {};
  const files = [
    ...new Set([
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env"),
      path.resolve(cwd, ".env"),
    ]),
  ];
  for (const file of files) {
    try {
      for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
        const t = line.trim(), i = t.indexOf("=");
        if (!t || t.startsWith("#") || i < 0) continue;
        const key = t.slice(0, i).trim();
        let value = t.slice(i + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (key && values[key] === undefined) values[key] = value;
      }
    } catch {}
  }
  return values;
}

function textOf(message) {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content.filter((p) => p?.type === "text").map((p) => p.text || "").join("").trim();
}

function extractFilePaths(text) {
  const paths = [];
  const regex = /(?:^|\s)(\/[^\s]+\.(?:pdf|doc|docx|txt|csv|json|xml|html|md|zip|tar|gz|png|jpg|jpeg|gif|mp3|mp4|wav|py|js|ts|sh|bash|log))/gmi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    paths.push(match[1].trim());
  }
  return paths;
}

function post(urlValue, body, token) {
  const url = new URL(urlValue);
  const payload = JSON.stringify(body);
  const transport = url.protocol === "https:" ? import("node:https") : import("node:http");
  return transport.then((module) => new Promise((resolve, reject) => {
    const request = module.request(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      },
    }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (c) => { raw += c; });
      response.on("end", () => resolve({ status: response.statusCode || 0, raw }));
    });
    request.setTimeout(15000, () => request.destroy(new Error("webhook request timed out")));
    request.on("error", reject);
    request.end(payload);
  }));
}

async function mirror(message, settings) {
  const response = await post(settings.url, { to: settings.to, message }, settings.token);
  if (response.status < 200 || response.status >= 300) throw new Error(response.raw || `HTTP ${response.status}`);
}

async function sendFile(filePath, settings, caption) {
  const payload = { to: settings.to, filePath, message: caption || "" };
  const response = await post(settings.url, payload, settings.token);
  if (response.status < 200 || response.status >= 300) throw new Error(response.raw || `HTTP ${response.status}`);
  return JSON.parse(response.raw);
}

async function sendTyping(settings) {
  if (!settings.to || !settings.token) return;
  await post(settings.url, { to: settings.to, action: "typing" }, settings.token).catch(() => {});
}

async function sendStopTyping(settings) {
  if (!settings.to || !settings.token) return;
  await post(settings.url, { to: settings.to, action: "stop_typing" }, settings.token).catch(() => {});
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => {
      body += c;
      if (body.length > 1024 * 1024) reject(new Error("request body is too large"));
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("request body must be valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

export default function telegramMirror(pi) {
  let settings;
  let server;
  let typingInterval = null;
  const seen = new Set();
  
  // Menu state management
  let currentMenuItems = [];
  let menuCaptureInProgress = false;
  let lastMenuCaptureTime = 0;

  const get = (cwd) => {
    if (settings) return settings;
    const env = { ...readDotEnv(cwd), ...process.env };
    settings = {
      url: env.PI_TELEGRAM_WEBHOOK_URL || env.TELEGRAM_WEBHOOK_URL || `http://${env.TELEGRAM_HOST || "127.0.0.1"}:${env.TELEGRAM_PORT || "3093"}/webhook`,
      token: env.PI_TELEGRAM_WEBHOOK_TOKEN || env.TELEGRAM_WEBHOOK_TOKEN || env.WEBHOOK_TOKEN || "",
      to: env.PI_TELEGRAM_TO || env.TELEGRAM_TO || "",
      botToken: env.TELEGRAM_BOT_TOKEN || "",
      apiBase: (env.TELEGRAM_API_BASE_URL || "https://api.telegram.org").replace(/\/$/, ""),
      inboundHost: env.PI_TELEGRAM_INBOUND_HOST || "127.0.0.1",
      inboundPort: Number(env.PI_TELEGRAM_INBOUND_PORT || "3094"),
      inboundPath: env.PI_TELEGRAM_INBOUND_PATH || "/telegram/inbound",
      inboundToken: env.PI_TELEGRAM_INBOUND_TOKEN || env.INBOUND_WEBHOOK_TOKEN || "",
    };
    return settings;
  };

  pi.registerTool({
    name: "send_telegram_file",
    label: "Send Telegram file",
    description: "Send a file to Telegram chat. Use this to send files, logs, documents, or any file to the user via Telegram.",
    parameters: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Absolute path to the file to send" },
        caption: { type: "string", description: "Optional caption message to include with the file" },
      },
      required: ["filePath"],
      additionalProperties: false,
    },
    async execute(_toolCallId, { filePath, caption }, _signal, _onUpdate, ctx) {
      const s = get(ctx?.cwd || process.cwd());
      if (!s.to || !s.token) {
        return {
          content: [{ type: "text", text: "Telegram not configured: set PI_TELEGRAM_TO and PI_TELEGRAM_WEBHOOK_TOKEN" }],
          details: { success: false },
        };
      }
      try {
        const result = await sendFile(filePath, s, caption || "");
        return {
          content: [{ type: "text", text: `Sent ${filePath} to Telegram.` }],
          details: { success: true, ...result },
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Telegram file send failed: ${e.message}` }],
          details: { success: false, error: e.message },
        };
      }
    },
  });

  // Slash commands accessible from Telegram and interactive mode
  // Note: /new and /compact are built-in Pi interactive commands. To avoid conflict warnings
  // and autocomplete skipping in Pi, we register /clear and /compact_session here, and inbound
  // Telegram commands /new and /compact are transparently routed to them.
  pi.registerCommand("clear", {
    description: "Start a fresh session",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      const res = await ctx.newSession();
      if (!res.cancelled) {
        const s = get(process.cwd());
        if (s.to && s.token) {
          await mirror("✓ New session started.", s).catch(() => {});
        }
      }
    },
  });

  pi.registerCommand("compact_session", {
    description: "Compact the session context",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      ctx.compact({ customInstructions: args ? args.trim() : undefined });
      const s = get(process.cwd());
      if (s.to && s.token) {
        await mirror("✓ Context compaction initiated.", s).catch(() => {});
      }
    },
  });

  pi.registerCommand("abort", {
    description: "Abort the currently running agent operation",
    handler: async (_args, ctx) => {
      ctx.abort();
      const s = get(process.cwd());
      if (s.to && s.token) {
        await mirror("⏹ Operation aborted.", s).catch(() => {});
      }
    },
  });

  pi.registerCommand("stop", {
    description: "Alias for /abort",
    handler: async (_args, ctx) => {
      ctx.abort();
      const s = get(process.cwd());
      if (s.to && s.token) {
        await mirror("⏹ Operation aborted.", s).catch(() => {});
      }
    },
  });

  pi.registerCommand("status", {
    description: "Show current Pi status",
    handler: async (_args, ctx) => {
      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
      const usage = ctx.getContextUsage?.();
      const sessionName = ctx.sessionManager?.getSessionName?.() || "default";
      const statusLines = [
        "📊 **Pi Session Status:**",
        `• Session: \`${sessionName}\``,
        `• Model: \`${model}\``,
        usage ? `• Context Tokens: \`${usage.totalTokens || 0}\` / \`${usage.contextWindow || 0}\`` : "",
      ].filter(Boolean);
      const s = get(process.cwd());
      if (s.to && s.token) {
        await mirror(statusLines.join("\n"), s).catch(() => {});
      }
    },
  });

  pi.registerCommand("help", {
    description: "Show available Telegram bot commands",
    handler: async (_args, _ctx) => {
      const s = get(process.cwd());
      if (s.to && s.token) {
        const helpText = [
          "🤖 **Available Telegram Commands:**",
          "• `/new` or `/clear` — Start a fresh session",
          "• `/compact [notes]` — Compact session context",
          "• `/abort` or `/stop` — Abort current operation",
          "• `/status` — View current model & token usage",
          "• `/menu` — Capture and display interactive menu from Pi",
          "• `/menu <number>` — Select menu option by number",
          "• `/menu capture` — Force menu capture with navigation",
          "• `/help` — Display this command list",
        ].join("\n");
        await mirror(helpText, s).catch(() => {});
      }
    },
  });

  pi.registerCommand("menu", {
    description: "Capture and interact with Pi's interactive menu",
    handler: async (args, ctx) => {
      const s = get(process.cwd());
      if (!s.to || !s.token) {
        return ctx.ui.notify("Telegram not configured: set PI_TELEGRAM_TO and PI_TELEGRAM_WEBHOOK_TOKEN", "warning");
      }

      // Check if tmux session exists
      if (!tmuxSessionExists("pi")) {
        await mirror("❌ No active Pi tmux session found. Please ensure Pi is running in a tmux session named 'pi'.", s).catch(() => {});
        return;
      }

      // If args provided, try to select menu item
      if (args && args.trim()) {
        const selection = args.trim();
        
        // Handle special commands
        if (selection === "capture" || selection === "refresh") {
          // Force menu capture with keyboard navigation (Down key)
          menuCaptureInProgress = true;
          await mirror("🔄 Pressing Down keys to collect menu items...", s).catch(() => {});
          
          try {
            currentMenuItems = collectMenuFromScreen("pi", { maxPresses: 20, delayMs: 80 });
            lastMenuCaptureTime = Date.now();
            
            if (currentMenuItems.length === 0) {
              await mirror("❌ No menu items detected. Make sure Pi is showing an interactive menu.", s).catch(() => {});
            } else {
              const menuText = formatMenuForTelegram(currentMenuItems);
              await mirror(menuText, s).catch(() => {});
            }
          } catch (error) {
            await mirror(`❌ Menu capture failed: ${error.message}`, s).catch(() => {});
          } finally {
            menuCaptureInProgress = false;
          }
          return;
        }
        
        if (selection === "clear") {
          currentMenuItems = [];
          await mirror("✓ Menu state cleared.", s).catch(() => {});
          return;
        }
        
        // Try to select menu item
        if (currentMenuItems.length === 0) {
          await mirror("❌ No menu captured yet. Use `/menu` first to capture the menu.", s).catch(() => {});
          return;
        }
        
        const selectedIndex = findMenuItemIndex(currentMenuItems, selection);
        if (selectedIndex === -1) {
          const availableOptions = currentMenuItems.map((item, i) => `${i + 1}. ${item.text}`).join("\n");
          await mirror(`❌ Selection "${selection}" not found. Available options:\n${availableOptions}`, s).catch(() => {});
          return;
        }
        
        // Send selection to tmux
        try {
          selectMenuItem("pi", currentMenuItems, selectedIndex);
          const selectedItem = currentMenuItems[selectedIndex];
          await mirror(`✓ Selected: ${selectedItem.text}\nWaiting for Pi to process...`, s).catch(() => {});
          
          // Wait a moment and capture the result
          setTimeout(async () => {
            try {
              const resultContent = captureTmuxPane("pi", 50);
              const menuDetection = detectMenu(resultContent);
              
              if (menuDetection.isMenu) {
                // New menu appeared, capture it
                const newItems = parseMenuItems(resultContent);
                if (newItems.length > 0) {
                  currentMenuItems = newItems;
                  const menuText = formatMenuForTelegram(currentMenuItems, "📋 New Menu");
                  await mirror(menuText, s).catch(() => {});
                }
              } else {
                // Show result preview
                const preview = resultContent.slice(-500).trim();
                if (preview) {
                  await mirror(`📄 Result:\n\`\`\`\n${preview}\n\`\`\``, s).catch(() => {});
                }
              }
            } catch (error) {
              console.error("Error capturing result:", error);
            }
          }, 500);
        } catch (error) {
          await mirror(`❌ Selection failed: ${error.message}`, s).catch(() => {});
        }
        return;
      }

      // No args - collect menu by pressing Down keys
      if (menuCaptureInProgress) {
        await mirror("⏳ Menu capture already in progress...", s).catch(() => {});
        return;
      }

      menuCaptureInProgress = true;
      await mirror("🔍 Collecting menu items...", s).catch(() => {});

      try {
        currentMenuItems = collectMenuFromScreen("pi", { maxPresses: 20, delayMs: 80 });
        lastMenuCaptureTime = Date.now();
        
        if (currentMenuItems.length > 0) {
          const menuText = formatMenuForTelegram(currentMenuItems);
          await mirror(menuText, s).catch(() => {});
        } else {
          await mirror("❌ No menu items found. Make sure Pi is showing an interactive menu, or try `/menu capture` to force navigation.", s).catch(() => {});
        }
      } catch (error) {
        await mirror(`❌ Menu capture failed: ${error.message}`, s).catch(() => {});
      } finally {
        menuCaptureInProgress = false;
      }
    },
  });

  function startTyping() {
    const s = get(process.cwd());
    if (!s.to || !s.token) return;
    if (typingInterval) return;
    void sendTyping(s);
    typingInterval = setInterval(() => {
      void sendTyping(s);
    }, 4000);
  }

  function stopTyping() {
    if (typingInterval) {
      clearInterval(typingInterval);
      typingInterval = null;
      const s = get(process.cwd());
      if (s.to && s.token) {
        void sendStopTyping(s);
      }
    }
  }

  pi.on("session_start", (_event, ctx) => {
    const s = get(ctx.cwd);
    if (!s.inboundToken) return ctx.ui.notify("Telegram inbound is disabled: set PI_TELEGRAM_INBOUND_TOKEN or INBOUND_WEBHOOK_TOKEN", "warning");

    if (server) {
      try { server.close(); } catch {}
      server = undefined;
    }

    server = http.createServer(async (req, res) => {
      const url = new URL(req.url || "/", `http://${s.inboundHost}`);
      if (req.method !== "POST" || url.pathname !== s.inboundPath) {
        res.writeHead(404);
        return res.end();
      }
      const auth = String(req.headers.authorization || "");
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : String(req.headers["x-webhook-token"] || "");
      if (token !== s.inboundToken) {
        res.writeHead(401);
        return res.end();
      }
      try {
        const message = await readJson(req);
        if (message.messageId && seen.has(message.messageId)) return res.end('{"ok":true}');
        if (message.messageId) seen.add(message.messageId);
        if (!message.body?.trim()) throw new Error("body is required");

        const trimmedBody = message.body.trim();
        const isSlashCommand = /^\/[a-zA-Z]/.test(trimmedBody);

        // --- Menu selection: if user sends just a number and we have a captured menu ---
        const isNumberSelection = /^\d+$/.test(trimmedBody);
        if (isNumberSelection && currentMenuItems.length > 0) {
          const number = parseInt(trimmedBody, 10);
          const index = number - 1;
          if (index >= 0 && index < currentMenuItems.length) {
            const selectedItem = currentMenuItems[index];
            // Navigate to the item: go to top first, then press Down index times, then Enter
            sendTmuxKey("pi", "Escape");
            await new Promise(r => setTimeout(r, 100));
            for (let i = 0; i < index; i++) {
              sendTmuxKey("pi", "Down");
              await new Promise(r => setTimeout(r, 50));
            }
            sendTmuxKey("pi", "Enter");
            currentMenuItems = []; // Clear after selection
            await mirror(`✓ Selected [${number}]: ${selectedItem.text}`, s).catch(() => {});

            // After selection, check if a new menu appeared
            setTimeout(async () => {
              try {
                if (!tmuxSessionExists("pi")) return;
                const newContent = captureTmuxPane("pi", 100);
                const newItems = collectMenuFromScreen("pi");
                if (newItems.length > 0) {
                  currentMenuItems = newItems;
                  lastMenuCaptureTime = Date.now();
                  await mirror(formatMenuForTelegram(newItems), s).catch(() => {});
                }
              } catch (e) {
                console.error("Post-selection menu check error:", e.message);
              }
            }, 1500);

            return res.end('{"ok":true}');
          }
        }

        // --- Slash commands: send to Pi, then check for menu ---
        if (isSlashCommand) {
          const commandText = translateInboundSlashCommand(trimmedBody);
          startTyping();
          await pi.sendUserMessage(commandText, {
            expandPromptTemplates: true,
            deliverAs: "followUp",
          });

          // Check tmux for menu after Pi processes the command
          setTimeout(async () => {
            try {
              if (!tmuxSessionExists("pi")) return;
              const items = collectMenuFromScreen("pi");
              if (items.length > 0) {
                currentMenuItems = items;
                lastMenuCaptureTime = Date.now();
                await mirror(formatMenuForTelegram(items), s).catch(() => {});
              }
            } catch (e) {
              console.error("Post-command menu check error:", e.message);
            }
          }, 2000);

          return res.end('{"ok":true}');
        }

        // --- Normal messages: send to Pi directly, no menu detection ---
        startTyping();
        const promptText = formatReplyPrompt(message.body, message.replyTo);
        await pi.sendUserMessage(`[Telegram ${message.senderId || message.chatId || "unknown"}]\n${promptText}`, { deliverAs: "followUp" });
        res.end('{"ok":true}');
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });

    server.on("error", (err) => {
      ctx.ui.notify(`Telegram inbound listener error: ${err.message}`, "error");
    });

    server.listen(s.inboundPort, s.inboundHost, () => ctx.ui.notify(`Telegram inbound listener: http://${s.inboundHost}:${s.inboundPort}${s.inboundPath}`));
  });

  pi.on("session_shutdown", () => {
    stopTyping();
    server?.close();
    server = undefined;
  });

  pi.on("agent_start", () => {
    startTyping();
  });

  pi.on("turn_start", () => {
    startTyping();
  });

  pi.on("tool_execution_start", () => {
    startTyping();
  });

  pi.on("tool_execution_update", () => {
    startTyping();
  });

  pi.on("tool_call", () => {
    startTyping();
  });

  pi.on("message_start", (event) => {
    if (event?.message?.role === "assistant") {
      startTyping();
    }
  });

  pi.on("message_update", (event) => {
    if (event?.message?.role === "assistant") {
      startTyping();
    }
  });

  pi.on("agent_end", () => {
    stopTyping();
  });

  pi.on("agent_settled", () => {
    stopTyping();
  });

  pi.on("message_end", (event, ctx) => {
    const message = textOf(event.message);
    const s = get(ctx.cwd);
    if (!message) return;
    stopTyping();
    if (!s.to || !s.token) return ctx.ui.notify("Telegram mirror is not configured: set PI_TELEGRAM_TO and PI_TELEGRAM_WEBHOOK_TOKEN", "warning");

    const filePaths = extractFilePaths(message);
    if (filePaths.length > 0) {
      for (const filePath of filePaths) {
        void sendFile(filePath, s, `File from Pi: ${path.basename(filePath)}`).catch((e) => ctx.ui.notify(`Telegram file send failed: ${e.message}`, "error"));
      }
    }

    // Automatically extract tables to HTML document with frozen header & first column
    try {
      const tables = extractMarkdownTables(message);
      if (tables.length > 0) {
        for (const t of tables) {
          const titleSlug = t.title ? t.title.slice(0, 20).replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, "_") : "table";
          const htmlFile = exportMarkdownTablesToHtmlFile(t.tableMd, {
            title: t.title,
            fileName: `${titleSlug}-${Date.now()}.html`,
          });
          if (htmlFile) {
            void sendFile(htmlFile, s, `📊 ${t.title || "数据表格"}（已冻结表头与首列）`).catch((e) =>
              ctx.ui.notify(`Telegram table export failed: ${e.message}`, "error")
            );
          }
        }
      }
    } catch {}

    void mirror(message, s).catch((e) => ctx.ui.notify(`Telegram mirror failed: ${e.message}`, "error"));
  });
}

export { textOf, textOf as getText, mirror };
