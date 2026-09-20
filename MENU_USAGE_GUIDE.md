# Menu Capture Feature - Usage Guide

## Overview
The menu capture feature allows Telegram users to interact with Pi's interactive menus remotely. When Pi displays a menu (model selection, tool picker, file browser, etc.), users can capture and interact with it through Telegram.

## Commands

### `/menu`
Captures the current menu displayed in Pi's tmux session.

**Usage:**
```
/menu
```

**Response:**
```
🔍 Detecting menu...
📋 Menu Options
1. Option 1
2. Option 2
3. Option 3

💡 Reply with the number or text to select an option.
```

### `/menu <number>`
Selects a menu option by number.

**Usage:**
```
/menu 2
```

**Response:**
```
✓ Selected: Option 2
Waiting for Pi to process...
```

### `/menu <text>`
Selects a menu option by text (partial match).

**Usage:**
```
/menu model
```

**Response:**
```
✓ Selected: Model Selection
Waiting for Pi to process...
```

### `/menu capture`
Forces menu capture with keyboard navigation. Use this when the menu isn't immediately visible.

**Usage:**
```
/menu capture
```

**Response:**
```
🔄 Capturing menu with navigation...
📋 Menu Options
[Menu items displayed]
```

### `/menu clear`
Clears the stored menu state.

**Usage:**
```
/menu clear
```

**Response:**
```
✓ Menu state cleared.
```

## How It Works

### 1. Menu Detection
The system automatically detects menus by analyzing the terminal screen for:
- Numbered lists (`1. Option`, `2) Option`)
- Arrow indicators (`►`, `▸`, `→`)
- Selection markers (`[x]`, `[ ]`)
- List items (`-`, `•`)
- Context keywords (`select`, `choose`, `menu`, etc.)

### 2. Menu Capture
When a menu is detected:
1. The current screen content is captured from tmux
2. Menu items are parsed and extracted
3. Items are formatted for Telegram display
4. The menu is stored for selection

### 3. Menu Navigation
If no menu is immediately visible:
1. The system simulates keyboard navigation (arrow keys)
2. It captures the screen after each navigation
3. It collects and deduplicates menu items
4. It handles submenus and nested menus

### 4. Selection
When you select an option:
1. The system finds the matching menu item
2. It sends the corresponding keystrokes to tmux
3. It waits for Pi to process the selection
4. It captures and displays the result

## Supported Menu Formats

### Numbered Lists
```
1. First option
2. Second option
3. Third option
```

### Arrow Indicators
```
► Option A
► Option B
► Option C
```

### Selection Markers
```
[x] Selected item
[ ] Unselected item
```

### List Items
```
- Item one
- Item two
- Item three
```

### Mixed Formats
The system can handle mixed formats and will deduplicate items.

## Examples

### Example 1: Model Selection
```
User: /menu
Bot: 📋 Model Selection
     1. GPT-4
     2. GPT-3.5-turbo
     3. Claude-3
     4. Gemini-pro
     
     💡 Reply with the number or text to select an option.

User: /menu 3
Bot: ✓ Selected: Claude-3
     Waiting for Pi to process...
```

### Example 2: Tool Selection
```
User: /menu
Bot: 📋 Available Tools
     1. Read file
     2. Write file
     3. Execute command
     4. Search files
     
     💡 Reply with the number or text to select an option.

User: /menu read
Bot: ✓ Selected: Read file
     Waiting for Pi to process...
```

### Example 3: File Browser
```
User: /menu capture
Bot: 🔄 Capturing menu with navigation...
Bot: 📋 File Browser
     1. Documents/
     2. Pictures/
     3. Downloads/
     4. config.json
     
     💡 Reply with the number or text to select an option.

User: /menu 1
Bot: ✓ Selected: Documents/
     Waiting for Pi to process...
```

## Troubleshooting

### No Menu Detected
If `/menu` returns "No menu items detected":
1. Make sure Pi is showing an interactive menu
2. Try `/menu capture` to force navigation
3. Check that the tmux session is running

### Wrong Menu Captured
If the wrong menu is captured:
1. Use `/menu clear` to reset
2. Navigate to the correct menu in Pi
3. Try `/menu` again

### Selection Not Found
If your selection isn't found:
1. Use `/menu` to see available options
2. Try selecting by number instead of text
3. Check for typos in your selection

### Menu Not Updating
If the menu doesn't update after selection:
1. Wait a moment for Pi to process
2. Try `/menu` again to see the new menu
3. Use `/menu capture` if needed

## Technical Details

### tmux Integration
The feature uses tmux to:
- Check if a session named "pi" exists
- Capture terminal screen content
- Send keystrokes for navigation and selection

### Menu Parsing
The parser recognizes:
- Numbered lists with various separators
- Arrow and bullet indicators
- Selection checkboxes
- Context keywords

### State Management
- Menu items are stored in memory
- State persists until `/menu clear` or session end
- Each user has independent menu state

## Limitations

1. **Menu Visibility**: The menu must be visible on screen
2. **Menu Format**: Non-standard menus may not be parsed correctly
3. **Timing**: Rapid menu changes may not be captured
4. **Screen Size**: Very long menus may be truncated

## Future Improvements

1. **Inline Buttons**: Telegram inline keyboard for selection
2. **Menu Caching**: Remember frequently used menus
3. **Real-time Updates**: Live menu updates via WebSocket
4. **Multi-select**: Support for multiple selections
5. **Menu Search**: Search through menu items