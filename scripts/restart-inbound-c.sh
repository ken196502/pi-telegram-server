#!/usr/bin/env bash
# restart-inbound-c.sh — 重启 gateway + 每个已配置的 Pi 会话以启用方案 C（WebSocket 反向注册）
#
# 机器人列表来自 .env 的 TELEGRAM_BOTS（name=token,...），不写死任何 bot 名。
# 会话映射：第 1 个 -> pi，第 2 个 -> pi2，第 3 个 -> pi3（TELEGRAM_BOTS 的顺序即约定）。
#
# 顺序：先 gateway（WS 端点就绪），再各 Pi 会话（主动连 gateway 注册）。
# 重启 Pi 会话会中断当前 Pi 会话（包括正在进行的对话），所以本脚本在最后才动它们。
#
# 用法：
#   scripts/restart-inbound-c.sh [all|gateway] [--dry-run]
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"
# shellcheck source=scripts/lib/bots.sh
source "$repo_dir/scripts/lib/bots.sh"

usage() {
  echo "用法: $0 [all|gateway] [--dry-run]" >&2
  echo "  all       重启 gateway 和每个已配置的 Pi 会话（默认）" >&2
  echo "  gateway   只重启 gateway" >&2
  echo "  --dry-run 只打印解析出的 bot/会话和将执行的动作，不 kill、不启动、不等待" >&2
}

target=all
dry_run=0
for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    --dry-run) dry_run=1 ;;
    all|gateway) target="$arg" ;;
    *) usage; exit 64 ;;
  esac
done

bots_init "$repo_dir" || exit 1
echo ">>> 配置: ${BOT_NAMES[*]} -> ${SESSIONS[*]}"

restart_gateway() {
  if (( dry_run )); then
    echo ">>> [dry-run] 会重启 pi-telegram-gateway（kill 旧 session、轮转 gateway.log、重新启动并等待 /health）"
    return 0
  fi
  echo ">>> 重启 pi-telegram-gateway ..."
  if tmux has-session -t pi-telegram-gateway 2>/dev/null; then
    tmux kill-session -t pi-telegram-gateway
  fi
  # 清空旧日志方便辨认（保留备份）
  [ -f gateway.log ] && mv gateway.log "gateway.log.$(date +%s).bak"
  tmux new-session -d -s pi-telegram-gateway -c "$repo_dir" \
    "node src/gateway.mjs >> gateway.log 2>&1"
  echo "    gateway 已在 tmux session 'pi-telegram-gateway' 启动"
  echo "    查看: tmux attach -t pi-telegram-gateway"
  echo "    日志: tail -f $repo_dir/gateway.log"

  # 等待 /health 就绪
  echo "    等待 gateway /health ..."
  for i in $(seq 1 15); do
    if curl -sf http://127.0.0.1:3093/health >/dev/null 2>&1; then
      echo "    gateway 就绪"
      curl -s http://127.0.0.1:3093/health | python3 -c "
import json,sys
h=json.load(sys.stdin)
print('    bots:', list(h.get('bots',{}).keys()))
print('    inboundRegistered:', h.get('inboundRegistered',[]))
print('    inboundWsPath: /inbound')
" 2>/dev/null || true
      return 0
    fi
    sleep 1
  done
  echo "    ⚠️ gateway 15s 内未就绪，请检查: tmux attach -t pi-telegram-gateway" >&2
  return 1
}

restart_pi_sessions() {
  echo ">>> 重启 Pi 会话: ${SESSIONS[*]} (bots: ${BOT_NAMES[*]})"
  echo "    ⚠️ 这会中断当前 Pi 会话（包括正在进行的对话）"
  command -v tmux >/dev/null || { echo "missing command: tmux" >&2; exit 1; }
  bots_warn_unmanaged_sessions

  if (( dry_run )); then
    for ss in "${SESSIONS[@]}"; do
      if tmux has-session -t "=$ss" 2>/dev/null; then
        echo "    [dry-run] 会 kill tmux session '$ss'"
      else
        echo "    [dry-run] tmux session '$ss' 未运行"
      fi
    done
    echo "    [dry-run] 会执行 scripts/start-two-pi-sessions.sh（启动 ${#BOT_NAMES[@]} 个会话）"
    return 0
  fi

  echo "    3 秒后开始，Ctrl-C 可中止 ..."
  sleep 3

  for ss in "${SESSIONS[@]}"; do
    if tmux has-session -t "$ss" 2>/dev/null; then
      echo "    kill tmux session '$ss'"
      tmux kill-session -t "$ss"
    fi
  done

  echo "    用 start-two-pi-sessions.sh 启动 ..."
  "$repo_dir/scripts/start-two-pi-sessions.sh"

  echo ""
  echo ">>> 完成。验证："
  echo "    curl -s http://127.0.0.1:3093/health | python3 -m json.tool"
  for i in "${!BOT_NAMES[@]}"; do
    echo "    tmux attach -t ${SESSIONS[$i]}      # ${BOT_NAMES[$i]}"
  done
  echo "    tmux attach -t pi-telegram-gateway  # gateway 日志"
}

case "$target" in
  gateway)
    restart_gateway
    ;;
  all)
    restart_gateway
    echo ""
    restart_pi_sessions
    ;;
esac
