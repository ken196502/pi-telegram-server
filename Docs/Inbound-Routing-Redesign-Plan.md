# Inbound Routing Redesign — 方案 C 落地计划（WebSocket 反向注册）

Status: **implementing**（替换原 proposal）
Scope: `src/gateway.mjs`, `src/lib.mjs`, 新增 `src/inbound-ws.mjs`,
`extensions/telegram-mirror.mjs`, `scripts/start-pi-session.sh`,
`scripts/start-two-pi-sessions.sh`, `scripts/check-telegram-ready.mjs`,
`.env`, `.env.example`, `README.md`, 测试。

## 0. 决策

走 **方案 C（推荐终局）**：Pi 不再监听任何 HTTP 端口，而是主动连 gateway 的
WebSocket，首帧声明身份（bot 名 + per-bot token）。gateway 按 bot 名把 update
推给已注册的连接。

依赖可行性已确认：
- `package.json` 已有 `ws@^8.22.1` 且已安装。
- Node 22 内置全局 `WebSocket`（客户端可用），`ws` 包提供 `WebSocketServer`（服务端可用）。
- gateway 已用 `undici`，WS 服务端与现有 HTTP server 共存于同一端口的不同路径。

## 1. 目标架构

```
Telegram --webhook/poll--> gateway:3093
                                |
                                | processUpdate(bot, update)
                                v
                          InboundWSHub  ──ws push──>  已注册的 Pi 连接(bot=main)
                          (per-bot 连接表)            ──ws push──>  已注册的 Pi 连接(bot=inspilot)
```

- Pi 启动 → 连 `ws://127.0.0.1:3093/inbound`（或 `wss://` 若 gateway 在 TLS 后）。
- 首帧（client→server）：`{type:"register", bot:"main", token:"<per-bot inbound token>"}`
- gateway 校验 bot 名存在 + token 匹配 → 存入连接表，回 `{type:"registered", bot:"main"}`
- gateway 收到 Telegram update → `hub.send(bot, {type:"telegram_message", ...})`
- Pi 收到 → 注入 agent（沿用现有 `pi.sendUserMessage` 逻辑）
- 心跳：每 25s 双向 ping/pong；60s 无 pong → gateway 视为离线并清理；Pi 侧 30s 无 ping → 重连
- 重连：Pi 侧指数退避（1s→2s→…→30s 封顶），重连后重新 register

## 2. 解决的问题（对照原 proposal）

| 问题 | C 如何解决 |
|---|---|
| P1 端口稀缺 | Pi 不监听端口，gateway 只占 3093 |
| P2 sed 抠端口 | 删除，无端口 |
| P3 静默丢失 | R1：bot 不符/缺失在 register 阶段即拒绝；push 失败明确报错 |
| P4 单一全局 token | R2：per-bot `TELEGRAM_BOT_<NAME>_INBOUND_TOKEN` |
| P5 TCP-only 就绪探针 | R3：register 成功 = 在线；`/health` 报告已注册 bot |
| P6 跨主机 | gateway 单端口可被远程 Pi 连（未来） |
| P7 预分配端口 | 无端口，可懒启动 |
| P8 双默认值漂移 | 无端口/host/path 默认值 |

## 3. R1–R5 落地点

- **R1 静默丢失**：register 阶段 bot 名不在配置 / token 不匹配 → WS close(4001) + 错误帧；
  push 时连接不存在 → gateway `log("warn")` + 不计入 `forwarded`（改计 `dropped`）。
  不再有"返 200 却丢弃"。
- **R2 per-bot token**：`TELEGRAM_BOT_<NAME>_INBOUND_TOKEN`，缺失则回退全局 `INBOUND_WEBHOOK_TOKEN`
  并 warning（过渡期兼容）；register 帧必须带 token，空 token 直接拒。
- **R3 身份探针**：`/health` 增加 `inboundRegistered: ["main"]`；
  `check-telegram-ready.mjs` 的 `inbound` 模式改为查 `/health` 看 bot 是否在 `inboundRegistered`，
  不再 TCP connect。
- **R4 配置校验**：`resolveBotConfigs()` 校验 bot 名唯一（已有）、token 非空（已有）；
  新增：若配置了 `INBOUND_TOKEN` 则所有 bot 的 inbound token 必须非空（多 bot 下不允许全局兜底）。
- **R5 明确报错**：register 失败、push 失败、连接断开 → 全部 `log` + 不降级。
  符合 AGENTS.md "no fallbacks to hide problems"。

## 4. 文件改动清单

### 4.1 新增 `src/inbound-ws.mjs`
- `createInboundHub()`：返回 hub 对象
  - `attachToServer(httpServer)`：在已有 http.Server 上挂 `upgrade` 监听，路径 `/inbound`
  - `register(ws, {bot, token})`：校验 + 存入 `connections: Map<botName, Set<ws>>`
  - `send(bot, payload)`：找到连接推 JSON，无连接返回 `false`（调用方报错）
  - `unregister(ws)`：连接关闭时清理
  - `registeredBots()`：返回已注册 bot 名列表（供 `/health`）
  - 心跳：`startPingInterval()` 每 25s 对所有连接 ping；`markAlive(ws)` 收到 pong 时调用
- `connectInboundClient({url, bot, token, onMessage, onOpen, onClose})`：Pi 侧客户端
  - 用 `ws` 包的 `WebSocket`（服务端环境）或全局 `WebSocket`（浏览器/Node22）
  - 自动重连：指数退避 1s→30s
  - 自动重新 register
  - 心跳：每 25s ping
- 纯函数 `parseInboundWsUrl(env)`：解析 `PI_TELEGRAM_INBOUND_WS_URL`，默认由
  `TELEGRAM_HOST`/`TELEGRAM_PORT` 推导 `ws://127.0.0.1:3093/inbound`

### 4.2 `src/gateway.mjs`
- 顶部 import `createInboundHub`
- `startHttp()` 后：`const hub = createInboundHub({bots}); hub.attachToServer(server)`
- `forwardInbound(bot, payload)` 改为：
  ```js
  const ok = hub.send(bot.config.name, payload);
  if (!ok) { bot.dropped += 1; log("warn","inbound push dropped: no registered connection",{bot:bot.config.name}); }
  else bot.forwarded += 1;
  ```
- `/health` 增加 `inboundRegistered: hub.registeredBots()` 和每 bot 的 `inboundConnected: boolean`
- bot 状态结构增加 `dropped` 计数
- 删除 `bot.config.inboundUrl` 的 HTTP POST 逻辑（保留 `inboundToken` 用于 WS 校验）

### 4.3 `extensions/telegram-mirror.mjs`
- `session_start` handler：
  - 删除 `http.createServer` + `server.listen(s.inboundPort)`
  - 改为 `const client = connectInboundClient({url: s.inboundWsUrl, bot: s.bot, token: s.inboundToken, onMessage: handleInboundMessage})`
  - `handleInboundMessage(payload)` 沿用现有 inbound handler 的消息处理逻辑（菜单/命令/model/普通消息），
    但不再有 `req`/`res`——改为直接调用处理函数，错误通过 `ctx.ui.notify` + WS 错误帧回报
  - R1：bot 名校验移到 register 阶段（gateway 拒绝），extension 侧不再需要"返 200 丢弃"
- settings 增加 `inboundWsUrl`，删除 `inboundHost`/`inboundPort`/`inboundPath`
- `session_shutdown`：`client?.close()`

### 4.4 `src/lib.mjs`
- `resolveBotConfigs()`：
  - `inboundToken: pick("INBOUND_TOKEN", env.INBOUND_WEBHOOK_TOKEN || "")` 保留
  - 删除 `inboundUrl` 字段（不再用 HTTP URL）
  - R4：多 bot 时若某 bot 的 `inboundToken` 为空 → throw（不静默用全局）
- 新增 `resolveInboundWsUrl(env)` 纯函数（可单测）

### 4.5 `scripts/start-pi-session.sh`
- 删除 `sed` 抠端口逻辑
- 只导出 `PI_TELEGRAM_BOT` + `PI_TG_TMUX_SS`
- `PI_TELEGRAM_INBOUND_WS_URL` 由 extension 从 gateway host/port 自动推导，无需脚本设置

### 4.6 `scripts/start-two-pi-sessions.sh`
- 删除两个 bot 的端口提取 + 端口对比
- 改为校验 `TELEGRAM_BOT_<NAME>_INBOUND_TOKEN` 存在（多 bot 必填）

### 4.7 `scripts/check-telegram-ready.mjs`
- `inbound` 模式：改为 `GET /health`，检查每个 bot 在 `inboundRegistered` 数组里
- 删除 `net.connect` TCP 探测

### 4.8 `.env` / `.env.example`
- `.env`：`TELEGRAM_BOT_MAIN_INBOUND_URL` → 删除；新增 `TELEGRAM_BOT_MAIN_INBOUND_TOKEN=<token>`
- `.env.example`：同步更新注释，说明 WS 反向注册

### 4.9 测试
- 新增 `test/inbound-ws.test.mjs`：
  - hub register 成功 / bot 不存在 → 拒绝 / token 错误 → 拒绝
  - hub.send 命中已注册连接 / 无连接 → 返回 false
  - 客户端自动重连 + 重新 register（用 mock WS server）
  - 心跳 ping/pong
- 扩 `test/lib.test.mjs`：`resolveInboundWsUrl` 解析；多 bot 缺 token → throw
- 现有 `test/telegram-mirror.test.mjs`：mock webhook server 保留（outbound 镜像不变）

## 5. 迁移步骤

1. 部署新代码（gateway + extension + 脚本 + .env）
2. 重启顺序：**先 gateway，再 pi/pi2**
   - gateway 先起来，WS 端点就绪
   - pi/pi2 启动后主动连 gateway 注册
3. 验证：
   - `curl http://127.0.0.1:3093/health` 看 `inboundRegistered`
   - Telegram 发消息给 main bot → pi 会话收到
   - Telegram 发消息给 inspilot bot → pi2 会话收到

## 6. 回滚

- 代码层：`git revert` 回到 HTTP 端口转发版本
- 配置层：`.env` 恢复 `TELEGRAM_BOT_<NAME>_INBOUND_URL=http://127.0.0.1:309x/telegram/inbound`
- 无数据迁移，无持久化状态，回滚即换代码 + 重启

## 7. 不做

- 不实现跨主机远程 Pi（C 架构支持，但当前都在本机，不引入 TLS/鉴权复杂度）
- 不做消息持久化/重放队列（连接断开期间的消息丢弃 + 明确日志，符合 R5）
- 不改 outbound 镜像路径（`/webhook` POST 不变）
- 不改 Telegram webhook/polling 入站（gateway 收 Telegram 的方式不变）
