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
