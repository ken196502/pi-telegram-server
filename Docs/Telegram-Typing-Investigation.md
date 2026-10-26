# Plan: Telegram typing indicator stops showing while Pi is thinking / calling tools

Status: FIXED (root cause confirmed by reproduction, tests added)

## Symptom
The "typing…" indicator disappeared while Pi was thinking or running tools, and never came
back for the rest of the turn. Replying with messages still worked.

## Root cause
Commit `c4105b3` ("stop Telegram typing indicator from getting stuck") added a 120s idle
watchdog to `extensions/telegram-mirror.mjs`:

```js
typingWatchdog = setTimeout(() => { typingWatchdog = null; stopTyping(); }, 120000);
```

Every extension event refreshed it, and the 4s `typing` interval kept running — but **long
silent stretches emit no extension events at all**:

- long model thinking with no streamed deltas
- a tool call that prints nothing for minutes (`node -e ...`, a build, a browser run, ...)

After 120s of such silence the watchdog called `stopTyping()`, which cleared the 4s interval
and posted `stop_typing`, so the rest of the turn had no indicator. Short turns (events every
few seconds) were unaffected, which is why it looked intermittent.

Reproduction (main session, gateway log with `TELEGRAM_DEBUG_TYPING=1`):

```
03:05:56.730Z debug typing keepalive started   <- tool_execution_start, then `sleep 140`
03:05:56..03:07:52  typing signal every 4s     <- keepalive still alive
03:07:56.791Z debug typing keepalive stopped   <- exactly 120s later: watchdog fired
03:08:16.814Z debug typing keepalive started   <- tool finished, next event restarts it
```

The second session (`pi2` / bot `inspilot`) had a silent `launchBrowser` tool running for
21 minutes: after the first 120s its indicator was off for the remaining ~19 minutes, and
`/health` showed `typingActive:false, lastTypingAt:null`.

## Fix
`extensions/telegram-mirror.mjs`:
1. The idle watchdog is only armed when **no agent run is active** (`!agentRunning`). While a
   run is active the 4s interval keeps the indicator alive; `agent_end` / `agent_settled` stop
   it. This keeps the original intent (a dispatched command that never starts a run must not
   leak a typing loop) without dropping the indicator mid-turn.
2. `message_end` no longer stops typing while a run is active, so the
   "assistant message -> tool call" transition no longer flickers.
3. `PI_TG_TYPING_IDLE_MS` makes the idle timeout configurable (default 120000) so it can be
   tested quickly.

`src/gateway.mjs`:
4. `sendChatAction` failures are no longer swallowed: each failure is logged
   (`warn sendChatAction failed` with a consecutive counter) instead of `.catch(() => {})`.
5. `TELEGRAM_DEBUG_TYPING=1` logs every typing signal plus keepalive start/stop.
6. `/health` per bot: `typingActive`, `lastTypingAt`, `typingErrors`.

`test/typing.test.mjs` (new):
- typing survives a silent stretch while the agent is running
- a dispatched message that never starts a run still drops typing after the idle timeout
- `message_end` between an assistant message and a tool call does not stop typing

## Verification
- `npm test` -> 64/64 pass.
- Live: `curl -s http://127.0.0.1:3093/health` shows `typingActive:true` and a fresh
  `lastTypingAt` while a run is active; `grep "sendChatAction failed" gateway.log` stays empty.

## Follow-up for the user
Restart both Pi sessions so the fixed extension is loaded:

```bash
cd /home/piagent/Pi/pi-telegram-server && scripts/start-pi-session.sh main pi
cd /home/piagent/Pi/pi-telegram-server && scripts/start-pi-session.sh inspilot pi2
```

Until then the old extension keeps running, so any silent stretch over 120s still drops the
indicator. The gateway change is already live (it was restarted).
