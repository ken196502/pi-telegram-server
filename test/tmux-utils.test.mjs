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

    it("should reject conversational numbered lists with prose/code descriptions", () => {
      const content = `Testing flow-ext project --list option flag and extension project extraction...
1. --
2. Testing flow-ext project --list option flag and extension project extraction...
3. Flow 扩展端 (extension/content.js)：
4. 添加 extractProjectsFromDOM()：利用 UUID 正则解析页面中所有的 /project/<uuid> 链接及卡片属性（data-project-id、aria-label 等），去重并提取项目 ID、标题与完整 URL。
5. 抽象 scrollToBottomInternal()：实现平滑分步滚动并监控页面高度与各滚动容器变化，在停滞或达到上限后触底等待懒加载挂载。
$ git status
── ⠴ Working ─────────────────────────`;
      const items = parseMenuItems(content);
      assert.equal(items.length, 0);
    });

    it("should return empty array when screen shows agent Working status", () => {
      const content = `Model Configuration
→ ✓ mimo-v2.5-pro [commandcode]
  ✓ gpt-4o [openai]
── ⠴ Working ─────────────────────────
/mnt/share/VM`;
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

    it("should reject screen with Working status", () => {
      const content = `Select an option:
1. Option 1
2. Option 2
── ⠴ Working ─────────────────────────`;
      const result = detectMenu(content);
      assert.equal(result.isMenu, false);
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

    it("should format all items without truncation even when >30 items", () => {
      const items = Array.from({ length: 85 }, (_, i) => ({
        text: `Model-${i + 1}`,
        selected: i === 0,
      }));
      const formatted = formatMenuForTelegram(items, "Models");
      assert.ok(formatted.includes("Total: 85 items"));
      assert.ok(formatted.includes("✅ Model-1"));
      assert.ok(formatted.includes("85. Model-85"));
      assert.ok(!formatted.includes("more items"));
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