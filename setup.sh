#!/usr/bin/env bash
# setup.sh — install and configure the Pi Super-Agent on Linux.
#
# It asks for the Telegram bot token and your Telegram user ID first, then
# installs only the missing pieces (tmux, Node.js >= 22.19, Pi), verifies the
# token with getMe, writes .env, installs config/APPEND_SYSTEM.md, and starts
# the gateway and Pi in tmux.
#
#   ./setup.sh [options]
#
# Non-interactive use:
#   PI_TG_BOT_TOKEN=... PI_TG_USER_ID=... ./setup.sh
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIN_NODE="22.19.0"
PI_INSTALL_URL="https://pi.dev/install.sh"

WORKSPACE="$HOME"
DRY_RUN=false
FORCE_ENV=false
FORCE_PROMPT=false
WITH_CRON=false
SKIP_PACKAGES=false
CRON_INTERVAL=20

TOKEN=""
USER_ID=""

if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_INFO=$'\033[36m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_OK=$'\033[32m'
else
  C_RESET=""; C_INFO=""; C_WARN=""; C_ERR=""; C_OK=""
fi

info() { printf '%s[info]%s %s\n' "$C_INFO" "$C_RESET" "$*"; }
ok()   { printf '%s[ ok ]%s %s\n' "$C_OK" "$C_RESET" "$*"; }
warn() { printf '%s[warn]%s %s\n' "$C_WARN" "$C_RESET" "$*" >&2; }
die()  { printf '%s[error]%s %s\n' "$C_ERR" "$C_RESET" "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
setup.sh — install and configure the Pi Super-Agent on Linux.

Usage:
  ./setup.sh [options]

The script asks for the Telegram bot token (input hidden) and your Telegram
user ID before installing anything. In a non-interactive shell, set
PI_TG_BOT_TOKEN and PI_TG_USER_ID instead.

Options:
  --workspace <dir>     Pi working directory (default: $HOME)
  --dry-run             print every action; write and start nothing
  --force-env           replace an existing .env (a timestamped backup is kept)
  --force-prompt        replace a differing ~/.pi/agent/APPEND_SYSTEM.md
                        (a timestamped backup is kept)
  --with-cron           install a crontab entry for scripts/tmux-inspect.sh
  --cron-interval <n>   inspection interval in minutes (default: 20)
  --skip-packages       do not install tmux, Node.js, Pi or npm dependencies;
                        fail if a required command is missing
  -h, --help            show this help

The token is verified with getMe before .env is written. Nothing is merged
silently: a conflicting prompt file or .env stops the script unless the matching
--force-* flag is given.
EOF
}

while (( $# )); do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --force-env) FORCE_ENV=true; shift ;;
    --force-prompt) FORCE_PROMPT=true; shift ;;
    --with-cron) WITH_CRON=true; shift ;;
    --skip-packages) SKIP_PACKAGES=true; shift ;;
    --workspace)
      [ "$#" -ge 2 ] || die "--workspace needs a directory"
      WORKSPACE="$2"; shift 2 ;;
    --cron-interval)
      [ "$#" -ge 2 ] || die "--cron-interval needs a number of minutes"
      CRON_INTERVAL="$2"; shift 2 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

[[ "$CRON_INTERVAL" =~ ^[0-9]+$ ]] && (( CRON_INTERVAL >= 1 )) \
  || die "--cron-interval must be a positive integer (got '$CRON_INTERVAL')"

case "$WORKSPACE" in
  "~")   WORKSPACE="$HOME" ;;
  "~/"*) WORKSPACE="$HOME/${WORKSPACE#\~/}" ;;
esac
[ -d "$WORKSPACE" ] || die "workspace is not a directory: $WORKSPACE"
[ -w "$WORKSPACE" ] || die "workspace is not writable: $WORKSPACE"

# ── 1. credentials (before anything is installed) ────────────────────────────
prompt_credentials() {
  TOKEN="${PI_TG_BOT_TOKEN:-}"
  USER_ID="${PI_TG_USER_ID:-}"

  if [ -z "$TOKEN" ]; then
    [ -t 0 ] || die "PI_TG_BOT_TOKEN is not set and stdin is not a terminal; set PI_TG_BOT_TOKEN and PI_TG_USER_ID to run non-interactively"
    read -rsp "Telegram bot token (input hidden): " TOKEN
    printf '\n' >&2
  fi
  if [ -z "$USER_ID" ]; then
    [ -t 0 ] || die "PI_TG_USER_ID is not set and stdin is not a terminal; set PI_TG_BOT_TOKEN and PI_TG_USER_ID to run non-interactively"
    read -rp "Telegram user ID (numeric): " USER_ID
  fi

  [[ "$TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]] \
    || die "invalid Telegram bot token format; expected <digits>:<letters/digits/_/-> from @BotFather"
  [[ "$USER_ID" =~ ^[0-9]+$ ]] \
    || die "invalid Telegram user ID '$USER_ID'; expected a numeric ID"
}

# ── 2. system detection ──────────────────────────────────────────────────────
PM=""
SUDO=""
DISTRO=""

detect_system() {
  case "$(uname -s)" in
    Linux) ;;
    Darwin) die "macOS is not supported by setup.sh; this script targets Linux" ;;
    *) die "unsupported operating system: $(uname -s); setup.sh targets Linux" ;;
  esac

  [ -r /etc/os-release ] || die "/etc/os-release not found; cannot detect the distribution"
  # shellcheck disable=SC1091
  . /etc/os-release
  DISTRO="${PRETTY_NAME:-${ID:-unknown Linux}}"

  if command -v apt-get >/dev/null 2>&1; then PM=apt
  elif command -v dnf >/dev/null 2>&1; then PM=dnf
  elif command -v yum >/dev/null 2>&1; then PM=yum
  elif command -v pacman >/dev/null 2>&1; then PM=pacman
  elif command -v zypper >/dev/null 2>&1; then PM=zypper
  elif command -v apk >/dev/null 2>&1; then PM=apk
  else
    die "no supported package manager found (apt/dnf/yum/pacman/zypper/apk)"
  fi

  if [ "$(id -u)" -eq 0 ]; then
    SUDO=""
    warn "running as root: Pi and the repository are installed under $HOME"
  elif command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    die "not root and sudo is not installed; run as root or install sudo"
  fi

  info "system: $DISTRO"
  info "package manager: $PM${SUDO:+ (via sudo)}"
}

# ── 3. installation helpers ──────────────────────────────────────────────────
run() {
  if $DRY_RUN; then
    printf '[dry-run] %s\n' "$*"
    return 0
  fi
  "$@"
}

run_shell() {
  if $DRY_RUN; then
    printf '[dry-run] bash -c %q\n' "$1"
    return 0
  fi
  bash -c "$1"
}

run_in() {
  local dir="$1"; shift
  if $DRY_RUN; then
    printf '[dry-run] (cd %s && %s)\n' "$dir" "$*"
    return 0
  fi
  ( cd "$dir" && "$@" )
}

pm_install() {
  case "$PM" in
    apt)
      run $SUDO env DEBIAN_FRONTEND=noninteractive apt-get update -qq
      run $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"
      ;;
    dnf)    run $SUDO dnf install -y -q "$@" ;;
    yum)    run $SUDO yum install -y -q "$@" ;;
    pacman) run $SUDO pacman -Sy --needed --noconfirm "$@" ;;
    zypper) run $SUDO zypper --non-interactive install "$@" ;;
    apk)    run $SUDO apk add --no-cache "$@" ;;
  esac
}

ensure_base_tools() {
  local -a need=()
  command -v tmux >/dev/null 2>&1 || need+=(tmux)
  command -v curl >/dev/null 2>&1 || need+=(curl)
  command -v xz >/dev/null 2>&1 || need+=(xz)

  if (( ${#need[@]} == 0 )); then
    ok "tmux, curl and xz are already installed"
    return
  fi

  # apt calls the xz binary package xz-utils.
  if [ "$PM" = "apt" ]; then
    local i
    for i in "${!need[@]}"; do
      [ "${need[$i]}" = "xz" ] && need[$i]="xz-utils"
    done
  fi

  info "installing missing tools: ${need[*]}"
  pm_install "${need[@]}" ca-certificates
}

node_version_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local ver
  ver="$(node -p 'process.versions.node' 2>/dev/null)" || return 1
  [ -n "$ver" ] || return 1
  [ "$(printf '%s\n%s\n' "$MIN_NODE" "$ver" | sort -V | head -n1)" = "$MIN_NODE" ]
}

install_node() {
  info "Node.js >= $MIN_NODE is required; installing it"
  case "$PM" in
    apt)
      pm_install ca-certificates curl
      run_shell "curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash -"
      pm_install nodejs
      ;;
    dnf|yum)
      run_shell "curl -fsSL https://rpm.nodesource.com/setup_22.x | $SUDO bash -"
      pm_install nodejs
      ;;
    pacman) pm_install nodejs npm ;;
    apk)    pm_install nodejs npm ;;
    zypper) pm_install nodejs22 ;;
  esac
}

ensure_node() {
  if node_version_ok; then
    ok "node $(node -p 'process.versions.node') ($(command -v node))"
    return
  fi
  if $SKIP_PACKAGES; then
    die "Node.js >= $MIN_NODE is required but --skip-packages was given; install Node.js and re-run"
  fi
  install_node
  if $DRY_RUN; then
    info "[dry-run] would verify Node.js >= $MIN_NODE afterwards"
    return
  fi
  node_version_ok || die "Node.js >= $MIN_NODE is still unavailable after installation; install it manually and re-run"
  ok "node $(node -p 'process.versions.node') ($(command -v node))"
}

ensure_pi() {
  export PATH="$HOME/.pi/agent/bin:$HOME/.local/bin:$PATH"
  if command -v pi >/dev/null 2>&1; then
    ok "pi already installed: $(pi --version 2>/dev/null || echo unknown)"
    return
  fi
  if $SKIP_PACKAGES; then
    die "the 'pi' command is required but --skip-packages was given; install Pi from $PI_INSTALL_URL and re-run"
  fi
  info "installing Pi from $PI_INSTALL_URL"
  run_shell "curl -fsSL $PI_INSTALL_URL | sh"
  if $DRY_RUN; then
    info "[dry-run] would verify the pi binary afterwards"
    return
  fi
  command -v pi >/dev/null 2>&1 \
    || die "Pi installation finished but the 'pi' binary is not on PATH; open a new shell and re-run with --skip-packages"
  ok "pi $(pi --version 2>/dev/null || echo unknown) ($(command -v pi))"
}

install_dependencies() {
  if $SKIP_PACKAGES; then
    info "skipping npm dependencies (--skip-packages)"
    return
  fi
  [ -f "$repo_dir/package-lock.json" ] || die "missing $repo_dir/package-lock.json; cannot run npm ci"
  info "installing npm dependencies with npm ci"
  run_in "$repo_dir" npm ci --no-audit --no-fund
}

# ── 4. verify the token ──────────────────────────────────────────────────────
verify_token() {
  if $DRY_RUN; then
    info "[dry-run] would verify the bot token with getMe"
    return
  fi
  local response getme_out
  response="$(curl -sS -m 15 "https://api.telegram.org/bot$TOKEN/getMe")" \
    || die "could not reach the Telegram Bot API for getMe (network/TLS error)"
  if ! getme_out="$(printf '%s' "$response" | node -e '
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  let doc;
  try { doc = JSON.parse(raw); } catch { console.error("invalid JSON from getMe"); process.exit(1); }
  if (!doc || doc.ok !== true || !doc.result) {
    console.error((doc && doc.description) || "getMe returned ok=false");
    process.exit(1);
  }
  console.log(doc.result.username || doc.result.first_name || "bot");
});
' 2>&1)"; then
    die "Telegram rejected the bot token: $getme_out"
  fi
  ok "bot verified: @$getme_out"
}

# ── 5. write .env ────────────────────────────────────────────────────────────
random_hex() {
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))'
}

write_env() {
  local env_file="$repo_dir/.env"
  if [ -f "$env_file" ] && ! $FORCE_ENV; then
    if $DRY_RUN; then
      info "[dry-run] would stop: $env_file already exists; re-run with --force-env to replace it"
      return
    fi
    die "$env_file already exists; re-run with --force-env to replace it (a backup will be written)"
  fi
  if [ -f "$env_file" ] && $FORCE_ENV; then
    local backup="$env_file.bak-$(date +%Y%m%d-%H%M%S)"
    if $DRY_RUN; then
      info "[dry-run] would back up $env_file to $backup"
    else
      cp -p "$env_file" "$backup"
      chmod 600 "$backup"
      info "backed up existing .env to $backup"
    fi
  fi

  if $DRY_RUN; then
    info "[dry-run] would write $env_file (mode 600) with:"
    info "  TELEGRAM_BOTS=main=<token>"
    info "  TELEGRAM_BOT_MAIN_INBOUND_TOKEN=<random>"
    info "  WEBHOOK_TOKEN=<random>"
    info "  TELEGRAM_BOT_MAIN_ALLOWED_SENDERS=$USER_ID"
    info "  TELEGRAM_TO=$USER_ID"
    info "  TELEGRAM_POLLING=true TELEGRAM_HOST=127.0.0.1 TELEGRAM_PORT=3093"
    return
  fi

  local inbound_token webhook_token
  inbound_token="$(random_hex)"
  webhook_token="$(random_hex)"
  ( umask 077
    cat > "$env_file" <<EOF
# Generated by setup.sh on $(date -Is).
TELEGRAM_BOTS=main=$TOKEN
TELEGRAM_BOT_MAIN_INBOUND_TOKEN=$inbound_token
WEBHOOK_TOKEN=$webhook_token
TELEGRAM_BOT_MAIN_ALLOWED_SENDERS=$USER_ID
TELEGRAM_TO=$USER_ID
TELEGRAM_POLLING=true
TELEGRAM_HOST=127.0.0.1
TELEGRAM_PORT=3093
EOF
  )
  chmod 600 "$env_file"
  ok "wrote $env_file (mode 600)"
}

# ── 6. install the agent prompt ──────────────────────────────────────────────
install_prompt() {
  local src="$repo_dir/config/APPEND_SYSTEM.md"
  local dest="$HOME/.pi/agent/APPEND_SYSTEM.md"

  [ -f "$src" ] || die "missing prompt template: $src"

  if [ -f "$dest" ]; then
    if cmp -s "$src" "$dest"; then
      ok "$dest is already up to date"
      return
    fi
    if ! $FORCE_PROMPT; then
      if $DRY_RUN; then
        info "[dry-run] would stop: $dest differs from $src; re-run with --force-prompt"
        return
      fi
      die "$dest already exists and differs from $src; re-run with --force-prompt to replace it (a backup will be written)"
    fi
    local backup="$dest.bak-$(date +%Y%m%d-%H%M%S)"
    if $DRY_RUN; then
      info "[dry-run] would back up $dest to $backup"
    else
      cp -p "$dest" "$backup"
      info "backed up existing prompt to $backup"
    fi
  fi

  if $DRY_RUN; then
    info "[dry-run] would install $src to $dest"
    return
  fi
  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest"
  chmod 644 "$dest"
  ok "installed $dest"
}

# ── 7. coding CLI check ──────────────────────────────────────────────────────
check_codex() {
  if command -v codex >/dev/null 2>&1; then
    ok "codex found: $(codex --version 2>/dev/null || echo unknown)"
    return
  fi
  warn "codex is not installed. The default prompt in config/APPEND_SYSTEM.md"
  warn "dispatches coding work to 'codex exec'. Install it with:"
  warn "  npm install -g @openai/codex"
  warn "or customize config/APPEND_SYSTEM.md to use another coding CLI."
}

# ── 8. optional cron entry ───────────────────────────────────────────────────
install_cron() {
  $WITH_CRON || return 0

  command -v crontab >/dev/null 2>&1 || die "--with-cron was given but crontab is not installed"
  local script="$repo_dir/scripts/tmux-inspect.sh"
  [ -x "$script" ] || die "$script is not executable"

  local existing line
  existing="$(crontab -l 2>/dev/null || true)"
  if printf '%s\n' "$existing" | grep -Fq "$script"; then
    die "crontab already contains an entry for $script; remove it before re-running with --with-cron"
  fi

  line="*/$CRON_INTERVAL * * * * $script >/dev/null 2>&1"
  if $DRY_RUN; then
    info "[dry-run] would add crontab entry: $line"
    return
  fi
  if [ -n "$existing" ]; then
    { printf '%s\n' "$existing"; printf '%s\n' "$line"; } | crontab -
  else
    printf '%s\n' "$line" | crontab -
  fi
  ok "installed crontab entry (every $CRON_INTERVAL minutes)"
}

# ── 9. start ─────────────────────────────────────────────────────────────────
start_services() {
  if $DRY_RUN; then
    info "[dry-run] would run: $repo_dir/scripts/start.sh --workspace $WORKSPACE"
    return
  fi
  "$repo_dir/scripts/start.sh" --workspace "$WORKSPACE"
}

main() {
  info "Pi Super-Agent setup"
  prompt_credentials
  detect_system

  if $SKIP_PACKAGES; then
    info "skipping package installation (--skip-packages)"
  else
    ensure_base_tools
  fi
  ensure_node
  ensure_pi
  install_dependencies

  verify_token
  write_env
  install_prompt
  check_codex
  install_cron
  start_services

  if $DRY_RUN; then
    info "dry run finished; nothing was written or started"
    return
  fi
  ok "setup complete"
  info "Pi:      tmux attach -t pi"
  info "gateway: tmux attach -t pi-telegram-gateway"
  info "inspect: $repo_dir/scripts/tmux-inspect.sh --dry-run"
}

main "$@"
