#!/usr/bin/env bash
# restart-inbound-c.sh — 重启 gateway + 两个 Pi 会话以启用方案 C（WebSocket 反向注册）
#
# 顺序：先 gateway（WS 端点就绪），再 pi/pi2（主动连 gateway 注册）。
# 重启 pi/pi2 会中断当前 Pi 会话（包括正在进行的对话），所以本脚本在最后才动它们。
#
# 用法：
#   scripts/restart-inbound-c.sh          # 重启全部（gateway + pi + pi2）
#   scripts/restart-inbound-c.sh gateway  # 只重启 gateway
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

target="${1:-all}"

restart_gateway() {
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
  echo ">>> 重启 pi (main) 和 pi2 (inspilot) ..."
  echo "    ⚠️ 这会中断当前 Pi 会话（包括正在进行的对话）"
  echo "    3 秒后开始，Ctrl-C 可中止 ..."
  sleep 3

  for ss in pi pi2; do
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
  echo "    tmux attach -t pi      # main"
  echo "    tmux attach -t pi2     # inspilot"
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
  *)
    echo "用法: $0 [all|gateway]" >&2
    exit 64
    ;;
esac
