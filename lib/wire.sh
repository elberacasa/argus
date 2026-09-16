# argus wire -- transport to a browser.
#
# Two transports implement one interface: cdp, js_exec, nav, current_url,
# set_files, session_open, session_drop. Everything above this file speaks only
# that interface.
#
#   chromedriver  headless and desk lanes: browsers argus launches. chromedriver
#                 ships inside the chromium package and speaks WebDriver over
#                 plain HTTP, with a passthrough for raw CDP.
#   bridge        own lanes (--own): tabs in the person's own Chromium, with
#                 their logins, through the Argus extension (lib/bridge.sh).

ARGUS_ROOT=${ARGUS_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
ARGUS_PORT=${ARGUS_PORT:-9515}
ARGUS_LANE=${ARGUS_LANE:-0}
ARGUS_STATE=${XDG_RUNTIME_DIR:-/tmp}/argus
ARGUS_BASE=http://127.0.0.1:$ARGUS_PORT
mkdir -p "$ARGUS_STATE"

# One chromedriver serves the whole machine; every lane is a session on it. That
# is what makes the pool a system resource rather than a per-project one.
driver_up() {
  curl -sf --max-time 1 "$ARGUS_BASE/status" >/dev/null 2>&1 && return 0
  # setsid makes the driver the leader of a session of its own. Every browser it
  # launches inherits that session, which is how shutdown can find exactly
  # argus's processes -- and nothing else on the machine -- later.
  setsid chromedriver --port="$ARGUS_PORT" --silent >/dev/null 2>&1 </dev/null &
  disown
  for _ in $(seq 1 60); do
    curl -sf --max-time 1 "$ARGUS_BASE/status" >/dev/null 2>&1 && return 0
    sleep 0.1
  done
  echo "argus: chromedriver did not start on port $ARGUS_PORT" >&2
  return 1
}

# The chromedriver actually listening on argus's port, by socket, not by name.
driver_pid() { ss -ltnpH "sport = :$ARGUS_PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2; }

# Stop argus's driver and every browser it started, and nothing else.
#
# Never match processes by name here. `pkill chromium` also kills the person's
# own browser -- with their tabs, and with any extension driving it -- which is
# exactly what an earlier cleanup did, repeatedly. Ownership is established two
# ways, and a process must pass one of them:
#   - it lives in the driver's own session, when the driver is a session leader
#     (argus started it through setsid; a driver someone ran from their terminal
#     shares that terminal's session and is left alone);
#   - it is a browser on chromedriver's throwaway profile under /tmp whose
#     session leader is gone -- a straggler from a driver that already died.
driver_shutdown() {
  local pid sid p leader
  pid=$(driver_pid)
  if [[ -n $pid && $(cat "/proc/$pid/comm" 2>/dev/null) == chromedriver ]]; then
    sid=$(ps -o sid= -p "$pid" | tr -d ' ')
    kill "$pid" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    if [[ -n $sid && $sid == "$pid" ]]; then
      pkill -TERM -s "$sid" 2>/dev/null
    fi
  fi
  for p in $(pgrep -x chromium 2>/dev/null); do
    tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | grep -q -- '--user-data-dir=/tmp/.org.chromium.Chromium.' || continue
    leader=$(ps -o sid= -p "$p" | tr -d ' ')
    [[ -n $leader ]] && kill -0 "$leader" 2>/dev/null && continue
    kill "$p" 2>/dev/null
  done
  return 0
}

wd()      { curl -s -X "$1" "$ARGUS_BASE/session/$SID$2" ${3:+-H 'Content-Type: application/json' -d "$3"}; }
wd_post() { wd POST "$1" "$2"; }
wd_get()  { wd GET  "$1"; }

own() { [[ ${ARGUS_OWN:-0} == 1 ]]; }

# ---- the transport interface ------------------------------------------------------
# Decided per call, because flags are parsed after this file is sourced.

# Raw CDP. chromedriver tunnels any Chrome DevTools Protocol command over the
# same HTTP session, which is how argus reaches the parts WebDriver never exposed.
cdp() { # <method> [params] [timeout-seconds: honoured by the bridge only]
  if own; then own_cdp "$@"; return; fi
  local params=${2:-'{}'}
  wd_post /goog/cdp/execute "$(jq -nc --arg c "$1" --argjson p "$params" '{cmd:$c,params:$p}')"
}

# Run a script body with `arguments` bound; prints the value it returns as JSON.
js_exec() { # <script-body> <args-json>
  if own; then own_js_exec "$@"; return; fi
  wd_post /execute/sync "$(jq -nc --arg s "$1" --argjson a "${2:-[]}" '{script:$s,args:$a}')" | jq -c '.value'
}

nav() {
  if own; then own_nav "$@"; return; fi
  wd_post /url "$(jq -nc --arg u "$1" '{url:$u}')" >/dev/null
}

current_url() {
  if own; then own_current_url; return; fi
  wd_get /url | jq -r '.value // ""'
}

# Put files on the input tagged data-argus-upload=<token>. Hidden inputs work.
set_files() { # <token> <path>...
  if own; then own_set_files "$@"; return; fi
  local token=$1; shift
  local found eid res
  # Take the W3C element key by name. Reading "the first value" also accepts an
  # error object, and then "no such element" becomes the element id.
  found=$(wd_post /element "$(jq -nc --arg v "[data-argus-upload=\"$token\"]" '{using:"css selector",value:$v}')")
  eid=$(jq -r '.value["element-6066-11e4-a52e-4f735466cecf"] // empty' <<<"$found")
  [[ -z $eid ]] && { echo "argus: could not address the file input: $(jq -r '.value.error // "unknown"' <<<"$found")" >&2; return 1; }
  res=$(wd_post "/element/$eid/value" "$(printf '%s\n' "$@" | jq -Rsc '{text: rtrimstr("\n")}')")
  if [[ $(jq -r '.value.error // empty' <<<"$res") != "" ]]; then
    echo "argus: upload failed: $(jq -r '.value.message // .value.error' <<<"$res" | head -1)" >&2; return 1
  fi
  return 0
}

session_open() { if own; then own_session_open; else pool_session_open; fi; }
session_drop() { if own; then own_session_drop; else pool_session_drop; fi; }

# Run a lib/*.js file in the page. Passed through --rawfile so quoting in the
# script never has to survive a shell round trip.
js() {
  local file=$1; shift
  # Small integers (a candidate index) travel as numbers; anything longer stays a
  # string. A JS number cannot hold a 19-digit value exactly, so coercing a
  # nanosecond token silently rounded it and broke an attribute lookup.
  local args; args=$(printf '%s\n' "$@" | jq -R . | jq -sc 'map(if test("^-?[0-9]{1,9}$") then tonumber else . end)')
  [[ $# -eq 0 ]] && args='[]'
  js_exec "$(cat "$ARGUS_ROOT/lib/$file")" "$args"
}

session_new() {
  local args='"--headless=new","--disable-gpu","--disable-dev-shm-usage","--no-first-run","--disable-extensions","--window-size=1280,800"'
  [[ ${ARGUS_IMAGES:-0} == 1 ]] || args+=',"--blink-settings=imagesEnabled=false"'
  if [[ ${ARGUS_DESK:-0} == 1 ]]; then
    # A real window someone may watch: GPU on, images on, and the class the
    # compositor rule routes to the invisible desk before the window maps.
    args='"--ozone-platform=wayland","--class=argus-desk","--no-first-run","--disable-extensions","--window-size=1280,800"'
  elif [[ ${ARGUS_HEADFUL:-0} == 1 ]]; then
    args=${args//\"--headless=new\",/}
  fi
  curl -s -X POST "$ARGUS_BASE/session" -H 'Content-Type: application/json' -d "{
    \"capabilities\":{\"alwaysMatch\":{\"browserName\":\"chrome\",\"goog:chromeOptions\":{
      \"binary\":\"/usr/bin/chromium\",\"args\":[$args],
      \"excludeSwitches\":[\"enable-automation\"]}}}}" | jq -r '.value.sessionId // empty'
}

# The probe must be installed with Page.addScriptToEvaluateOnNewDocument rather
# than executed after load: it has to be in place before page scripts run, or it
# misses the console errors thrown during parse -- exactly the ones worth seeing.
# Downloads go to a directory per pool slot rather than ~/Downloads: a desk
# browser is a real Chromium and would otherwise write into the user's own
# folder. Browser-wide, so it is per session, which is per slot.
downloads_dir() {
  # In the person's own browser, downloads go where they always go. Redirecting
  # them would change the browser's behaviour for everything else they do.
  if own; then xdg-user-dir DOWNLOAD 2>/dev/null || printf '%s/Downloads' "$HOME"; return; fi
  printf '%s/downloads/%s' "$ARGUS_STATE" "$(basename "$(pool_dir)")-$(pool_session_index)"
}

probe_install() {
  cdp Page.enable >/dev/null
  # Belt and braces with the probe: even a picker the page opens some way the
  # probe does not wrap is intercepted by the browser instead of the portal.
  cdp Page.setInterceptFileChooserDialog '{"enabled":true}' >/dev/null
  if ! own; then
    mkdir -p "$(downloads_dir)"
    cdp Browser.setDownloadBehavior "$(jq -nc --arg d "$(downloads_dir)" '{behavior:"allow",downloadPath:$d}')" >/dev/null
  fi
  cdp Page.addScriptToEvaluateOnNewDocument \
    "$(jq -nc --rawfile s "$ARGUS_ROOT/lib/probe.js" '{source:$s}')" >/dev/null
}

# Lanes are tabs in a shared pool of browsers; pool.sh owns session_open,
# session_drop and the locking that keeps lanes on one session from colliding.
source "$ARGUS_ROOT/lib/pool.sh"
source "$ARGUS_ROOT/lib/desk.sh"
source "$ARGUS_ROOT/lib/eyes.sh"
source "$ARGUS_ROOT/lib/bridge.sh"

# The probe is re-installed on every navigation by CDP, but a session that was
# already warm when argus upgraded needs a nudge.
probe_ready() {
  [[ $(js_raw 'return typeof window.__argus') == '"object"' ]] && return 0
  js_exec "$(cat "$ARGUS_ROOT/lib/probe.js")" '[]' >/dev/null
  probe_install
}
js_raw() { js_exec "$1" '[]'; }
