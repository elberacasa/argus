#!/bin/bash

# Can an agent get a real, headful browser on a monitor that does not exist,
# without a single frame of it touching the user's screen?
#
# Everything here is reversible and the trap restores the desktop even on
# failure. The one thing that must never happen is the user's focus moving: the
# test records their active workspace first and fails loudly if it changed.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
WS=${ARGUS_DESK_WORKSPACE:-91}
CLASS=argus-desk
PORT=9515
BASE=http://127.0.0.1:$PORT

before_ws=$(hyprctl activeworkspace -j | jq -r .id)
before_mon=$(hyprctl activeworkspace -j | jq -r .monitor)
output=""; sid=""

restore() {
  [[ -n $sid ]] && curl -s -X DELETE "$BASE/session/$sid" >/dev/null 2>&1
  sleep 0.5
  [[ -n $output ]] && hyprctl output remove "$output" >/dev/null 2>&1
  # Rules added at runtime vanish on reload, but disable ours explicitly so a
  # long session is not left with a rule matching a class nobody uses.
  hyprctl eval "hl.window_rule({ name = \"argus-desk\", enabled = false, match = { class = \"^$CLASS\$\" } })" >/dev/null 2>&1
}
trap restore EXIT

echo "user is on workspace $before_ws ($before_mon) -- this must not change"

# 1. A monitor that does not exist.
known=$(hyprctl monitors all -j | jq -r '.[].name' | sort)
hyprctl output create headless >/dev/null
sleep 0.4
output=$(comm -13 <(echo "$known") <(hyprctl monitors all -j | jq -r '.[].name' | sort) | head -1)
[[ -z $output ]] && { echo "FAIL: no headless output appeared"; exit 1; }
echo "created virtual monitor: $output"

# 2. Pin a workspace to it, and route our browser class there silently. The
#    rule must exist before the window maps, or it flashes onto the real screen.
hyprctl eval "hl.workspace_rule({ workspace = \"$WS\", monitor = \"$output\", persistent = true })" 2>&1 | grep -v '^ok$'
hyprctl eval "hl.window_rule({ name = \"argus-desk\", match = { class = \"^$CLASS\$\" }, workspace = \"$WS silent\", no_initial_focus = true })" 2>&1 | grep -v '^ok$'

# 3. A real, headful Chromium -- no --headless -- speaking Wayland.
curl -sf --max-time 1 "$BASE/status" >/dev/null 2>&1 || { setsid chromedriver --port=$PORT --silent >/dev/null 2>&1 </dev/null & disown; sleep 1; }
sid=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d "{
  \"capabilities\":{\"alwaysMatch\":{\"browserName\":\"chrome\",\"goog:chromeOptions\":{
    \"binary\":\"/usr/bin/chromium\",
    \"args\":[\"--ozone-platform=wayland\",\"--class=$CLASS\",\"--no-first-run\",
             \"--window-size=1280,800\",\"--disable-extensions\"]}}}}" | jq -r '.value.sessionId // empty')
[[ -z $sid ]] && { echo "FAIL: headful chromium did not start"; exit 1; }
curl -s -X POST "$BASE/session/$sid/url" -H 'Content-Type: application/json' -d '{"url":"https://example.com"}' >/dev/null
sleep 1

# 4. Where did it land, and did the user notice?
win=$(hyprctl clients -j | jq -c --arg c "$CLASS" '[.[] | select(.class == $c or (.class|test("chromium";"i")) and .workspace.id == '"$WS"')] | .[0] // empty')
[[ -z $win ]] && win='{}'
echo "window: $(jq -c '{class, title, workspace: .workspace.name, monitor}' <<<"$win")"
after_ws=$(hyprctl activeworkspace -j | jq -r .id)

echo
[[ $win != '{}' ]]                                && echo "ok   a headful browser window exists"             || echo "FAIL no window found"
[[ $(jq -r '.workspace.id' <<<"$win") == "$WS" ]] && echo "ok   it landed on workspace $WS"             || echo "FAIL it landed on $(jq -r '.workspace.id' <<<"$win")"
mon_id=$(hyprctl monitors all -j | jq -r --arg o "$output" '.[] | select(.name==$o) | .id')
[[ $(jq -r '.monitor' <<<"$win") == "$mon_id" ]] && echo "ok   it is on the virtual monitor"           || echo "FAIL it is on monitor $(jq -r '.monitor' <<<"$win")"
[[ $after_ws == "$before_ws" ]]                   && echo "ok   user never left workspace $before_ws"        || echo "FAIL user was moved to workspace $after_ws"

# 5. The page is real and drivable exactly like a headless lane.
title=$(curl -s "$BASE/session/$sid/title" | jq -r .value)
[[ $title == "Example Domain" ]]                  && echo "ok   the page is drivable over WebDriver ($title)" || echo "FAIL title: $title"
