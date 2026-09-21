#!/usr/bin/env node
import { execSync } from "node:child_process";

/**
 * Check if tmux is installed and available on PATH
 * @returns {boolean}
 */
export function isTmuxInstalled() {
  try {
    execSync("command -v tmux", { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a tmux session with the given name exists
 * @param {string} sessionName - Name of the tmux session to check
 * @returns {boolean} - True if session exists
 */
export function tmuxSessionExists(sessionName = "pi") {
  if (!isTmuxInstalled()) return false;
  try {
    execSync(`tmux has-session -t ${sessionName} 2>/dev/null`, { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Capture the current content of a tmux pane
 * @param {string} sessionName - Name of the tmux session
 * @param {number} historyLines - Number of history lines to capture (default: 35)
 * @returns {string} - Captured pane content
 */
export function captureTmuxPane(sessionName = "pi", historyLines = 35) {
  try {
    return execSync(`tmux capture-pane -t ${sessionName} -p -S -${historyLines}`, { encoding: "utf8" });
  } catch (error) {
    throw new Error(`Failed to capture tmux pane: ${error.message}`);
  }
}

/**
 * Send a keystroke to a tmux session
 * @param {string} sessionName - Name of the tmux session
 * @param {string} key - Key to send (e.g., "Down", "Up", "Enter", "Escape", "Tab")
 * @param {object} options - Additional options
 * @param {boolean} options.literal - Send as literal text
 */
export function sendTmuxKey(sessionName = "pi", key, options = {}) {
  try {
    const literalFlag = options.literal ? "-l" : "";
    execSync(`tmux send-keys -t ${sessionName} ${literalFlag} ${key}`, { encoding: "utf8" });
  } catch (error) {
    throw new Error(`Failed to send key to tmux: ${error.message}`);
  }
}

/**
 * Send text to a tmux session
 * @param {string} sessionName - Name of the tmux session
 * @param {string} text - Text to send
 */
export function sendTmuxText(sessionName = "pi", text) {
  try {
    execSync(`tmux send-keys -t ${sessionName} -l "${text.replace(/"/g, '\\"')}"`, { encoding: "utf8" });
  } catch (error) {
    throw new Error(`Failed to send text to tmux: ${error.message}`);
  }
}

/**
 * Helper to check if a line is a candidate for a menu item
 */
function isCandidateMenuItem(text) {
  if (!text || typeof text !== "string") return false;
  const trimmed = text.trim();
  if (trimmed.length < 1) return false;
  if (trimmed === "--" || trimmed === "---" || trimmed === "...") return false;
  if (trimmed.startsWith("$ ") || trimmed.startsWith("# ")) return false;
  if (/^[─═━\-_]{3,}$/.test(trimmed)) return false;
  if (/^(?:Enter to select|Escape.*cancel|Ctrl.*cancel|Only showing|Model catalogs|Model Name)/i.test(trimmed)) return false;
  if (/[。；;]$/.test(trimmed)) return false; // Sentences ending with full stops or semicolons
  if (trimmed.length > 75) return false; // Overly long descriptions are prose, not menu labels
  return true;
}

/**
 * Parse menu items from captured tmux content
 * @param {string} content - Raw tmux pane content
 * @returns {Array<{index: number, text: string, selected: boolean, line: string}>} - Parsed menu items
 */
export function parseMenuItems(content) {
  if (!content || typeof content !== "string") return [];

  // If the agent is actively working (spinner/Working status), there is no interactive menu
  if (/──\s+[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏*]?\s*Working/i.test(content)) {
    return [];
  }

  const lines = content.split("\n");
  const menuItems = [];

  // Find menu boundaries - look for headers, borders, or arrow pointers
  let menuStart = -1;
  let menuEnd = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Menu start headers
    if (/Only showing models|Select a model|Model Configuration|Thinking Level|Select provider|Choose an option|Select an option|Menu Options/i.test(line)) {
      menuStart = i + 1;
      continue;
    }
    // Dynamic border as top delimiter
    if (menuStart === -1 && /^[─═]{4,}/.test(line.trim())) {
      menuStart = i + 1;
      continue;
    }
    // Arrow pointer or selection checkbox
    if (menuStart === -1 && /^\s*(?:[→▸►>]|\[[xX ]\])\s+/.test(line)) {
      menuStart = i;
      continue;
    }
    // Numbered list start (only if preceded by header / context)
    if (menuStart === -1 && /^\s*1[\.\)\:]\s+/.test(line) && i > 0 && lines[i - 1].trim().length > 0) {
      menuStart = i;
      continue;
    }
    // Menu end: instructions, footer hints, or bottom border
    if (menuStart >= 0 && i > menuStart && /Enter to select|Escape.*cancel|Ctrl.*cancel|to select|to cancel|toggle.*provider/i.test(line)) {
      menuEnd = i;
      break;
    }
    if (menuStart >= 0 && i > menuStart && /^[─═]{4,}/.test(line.trim())) {
      menuEnd = i;
      break;
    }
  }

  // If no menu boundary or pointer was detected, this content is not an interactive menu
  if (menuStart === -1) {
    // Check if there are pure list items with indicators
    const hasArrowOrCheckbox = lines.some((l) => /^\s*(?:[→▸►>]|\[[xX ]\])\s+/.test(l));
    const hasDashes = lines.filter((l) => /^\s*[-•]\s+\S+/.test(l)).length >= 2;
    if (!hasArrowOrCheckbox && !hasDashes) {
      return [];
    }
    menuStart = 0;
    menuEnd = lines.length;
  } else if (menuEnd === -1) {
    menuEnd = lines.length;
  }

  const patterns = [
    // Arrow indicator: "► Option", "▸ Option", "→ Option", "> Option"
    /^\s*([►▸→>])\s*(?:([✓✗])\s*)?(.+)$/,
    // Selection markers: "[x] Option", "[ ] Option", "* Option"
    /^\s*\[([xX ])\]\s*(.+)$/,
    /^\s*\*\s*(.+)$/,
    // Highlighted/reverse video (common in ANSI TUI menus)
    /^\s*\x1b\[7m(.+?)\x1b\[0m\s*$/,
    // Numbered list: "1. Option", "1) Option", "1: Option"
    /^\s*(\d+)[\.\)\:]\s+(.+)$/,
    // Simple list items with dash/bullet prefix
    /^\s*[-•]\s*(.+)$/,
  ];

  for (let i = menuStart; i < menuEnd; i++) {
    const line = lines[i];
    const trimmedLine = line.trim();

    // Skip pagination info like "(1/85)"
    if (/^\s*\(\d+\/\d+\)\s*$/.test(line)) continue;
    if (!trimmedLine) continue;

    // Skip lines that look like shell commands or logs
    if (trimmedLine.startsWith("$ ") || trimmedLine.startsWith("# ") || trimmedLine.startsWith("✓ ")) continue;
    if (trimmedLine.startsWith("Follow-up:") || trimmedLine.includes("Working")) continue;

    let matched = false;
    for (let pIdx = 0; pIdx < patterns.length; pIdx++) {
      const match = line.match(patterns[pIdx]);
      if (match) {
        let text = "";
        let selected = false;

        if (pIdx === 0) {
          // Arrow indicator
          selected = true;
          text = match[3].trim();
        } else if (pIdx === 1) {
          // Selection checkbox [x] / [ ]
          selected = match[1].toLowerCase() === "x";
          text = match[2].trim();
        } else if (pIdx === 2) {
          // Asterisk
          selected = true;
          text = match[1].trim();
        } else if (pIdx === 3) {
          // Reverse ANSI
          selected = true;
          text = match[1].trim();
        } else if (pIdx === 4) {
          // Numbered list
          text = match[2].trim();
          selected = line.includes("✓") || line.includes("→");
        } else {
          // Dash / bullet
          text = match[1].trim();
          selected = line.includes("✓") || line.includes("→");
        }

        if (isCandidateMenuItem(text)) {
          menuItems.push({
            index: i,
            text,
            selected,
            line: trimmedLine,
          });
          matched = true;
        }
        break;
      }
    }

    // Pi-specific selector format: indented text with provider suffix (e.g. "  mimo-v2.5-pro [commandcode]")
    if (!matched && /^\s{2,}([^\s].+?\s*\[\w+\])\s*$/.test(line)) {
      const text = trimmedLine;
      if (isCandidateMenuItem(text)) {
        menuItems.push({
          index: i,
          text,
          selected: line.includes("✓") || line.includes("→"),
          line: trimmedLine,
        });
      }
    }
  }

  // Deduplicate items by text preserving order
  const seenTexts = new Set();
  return menuItems.filter((item) => {
    if (seenTexts.has(item.text)) return false;
    seenTexts.add(item.text);
    return true;
  });
}

/**
 * Detect if current screen shows a menu
 * @param {string} content - Raw tmux pane content
 * @returns {object} - { isMenu: boolean, menuType: string, confidence: number, itemCount: number }
 */
export function detectMenu(content) {
  if (!content || typeof content !== "string") {
    return { isMenu: false, menuType: "none", confidence: 0, itemCount: 0 };
  }

  // Active agent turn is not an interactive menu
  if (/──\s+[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏*]?\s*Working/i.test(content)) {
    return { isMenu: false, menuType: "none", confidence: 0, itemCount: 0 };
  }

  const items = parseMenuItems(content);
  if (items.length === 0) {
    return { isMenu: false, menuType: "none", confidence: 0, itemCount: 0 };
  }

  let menuIndicators = 0;
  let menuType = "unknown";

  if (/select|choose|pick|options|Model Configuration|Thinking Level|Theme/i.test(content)) {
    menuIndicators += 3;
    menuType = "prompt";
  }

  if (content.includes("→") || content.includes("►") || content.includes("▸")) {
    menuIndicators += 4;
    menuType = "arrow";
  }

  if (/\[[xX ]\]/.test(content)) {
    menuIndicators += 3;
    menuType = "selection";
  }

  if (/\(\d+\/\d+\)/.test(content)) {
    menuIndicators += 3;
  }

  if (/Enter to select|Esc.*cancel|↑↓ navigate/i.test(content)) {
    menuIndicators += 3;
  }

  if (items.length >= 2) {
    menuIndicators += Math.min(items.length, 5);
  }

  const confidence = Math.min(100, menuIndicators * 10);
  return {
    isMenu: confidence >= 30,
    menuType,
    confidence,
    itemCount: items.length,
  };
}

/**
 * Capture menu by simulating keyboard navigation
 * @param {string} sessionName - Name of the tmux session
 * @param {object} options - Configuration options
 * @param {number} options.maxAttempts - Maximum navigation attempts (default: 20)
 * @param {number} options.delayMs - Delay between keystrokes in ms (default: 100)
 * @returns {Array<{index: number, text: string, selected: boolean}>} - Collected menu items
 */
export function captureMenuByNavigation(sessionName = "pi", options = {}) {
  const { maxAttempts = 20, delayMs = 100 } = options;
  const allItems = new Map();

  const initialContent = captureTmuxPane(sessionName, 35);
  const initialItems = parseMenuItems(initialContent);
  for (const item of initialItems) {
    allItems.set(item.text, item);
  }

  const menuDetection = detectMenu(initialContent);
  if (menuDetection.isMenu && menuDetection.confidence >= 60 && allItems.size >= 2) {
    return Array.from(allItems.values());
  }

  let previousSize = allItems.size;
  let noNewItemsCount = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    sendTmuxKey(sessionName, "Down");
    if (delayMs > 0) execSync(`sleep ${delayMs / 1000}`);

    const content = captureTmuxPane(sessionName, 35);
    const items = parseMenuItems(content);
    for (const item of items) {
      allItems.set(item.text, item);
    }

    if (allItems.size === previousSize) {
      noNewItemsCount++;
      if (noNewItemsCount >= 3) break;
    } else {
      noNewItemsCount = 0;
      previousSize = allItems.size;
    }
  }

  return Array.from(allItems.values());
}

/**
 * Format menu items for Telegram display
 * @param {Array<{index: number, text: string, selected: boolean}>} items - Menu items
 * @param {string} title - Optional menu title
 * @returns {string} - Formatted text for Telegram
 */
export function formatMenuForTelegram(items, title = "📋 Menu Options") {
  if (!items || items.length === 0) {
    return "❌ No menu items detected.";
  }

  const lines = [`${title}`];
  lines.push(`Total: ${items.length} items\n`);

  items.forEach((item, index) => {
    const selectedMark = item.selected ? "✅" : `${index + 1}.`;
    lines.push(`${selectedMark} ${item.text}`);
  });

  lines.push(`\n👉 Reply with the number or text to select an option.`);

  return lines.join("\n");
}

/**
 * Find the index of a menu item by number or text
 * @param {Array<{index: number, text: string, selected: boolean}>} items - Menu items
 * @param {string} selection - User selection (number or text)
 * @returns {number} - Index of selected item, or -1 if not found
 */
export function findMenuItemIndex(items, selection) {
  if (!items || !selection) return -1;

  const num = parseInt(selection, 10);
  if (!isNaN(num) && num >= 1 && num <= items.length) {
    return num - 1;
  }

  const lowerSelection = selection.toLowerCase();
  for (let i = 0; i < items.length; i++) {
    if (items[i].text.toLowerCase().includes(lowerSelection)) {
      return i;
    }
  }

  return -1;
}

/**
 * Send menu selection to tmux session
 * @param {string} sessionName - Name of the tmux session
 * @param {Array<{index: number, text: string, selected: boolean}>} items - Menu items
 * @param {number} itemIndex - Index of item to select (0-based)
 * @param {object} options - Navigation options
 */
export function selectMenuItem(sessionName, items, itemIndex, options = {}) {
  if (itemIndex < 0 || itemIndex >= items.length) {
    throw new Error("Invalid menu item index");
  }

  const { delayMs = 50 } = options;
  const currentSelectedIndex = items.findIndex((item) => item.selected);

  if (currentSelectedIndex >= 0) {
    if (itemIndex > currentSelectedIndex) {
      for (let i = 0; i < itemIndex - currentSelectedIndex; i++) {
        sendTmuxKey(sessionName, "Down");
        execSync(`sleep ${delayMs / 1000}`);
      }
    } else if (itemIndex < currentSelectedIndex) {
      for (let i = 0; i < currentSelectedIndex - itemIndex; i++) {
        sendTmuxKey(sessionName, "Up");
        execSync(`sleep ${delayMs / 1000}`);
      }
    }
  } else {
    // If current selected item unknown, send Up keys to reach top without using Escape
    for (let i = 0; i < items.length; i++) {
      sendTmuxKey(sessionName, "Up");
      execSync(`sleep ${delayMs / 1000}`);
    }
    for (let i = 0; i < itemIndex; i++) {
      sendTmuxKey(sessionName, "Down");
      execSync(`sleep ${delayMs / 1000}`);
    }
  }

  // Select the item
  sendTmuxKey(sessionName, "Enter");
}

/**
 * Complete menu interaction workflow
 * @param {string} sessionName - Name of the tmux session
 * @param {string} selection - User's selection (number or text)
 * @returns {object} - Result of the interaction
 */
export async function handleMenuSelection(sessionName, selection) {
  const content = captureTmuxPane(sessionName, 35);
  const items = parseMenuItems(content);

  if (items.length === 0) {
    return {
      success: false,
      error: "No menu detected in current view",
    };
  }

  const selectedIndex = findMenuItemIndex(items, selection);
  if (selectedIndex === -1) {
    return {
      success: false,
      error: `Selection "${selection}" not found in menu`,
      availableOptions: items.map((item, i) => `${i + 1}. ${item.text}`),
    };
  }

  selectMenuItem(sessionName, items, selectedIndex);
  execSync(`sleep 0.2`);

  const resultContent = captureTmuxPane(sessionName, 35);
  return {
    success: true,
    selectedItem: items[selectedIndex],
    selectedIndex,
    resultPreview: resultContent.slice(0, 200) + (resultContent.length > 200 ? "..." : ""),
  };
}

/**
 * Collect all menu items from a tmux screen by pressing Down repeatedly.
 * @param {string} sessionName - tmux session name
 * @param {object} options
 * @param {number} options.maxPresses - max Down presses (default 100)
 * @param {number} options.delayMs - delay between presses (default 80)
 * @returns {Array<{index: number, text: string, selected: boolean}>} collected menu items
 */
export function collectMenuFromScreen(sessionName = "pi", options = {}) {
  const { maxPresses = 100, delayMs = 80 } = options;
  const allItems = new Map();

  // Capture active screen area (last 35 lines)
  let content = captureTmuxPane(sessionName, 35);
  const detection = detectMenu(content);
  if (!detection.isMenu) {
    return [];
  }

  let items = parseMenuItems(content);
  if (items.length === 0) return [];

  for (const item of items) allItems.set(item.text, item);

  let staleCount = 0;
  const staleThreshold = 10;
  let pressesCount = 0;

  for (let press = 0; press < maxPresses; press++) {
    sendTmuxKey(sessionName, "Down");
    pressesCount++;
    execSync(`sleep ${delayMs / 1000}`);

    content = captureTmuxPane(sessionName, 35);
    items = parseMenuItems(content);

    const sizeBefore = allItems.size;
    for (const item of items) allItems.set(item.text, item);

    if (allItems.size === sizeBefore) {
      staleCount++;
      if (staleCount >= staleThreshold) break;
    } else {
      staleCount = 0;
    }

    const paginationMatch = content.match(/\((\d+)\/(\d+)\)/);
    if (paginationMatch) {
      const [, current, total] = paginationMatch;
      if (allItems.size >= parseInt(total, 10) || parseInt(current, 10) >= parseInt(total, 10)) {
        break;
      }
    }
  }

  // Restore cursor position by pressing Up
  for (let i = 0; i < pressesCount; i++) {
    sendTmuxKey(sessionName, "Up");
    execSync(`sleep 0.02`);
  }

  return Array.from(allItems.values());
}

export default {
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
  handleMenuSelection,
};
