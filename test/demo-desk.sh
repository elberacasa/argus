#!/bin/bash

# Agents at work on the invisible desk, watched from the Omarchy bar.
#
# Four agents run at once, each in its own real window on a monitor nobody
# looks at: a checkout agent that hits a covered button and recovers, a UI
# reviewer that audits the landing page at phone width, a layout checker, and
# a native GTK app in a nested desktop, driven with its own mouse and keyboard. The Argus panel opens
# in the bar with a live, view-only card for each; your focus stays where it is.
#
#   test/demo-desk.sh            paced so a person can follow it
#   DEMO_PACE=0 test/demo-desk.sh   full speed
#
# Everything it starts, it stops: its lanes, the app, the panel. Pass --keep to
# leave the windows up afterwards.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
ROOT=$PWD
A=$ROOT/bin/argus
PACE=${DEMO_PACE:-0.8}
KEEP=false; [[ ${1:-} == --keep ]] && KEEP=true
T0=$(date +%s%N)

say() { # <agent> <message>
  local msg=${2//$ROOT/}
  (( ${#msg} > 64 )) && msg="${msg:0:63}…"
  printf '\033[2m%6.2fs\033[0m  \033[1m%-9s\033[0m %s\n' "$(( ($(date +%s%N) - T0) / 1000000 ))e-3" "$1" "$msg"
}
pace() { [[ $PACE == 0 ]] || sleep "$PACE"; }
first_line() { head -1 | cut -c1-90; }

"$A" desk up >/dev/null || exit 1
# Serve the demo pages over HTTP, the way an agent meets a dev server.
PORT=${DEMO_PORT:-8765}
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$ROOT" >/dev/null 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null' EXIT
for _ in $(seq 1 30); do curl -s -o /dev/null "http://localhost:$PORT/" && break; sleep 0.1; done
URL=http://localhost:$PORT
omarchy-shell -q argus open

checkout() {
  local D="$A --desk --lane 11"
  say checkout "$($D open "$URL/test/fixture.html" 2>&1 | first_line)"; pace
  say checkout "$($D click "button:Place order" 2>&1 | grep -m1 -E 'covered|blocked|✗|clicked' | cut -c1-90)"; pace
  say checkout "$($D click "button:Accept" 2>&1 | first_line)"; pace
  say checkout "$($D type "textbox:Email address" "agent@omarchy.org" 2>&1 | first_line)"; pace
  say checkout "$($D click "button:Place order" 2>&1 | first_line)"
}

reviewer() {
  local D="$A --desk --lane 12"
  say reviewer "$($D open "$URL/site/" 2>&1 | first_line)"; pace
  say reviewer "$($D viewport 390x844 2>&1 | first_line)"; pace
  say reviewer "$($D audit 2>&1 | grep -m1 score | sed 's/^ *//')"; pace
  say reviewer "$($D viewport reset 2>&1 | first_line)"; pace
  say reviewer "$($D audit 2>&1 | grep -m1 score | sed 's/^ *//')"
}

layout() {
  local D="$A --desk --lane 13"
  say layout "$($D open "$URL/test/overflow.html" 2>&1 | first_line)"; pace
  say layout "$($D viewport 390x844 2>&1 | first_line)"; pace
  local finding
  finding=$($D audit 2>&1 | grep -m1 -oE 'Page scrolls sideways at [0-9]+px wide')
  say layout "${finding:+✗ overflow-x: ${finding,}}"
}

native() {
  local N="$A nest" app
  "$A" nest up demo >/dev/null || { say native "could not start a nest"; return 1; }
  app=$($N run demo -- python3 "$ROOT/test/fixture-app.py" argus-demo-app)
  echo "$app" > "$XDG_RUNTIME_DIR/argus/demo-app.pid"
  for _ in $(seq 1 60); do python3 "$ROOT/lib/atspi.py" find "$app" "button:Add" >/dev/null 2>&1 && break; sleep 0.1; done
  say native "GTK app in its own nested desktop, own mouse"; pace
  local n=0 item want
  for item in "Oat milk" "Sourdough" "Coffee beans"; do
    n=$((n + 1)); want="$n item$([[ $n == 1 ]] || echo s)"
    # Tick "Urgent" before focusing the entry: a click moves focus, and Enter
    # on a check box adds nothing.
    [[ $n == 2 ]] && $N click-on demo "$app" "checkbox:Urgent" >/dev/null
    $N click-on demo "$app" "text:New item" >/dev/null
    $N type demo "$item"
    $N key demo Return
    # Verified means the app's own tree shows it, not that the input was sent.
    local ok=false
    for _ in $(seq 1 40); do
      python3 "$ROOT/lib/atspi.py" json "$app" 2>/dev/null | jq -e --arg w "$want" '[.[]|select(.role=="label")|.name]|index($w)' >/dev/null && { ok=true; break; }
      sleep 0.05
    done
    if [[ $ok == true ]]; then say native "added \"$item\" with real clicks and keys: $want ✓"
    else say native "FAILED: \"$item\" not confirmed in the app"; return 1; fi
    pace
  done
}

before=$(hyprctl -j activeworkspace | jq -r .id)
pids=()
checkout & pids+=($!)
reviewer & pids+=($!)
layout & pids+=($!)
native & pids+=($!)
failed=0
for p in "${pids[@]}"; do wait "$p" || failed=$((failed + 1)); done
after=$(hyprctl -j activeworkspace | jq -r .id)
place=$([[ $before == "$after" ]] && echo "your focus never moved" || echo "your workspace CHANGED ($before -> $after)")
took=$(awk -v t="$(( $(date +%s%N) - T0 ))" 'BEGIN { printf "%.1f", t / 1e9 }')
if [[ $failed == 0 ]]; then say argus "4 agents finished in ${took}s · $place"
else say argus "$failed of 4 agents FAILED; $place"; fi

if [[ $KEEP == false ]]; then
  sleep "${DEMO_LINGER:-6}"
  omarchy-shell -q argus close
  for lane in 11 12 13; do "$A" --desk --lane "$lane" close >/dev/null 2>&1; done
  "$A" nest down demo >/dev/null 2>&1
  rm -f "$XDG_RUNTIME_DIR/argus/demo-app.pid"
fi
