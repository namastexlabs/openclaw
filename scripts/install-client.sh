#!/usr/bin/env bash
# Namastex OpenClaw — Client-only installer (Linux + macOS)
# Installs the CLI binary only. No gateway, no systemd, no LaunchAgent.
# Usage: curl -fsSL https://raw.githubusercontent.com/namastexlabs/openclaw/namastex/main/scripts/install-client.sh | bash
set -euo pipefail

REPO_URL="https://github.com/namastexlabs/openclaw.git"
REPO_BRANCH="namastex/main"
NODE_VERSION="v24.13.1"

NVM_INSTALL_URL="https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh"
BUN_INSTALL_URL="https://bun.sh/install"

FORCE_BUILD=0
SHOW_HELP=0
INSTALL_DIR=""
BIN_DIR=""
REPO_UPDATED=1

BOLD='\033[1m'
ACCENT='\033[38;2;255;77;77m'
SUCCESS='\033[38;2;0;229;204m'
WARN='\033[38;2;255;176;32m'
ERROR='\033[38;2;230;57;70m'
MUTED='\033[38;2;90;100;128m'
NC='\033[0m'

log_section() { echo; echo -e "${ACCENT}${BOLD}$*${NC}"; }
log_info()    { echo -e "${MUTED}·${NC} $*"; }
log_ok()      { echo -e "${SUCCESS}✓${NC} $*"; }
log_warn()    { echo -e "${WARN}!${NC} $*"; }
log_err()     { echo -e "${ERROR}✗${NC} $*" >&2; }
die()         { log_err "$*"; exit 1; }

on_err() {
  local code=$?
  log_err "Installer failed at line ${BASH_LINENO[0]} (exit ${code})."
  exit "${code}"
}
trap on_err ERR

usage() {
  cat <<'EOF'
Namastex OpenClaw — Client-only installer (Linux + macOS)

Usage:
  bash install-client.sh [options]

Options:
  --force-build     Force build even if up-to-date
  --install-dir DIR Override install directory
  --bin-dir DIR     Override binary directory
  --help, -h        Show this help

Installs:
  - nvm + Node v24.13.1 (if missing)
  - Bun (if missing)
  - OpenClaw fork (namastex/main) — CLI only, no gateway/service
  - Wrapper script in PATH

Defaults:
  Linux:  ~/.local/share/openclaw/repo  →  ~/.local/bin/openclaw
  macOS:  ~/.local/share/openclaw/repo  →  ~/.local/bin/openclaw
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --force-build)   FORCE_BUILD=1 ;;
      --install-dir)   shift; INSTALL_DIR="${1:?--install-dir requires a path}" ;;
      --bin-dir)       shift; BIN_DIR="${1:?--bin-dir requires a path}" ;;
      --help|-h)       SHOW_HELP=1 ;;
      *)               die "Unknown option: $1 (use --help)" ;;
    esac
    shift
  done
}

detect_platform() {
  OS="$(uname -s)"
  case "${OS}" in
    Linux)  PLATFORM="linux" ;;
    Darwin) PLATFORM="macos" ;;
    *)      die "Unsupported OS: ${OS}" ;;
  esac

  [[ -z "${INSTALL_DIR}" ]] && INSTALL_DIR="${HOME}/.local/share/openclaw/repo"
  [[ -z "${BIN_DIR}" ]] && BIN_DIR="${HOME}/.local/bin"
}

ensure_nvm() {
  log_section "[1/5] nvm + Node ${NODE_VERSION}"
  local nvm_dir="${HOME}/.nvm"

  if [[ -s "${nvm_dir}/nvm.sh" ]]; then
    log_ok "nvm found"
  else
    log_info "Installing nvm..."
    curl -fsSL "${NVM_INSTALL_URL}" | bash
    [[ -s "${nvm_dir}/nvm.sh" ]] || die "nvm install failed"
    log_ok "nvm installed"
  fi

  # shellcheck disable=SC1091
  export NVM_DIR="${nvm_dir}"
  source "${nvm_dir}/nvm.sh"

  if nvm which "${NODE_VERSION}" >/dev/null 2>&1; then
    log_ok "Node ${NODE_VERSION} already installed"
  else
    log_info "Installing Node ${NODE_VERSION}..."
    nvm install "${NODE_VERSION}"
  fi

  nvm use "${NODE_VERSION}" >/dev/null
  nvm alias default "${NODE_VERSION}" >/dev/null 2>&1 || true
  log_ok "Node $(node -v) active"
}

ensure_bun() {
  log_section "[2/5] Bun"
  export PATH="${HOME}/.bun/bin:${PATH}"

  if command -v bun >/dev/null 2>&1; then
    log_ok "Bun $(bun --version) found"
  else
    log_info "Installing Bun..."
    curl -fsSL "${BUN_INSTALL_URL}" | bash
    export PATH="${HOME}/.bun/bin:${PATH}"
    command -v bun >/dev/null 2>&1 || die "Bun install failed"
    log_ok "Bun $(bun --version) installed"
  fi
}

sync_repo() {
  log_section "[3/5] Repository"

  if [[ ! -d "${INSTALL_DIR}" ]]; then
    log_info "Cloning ${REPO_URL} (${REPO_BRANCH})..."
    mkdir -p "$(dirname "${INSTALL_DIR}")"
    git clone --branch "${REPO_BRANCH}" "${REPO_URL}" "${INSTALL_DIR}"
    REPO_UPDATED=1
    log_ok "Cloned"
    return
  fi

  [[ -d "${INSTALL_DIR}/.git" ]] || die "${INSTALL_DIR} exists but is not a git repo"

  if [[ -n "$(cd "${INSTALL_DIR}" && git status --porcelain)" ]]; then
    log_warn "Local changes detected; skipping pull"
    REPO_UPDATED=1
    return
  fi

  log_info "Fetching updates..."
  (cd "${INSTALL_DIR}" && git remote set-url origin "${REPO_URL}")
  (cd "${INSTALL_DIR}" && git fetch origin "${REPO_BRANCH}")

  local local_head remote_head
  local_head="$(cd "${INSTALL_DIR}" && git rev-parse HEAD)"
  remote_head="$(cd "${INSTALL_DIR}" && git rev-parse "origin/${REPO_BRANCH}")"

  if [[ "${local_head}" == "${remote_head}" ]]; then
    REPO_UPDATED=0
    log_ok "Already up to date (${local_head:0:10})"
    return
  fi

  (cd "${INSTALL_DIR}" && git checkout -B "${REPO_BRANCH}" "origin/${REPO_BRANCH}")
  (cd "${INSTALL_DIR}" && git pull --ff-only origin "${REPO_BRANCH}")
  REPO_UPDATED=1
  log_ok "Updated to $(cd "${INSTALL_DIR}" && git rev-parse --short HEAD)"
}

build() {
  log_section "[4/5] Build"

  log_info "bun install..."
  (cd "${INSTALL_DIR}" && bun install)

  if [[ ${FORCE_BUILD} -eq 0 && ${REPO_UPDATED} -eq 0 ]]; then
    if [[ -f "${INSTALL_DIR}/dist/index.js" && "${INSTALL_DIR}/dist/index.js" -nt "${INSTALL_DIR}/package.json" ]]; then
      log_ok "Build artifacts current; skipping"
      return
    fi
  fi

  log_info "bun run build..."
  (cd "${INSTALL_DIR}" && bun run build)
  log_ok "Build complete"
}

install_wrapper() {
  log_section "[5/5] Wrapper"
  mkdir -p "${BIN_DIR}"

  local node_bin="${HOME}/.nvm/versions/node/${NODE_VERSION}/bin/node"
  [[ -x "${node_bin}" ]] || die "Node binary not found: ${node_bin}"

  local wrapper_path="${BIN_DIR}/openclaw"

  # Remove stale symlinks (prevent writing through to dist/index.js)
  [[ -L "${wrapper_path}" ]] && rm -f "${wrapper_path}"

  cat > "${wrapper_path}" << WRAPPER
#!/bin/bash
exec "${node_bin}" "${INSTALL_DIR}/dist/index.js" "\$@"
WRAPPER
  chmod +x "${wrapper_path}"
  log_ok "Wrapper: ${wrapper_path}"

  # Ensure BIN_DIR is in PATH
  local shell_rc
  if [[ "${PLATFORM}" == "macos" ]]; then
    shell_rc="${HOME}/.zshrc"
  else
    shell_rc="${HOME}/.bashrc"
  fi

  if ! grep -Fq "${BIN_DIR}" "${shell_rc}" 2>/dev/null; then
    echo "export PATH=\"${BIN_DIR}:\$PATH\"" >> "${shell_rc}"
    log_ok "Added ${BIN_DIR} to ${shell_rc}"
  fi

  # Cleanup: remove npm-global openclaw if present
  if command -v npm >/dev/null 2>&1 && npm list -g --depth=0 openclaw >/dev/null 2>&1; then
    log_warn "Removing npm-global openclaw..."
    npm uninstall -g openclaw 2>/dev/null || true
    log_ok "npm-global openclaw removed"
  fi

  # Verify
  local version
  version="$("${wrapper_path}" --version 2>/dev/null || echo "unknown")"
  echo
  echo -e "${SUCCESS}${BOLD}OpenClaw client installed.${NC}"
  echo -e "${MUTED}Version:${NC}  ${version}"
  echo -e "${MUTED}Binary:${NC}   ${wrapper_path}"
  echo -e "${MUTED}Repo:${NC}     ${INSTALL_DIR}"
  echo -e "${MUTED}Branch:${NC}   ${REPO_BRANCH}"
  echo -e "${MUTED}Tip:${NC}      Open a new shell or: source ${shell_rc}"
}

main() {
  parse_args "$@"
  [[ ${SHOW_HELP} -eq 1 ]] && usage && exit 0

  detect_platform
  log_info "Platform: ${PLATFORM}"
  log_info "Install dir: ${INSTALL_DIR}"
  log_info "Binary dir: ${BIN_DIR}"

  ensure_nvm
  ensure_bun
  sync_repo
  build
  install_wrapper
}

main "$@"
