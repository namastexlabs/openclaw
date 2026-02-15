#!/usr/bin/env bash
set -euo pipefail

# Fleet preflight (read-only): detect OpenClaw drift and gateway health per host.
# Intended to be run via Jenkins and piped over SSH to each host.
#
# Checks:
# - which openclaw + resolved path
# - openclaw --version
# - /opt/genie/openclaw version (if present)
# - openclaw-gateway systemd --user status + port 18789 listening
#
# Exit codes:
# 0: OK
# 10: drift detected (path mismatch, version mismatch, missing wrapper)
# 20: gateway health issue

HOST_LABEL="${1:-unknown}"
EXPECTED_WRAPPER="/opt/genie/bin/openclaw"
EXPECTED_PORT="18789"

red=$'\033[31m'; grn=$'\033[32m'; ylw=$'\033[33m'; blu=$'\033[34m'; nc=$'\033[0m'

say() { echo "$*"; }
kv() { printf '%-14s %s\n' "$1" "$2"; }

rc_drift=0
rc_health=0

say "--- preflight:${HOST_LABEL} ---"
kv user "$(id -un 2>/dev/null || echo '?')"
kv host "$(hostname 2>/dev/null || echo '?')"

oc_path="$(command -v openclaw 2>/dev/null || true)"
if [[ -z "$oc_path" ]]; then
  kv openclaw "MISSING"
  rc_drift=10
else
  oc_real="$oc_path"
  if command -v readlink >/dev/null 2>&1; then
    oc_real="$(readlink -f "$oc_path" 2>/dev/null || echo "$oc_path")"
  fi
  kv openclaw "$oc_path"
  kv openclaw_real "$oc_real"

  if [[ "$oc_path" != "$EXPECTED_WRAPPER" ]]; then
    # If wrapper exists but PATH prefers something else, still drift.
    if [[ -x "$EXPECTED_WRAPPER" ]]; then
      kv drift "PATH_PREFERS_NON_WRAPPER (expected $EXPECTED_WRAPPER)"
    else
      kv drift "WRAPPER_MISSING (expected $EXPECTED_WRAPPER)"
    fi
    rc_drift=10
  else
    kv drift "none"
  fi

  oc_ver="$($oc_path --version 2>/dev/null || true)"
  [[ -n "$oc_ver" ]] && kv openclaw_ver "$oc_ver" || { kv openclaw_ver "ERROR"; rc_drift=10; }
fi

opt_ver=""
if [[ -f /opt/genie/openclaw/package.json ]]; then
  opt_ver="$(grep -oP '"version"\s*:\s*"\K[^"]+' /opt/genie/openclaw/package.json 2>/dev/null | head -1 || true)"
fi
kv opt_openclaw_ver "${opt_ver:-n/a}"

# Version mismatch heuristic: only if both exist and differ in a clear way.
if [[ -n "${oc_ver:-}" && -n "${opt_ver:-}" ]]; then
  # oc_ver may include extra text; look for version-like token.
  oc_semver="$(echo "$oc_ver" | grep -oE '[0-9]{4}\.[0-9]+\.[0-9]+' | head -1 || true)"
  if [[ -n "$oc_semver" && "$oc_semver" != "$opt_ver" ]]; then
    kv mismatch "CLI=$oc_semver vs /opt=$opt_ver"
    rc_drift=10
  fi
fi

# Gateway health
svc_active="unknown"
if command -v systemctl >/dev/null 2>&1; then
  if systemctl --user is-active openclaw-gateway >/dev/null 2>&1; then
    svc_active="active"
  else
    svc_active="inactive"
    rc_health=20
  fi
else
  svc_active="no-systemctl"
fi
kv gateway_service "$svc_active"

port_listen="unknown"
if command -v ss >/dev/null 2>&1; then
  if ss -tln 2>/dev/null | grep -q ":${EXPECTED_PORT} "; then
    port_listen="listening"
  else
    port_listen="not_listening"
    rc_health=20
  fi
else
  port_listen="no-ss"
fi
kv gateway_port "$EXPECTED_PORT ($port_listen)"

# Summary
if [[ $rc_drift -eq 0 && $rc_health -eq 0 ]]; then
  say "result ${grn}OK${nc}"
  exit 0
fi

if [[ $rc_drift -ne 0 ]]; then
  say "result ${ylw}DRIFT${nc}"
fi
if [[ $rc_health -ne 0 ]]; then
  say "result ${red}HEALTH_FAIL${nc}"
fi

exit $(( rc_health != 0 ? rc_health : rc_drift ))
