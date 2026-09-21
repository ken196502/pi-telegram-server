# Plan: Display All Options and Models Without Redundancy or Truncation

## 1. Problem Analysis
1. **Truncation Issue (Previously Fixed)**:
   - Artificial `.slice(0, 30)` was cutting off models 31-85. Removed so all models are accessible.
2. **Double Output / Redundancy Issue (Current Focus)**:
   - The user noted: "字符太多也是问题，这个菜单每个选项都输出两遍，浪费字符数，也修正"
   - Every single model line was formatted as:
     `${isCur ? "✅" : `${i + 1}.`} \`${m.provider}/${m.id}\`${m.name ? ` (${m.name})` : ""}`
   - E.g.: `✅ antigravity/gemini-3.8-flash (Gemini 3.8 Flash (Antigravity))`
   - In Pi, `m.name` is almost always a title-cased duplicate of `m.id` with `(Provider)` appended.
   - Result: both the provider and model ID were printed twice on every line, blowing up message size to >5.5KB and cluttering Telegram with redundant text.

## 2. Solution Design
1. **Redundant Name Deduplication**:
   - Implement `isRedundantName(name, id, provider)`: compares normalized alphanumeric representations.
   - If `name` simply repeats `id` and/or `provider`, suppress it completely.
   - Only preserve `name` if it provides genuinely distinct info (e.g. a custom alias or descriptive name).
2. **Provider Grouping for Model Catalog (`/model`)**:
   - Group models by provider with a clean header: `**<provider>** (<count>):`.
   - Under each provider, show concise item lines: `${idx}. \`${m.id}\`${extra}${check}`.
   - Preserves continuous numbering (1 to N) so `currentModelMenu` indices map 1:1 with user selection numbers.
   - Drastically cuts character count from ~5,500 down to ~2,200 chars (~60% reduction), allowing the entire 85-model catalog to fit in a single Telegram message.
3. **Clean Search Results (`/model <query>` & interactive text search)**:
   - Display `${idx}. \`${m.provider}/${m.id}\`` without repeating redundant `m.name`.
4. **Testing**:
   - Add unit tests for `isRedundantName` logic.
   - Verify all tests pass (`npm test`).
   - Re-verify with `node --check`.

## 3. Progress Tracking
- [x] Problem analysis & plan formulation
- [ ] Implement `isRedundantName` and provider grouping in `extensions/telegram-mirror.mjs`
- [ ] Add unit tests in `test/lib.test.mjs` or dedicated test
- [ ] Run test suite & reload service
- [ ] Document results in plan
