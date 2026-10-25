#!/usr/bin/env bash
#
# LinuxAgentSetup.sh - bootstrap a Linux machine for Pi + pi-telegram-server.
#
# Installs git, Node.js (>= 22.19), tmux and Pi, writes the global Pi
# AGENTS.md, clones this repository, installs npm dependencies and creates
# .env from .env.example.
#
# Usage (one-liner):
#   curl -fsSL https://raw.githubusercontent.com/ken196502/pi-telegram-server/main/LinuxAgentSetup.sh | bash
#
# Options:
#   --dir <path>       Clone/update the repo at <path>
#                      (default: ~/Pi/pi-telegram-server)
#   --skip-packages    Do not install git/curl/tmux/Node.js
#   --skip-pi          Do not install Pi
#   --update-pi        Run "pi update" when Pi is already installed
#   --skip-repo        Do not clone or update the repository
#   --skip-npm         Do not run npm install
#   --force-agents     Overwrite ~/.pi/agent/AGENTS.md (backup is kept)
#   --dry-run          Print what would be executed, change nothing
#   -h, --help         Show this help
#
set -euo pipefail

REPO_URL="${PI_TG_REPO_URL:-https://github.com/ken196502/pi-telegram-server.git}"
AGENTS_URL="${PI_TG_AGENTS_URL:-https://raw.githubusercontent.com/ken196502/pi-telegram-server/main/config/AGENTS.md}"
MIN_NODE="22.19.0"

TARGET_DIR="$HOME/Pi/pi-telegram-server"
SKIP_PACKAGES=false
SKIP_PI=false
UPDATE_PI=false
SKIP_REPO=false
SKIP_NPM=false
FORCE_AGENTS=false
DRY_RUN=false

PM=""
SUDO=""
TMPDIR_SETUP=""

if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_INFO=$'\033[36m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_OK=$'\033[32m'
else
  C_RESET=""; C_INFO=""; C_WARN=""; C_ERR=""; C_OK=""
fi

info() { printf '%s[info]%s %s\n' "$C_INFO" "$C_RESET" "$*"; }
ok()   { printf '%s[ ok ]%s %s\n' "$C_OK" "$C_RESET" "$*"; }
warn() { printf '%s[warn]%s %s\n' "$C_WARN" "$C_RESET" "$*" >&2; }
die()  { printf '%s[error]%s %s\n' "$C_ERR" "$C_RESET" "$*" >&2; exit 1; }

cleanup() { if [ -n "$TMPDIR_SETUP" ]; then rm -rf "$TMPDIR_SETUP"; fi; }
trap cleanup EXIT

usage() {
  cat <<'EOF'
LinuxAgentSetup.sh - bootstrap a Linux machine for Pi + pi-telegram-server.

Usage (one-liner):
  curl -fsSL https://raw.githubusercontent.com/ken196502/pi-telegram-server/main/LinuxAgentSetup.sh | bash

Options:
  --dir <path>       Clone/update the repo at <path>
                     (default: ~/Pi/pi-telegram-server)
  --skip-packages    Do not install git/curl/tmux/Node.js
  --skip-pi          Do not install Pi
  --update-pi        Run "pi update" when Pi is already installed
  --skip-repo        Do not clone or update the repository
  --skip-npm         Do not run npm install
  --force-agents     Overwrite ~/.pi/agent/AGENTS.md (backup is kept)
  --dry-run          Print what would be executed, change nothing
  -h, --help         Show this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir)            [ "$#" -ge 2 ] || die "--dir needs a path"; TARGET_DIR="$2"; shift 2 ;;
    --skip-packages)  SKIP_PACKAGES=true; shift ;;
    --skip-pi)        SKIP_PI=true; shift ;;
    --update-pi)      UPDATE_PI=true; shift ;;
    --skip-repo)      SKIP_REPO=true; shift ;;
    --skip-npm)       SKIP_NPM=true; shift ;;
    --force-agents)   FORCE_AGENTS=true; shift ;;
    --dry-run)        DRY_RUN=true; shift ;;
    -h|--help)        usage; exit 0 ;;
    *)                die "unknown option: $1 (try --help)" ;;
  esac
done

# Expand a leading ~ in --dir.
case "$TARGET_DIR" in
  "~")   TARGET_DIR="$HOME" ;;
  "~/"*) TARGET_DIR="$HOME/${TARGET_DIR#\~/}" ;;
esac

run() {
  if $DRY_RUN; then
    printf '[dry-run] %s\n' "$*"
    return 0
  fi
  "$@"
}

# Run a shell snippet (needed for "curl ... | bash" pipelines).
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

detect_system() {
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
    warn "running as root: Pi and the repo will be installed under $HOME"
  elif command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    die "not root and sudo is not installed; run as root or install sudo"
  fi

  info "system: $DISTRO"
  info "package manager: $PM${SUDO:+ (via sudo)}"
}

install_base_packages() {
  info "installing git, curl, ca-certificates, tmux, xz"
  case "$PM" in
    apt)
      run $SUDO env DEBIAN_FRONTEND=noninteractive apt-get update -qq
      run $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
        git curl ca-certificates tmux xz-utils
      ;;
    dnf)    run $SUDO dnf install -y -q git curl ca-certificates tmux xz ;;
    yum)    run $SUDO yum install -y -q git curl ca-certificates tmux xz ;;
    pacman) run $SUDO pacman -Sy --needed --noconfirm git curl ca-certificates tmux xz ;;
    zypper) run $SUDO zypper --non-interactive install git curl ca-certificates tmux xz ;;
    apk)    run $SUDO apk add --no-cache git curl ca-certificates tmux xz ;;
  esac
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
      run $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl
      run_shell "curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash -"
      run $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs
      ;;
    dnf|yum)
      run_shell "curl -fsSL https://rpm.nodesource.com/setup_22.x | $SUDO bash -"
      run $SUDO "$PM" install -y nodejs
      ;;
    pacman) run $SUDO pacman -S --needed --noconfirm nodejs npm ;;
    apk)    run $SUDO apk add --no-cache nodejs npm ;;
    zypper)
      if ! run $SUDO zypper --non-interactive install nodejs22; then
        warn "nodejs22 package not available; trying nodejs"
        run $SUDO zypper --non-interactive install nodejs
      fi
      ;;
  esac
}

ensure_node() {
  if node_version_ok; then
    ok "node $(node -p 'process.versions.node') ($(command -v node))"
    return
  fi
  install_node
  if $DRY_RUN; then
    info "[dry-run] would verify Node.js >= $MIN_NODE afterwards"
    return
  fi
  node_version_ok || die "Node.js >= $MIN_NODE is still unavailable after installation; install it manually and re-run"
  ok "node $(node -p 'process.versions.node') ($(command -v node))"
}

ensure_pi_path() {
  export PATH="$HOME/.pi/agent/bin:$HOME/.local/bin:$PATH"
  local rc="$HOME/.bashrc"
  if $DRY_RUN; then
    info "[dry-run] would ensure ~/.pi/agent/bin is in $rc"
    return
  fi
  if [ -f "$rc" ] && ! grep -qF '.pi/agent/bin' "$rc"; then
    printf '\n# Pi CLI\nexport PATH="$HOME/.pi/agent/bin:$PATH"\n' >> "$rc"
    info "added ~/.pi/agent/bin to $rc"
  fi
}

install_pi() {
  ensure_pi_path
  if command -v pi >/dev/null 2>&1; then
    ok "pi already installed: $(pi --version 2>/dev/null || echo unknown)"
    if $UPDATE_PI; then
      info "updating Pi"
      run pi update
    fi
    return
  fi
  info "installing Pi from https://pi.dev/install.sh"
  run_shell "curl -fsSL https://pi.dev/install.sh | sh"
  ensure_pi_path
  if $DRY_RUN; then
    info "[dry-run] would verify the pi binary afterwards"
    return
  fi
  command -v pi >/dev/null 2>&1 || die "Pi installation finished but the 'pi' binary is not on PATH; open a new shell and re-run with --skip-pi"
  ok "pi $(pi --version 2>/dev/null || echo unknown) ($(command -v pi))"
}

clone_repo() {
  if [ -d "$TARGET_DIR/.git" ]; then
    info "updating existing checkout at $TARGET_DIR"
    run git -C "$TARGET_DIR" pull --ff-only
    return
  fi
  if [ -e "$TARGET_DIR" ] && [ -n "$(ls -A "$TARGET_DIR" 2>/dev/null)" ]; then
    die "$TARGET_DIR exists but is not a git checkout; move it away or pass --dir <other-path>"
  fi
  info "cloning $REPO_URL into $TARGET_DIR"
  run mkdir -p "$(dirname "$TARGET_DIR")"
  run git clone "$REPO_URL" "$TARGET_DIR"
}

install_agents_md() {
  local dest="$HOME/.pi/agent/AGENTS.md"
  local src="$TARGET_DIR/config/AGENTS.md"

  if [ ! -f "$src" ]; then
    info "local AGENTS.md template not found; downloading $AGENTS_URL"
    TMPDIR_SETUP="$(mktemp -d)"
    src="$TMPDIR_SETUP/AGENTS.md"
    run curl -fsSL "$AGENTS_URL" -o "$src" \
      || die "could not download the AGENTS.md template"
  fi

  run mkdir -p "$HOME/.pi/agent"

  if [ -f "$dest" ] && ! $FORCE_AGENTS; then
    info "keeping existing $dest (use --force-agents to replace it)"
    return
  fi

  if [ -f "$dest" ]; then
    local backup="$dest.bak-$(date +%Y%m%d-%H%M%S)"
    run cp "$dest" "$backup"
    info "backed up existing AGENTS.md to $backup"
  fi

  run cp "$src" "$dest"
  run chmod 644 "$dest"
  ok "wrote $dest"
}

install_dependencies() {
  if [ ! -f "$TARGET_DIR/package.json" ]; then
    warn "no package.json in $TARGET_DIR; skipping npm install"
    return
  fi
  info "installing npm dependencies in $TARGET_DIR"
  run_in "$TARGET_DIR" npm install --no-audit --no-fund

  if [ -f "$TARGET_DIR/.env" ]; then
    info ".env already exists; leaving it untouched"
  elif [ -f "$TARGET_DIR/.env.example" ]; then
    run cp "$TARGET_DIR/.env.example" "$TARGET_DIR/.env"
    run chmod 600 "$TARGET_DIR/.env"
    ok "created $TARGET_DIR/.env from .env.example"
  else
    warn "no .env.example in $TARGET_DIR; create .env manually"
  fi
}

print_next_steps() {
  cat <<EOF

${C_OK}Setup complete.${C_RESET}

Next steps:
  1. Put your bot token and secrets into:
       $TARGET_DIR/.env
     (TELEGRAM_BOT_TOKEN, WEBHOOK_TOKEN, TELEGRAM_INBOUND_ALLOWED_SENDERS)
  2. Start the gateway:
       cd $TARGET_DIR && npm start
  3. Start a Pi session bound to one bot inside tmux:
       cd $TARGET_DIR && scripts/start-pi-session.sh main pi
  4. For a public webhook, expose the gateway over HTTPS and set
       TELEGRAM_WEBHOOK_URL in .env
  5. If you plan to run it as a service, see systemd/pi-telegram.service.

Notes:
  - Pi reads global rules from ~/.pi/agent/AGENTS.md
  - Run './LinuxAgentSetup.sh --help' for all options
EOF
}

main() {
  info "Pi + pi-telegram-server setup"
  detect_system

  if $SKIP_PACKAGES; then
    info "skipping package installation (--skip-packages)"
  else
    install_base_packages
    ensure_node
  fi

  if $SKIP_PI; then
    info "skipping Pi installation (--skip-pi)"
  else
    install_pi
  fi

  if $SKIP_REPO; then
    info "skipping repository clone/update (--skip-repo)"
    if [ ! -d "$TARGET_DIR" ]; then
      die "--skip-repo was given but $TARGET_DIR does not exist"
    fi
  else
    clone_repo
  fi

  install_agents_md

  if $SKIP_NPM; then
    info "skipping npm install (--skip-npm)"
  else
    install_dependencies
  fi

  if $DRY_RUN; then
    info "dry run finished; nothing was changed"
    return
  fi
  print_next_steps
}

main "$@"
