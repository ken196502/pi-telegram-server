# LinuxAgentSetup.sh 实施计划

## 目标

提供一条命令完成 Pi + Telegram 服务在新 Linux 机器上的初始化：

```bash
curl -fsSL https://raw.githubusercontent.com/ken196502/pi-telegram-server/main/LinuxAgentSetup.sh | bash
```

脚本自动识别发行版与包管理器，安装 git、Node.js（>= 22.19）、tmux、Pi，写入
`~/.pi/agent/AGENTS.md`，克隆本仓库并执行 `npm install`、生成 `.env`。

## 交付物

| 文件 | 说明 |
| --- | --- |
| `LinuxAgentSetup.sh` | 主安装脚本，POSIX 友好的 bash，`set -euo pipefail` |
| `config/AGENTS.md` | Pi 全局规则模板，安装时复制到 `~/.pi/agent/AGENTS.md` |
| `README.md` | 增加 “One-command setup” 章节与 curl 命令、参数说明 |
| `.gitignore` | 忽略脚本运行产生的本地文件（如有） |

## 脚本流程

1. **参数解析**：`--dir <path>`、`--skip-packages`、`--skip-pi`、`--update-pi`、
   `--skip-repo`、`--skip-npm`、`--force-agents`、`--dry-run`、`-h`。
2. **系统检测**：读取 `/etc/os-release`，按 `apt-get` / `dnf` / `yum` /
   `pacman` / `zypper` / `apk` 选择安装命令；非 root 时使用 `sudo`，
   无 `sudo` 则明确报错退出。
3. **基础依赖**：git、curl、ca-certificates、tmux、xz-utils。
4. **Node.js**：检查 `node -v` 是否 >= 22.19；不满足时按发行版安装
   （apt/dnf 使用 NodeSource 22.x，Arch/Alpine 用官方仓库，SUSE 用
   `nodejs22`）。安装后再次校验版本，失败即报错，不做静默降级。
5. **Pi**：已存在则报告版本（`--update-pi` 时才执行 `pi update`），否则执行
   `curl -fsSL https://pi.dev/install.sh | sh`，并把 `~/.pi/agent/bin`
   加入当前 PATH 与 `~/.bashrc`。
6. **仓库**：`git clone https://github.com/ken196502/pi-telegram-server.git`
   到 `--dir`（默认 `~/Pi/pi-telegram-server`）；已存在则 `git pull --ff-only`。
7. **AGENTS.md**：从仓库内 `config/AGENTS.md` 复制（无本地副本时从 GitHub raw
   下载）；目标不存在时写入，存在时默认保留并提示，`--force-agents` 覆盖
   （覆盖前备份为 `AGENTS.md.bak-<时间戳>`）。
8. **服务依赖与配置**：`npm install`；无 `.env` 时从 `.env.example` 复制，
   并提示填写 BotFather token 与 WEBHOOK_TOKEN。
9. **收尾输出**：下一步命令（编辑 `.env`、`npm start`、`scripts/start-pi-session.sh`）。

## 验证

- `bash -n LinuxAgentSetup.sh`
- `shellcheck LinuxAgentSetup.sh`（如可用）
- `./LinuxAgentSetup.sh --dry-run` 不产生副作用
- 临时 `HOME` 下验证 AGENTS.md 写入/备份逻辑
- `npm test` 确认仓库原有测试不受影响

## 非目标

- 不自动配置 HTTPS 反代、systemd 服务或 BotFather token。
- 不安装桌面环境或非必要工具。
