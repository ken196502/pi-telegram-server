import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  tmuxSessionExists,
  captureTmuxPane,
  parseMenuItems,
  detectMenu,
  formatMenuForTelegram,
  findMenuItemIndex,
} from "../src/tmux-utils.mjs";

describe("tmux-utils", () => {
  describe("parseMenuItems", () => {
    it("should parse numbered list items", () => {
      const content = `Some header
1. First option
2. Second option
3. Third option
Some footer`;
      const items = parseMenuItems(content);
      assert.equal(items.length, 3);
      assert.equal(items[0].text, "First option");
      assert.equal(items[1].text, "Second option");
      assert.equal(items[2].text, "Third option");
    });

    it("should parse arrow indicator items", () => {
      const content = `► Option A
▸ Option B
→ Option C
> Option D`;
      const items = parseMenuItems(content);
      assert.equal(items.length, 4);
      assert.equal(items[0].text, "Option A");
      assert.equal(items[1].text, "Option B");
      assert.equal(items[2].text, "Option C");
      assert.equal(items[3].text, "Option D");
    });

    it("should parse selection markers", () => {
      const content = `[x] Selected item
[ ] Unselected item
[X] Also selected`;
      const items = parseMenuItems(content);
      assert.equal(items.length, 3);
      assert.equal(items[0].text, "Selected item");
      assert.equal(items[0].selected, true);
      assert.equal(items[1].text, "Unselected item");
      assert.equal(items[1].selected, false);
      assert.equal(items[2].text, "Also selected");
      assert.equal(items[2].selected, true);
    });

    it("should parse list items with dashes", () => {
      const content = `- Item one
- Item two
- Item three`;
      const items = parseMenuItems(content);
      assert.equal(items.length, 3);
      assert.equal(items[0].text, "Item one");
    });

    it("should filter out non-menu lines", () => {
      const content = `$ command
# Comment
─── separator ───
1. Real menu item
2. Another item`;
      const items = parseMenuItems(content);
      assert.equal(items.length, 2);
      assert.equal(items[0].text, "Real menu item");
    });

    it("should return empty array for no menu items", () => {
      const content = `Just some random text
No menu items here
$ command`;
      const items = parseMenuItems(content);
      assert.equal(items.length, 0);
    });
  });

  describe("detectMenu", () => {
    it("should detect menu with high confidence", () => {
      const content = `Select an option:
1. Option 1
2. Option 2
3. Option 3`;
      const result = detectMenu(content);
      assert.equal(result.isMenu, true);
      assert.ok(result.confidence >= 50);
    });

    it("should not detect menu for regular text", () => {
      const content = `Just some regular text
No indicators here
$ command`;
      const result = detectMenu(content);
      assert.equal(result.isMenu, false);
      assert.ok(result.confidence < 30);
    });

    it("should detect menu with arrow indicators", () => {
      const content = `Choose an option:
► Option A
► Option B
► Option C`;
      const result = detectMenu(content);
      assert.equal(result.isMenu, true);
    });
  });

  describe("formatMenuForTelegram", () => {
    it("should format menu items with numbers", () => {
      const items = [
        { text: "Option 1", selected: false },
        { text: "Option 2", selected: true },
        { text: "Option 3", selected: false },
      ];
      const formatted = formatMenuForTelegram(items, "Test Menu");
      assert.ok(formatted.includes("Test Menu"));
      assert.ok(formatted.includes("1. Option 1"));
      assert.ok(formatted.includes("✅ Option 2"));
      assert.ok(formatted.includes("3. Option 3"));
    });

    it("should handle empty items", () => {
      const formatted = formatMenuForTelegram([]);
      assert.ok(formatted.includes("No menu items"));
    });
  });

  describe("findMenuItemIndex", () => {
    const items = [
      { text: "Option 1" },
      { text: "Option 2" },
      { text: "Another option" },
    ];

    it("should find item by number", () => {
      assert.equal(findMenuItemIndex(items, "1"), 0);
      assert.equal(findMenuItemIndex(items, "2"), 1);
      assert.equal(findMenuItemIndex(items, "3"), 2);
    });

    it("should find item by text", () => {
      assert.equal(findMenuItemIndex(items, "Option 1"), 0);
      assert.equal(findMenuItemIndex(items, "option 2"), 1);
      assert.equal(findMenuItemIndex(items, "another"), 2);
    });

    it("should return -1 for invalid selection", () => {
      assert.equal(findMenuItemIndex(items, "4"), -1);
      assert.equal(findMenuItemIndex(items, "nonexistent"), -1);
      assert.equal(findMenuItemIndex(items, ""), -1);
    });
  });
});