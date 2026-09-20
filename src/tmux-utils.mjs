#!/usr/bin/env node
import { execSync } from "node:child_process";

/**
 * Check if a tmux session with the given name exists
 * @param {string} sessionName - Name of the tmux session to check
 * @returns {boolean} - True if session exists
 */
export function tmuxSessionExists(sessionName = "pi") {
  try {
    const result = execSync(`tmux has-session -t ${sessionName} 2>/dev/null`, { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Capture the current content of a tmux pane
 * @param {string} sessionName - Name of the tmux session
 * @param {number} historyLines - Number of history lines to capture (default: 100)
 * @returns {string} - Captured pane content
 */
export function captureTmuxPane(sessionName = "pi", historyLines = 100) {
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
 * Parse menu items from captured tmux content
 * @param {string} content - Raw tmux pane content
 * @returns {Array<{index: number, text: string, selected: boolean}>} - Parsed menu items
 */
export function parseMenuItems(content) {
  if (!content || typeof content !== "string") return [];
  
  const lines = content.split("\n");
  const menuItems = [];
  
  // Common menu patterns
  const patterns = [
    // Numbered list: "1. Option", "1) Option", "1: Option"
    /^\s*(\d+)[.):\s]+(.+)$/,
    // Arrow indicator: "► Option", "▸ Option", "→ Option", "> Option"
    /^\s*[►▸→>]\s*(.+)$/,
    // Selection markers: "[x] Option", "[ ] Option", "* Option"
    /^\s*\[([xX ])\]\s*(.+)$/,
    /^\s*\*\s*(.+)$/,
    // Highlighted/reverse video (common in TUI menus)
    // We'll detect these by looking for ANSI escape codes
    /^\s*\x1b\[7m(.+?)\x1b\[0m\s*$/,
    // Simple list items with common prefixes
    /^\s*[-•]\s*(.+)$/,
  ];
  
  let currentMenuStart = -1;
  let menuContext = "";
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Look for menu context indicators (only if line doesn't look like a menu item)
    if (/select|choose|pick|menu|options|choices|请输入|选择|选项/i.test(line) && 
        !/^\s*[\d►▸→>\[\-*•]/.test(line)) {
      menuContext = line.trim();
      currentMenuStart = i;
      continue;
    }
    
    // Try to match menu patterns
    for (let patternIndex = 0; patternIndex < patterns.length; patternIndex++) {
      const pattern = patterns[patternIndex];
      const match = line.match(pattern);
      if (match) {
        let text = "";
        let selected = false;
        
        if (patternIndex === 2) { // Selection markers
          selected = match[1].toLowerCase() === "x";
          text = match[2].trim();
        } else if (patternIndex === 0) { // Numbered list
          text = match[2].trim();
        } else {
          text = match[1].trim();
        }
        
        // Filter out common non-menu lines
        if (text.length > 0 && 
            !text.startsWith("$") && 
            !text.startsWith("#") &&
            !text.includes("──") &&
            !text.includes("───") &&
            !text.includes("===")) {
          menuItems.push({
            index: i,
            text: text,
            selected: selected,
            line: line.trim()
          });
        }
        break;
      }
    }
  }
  
  return menuItems;
}

/**
 * Detect if current screen shows a menu
 * @param {string} content - Raw tmux pane content
 * @returns {object} - { isMenu: boolean, menuType: string, confidence: number }
 */
export function detectMenu(content) {
  if (!content || typeof content !== "string") {
    return { isMenu: false, menuType: "none", confidence: 0 };
  }
  
  const lines = content.split("\n");
  let menuIndicators = 0;
  let menuType = "unknown";
  
  // Check for menu-like patterns
  const menuPatterns = [
    { pattern: /select|choose|pick|menu|options|choices|请输入|选择|选项/i, type: "prompt" },
    { pattern: /^\s*\d+[.):\s]+\s*.+$/m, type: "numbered" },
    { pattern: /^\s*[►▸→>]\s*.+$/m, type: "arrow" },
    { pattern: /^\s*\[([xX ])\]\s*.+$/m, type: "selection" },
    { pattern: /^\s*[-•]\s*.+$/m, type: "list" },
  ];
  
  for (const { pattern, type } of menuPatterns) {
    // Use test() for single match detection, match() for counting
    if (pattern.test(content)) {
      const matches = content.match(new RegExp(pattern, "gm"));
      const matchCount = matches ? matches.length : 1;
      menuIndicators += matchCount;
      if (menuType === "unknown") menuType = type;
      // Bonus for prompt indicators
      if (type === "prompt") menuIndicators += 2;
    }
  }
  
  // Check for common TUI menu indicators
  if (content.includes("↑") && content.includes("↓")) menuIndicators += 2;
  if (content.includes("j/k") || content.includes("J/K")) menuIndicators += 2;
  if (/^\s*>.*<\s*$/m.test(content)) menuIndicators += 3; // Highlighted item
  
  // Calculate confidence (0-100)
  const confidence = Math.min(100, menuIndicators * 10);
  
  return {
    isMenu: confidence >= 30,
    menuType: menuType,
    confidence: confidence,
    itemCount: parseMenuItems(content).length
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
  const allItems = new Map(); // Use Map for deduplication
  
  // Initial capture
  const initialContent = captureTmuxPane(sessionName);
  const initialItems = parseMenuItems(initialContent);
  for (const item of initialItems) {
    allItems.set(item.text, item);
  }
  
  // If we already have a good menu, return it
  const menuDetection = detectMenu(initialContent);
  if (menuDetection.isMenu && menuDetection.confidence >= 60 && allItems.size >= 2) {
    return Array.from(allItems.values());
  }
  
  // Try navigating to find more items
  let previousSize = allItems.size;
  let noNewItemsCount = 0;
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Send down arrow
    sendTmuxKey(sessionName, "Down");
    
    // Wait a bit for the screen to update
    if (delayMs > 0) {
      execSync(`sleep ${delayMs / 1000}`);
    }
    
    // Capture and parse
    const content = captureTmuxPane(sessionName);
    const items = parseMenuItems(content);
    
    for (const item of items) {
      allItems.set(item.text, item);
    }
    
    // Check if we found new items
    if (allItems.size === previousSize) {
      noNewItemsCount++;
      if (noNewItemsCount >= 3) {
        // If no new items for 3 attempts, try pressing Enter to see if there's a submenu
        sendTmuxKey(sessionName, "Enter");
        execSync(`sleep ${delayMs / 1000}`);
        
        const submenuContent = captureTmuxPane(sessionName);
        const submenuItems = parseMenuItems(submenuContent);
        
        if (submenuItems.length > 0) {
          // We found a submenu, add items with prefix
          for (const item of submenuItems) {
            allItems.set(`[Sub] ${item.text}`, { ...item, text: `[Sub] ${item.text}` });
          }
        }
        
        // Press Escape to go back
        sendTmuxKey(sessionName, "Escape");
        execSync(`sleep ${delayMs / 1000}`);
        
        break;
      }
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
  
  const lines = [`${title}\n`];
  
  items.forEach((item, index) => {
    const selectedMark = item.selected ? "✅" : `${index + 1}.`;
    lines.push(`${selectedMark} ${item.text}`);
  });
  
  lines.push(`\n💡 Reply with the number or text to select an option.`);
  
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
  
  // Try to parse as number
  const num = parseInt(selection, 10);
  if (!isNaN(num) && num >= 1 && num <= items.length) {
    return num - 1; // Convert to 0-based index
  }
  
  // Try to find by text (case-insensitive, partial match)
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
  
  // First, press Escape to ensure we're at the top level
  sendTmuxKey(sessionName, "Escape");
  execSync(`sleep ${delayMs / 1000}`);
  
  // Navigate to the item
  for (let i = 0; i < itemIndex; i++) {
    sendTmuxKey(sessionName, "Down");
    execSync(`sleep ${delayMs / 1000}`);
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
  // Capture current menu
  const content = captureTmuxPane(sessionName);
  const items = parseMenuItems(content);
  
  if (items.length === 0) {
    return {
      success: false,
      error: "No menu detected in current view"
    };
  }
  
  // Find selected item
  const selectedIndex = findMenuItemIndex(items, selection);
  if (selectedIndex === -1) {
    return {
      success: false,
      error: `Selection "${selection}" not found in menu`,
      availableOptions: items.map((item, i) => `${i + 1}. ${item.text}`)
    };
  }
  
  // Select the item
  selectMenuItem(sessionName, items, selectedIndex);
  
  // Wait for selection to process
  execSync(`sleep 0.2`);
  
  // Capture result
  const resultContent = captureTmuxPane(sessionName);
  
  return {
    success: true,
    selectedItem: items[selectedIndex],
    selectedIndex: selectedIndex,
    resultPreview: resultContent.slice(0, 200) + (resultContent.length > 200 ? "..." : "")
  };
}

export default {
  tmuxSessionExists,
  captureTmuxPane,
  sendTmuxKey,
  sendTmuxText,
  parseMenuItems,
  detectMenu,
  captureMenuByNavigation,
  formatMenuForTelegram,
  findMenuItemIndex,
  selectMenuItem,
  handleMenuSelection
};