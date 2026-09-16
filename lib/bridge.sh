# argus bridge transport -- the person's own Chromium, through the Argus extension.
#
# Headless and desk lanes are browsers argus launches through chromedriver.
# An own lane is a tab in the browser the person already uses, with their
# logins, reached through the Argus extension and its native host -- no
# remote-debugging port. See extension/background.js for the scoping rules.
#
# This file implements the same transport interface wire.sh defines for
# chromedriver: cdp, js_exec, nav, current_url, set_files, session_open,
# session_drop. Callers never know which one they are talking to.

ARGUS_BRIDGE_SOCK=${ARGUS_BRIDGE_SOCK:-$ARGUS_STATE/bridge.sock}

# One request per connection: a JSON line in, a JSON line out.
bridge_call() {
  if [[ ! -S $ARGUS_BRIDGE_SOCK ]]; then
    echo '{"ok":false,"error":"the Argus extension is not connected: is Chromium running with it installed? (argus own status)"}'
    return 1
  fi
  local out
  out=$(printf '%s\n' "$1" | socat -t 70 - "UNIX-CONNECT:$ARGUS_BRIDGE_SOCK" 2>/dev/null)
  [[ -z $out ]] && out='{"ok":false,"error":"no answer from the Argus bridge"}'
  printf '%s' "$out"
}

bridge_live() { [[ -S $ARGUS_BRIDGE_SOCK ]] && [[ $(bridge_call '{"op":"hello"}' | jq -r '.ok' 2>/dev/null) == true ]]; }

# Same shape chromedriver's CDP passthrough returns -- {"value": ...}, with
# failures as {"value": {"error", "message"}} -- so every caller reads one form.
own_cdp() { # <method> [params] [timeout-seconds]
  local params=${2:-'{}'} timeout=${3:-60}
  bridge_call "$(jq -nc --arg l "$ARGUS_LANE" --arg m "$1" --argjson p "$params" --argjson t "$timeout" '{op:"cdp",lane:$l,method:$m,params:$p,timeout:$t}')" \
    | jq -c 'if .ok then {value: .result} else {value: {error: "bridge", message: .error}} end'
}

# WebDriver runs a script as a function body with `arguments` bound, and awaits
# a returned promise. Runtime.evaluate is given the same contract, so every
# lib/*.js file runs unchanged over either transport.
own_js_exec() { # <script-body> <args-json>
  local expr
  expr=$(jq -nr --arg body "$1" --argjson args "${2:-[]}" '"(async function () {\n" + $body + "\n}).apply(null, " + ($args|tojson) + ")"')
  own_cdp Runtime.evaluate "$(jq -nc --arg e "$expr" '{expression:$e, awaitPromise:true, returnByValue:true, userGesture:true}')" \
    | jq -c '.value as $v
             | if ($v|type) == "object" and $v.error then $v
               elif $v.exceptionDetails then {error: "javascript error", message: ($v.exceptionDetails.exception.description // $v.exceptionDetails.text)}
               # not `// null`: jq treats false as missing, and a script may return false
               elif ($v.result|type) == "object" and ($v.result|has("value")) then $v.result.value
               else null end'
}

# Page.navigate returns once navigation starts. Load is detected by marking the
# current document and waiting for a *different* document to finish loading --
# checking readyState alone would read the old page's "complete".
own_nav() {
  local url=$1 token res loader state _
  token="argus-nav-$(date +%s%N)"
  own_js_exec "window.__argusNav = $(jq -nc --arg t "$token" '$t'); return 1" '[]' >/dev/null
  res=$(own_cdp Page.navigate "$(jq -nc --arg u "$url" '{url:$u}')")
  if [[ -n $(jq -r '.value.errorText // empty' <<<"$res") ]]; then
    echo "argus: navigation failed: $(jq -r '.value.errorText' <<<"$res")" >&2; return 1
  fi
  loader=$(jq -r '.value.loaderId // empty' <<<"$res")
  [[ -z $loader ]] && return 0          # same-document navigation: nothing to wait for
  for _ in $(seq 1 300); do
    state=$(own_js_exec "return (window.__argusNav === $(jq -nc --arg t "$token" '$t') ? 'old' : document.readyState)" '[]' 2>/dev/null)
    [[ $state == '"complete"' ]] && return 0
    sleep 0.1
  done
  echo "argus: page did not finish loading within 30s" >&2
  return 0
}

own_current_url() { own_js_exec 'return location.href' '[]' | jq -r '. // ""'; }

own_set_files() { # <token> <path>...
  local token=$1; shift
  local root node files res
  root=$(own_cdp DOM.getDocument '{"depth":0}' | jq -r '.value.root.nodeId // empty')
  node=$(own_cdp DOM.querySelector "$(jq -nc --argjson r "${root:-0}" --arg s "[data-argus-upload=\"$token\"]" '{nodeId:$r,selector:$s}')" \
         | jq -r '.value.nodeId // empty')
  [[ -z $node || $node == 0 ]] && { echo "argus: could not address the file input" >&2; return 1; }
  files=$(printf '%s\n' "$@" | jq -R . | jq -sc .)
  res=$(own_cdp DOM.setFileInputFiles "$(jq -nc --argjson f "$files" --argjson n "$node" '{files:$f,nodeId:$n}')")
  [[ -n $(jq -r '.value.error // empty' <<<"$res") ]] && { echo "argus: upload failed: $(jq -r '.value.message' <<<"$res")" >&2; return 1; }
  return 0
}

own_session_open() {
  local res
  res=$(bridge_call "$(jq -nc --arg l "$ARGUS_LANE" '{op:"lane_open",lane:$l}')")
  if [[ $(jq -r '.ok' <<<"$res" 2>/dev/null) != true ]]; then
    echo "argus: $(jq -r '.error // "bridge unavailable"' <<<"$res" 2>/dev/null)" >&2
    return 1
  fi
  # A fresh debugger session has none of argus's registered scripts.
  [[ $(jq -r '.result.fresh' <<<"$res") == true ]] && probe_install
  return 0
}

own_session_drop() { bridge_call "$(jq -nc --arg l "$ARGUS_LANE" '{op:"lane_close",lane:$l}')" >/dev/null; }

# Close every argus tab in the person's browser. The browser itself, and every
# tab argus did not open, are never touched.
own_shutdown() {
  bridge_live || return 0
  local lane
  for lane in $(bridge_call '{"op":"lanes"}' | jq -r '.result // {} | keys[]'); do
    bridge_call "$(jq -nc --arg l "$lane" '{op:"lane_close",lane:$l}')" >/dev/null
  done
}
