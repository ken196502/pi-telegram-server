#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exportMarkdownTablesToHtmlFile, extractMarkdownTables, formatReplyPrompt, translateInboundSlashCommand } from "../src/lib.mjs";
import { 
  tmuxSessionExists, 
  isTmuxInstalled,
  captureTmuxPane, 
  sendTmuxKey,
  sendTmuxText,
  parseMenuItems, 
  detectMenu, 
  captureMenuByNavigation, 
  collectMenuFromScreen,
  formatMenuForTelegram, 
  findMenuItemIndex, 
  selectMenuItem,
  handleMenuSelection
} from "../src/tmux-utils.mjs";

const TMUX_NOT_INSTALLED_MSG = "tmux is not installed. Install it with:\n\n  sudo apt install tmux        (Debian/Ubuntu)\n  sudo dnf install tmux        (Fedora)\n  sudo pacman -S tmux          (Arch)\n  brew install tmux            (macOS)\n\nThen start Pi inside a tmux session and try again.";

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
  
  // Menu interception state
  let currentMenuItems = [];
  let currentModelMenu = [];
  let modelMenuSentAt = 0;
  const MODEL_MENU_STALE_MS = 120000;
  let menuInProgress = false;        // /menu command capture in progress
  const MENU_STALE_MS = 120000;     // forget menu after 2 min
  let lastMenuSentAt = 0;
  let lastSelectionTime = 0;         // timestamp of last menu selection
  const MENU_SELECTION_COOLDOWN_MS = 5000; // 5s cooldown after selection
  let latestCtx = null;

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

  pi.registerCommand("commands", {
    description: "List all available Pi slash commands",
    handler: async (_args, ctx) => {
      latestCtx = ctx;
      const s = get(process.cwd());
      if (s.to && s.token) {
        const commands = pi.getCommands?.() || [];
        const lines = [
          "📋 **Available Telegram Commands:**",
          "• `/new` or `/clear` — Start a fresh session",
          "• `/compact [notes]` — Compact session context",
          "• `/model [name]` — View or switch AI model",
          "• `/status` — View current model & token usage",
          "• `/abort` or `/stop` — Abort current operation",
          "• `/menu` — Interact with active terminal menu",
          "• `/commands` — List all slash commands",
          "• `/help` — Display bot commands",
        ];
        if (commands.length > 0) {
          lines.push("\n**Session & Extension Commands:**");
          for (const cmd of commands) {
            const desc = cmd.description ? ` — ${cmd.description}` : "";
            lines.push(`• \`/${cmd.name}\`${desc}`);
          }
        }
        await mirror(lines.join("\n"), s).catch(() => {});
      }
    },
  });

  pi.registerCommand("help", {
    description: "Show available Telegram bot commands",
    handler: async (_args, ctx) => {
      latestCtx = ctx;
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

      // Check if tmux is installed
      if (!isTmuxInstalled()) {
        await mirror(TMUX_NOT_INSTALLED_MSG, s).catch(() => {});
        return;
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
          menuInProgress = true;
          await mirror("🔄 Pressing Down keys to collect menu items...", s).catch(() => {});
          
          try {
            currentMenuItems = collectMenuFromScreen("pi");
            lastMenuSentAt = Date.now();
            
            if (currentMenuItems.length === 0) {
              await mirror("❌ No menu items detected. Make sure Pi is showing an interactive menu.", s).catch(() => {});
            } else {
              const menuText = formatMenuForTelegram(currentMenuItems);
              await mirror(menuText, s).catch(() => {});
            }
          } catch (error) {
            await mirror(`❌ Menu capture failed: ${error.message}`, s).catch(() => {});
          } finally {
            menuInProgress = false;
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
      if (menuInProgress) {
        await mirror("⏳ Menu capture already in progress...", s).catch(() => {});
        return;
      }

      menuInProgress = true;
      await mirror("🔍 Collecting menu items...", s).catch(() => {});

      try {
        currentMenuItems = collectMenuFromScreen("pi");
        lastMenuSentAt = Date.now();
        
        if (currentMenuItems.length > 0) {
          const menuText = formatMenuForTelegram(currentMenuItems);
          await mirror(menuText, s).catch(() => {});
        } else {
          await mirror("❌ No menu items found. Make sure Pi is showing an interactive menu, or try `/menu capture` to force navigation.", s).catch(() => {});
        }
      } catch (error) {
        await mirror(`❌ Menu capture failed: ${error.message}`, s).catch(() => {});
      } finally {
        menuInProgress = false;
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

  // ── Tmux menu check ───────────────────────────────────────────────
  // Check tmux for a menu, collect items by pressing Down, send to Telegram.
  // Returns collected items or empty array.
  async function checkTmuxForMenu(sendToUser = true) {
    if (!tmuxSessionExists("pi")) return [];
    
    // Respect cooldown period after menu selection
    const timeSinceSelection = Date.now() - lastSelectionTime;
    if (timeSinceSelection < MENU_SELECTION_COOLDOWN_MS) {
      console.log(`Menu check skipped: ${MENU_SELECTION_COOLDOWN_MS - timeSinceSelection}ms cooldown remaining`);
      return [];
    }
    
    try {
      const items = collectMenuFromScreen("pi");
      if (items.length >= 2) {
        currentMenuItems = items;
        lastMenuSentAt = Date.now();
        if (sendToUser) {
          const s = get(process.cwd());
          if (s.to && s.token) {
            await mirror(formatMenuForTelegram(items), s).catch(() => {});
          }
        }
        return items;
      }
    } catch (e) {
      console.error("checkTmuxForMenu error:", e.message);
    }
    return [];
  }

  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
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
        const isNumberSelection = /^\d+$/.test(trimmedBody);

        // ── Number selection: user sends a number ──
        if (isNumberSelection) {
          const number = parseInt(trimmedBody, 10);

          // 1. Model selection menu
          if (currentModelMenu.length > 0 && (Date.now() - modelMenuSentAt) < MODEL_MENU_STALE_MS) {
            const idx = number - 1;
            if (idx >= 0 && idx < currentModelMenu.length) {
              const chosen = currentModelMenu[idx];
              currentModelMenu = [];
              try {
                await pi.setModel(chosen);
                await mirror(`✓ Switched model to: \`${chosen.provider}/${chosen.id}\``, s).catch(() => {});
              } catch (err) {
                await mirror(`❌ Failed to switch model: ${err.message}`, s).catch(() => {});
              }
              return res.end('{"ok":true}');
            }
          }

          // 2. Terminal captured menu
          if (currentMenuItems.length > 0 && (Date.now() - lastMenuSentAt) < MENU_STALE_MS) {
            const index = number - 1;
            if (index >= 0 && index < currentMenuItems.length) {
              const selectedItem = currentMenuItems[index];
              try {
                selectMenuItem("pi", currentMenuItems, index);
                lastSelectionTime = Date.now();
                currentMenuItems = [];
                await mirror(`✓ Selected [${number}]: ${selectedItem.text}`, s).catch(() => {});

                setTimeout(async () => {
                  const newItems = await checkTmuxForMenu(true);
                  if (newItems.length === 0) {
                    try {
                      const screenContent = captureTmuxPane("pi", 35);
                      const preview = screenContent.trim().slice(-500);
                      if (preview) await mirror(`📄 Result:\n\`\`\`\n${preview}\n\`\`\``, s).catch(() => {});
                    } catch {}
                  }
                }, 2000);
              } catch (err) {
                await mirror(`❌ Selection failed: ${err.message}`, s).catch(() => {});
              }
              return res.end('{"ok":true}');
            }
          }
        }

        // ── Menu search: user sends text while model or terminal menu is open ──
        if (!isSlashCommand && !isNumberSelection) {
          // Model menu search
          if (currentModelMenu.length > 0 && (Date.now() - modelMenuSentAt) < MODEL_MENU_STALE_MS) {
            const searchTerm = trimmedBody.toLowerCase();
            const matched = currentModelMenu.filter(m =>
              `${m.provider}/${m.id}`.toLowerCase().includes(searchTerm) ||
              (m.name && m.name.toLowerCase().includes(searchTerm))
            );
            if (matched.length === 1) {
              const chosen = matched[0];
              currentModelMenu = [];
              try {
                await pi.setModel(chosen);
                await mirror(`✓ Switched model to: \`${chosen.provider}/${chosen.id}\``, s).catch(() => {});
              } catch (err) {
                await mirror(`❌ Failed to switch model: ${err.message}`, s).catch(() => {});
              }
              return res.end('{"ok":true}');
            } else if (matched.length > 1) {
              const lines = [`🤖 Found ${matched.length} models matching "${trimmedBody}":\n`];
              matched.forEach((m) => {
                const idx = currentModelMenu.indexOf(m) + 1;
                lines.push(`${idx}. ${m.id}`);
              });
              lines.push(`\n👉 Reply with number to select.`);
              await mirror(lines.join("\n"), s).catch(() => {});
              return res.end('{"ok":true}');
            }
          }

          // Terminal menu search
          if (currentMenuItems.length > 0 && (Date.now() - lastMenuSentAt) < MENU_STALE_MS) {
            const searchTerm = trimmedBody.toLowerCase();
            const matchingItems = currentMenuItems.filter(item =>
              item.text.toLowerCase().includes(searchTerm)
            );

            if (matchingItems.length === 1) {
              const selectedItem = matchingItems[0];
              const index = currentMenuItems.indexOf(selectedItem);
              try {
                selectMenuItem("pi", currentMenuItems, index);
                lastSelectionTime = Date.now();
                currentMenuItems = [];
                await mirror(`✓ Selected: ${selectedItem.text}`, s).catch(() => {});

                setTimeout(async () => {
                  const newItems = await checkTmuxForMenu(true);
                  if (newItems.length === 0) {
                    try {
                      const screenContent = captureTmuxPane("pi", 35);
                      const preview = screenContent.trim().slice(-500);
                      if (preview) await mirror(`📄 Result:\n\`\`\`\n${preview}\n\`\`\``, s).catch(() => {});
                    } catch {}
                  }
                }, 2000);
              } catch (err) {
                await mirror(`❌ Selection failed: ${err.message}`, s).catch(() => {});
              }
              return res.end('{"ok":true}');
            } else if (matchingItems.length > 1) {
              const lines = [`📋 Found ${matchingItems.length} items matching "${trimmedBody}":\n`];
              matchingItems.forEach((item) => {
                const index = currentMenuItems.indexOf(item) + 1;
                const selectedMark = item.selected ? "✅" : `${index}.`;
                lines.push(`${selectedMark} ${item.text}`);
              });
              lines.push(`\n👉 Reply with the number to select.`);
              await mirror(lines.join("\n"), s).catch(() => {});
              return res.end('{"ok":true}');
            } else {
              await mirror(`❌ No items matching "${trimmedBody}". Try a different search term or reply with a number.`, s).catch(() => {});
              return res.end('{"ok":true}');
            }
          }
        }

        // ── Determine how to forward the message ──
        const EXTENSION_COMMANDS = new Set([
          "/clear", "/compact_session", "/abort", "/stop", "/status", "/help", "/menu", "/commands", "/model"
        ]);
        const commandName = trimmedBody.split(/\s+/)[0].toLowerCase();
        const isRegisteredCommand = EXTENSION_COMMANDS.has(commandName) ||
          ["/new", "/compact"].includes(commandName);

        startTyping();
        currentMenuItems = [];
        currentModelMenu = [];

        // ── Native model command handling ──
        if (commandName === "/model") {
          const arg = trimmedBody.replace(/^\/model\s*/i, "").trim();
          const availableModels = latestCtx?.modelRegistry?.getAvailable?.() ||
            latestCtx?.modelRegistry?.getAvailableSnapshot?.() || [];
          const currentModel = latestCtx?.model;
          const currentStr = currentModel ? `${currentModel.provider}/${currentModel.id}` : "unknown";

          if (arg) {
            const lower = arg.toLowerCase();
            let matches = availableModels.filter(m =>
              `${m.provider}/${m.id}`.toLowerCase() === lower ||
              m.id.toLowerCase() === lower
            );
            if (matches.length === 0) {
              matches = availableModels.filter(m =>
                `${m.provider}/${m.id}`.toLowerCase().includes(lower) ||
                (m.name && m.name.toLowerCase().includes(lower))
              );
            }

            if (matches.length === 1) {
              const target = matches[0];
              try {
                await pi.setModel(target);
                await mirror(`✓ Switched model to: \`${target.provider}/${target.id}\``, s).catch(() => {});
              } catch (err) {
                await mirror(`❌ Failed to switch model: ${err.message}`, s).catch(() => {});
              }
              return res.end('{"ok":true}');
            } else if (matches.length > 1) {
              currentModelMenu = matches;
              modelMenuSentAt = Date.now();
              const lines = [
                `🤖 **Multiple models match "${arg}":**`,
                `Current: \`${currentStr}\`\n`,
              ];
              matches.forEach((m, i) => {
                const isCur = currentModel && m.provider === currentModel.provider && m.id === currentModel.id;
                lines.push(`${isCur ? "✅" : `${i + 1}.`} ${m.id}`);
              });
              lines.push(`\n👉 Reply with number to select.`);
              await mirror(lines.join("\n"), s).catch(() => {});
              return res.end('{"ok":true}');
            } else {
              await mirror(`❌ No model matching "${arg}" found. Use \`/model\` to view available models.`, s).catch(() => {});
              return res.end('{"ok":true}');
            }
          } else {
            const modelsToShow = latestCtx?.scopedModels?.length > 0
              ? latestCtx.scopedModels.map(sm => sm.model)
              : availableModels;

            currentModelMenu = modelsToShow;
            modelMenuSentAt = Date.now();

            const lines = [
              `🤖 **Available Models** (${modelsToShow.length} total)`,
              `Current: \`${currentStr}\`\n`,
            ];
            modelsToShow.forEach((m, i) => {
              const isCur = currentModel && m.provider === currentModel.provider && m.id === currentModel.id;
              lines.push(`${isCur ? "✅" : `${i + 1}.`} ${m.id}`);
            });
            lines.push(`\n👉 Reply with a number or name to switch.`);
            await mirror(lines.join("\n"), s).catch(() => {});
            return res.end('{"ok":true}');
          }
        }

        if (isSlashCommand && !isRegisteredCommand) {
          // TUI command (e.g. /theme, /settings) → send to tmux terminal directly
          if (!isTmuxInstalled()) {
            await mirror(TMUX_NOT_INSTALLED_MSG, s).catch(() => {});
            return res.end('{"ok":true}');
          }
          if (tmuxSessionExists("pi")) {
            const screenBefore = captureTmuxPane("pi", 35);

            sendTmuxText("pi", trimmedBody);
            sendTmuxKey("pi", "Enter");

            setTimeout(async () => {
              try {
                const menuItems = await checkTmuxForMenu(true);
                if (menuItems.length === 0) {
                  const screenAfter = captureTmuxPane("pi", 35);
                  const beforeLines = new Set(screenBefore.split('\n').map(l => l.trim()));
                  const afterLines = screenAfter.split('\n');
                  const newLines = afterLines.filter(line => {
                    const trimmed = line.trim();
                    return trimmed && !beforeLines.has(trimmed) &&
                           !trimmed.startsWith('$') && !trimmed.startsWith('#') &&
                           !trimmed.includes("Working");
                  });

                  if (newLines.length > 0) {
                    const output = newLines.join('\n').trim();
                    const preview = output.slice(-1500).trim();
                    await mirror(`📄 Output of \`${trimmedBody}\`:\n\n${preview}`, s).catch(() => {});
                  } else {
                    await mirror(`✓ Command \`${trimmedBody}\` sent to Pi.`, s).catch(() => {});
                  }
                }
              } catch (e) {
                console.error("Error capturing tmux output:", e.message);
              }
            }, 2000);
          }
        } else if (isSlashCommand) {
          // Registered extension command → send through Pi's command system
          const commandText = translateInboundSlashCommand(trimmedBody);
          await pi.sendUserMessage(commandText, {
            expandPromptTemplates: true,
            deliverAs: "followUp",
          });
        } else {
          // Normal message → send to AI agent
          const promptText = formatReplyPrompt(message.body, message.replyTo);
          await pi.sendUserMessage(`[Telegram ${message.senderId || message.chatId || "unknown"}]\n${promptText}`, { deliverAs: "followUp" });
        }

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
    currentMenuItems = [];
    server?.close();
    server = undefined;
  });

  pi.on("agent_start", (_event, ctx) => {
    if (ctx) latestCtx = ctx;
    startTyping();
  });

  pi.on("turn_start", (_event, ctx) => {
    if (ctx) latestCtx = ctx;
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
    // Don't stop menu monitor here - menu might still be on screen
    // The monitor will stop itself when it detects a menu or times out
  });

  pi.on("agent_settled", () => {
    stopTyping();
  });

  pi.on("message_end", (event, ctx) => {
    if (ctx) latestCtx = ctx;
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
            void sendFile(htmlFile, s, `📊 ${t.title || "Table"}`).catch((e) =>
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
