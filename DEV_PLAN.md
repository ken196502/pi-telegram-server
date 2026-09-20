# Development Plan: Resolve Built-in Command Conflicts in Telegram Extension

## Objectives
1. **Eliminate Extension Command Conflict Warnings**:
   Resolve the startup warnings:
   `Extension command '/new' conflicts with built-in interactive command. Skipping in autocomplete.`
   `Extension command '/compact' conflicts with built-in interactive command. Skipping in autocomplete.`
2. **Preserve Full Slash Command Functionality from Telegram**:
   Ensure users can continue to send `/new` and `/compact` from Telegram, with identical behavior (starting a fresh session and compacting session context respectively), while having clean autocomplete and zero diagnostic warnings in interactive Pi.

## Problem Statement
1. Pi defines built-in interactive commands (`BUILTIN_SLASH_COMMANDS`) including `new` and `compact`.
2. When `extensions/telegram-mirror.mjs` registered `pi.registerCommand("new", ...)` and `pi.registerCommand("compact", ...)`, Pi detected these names conflict with built-in interactive commands and emitted warnings in `loadedResourcesContainer`.
3. In interactive mode, Pi's submit handler intercepts `/new` and `/compact` natively anyway, so the extension's `new` and `compact` handlers were only needed for inbound Telegram messages.

## Solution Architecture
1. **Extension Commands**:
   - Remove registration of conflicting commands `new` and `compact` from `telegram-mirror.mjs`.
   - Retain `/clear` (starts fresh session via `ctx.newSession()`), which has no conflict with Pi built-in commands.
   - Register `/compact_session` (compacts context via `ctx.compact()`), avoiding collision with Pi's built-in `/compact`.
   - Retain `/abort` and `/stop` (cancels operation via `ctx.abort()`).
   - Retain `/status` (mirrors session, model, token usage).
   - Register `/help` (displays bot command list).
2. **Inbound Telegram Command Translation**:
   - In inbound webhook listener, when a slash command is detected:
     - Map `/new` (or `/new ...`) to `/clear`.
     - Map `/compact` (or `/compact ...`) to `/compact_session` (preserving any arguments).
     - Forward command to `pi.sendUserMessage` with `expandPromptTemplates: true`.
3. **Inbound HTTP Server Resilience**:
   - Attach `error` event listener to `server` to avoid unhandled crash if port 3094 is temporarily occupied.
4. **Verification**:
   - Run `npm run check` and `npm test`.
   - Verify extension loads cleanly with zero conflict warnings.

## Implementation & Verification Summary
1. **Removed Conflicting Built-in Commands**:
   - Removed `pi.registerCommand("new")` and `pi.registerCommand("compact")` from `extensions/telegram-mirror.mjs`.
   - Registered `/compact_session` for session context compaction.
   - Retained `/clear` for fresh session creation.
   - Added `/help` command displaying available bot commands.
2. **Inbound Slash Command Translation**:
   - Implemented and exported `translateInboundSlashCommand` in `src/lib.mjs`.
   - Mapped inbound `/new` -> `/clear` and `/compact` -> `/compact_session` seamlessly.
   - Wired `translateInboundSlashCommand` into `extensions/telegram-mirror.mjs`.
3. **Inbound Server Safeguard**:
   - Added `error` listener on HTTP inbound listener server to prevent unhandled node error events if the port is busy.
4. **Testing & Conflict Check**:
   - Added 4 unit tests in `test/lib.test.mjs` covering `/new`, `/compact`, non-conflicting slash commands, and non-command text.
   - All 33 unit tests pass (100%).
   - `npm run check` passes with 0 syntax errors.
   - Verified programmatic check against `BUILTIN_SLASH_COMMANDS`: 0 conflicts detected.

---

# Development Plan: Slash Command Forwarding and Execution via Telegram

## Objectives
1. **Slash Command Execution Support from Telegram**:
   When users send slash commands (e.g. `/new`, `/clear`, `/compact`, `/abort`, `/help`, `/status`) from Telegram, execute them natively as commands in Pi rather than prefixing them with `[Telegram id]` and sending them as regular prompt text to the LLM.
2. **Built-in Session Management Commands**:
   Register `/new`, `/clear`, `/compact`, `/abort`, `/status`, and `/help` as extension commands in `telegram-mirror.mjs`, enabling remote session creation (`ctx.newSession()`), compaction (`ctx.compact()`), and execution aborts from Telegram.

## Problem Statement
1. In `extensions/telegram-mirror.mjs`, all inbound messages were unconditionally wrapped with:
   `[Telegram ${message.senderId || message.chatId || "unknown"}]\n${promptText}`.
2. Because the message started with `[Telegram ...]` rather than `/`, Pi's command parser never identified it as a command.
3. Furthermore, `expandPromptTemplates: true` was not passed in `pi.sendUserMessage`, which prevented extension commands and skill commands from executing.
4. Additionally, interactive TUI commands like `/new` are handled in `interactive-mode.js` on editor submit and were not registered in Pi's `_extensionRunner`, so they could not be triggered programmatically without explicit command registration.

## Solution Architecture
1. **Command Registration in `extensions/telegram-mirror.mjs`**:
   - Register `new` and `clear`: awaits idle, calls `ctx.newSession()`, and notifies user via Telegram `✓ New session started.`.
   - Register `compact`: awaits idle, calls `ctx.compact()`, and notifies user via Telegram `✓ Compaction started.`.
   - Register `abort` / `stop`: calls `ctx.abort()` and notifies user `⏹ Operation aborted.`.
   - Register `status`: reports session name, active model, and token usage to Telegram.
   - Register `help`: lists available bot commands.
2. **Inbound Message Routing**:
   - Check if `trimmedBody.startsWith("/")`.
   - If true: send directly to `pi.sendUserMessage(trimmedBody, { expandPromptTemplates: true, deliverAs: "followUp" })` without prepending `[Telegram ...]`.
   - If false: format with `formatReplyPrompt` and prepend `[Telegram ...]`.
3. **Verification**:
   - Syntax check (`npm run check`) and unit tests (`npm test`).

## Implementation & Verification Summary
1. **Slash Command Detection & Dispatch**:
   - In `extensions/telegram-mirror.mjs`: Added check `trimmedBody.startsWith("/")`.
   - When a slash command is sent from Telegram, dispatches directly via `pi.sendUserMessage(trimmedBody, { expandPromptTemplates: true, deliverAs: "followUp" })` without prepending `[Telegram ...]`.
   - Normal chat messages continue to be formatted with `[Telegram ${senderId}]\n${promptText}` and Markdown reply blockquotes.
2. **Registered Commands in Extension**:
   - Registered `/new` and `/clear`: calls `ctx.newSession()` and mirrors `✓ New session started.` to Telegram.
   - Registered `/compact`: calls `ctx.compact()` and mirrors `✓ Context compaction initiated.` to Telegram.
   - Registered `/abort` and `/stop`: calls `ctx.abort()` and mirrors `⏹ Operation aborted.` to Telegram.
   - Registered `/status`: mirrors current model, session, and context tokens to Telegram.
3. **Prevented EADDRINUSE on Session Switches**:
   - In `session_start`: ensures previous HTTP listener is closed before re-binding to port 3094.
4. **All 29 tests pass (100%) and `npm run check` passes with 0 errors**.

---

# Development Plan: Reply & Quoted Message Forwarding to Pi

## Objectives
1. **Synchronize Replied/Quoted Telegram Content to Pi**:
   When a user replies to an earlier message or uses Telegram's quote feature in chat, the referenced message content and sender must be synchronously forwarded to Pi as context.
2. **Standardized Blockquote Formatting**:
   Format the quoted content cleanly using standard Markdown blockquotes (`> ...`) with author attribution (`[Replying to <sender>]:`), allowing Pi to understand context without ambiguity.

## Problem Statement
1. In `src/gateway.mjs`, `processUpdate(update)` only extracted `const text = String(message?.text || message?.caption || "").trim();`.
2. The `message.reply_to_message` and `message.quote` objects provided by Telegram Bot API were completely ignored.
3. Consequently, the inbound webhook payload forwarded to Pi only contained the user's new message text, completely stripping out the quoted message context.

## Solution Architecture
1. **Helper Functions in `src/lib.mjs`**:
   - `extractReplyInfo(message)`: Extracts sender name (`@username`, `first_name`, or `Assistant`), message text (from `message.quote.text`, `reply_to_message.text`, `reply_to_message.caption`, or media placeholders like `[Photo]`, `[Document: filename]`), message ID, and quote flag.
   - `formatReplyPrompt(bodyText, replyInfo)`: Formats the user message with a blockquote header (`[Replying to <sender>]:\n> <quote>\n\n<bodyText>`), with reasonable length truncation if quote exceeds 1000 characters.
2. **Inbound Forwarding in `src/gateway.mjs`**:
   - In `processUpdate(update)`: Call `extractReplyInfo(message)` and pass `replyTo` in the inbound webhook payload sent to Pi.
3. **Prompt Injection in `extensions/telegram-mirror.mjs`**:
   - When receiving inbound messages, format the user message using `formatReplyPrompt(message.body, message.replyTo)` before dispatching `pi.sendUserMessage(...)`.
4. **Testing & Service Reload**:
   - Add unit tests in `test/lib.test.mjs` verifying reply extraction, author attribution, blockquote formatting, and truncation.
   - Run `npm test` (100% pass rate).
   - Reload gateway background service and verify `/health`.

## Implementation & Verification Summary
1. **Implemented `extractReplyInfo` & `formatReplyPrompt` in `src/lib.mjs`**:
   - Extracts sender name (`@username`, full name, or `Assistant`/`User`).
   - Retrieves quoted text prioritizing Telegram's selective `message.quote.text`, followed by `reply_to_message.text`, `reply_to_message.caption`, or media placeholders (`[Photo]`, `[Document: filename]`, `[Video]`, etc.).
   - Prefixes quoted lines with Markdown blockquote syntax (`> ...`).
   - Gracefully truncates quotes exceeding 1000 characters.
2. **Updated `processUpdate` in `src/gateway.mjs`**:
   - Parses `replyTo = extractReplyInfo(message)`.
   - Forwards `replyTo` in the inbound webhook payload to Pi.
3. **Updated `extensions/telegram-mirror.mjs`**:
   - Formats user prompts with `formatReplyPrompt(message.body, message.replyTo)` before injecting via `pi.sendUserMessage(...)`.
4. **Testing & Service Status**:
   - 29 unit tests pass (100% pass rate).
   - Code syntax check (`npm run check`) 0 errors.
   - Gateway process restarted (`http://127.0.0.1:3093/health` reports status `connected`).

---

# Development Plan: Continuous Typing Indicator & Markdown Table Rendering

## Objectives
1. **Markdown Table Rendering**: Convert markdown tables to mobile-friendly cards in chat and export full HTML documents with frozen headers & frozen first columns.
2. **Continuous Typing Indicator**: Ensure Telegram shows `typing...` continuously without interruption as long as the provider/agent is generating output or executing tools.

## Implementation Details

### 1. Frozen Headers & Frozen First Column in HTML Export (`src/lib.mjs`)
- Added `renderHtmlTableDocument(markdownTable, options)`:
  * Uses `border-collapse: separate; border-spacing: 0;` ensuring `position: sticky` works on WebKit mobile browsers.
  * Sticky Header: `th { position: sticky; top: 0; z-index: 2; background: #182234; }`
  * Sticky First Column: `th:first-child, td:first-child { position: sticky; left: 0; box-shadow: 2px 0 6px rgba(0,0,0,0.35); }`
  * Smooth touch scrolling: `-webkit-overflow-scrolling: touch;`.
- Added `extractMarkdownTables(text)` and `exportMarkdownTablesToHtmlFile(text, options)`.

### 2. Automatic Table Attachment in Telegram Mirror (`extensions/telegram-mirror.mjs`)
- In `pi.on("message_end")`:
  * Automatically scans for tables in the assistant's reply.
  * If found, exports the styled HTML document and delivers it via `sendFile()` with frozen headers and frozen first column.

### 3. Continuous Typing Indicator (`gateway.mjs` & `telegram-mirror.mjs`)
- Telegram's `sendChatAction(chatId, "typing")` expires every 5 seconds.
- In `telegram-mirror.mjs`:
  * Removed premature `stopTyping()` on `turn_end` (which previously killed typing during multi-turn agent tool executions).
  * Added `message_update` listener: keeps typing keepalive continuously refreshed as long as the provider is streaming output chunks.
  * Added `tool_execution_start`, `tool_execution_update`, `tool_call` listeners.
  * Stops typing strictly when the message is fully completed (`message_end` / `agent_end` / `agent_settled`).
- In `gateway.mjs`:
  * Removed static 120s hard timeout; keepalive interval ticks continuously and dynamically resets the watchdog timer on each typing signal.
  * Added `stop_typing` action handler to immediately clear typing when finished.

## Verification & Test Results
- Full test suite: 21 tests passed (100% pass rate).
- Background service reloaded and verified healthy (`http://127.0.0.1:3093/health`).
