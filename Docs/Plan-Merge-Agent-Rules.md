# Plan — Merge config/AGENTS.md into Global AGENTS.md

## Goal
Preserve every distinct rule from the workspace `config/AGENTS.md` inside the global
`/home/piagent/.pi/agent/AGENTS.md`, avoid duplicating rules already present there, then
delete `config/AGENTS.md`.

## Source files
- Workspace: `config/AGENTS.md` (7 rules, English, flat bullet list)
- Global: `/home/piagent/.pi/agent/AGENTS.md` (铁律 1–6 + 项目级规范, Chinese)

## Rule-by-rule mapping (workspace → global)

| # | Workspace rule | Status | Covered by |
|---|----------------|--------|------------|
| 1 | No fallbacks to hide problems | Duplicate | 铁律 4（不许 fallback 掩盖问题）|
| 2 | Clean up all test processes after testing | **DISTINCT — merge** | — |
| 3 | Write a plan md file to `Docs` before developing | Duplicate | 铁律 6（计划先落地到 `Docs/Plan-<Topic>.md`）|
| 4 | Add generated data to `.gitignore` | **DISTINCT — merge** | — |
| 5 | Tell the user what to do next before the first tool call in every chat | **DISTINCT — merge** | — |
| 6 | Run every long-lived process inside a NAMED tmux session | Duplicate | 铁律 2 |
| 7 | After starting such a process, report tmux session name + attach/view/kill commands | Duplicate | 铁律 2（派发后立即给出 attach / capture-pane / kill-session）|

Net: 3 distinct rules (#2, #4, #5) to add; 4 rules already covered — do not duplicate.

## Implementation steps (to run later; not part of this plan commit)
1. Edit `/home/piagent/.pi/agent/AGENTS.md`. Add the 3 distinct rules as short bullets.
   Suggested placement: a new section before `## 项目级规范`, e.g.:
   ```
   ## 铁律 7：工程卫生
   - 测试后清理所有测试进程（test processes），不留残留。
   - 生成的数据（产物、日志、缓存）必须加入 `.gitignore`。
   - 每次对话在第一个工具调用之前，先告诉用户接下来要做什么。
   ```
   (Keep wording concise; preserve the original intent of each rule.)
2. Delete `config/AGENTS.md`.

## Verification steps
1. **Distinct rules present** — confirm each merged rule exists in the global file:
   ```bash
   G=/home/piagent/.pi/agent/AGENTS.md
   grep -q '测试进程\|test process' "$G" && echo OK:cleanup || echo MISSING:cleanup
   grep -q '\.gitignore' "$G"            && echo OK:gitignore || echo MISSING:gitignore
   grep -q '第一个工具调用\|next before' "$G" && echo OK:next-step || echo MISSING:next-step
   ```
2. **No needless duplication** — confirm the already-covered rules were NOT re-added
   (fallback / plan-in-Docs / tmux rules should each appear once, within 铁律 2/4/6).
   Spot-check by reading the global file.
3. **Workspace file deleted**:
   ```bash
   test ! -e /home/piagent/Pi/pi-telegram-server/config/AGENTS.md && echo DELETED || echo STILL-EXISTS
   ```
4. **No dangling references** — ensure nothing else references the deleted path:
   ```bash
   grep -rn 'config/AGENTS.md' /home/piagent/Pi/pi-telegram-server --exclude-dir=node_modules --exclude-dir=.git
   ```
   Investigate/update any hits (e.g. steering `#[[file:...]]` includes, scripts, docs).
5. **Global file still well-formed** — read it end-to-end; confirm Markdown headings
   intact and the `## 项目级规范` closing section remains last.

## Rollback
`config/AGENTS.md` is tracked by git; `git checkout -- config/AGENTS.md` (or revert the
commit) restores it if the merge needs to be undone.
