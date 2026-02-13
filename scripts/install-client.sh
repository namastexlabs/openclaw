#!/usr/bin/env bash
# Namastex OpenClaw — Client-only installer (Linux + macOS)
# Installs the CLI binary only. No gateway, no systemd, no LaunchAgent.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/namastexlabs/openclaw/feat/client-build/scripts/install-client.sh | bash
#
# Modes:
#   --from-source    Clone repo + build locally (needs Bun + git)
#   (default)        Download pre-built artifact (needs only Node.js)
#
set -euo pipefail

REPO_URL="https://github.com/namastexlabs/openclaw.git"
REPO_BRANCH="feat/client-build"
NODE_VERSION="v24.13.1"
ARTIFACT_BRANCH="feat/client-build"
ARTIFACT_PATH="dist-client/entry-client.js"
WRAPPER_ENTRY="openclaw-client.mjs"

NVM_INSTALL_URL="https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh"
BUN_INSTALL_URL="https://bun.sh/install"

RAW_BASE="https://raw.githubusercontent.com/namastexlabs/openclaw"

FROM_SOURCE=0
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
  --from-source     Clone repo + build (needs Bun + git)
  --force-build     Force rebuild (source mode only)
  --install-dir DIR Override install directory
  --bin-dir DIR     Override binary directory
  --help, -h        Show this help

Default mode (pre-built):
  Downloads only Node.js + the pre-built client JS file (~134KB).
  No git, Bun, or build tooling required.

Source mode (--from-source):
  Clones the full repo, installs Bun, runs build:client.
  Use if you need to modify the source.

Defaults:
  Install: ~/.local/share/openclaw
  Binary:  ~/.local/bin/openclaw
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --from-source)   FROM_SOURCE=1 ;;
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

  if [[ ${FROM_SOURCE} -eq 1 ]]; then
    [[ -z "${INSTALL_DIR}" ]] && INSTALL_DIR="${HOME}/.local/share/openclaw/repo"
  else
    [[ -z "${INSTALL_DIR}" ]] && INSTALL_DIR="${HOME}/.local/share/openclaw"
  fi
  [[ -z "${BIN_DIR}" ]] && BIN_DIR="${HOME}/.local/bin"
}

ensure_nvm() {
  log_section "[1/3] nvm + Node ${NODE_VERSION}"
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

# ─── Pre-built mode ───────────────────────────────────────────────

download_artifact() {
  log_section "[2/3] Download client artifact"

  mkdir -p "${INSTALL_DIR}/dist-client"

  local entry_url="${RAW_BASE}/${ARTIFACT_BRANCH}/${ARTIFACT_PATH}"
  local pkg_url="${RAW_BASE}/${ARTIFACT_BRANCH}/dist-client/package.json"
  local dest_entry="${INSTALL_DIR}/dist-client/entry-client.js"
  local dest_pkg="${INSTALL_DIR}/dist-client/package.json"

  # Check if already up to date (simple size check)
  if [[ -f "${dest_entry}" && ${FORCE_BUILD} -eq 0 ]]; then
    local remote_size
    remote_size=$(curl -fsSI "${entry_url}" 2>/dev/null | grep -i content-length | tail -1 | tr -dc '0-9' || echo "0")
    local local_size
    local_size=$(wc -c < "${dest_entry}" 2>/dev/null | tr -dc '0-9' || echo "0")
    if [[ "${remote_size}" -gt 0 && "${remote_size}" == "${local_size}" ]]; then
      log_ok "Client artifact up to date (${local_size} bytes)"
      # Still ensure deps are installed
      if [[ ! -d "${INSTALL_DIR}/dist-client/node_modules" ]]; then
        log_info "Installing dependencies..."
        (cd "${INSTALL_DIR}/dist-client" && npm install --production --no-fund --no-audit 2>&1 | tail -1)
        log_ok "Dependencies installed"
      fi
      return
    fi
  fi

  log_info "Downloading entry-client.js..."
  curl -fsSL "${entry_url}" -o "${dest_entry}" || die "Failed to download ${entry_url}"
  local size
  size=$(wc -c < "${dest_entry}" | tr -dc '0-9')
  log_ok "entry-client.js downloaded (${size} bytes)"

  log_info "Downloading package.json..."
  curl -fsSL "${pkg_url}" -o "${dest_pkg}" || die "Failed to download ${pkg_url}"
  log_ok "package.json downloaded"

  log_info "Installing dependencies (npm)..."
  (cd "${INSTALL_DIR}/dist-client" && npm install --production --no-fund --no-audit 2>&1 | tail -3)
  log_ok "Dependencies installed"
}

# ─── Source mode ──────────────────────────────────────────────────

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

build_source() {
  log_section "[4/5] Build (client-only)"

  log_info "bun install..."
  (cd "${INSTALL_DIR}" && bun install)

  if [[ ${FORCE_BUILD} -eq 0 && ${REPO_UPDATED} -eq 0 ]]; then
    if [[ -f "${INSTALL_DIR}/dist-client/entry-client.js" && "${INSTALL_DIR}/dist-client/entry-client.js" -nt "${INSTALL_DIR}/package.json" ]]; then
      log_ok "Client build artifacts current; skipping"
      return
    fi
  fi

  log_info "bun run build:client..."
  (cd "${INSTALL_DIR}" && bun run build:client)
  log_ok "Client build complete"
}

# ─── Shared ───────────────────────────────────────────────────────

install_wrapper() {
  local step_label="[3/3] Wrapper"
  [[ ${FROM_SOURCE} -eq 1 ]] && step_label="[5/5] Wrapper"
  log_section "${step_label}"

  mkdir -p "${BIN_DIR}"

  local node_bin="${HOME}/.nvm/versions/node/${NODE_VERSION}/bin/node"
  [[ -x "${node_bin}" ]] || die "Node binary not found: ${node_bin}"

  local entry_js="${INSTALL_DIR}/dist-client/entry-client.js"
  [[ -f "${entry_js}" ]] || die "Client entry not found: ${entry_js}"

  local wrapper_path="${BIN_DIR}/openclaw"

  # Remove stale symlinks
  [[ -L "${wrapper_path}" ]] && rm -f "${wrapper_path}"

  cat > "${wrapper_path}" << WRAPPER
#!/bin/bash
exec "${node_bin}" "${entry_js}" "\$@"
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
  echo -e "${MUTED}Install:${NC}  ${INSTALL_DIR}"
  [[ ${FROM_SOURCE} -eq 1 ]] && echo -e "${MUTED}Branch:${NC}   ${REPO_BRANCH}"
  echo -e "${MUTED}Mode:${NC}     $([ ${FROM_SOURCE} -eq 1 ] && echo 'source' || echo 'pre-built')"
  echo -e "${MUTED}Tip:${NC}      Open a new shell or: source ${shell_rc}"
}

main() {
  parse_args "$@"
  [[ ${SHOW_HELP} -eq 1 ]] && usage && exit 0

  detect_platform
  log_info "Platform: ${PLATFORM}"
  log_info "Install dir: ${INSTALL_DIR}"
  log_info "Binary dir: ${BIN_DIR}"
  log_info "Mode: $([ ${FROM_SOURCE} -eq 1 ] && echo 'source (clone + build)' || echo 'pre-built (download only)')"

  ensure_nvm

  if [[ ${FROM_SOURCE} -eq 1 ]]; then
    ensure_bun
    sync_repo
    build_source
  else
    download_artifact
  fi

  install_wrapper
}

main "$@"
