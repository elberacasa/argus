#!/bin/bash

# A disposable Chromium with the Argus extension loaded, for testing own lanes
# without touching the person's real browser.
#
#   test/throwaway-browser.sh start    fresh profile, extension, native host
#   test/throwaway-browser.sh stop     stop exactly that browser, nothing else
#
# Every start uses a brand-new profile directory. A reused profile served stale
# extension code: Chromium cached the extension's service worker under an
# unchanged version, and a relaunch on a locked profile silently handed off to
# the old instance instead of starting a new one.
#
# Stopping never matches by process name or by a pattern that could match the
# shell running this script: the browser is identified by reading /proc for a
# chromium on this exact profile that leads its own session (it was started with
# setsid), and that session is what gets stopped.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
ROOT=$PWD
STATE=${XDG_RUNTIME_DIR:-/tmp}/argus
WORK=${ARGUS_THROWAWAY_DIR:-$STATE/throwaway}
# Its own bridge socket, passed to the native host through the browser's
# environment. The person's real browser keeps $STATE/bridge.sock untouched.
SOCK=$WORK/bridge.sock
mkdir -p "$WORK"

extension_id() {
  # The ID Chromium derives from the manifest's public key: sha256 of the DER
  # key, first 32 hex digits, each mapped 0-f -> a-p.
  jq -r .key extension/manifest.json | base64 -d | sha256sum | cut -c1-32 | tr '0-9a-f' 'a-p'
}

leader_of() { # <profile-dir>: pid of the browser leading its own session on that profile
  local d p cmd
  for d in /proc/[0-9]*; do
    p=${d#/proc/}
    [[ $(cat "$d/comm" 2>/dev/null) == chromium ]] || continue
    cmd=$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null)
    [[ $cmd == *"--user-data-dir=$1 "* && $cmd != *"--type="* ]] || continue
    [[ $(ps -o sid= -p "$p" | tr -d ' ') == "$p" ]] && { echo "$p"; return 0; }
  done
  return 1
}

stop() {
  local prof pid
  prof=$(cat "$WORK/current" 2>/dev/null) || return 0
  if pid=$(leader_of "$prof"); then
    pkill -TERM -s "$pid"
    for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    kill -0 "$pid" 2>/dev/null && pkill -KILL -s "$pid"
  fi
  rm -rf "$prof" "$WORK/current"
  echo "throwaway browser stopped"
}

start() {
  stop >/dev/null
  local prof id
  prof=$(mktemp -d "$WORK/profile-XXXX")
  id=$(extension_id)
  mkdir -p "$prof/NativeMessagingHosts"
  jq -n --arg p "$ROOT/bin/argus-bridge-host" --arg id "$id" \
    '{name:"com.omarchy.argus", description:"Argus bridge host", path:$p, type:"stdio",
      allowed_origins:["chrome-extension://\($id)/"]}' > "$prof/NativeMessagingHosts/com.omarchy.argus.json"
  echo "$prof" > "$WORK/current"
  rm -f "$SOCK"
  ARGUS_BRIDGE_SOCK=$SOCK setsid chromium --headless=new --user-data-dir="$prof" --load-extension="$ROOT/extension" \
    --no-first-run --disable-gpu about:blank >"$WORK/chromium.log" 2>&1 </dev/null &
  disown
  for _ in $(seq 1 100); do
    [[ -S $SOCK ]] && printf '{"op":"hello"}\n' | socat -t 5 - "UNIX-CONNECT:$SOCK" 2>/dev/null | grep -q '"ok":true' && {
      echo "throwaway browser up (extension $id, profile $prof)"; return 0; }
    sleep 0.1
  done
  echo "throwaway browser did not connect; see $WORK/chromium.log" >&2
  return 1
}

case ${1:-} in
  start) start ;;
  stop)  stop ;;
  *) echo "usage: test/throwaway-browser.sh start|stop" >&2; exit 1 ;;
esac
