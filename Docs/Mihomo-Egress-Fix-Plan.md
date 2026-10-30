# Plan: Fix "switching mihomo nodes does not change opencode.ai egress IP / always 429"

Status: DIAGNOSED - awaiting user choice between Option A and B before applying.

## Symptom
- Telegram gateway -> Pi -> OpenCode Zen free models: every call returns 429 FreeUsageLimitError
  (free daily quota, about 200 req/day, PER IP).
- User switches mihomo nodes many times, but the IP OpenCode sees never changes, so the quota
  never resets and it stays 429.

## Root cause (confirmed empirically)
1. Egress DOES go through mihomo: ip route get 8.8.8.8 resolves via 198.18.0.2 dev Meta (mihomo TUN).
   opencode.ai resolves to fake-ip 198.18.0.136 and rides the same TUN. Traffic is NOT bypassing mihomo.
2. mihomo runs in mode=global, not rule. GET /configs returns mode=global even though
   /etc/mihomo/config.yaml says mode=rule (likely overridden at runtime by the dashboard).
3. In global mode every connection goes straight to the GLOBAL group and rules are bypassed
   (all /connections show empty rule, chain 日本-3 -> GLOBAL).
   The rule-groups the user was switching (node-selection / auto-select) are IGNORED in
   global mode, so opencode.ai was pinned to GLOBAL -> 日本-3 = constant IP = 429.
4. Switching the governing group DOES change the IP (fresh curl, no keep-alive reuse):
   GLOBAL to HK / LA / SG / JP each gave a distinct stable exit.

## Fix options

### Option A - switch mihomo back to rule mode (matches config.yaml design; recommended)
- Apply: PATCH http://127.0.0.1:9090/configs body mode=rule (or set Mode=Rule in dashboard).
- Then opencode.ai matches MATCH -> node-selection group. Rotate that group to change its IP.
- Optional isolate: add rule DOMAIN-SUFFIX,opencode.ai,<dedicated-group> before MATCH, rotate only it.
- Side effect: reroutes ALL traffic to the ruleset (CN->direct, foreign->node-selection).

### Option B - stay in global mode; rotate the GLOBAL group (zero config change)
- No config/mode change. Switch the GLOBAL group (not the rule-groups) to change opencode.ai IP.
- Downside: all apps share one node (no per-app routing), but works immediately for dodging 429.

## Persistence gotcha
- Runtime mode was overridden to global (config.yaml says rule). A mihomo restart reloads config.yaml -> rule.
- If a dashboard keeps re-setting global, fix that setting so Option A sticks.

## Verification after applying
1. curl -s http://127.0.0.1:9090/configs  -> confirm mode.
2. Switch governing group; curl -s https://api.ipify.org (fresh conn) -> confirm exit IP changes.
3. OPENCODE_API_KEY=public pi --model opencode-zen/<free>-free --print hi from a FRESH IP -> expect 200.

## Bigger picture (independent of this fix)
- 429 is a per-IP daily quota (~200/day); an always-on bot answering every message burns it fast.
  Rotating IPs helps but is fragile.
- A real Zen key (OPENCODE_API_KEY=oc_sk_... or /login opencode-zen) uses the paid catalog with NO
  per-IP free quota, removing the 429 problem entirely.

## Recommendation
Option A (rule mode) is the intended design and lets you rotate opencode.ai via the node-selection
group. Because it reroutes all traffic, confirm before applying. Option B is instant and zero-risk.

## Result
(filled after applying the chosen option)

## Result (2026-10-25)
- Egress path is actually healthy: mode=global, GLOBAL=韩国|移动优化, real egress 109.61.127.36 (fresh KR IP).
- Still 429 even with a FRESH Korea IP AND a fresh Pi session (fresh ses_ SortableID). Error:
  429 FreeUsageLimitError "Free usage limit reached ... subscribe to OpenCode Go to keep going".
- Conclusion: the 429 is NOT an egress/IP problem. Rotating IP or session does not reset it.
  The mihomo global-mode issue was real but was NOT the cause of 429. OpenCode has effectively
  closed anonymous free-tier use (shared exits exhaust the ~200/day quota; likely UA/fingerprint
  or pool-level throttling on top). Reliable fix = a real Zen key (paid / OpenCode Go).
