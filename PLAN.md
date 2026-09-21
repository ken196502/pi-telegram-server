# Plan: Fix Telegram Slash Command Menu Detection & Acquisition

## 1. Problem Analysis
When users send slash commands (e.g. `/model` or `/menu`) or interact with menus via Telegram:
1. `telegram-mirror.mjs` attempted to detect interactive menus in the Pi tmux session by capturing 100 lines of the pane and parsing them.
2. In `src/tmux-utils.mjs`, `parseMenuItems()` had a fallback `const startIdx = menuStart >= 0 ? menuStart : 0;`. When no menu was active (`menuStart === -1`), it fell back to scanning the entire 100 lines of scrollback history.
3. Pattern 0 was `/^\s*(\d+)[\.\)\:]\s+(.+)$/`, matching ANY numbered list in chat history, tool outputs, git logs, or assistant responses.
4. In this case, an assistant message in the scrollback containing 17 numbered items (describing flow-ext implementation) was misidentified as 17 menu items.
5. Because `items.length >= 2`, `checkTmuxForMenu()` deemed it a valid menu, blindly pressed `Down` 100 times into the tmux session (disrupting the active terminal), and sent the conversational list to Telegram as `Menu Options`.
6. Furthermore, `sendTmuxKey("pi", "Escape")` was being sent before navigating to "reset to top", which in Pi's TUI actually cancels/closes the selector dialog.
7. Unstaged changes broke `test/tmux-utils.test.mjs` by skipping any line starting with `[` (`trimmedLine.startsWith('[')`), which caused checkbox selection markers (`[x]`) to fail.

## 2. Solution Implementation
### A. Robust Menu Detection & Parsing (`src/tmux-utils.mjs`)
- **No Fallback to History**: If no active menu boundary or selection pointer (`→`, `►`, `▸`, `>`) is found, returns `[]`. Never falls back to scanning scrollback text.
- **Active Area Scoping**: Restricted tmux capture to the active visible viewport (last 35 lines) rather than 100 lines of historical scrollback.
- **Agent Busy Check**: If the pane displays an active working state (`── Working ──` or spinner), `parseMenuItems` and `detectMenu` immediately return empty / `isMenu: false`.
- **Prose vs Menu Filtering**: Text items longer than 75 characters or ending in Chinese/English sentence punctuation (`。`, `；`, `;`) are recognized as conversational prose and excluded from menu candidate parsing.
- **Checkbox Marker Fix**: Preserved `[x]` / `[ ]` checkbox marker detection without false skipping.
- **Relative Navigation**: In `selectMenuItem()`, navigate using relative `Up`/`Down` deltas based on current selected index instead of blindly sending `Escape` (which was cancelling the TUI selector dialog).
- **Cursor State Restoration**: In `collectMenuFromScreen()`, after pressing `Down` to collect items, restore the cursor position by pressing `Up`.

### B. Native Model & Slash Command Handling (`extensions/telegram-mirror.mjs`)
- **Native Model Selection (`/model`)**: Directly interfaces with `latestCtx.modelRegistry` and `pi.setModel()`:
  - `/model`: Displays available models (scoped or registered) with the current active model highlighted (`✅`).
  - `/model <query>`: Instantly searches and switches model, or presents matching options if ambiguous.
  - Number reply (e.g. `1`, `2`) directly switches model using `pi.setModel(chosenModel)` with zero terminal screen scraping or keystroke simulation.
- **Slash Commands Listing (`/commands`)**: Dynamically queries `pi.getCommands()` to display all available session and extension commands.
- **Updated Bot Help (`/help`)**: Lists all supported Telegram commands with clean formatting.

### C. Telegram Bot Command Synchronization (`src/gateway.mjs`)
- Registered `/model`, `/menu`, and `/commands` alongside `/new`, `/compact`, `/status`, `/abort`, `/help` in Telegram's `setMyCommands`.

## 3. Verification & Results
- **Unit Tests**: All 50 tests pass (`npm test`), including new test cases for:
  - Rejection of conversational numbered lists with prose/code descriptions.
  - Rejection of screens showing agent `Working` status.
- **Syntax Check**: All files pass Node syntax verification (`node --check`).
- **Gateway Health**: HTTP gateway restarted and connected cleanly with `status: connected` and inbound webhook enabled.
