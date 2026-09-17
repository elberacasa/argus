# argus desk -- a real desktop for agents, on a monitor that does not exist.
#
# A headless browser is detectable, has no GPU compositing, and cannot show a
# person what it is doing. A desk lane is a normal, headful Chromium: real
# Wayland window, real WebGL, real fonts. It runs on a Hyprland headless output,
# so it is invisible until someone asks to look -- `argus peek` pulls the whole
# desk onto the user's monitor, and a second peek sends it back.
#
# Routing happens in the compositor, not the browser: a workspace rule pins the
# desk workspace to the virtual monitor, and a window rule sends every window of
# the argus-desk class there *silently*. The rule exists before any window maps,
# so not one frame reaches the user's screen and their focus never moves
# (test/spike-desktop.sh asserts exactly that).
#
# Only possible because the machine is the host. A browser extension cannot
# create a monitor, and a library cannot write a window rule.

ARGUS_DESK_WS=${ARGUS_DESK_WS:-91}
ARGUS_DESK_CLASS=argus-desk
ARGUS_DESK_W=${ARGUS_DESK_W:-1280}
ARGUS_DESK_H=${ARGUS_DESK_H:-800}
ARGUS_DESK_POS=${ARGUS_DESK_POS:--20000x-20000}
ARGUS_DESK_FILE=$ARGUS_STATE/desk.json

# Hyprland's Lua IPC answers "ok" on success and an error string otherwise.
hl_eval()     { local out; out=$(hyprctl eval "$1" 2>&1); [[ $out == ok || -z $out ]] || { echo "argus: hyprland: $out" >&2; return 1; }; }
hl_dispatch() { local out; out=$(hyprctl dispatch "$1" 2>&1); [[ $out == ok || -z $out ]] || { echo "argus: hyprland: $out" >&2; return 1; }; }

desk_output() { jq -r '.output // empty' "$ARGUS_DESK_FILE" 2>/dev/null; }

desk_active() {
  local out; out=$(desk_output)
  [[ -n $out ]] && hyprctl monitors all -j | jq -e --arg o "$out" 'any(.[]; .name == $o)' >/dev/null 2>&1
}

# The routing rules. Idempotent, because they must be re-asserted: Hyprland
# drops every runtime rule on a config reload, and Omarchy reloads on theme and
# settings changes. Without the rules a desk window maps onto the user's screen.
#
# The window rule is held by handle in a Lua global rather than re-declared:
# globals persist across `hyprctl eval` calls, so the rule is created once and
# re-enabled on demand, and a config reload -- which is exactly what drops the
# rule -- also drops the global, so the next call recreates it. Workspace rules
# are keyed by workspace and do not duplicate (measured), so those are simply
# re-declared.
#
# Every desk window floats at one fixed size. Tiled, a lane's viewport changed
# whenever another agent opened a window next to it -- 1896px wide became 941px
# mid-task, so responsive layouts flipped under an agent that did nothing
# (measured). Floating windows may overlap; nobody looks at the desk, and the
# compositor still captures each window whole. They are also fully opaque:
# Omarchy's default rule makes every window slightly translucent, which is
# taste on a person's desktop and noise in an agent's screenshot.
#
# The desk monitor sits far from every real one. Placed automatically it was
# adjacent to the person's screen (x=1920), so a mouse pushed past the right
# edge wandered onto a monitor nobody can see, taking focus with it -- the
# suite's focus spy caught it while the person was using the mouse. A pointer
# cannot cross a gap between monitors. The output name is checked first: a
# monitor rule for an empty name would rewrite the default rule for every
# monitor (it happened once, during development; a config reload undid it).
#
# focus_on_activate=false is the one that is easy to miss. Omarchy turns the
# global option on, so a desk browser that opens a popup, goes fullscreen or is
# raised over CDP asks to be activated -- and Hyprland hands it the user's focus,
# following it to a monitor they cannot see. Scoping the override to our class
# leaves the user's own preference alone.
desk_rules() {
  local output=$1
  [[ $output == HEADLESS-* ]] || { echo "argus: refusing desk rules for output '$output'" >&2; return 1; }
  hl_eval "hl.monitor({ output = \"$output\", mode = \"1920x1080\", position = \"$ARGUS_DESK_POS\", scale = 1 })" &&
  hl_eval "hl.workspace_rule({ workspace = \"$ARGUS_DESK_WS\", monitor = \"$output\", persistent = true })" &&
  hl_eval "for _, r in ipairs({ argus_desk_rule, argus_desk_rule2 }) do r:set_enabled(false) end; if not argus_desk_rule3 then argus_desk_rule3 = hl.window_rule({ name = \"argus-desk\", match = { class = \"^$ARGUS_DESK_CLASS\$\" }, workspace = \"$ARGUS_DESK_WS silent\", no_initial_focus = true, focus_on_activate = false, float = true, size = { $ARGUS_DESK_W, $ARGUS_DESK_H }, center = true, opacity = \"1.0 override 1.0 override\" }) end; argus_desk_rule3:set_enabled(true)"
}

desk_up() {
  if desk_active; then
    printf 'desk already up on %s, workspace %s\n' "$(desk_output)" "$ARGUS_DESK_WS"
    return 0
  fi
  local known output
  known=$(hyprctl monitors all -j | jq -r '.[].name' | sort)
  hyprctl output create headless >/dev/null || { echo "argus: could not create a headless output" >&2; return 1; }

  # Hyprland names the output itself; identify it as the one that was not there.
  local _
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    output=$(comm -13 <(echo "$known") <(hyprctl monitors all -j | jq -r '.[].name' | sort) | head -1)
    [[ -n $output ]] && break
    sleep 0.1
  done
  [[ -z $output ]] && { echo "argus: headless output did not appear" >&2; return 1; }

  # A new monitor gets the lowest free workspace id (usually 1) as its visible
  # workspace, not the desk's. The compositor only draws a monitor's visible
  # workspace, so desk windows were never rendered -- CDP screenshots still
  # worked, compositor captures showed wallpaper -- and the person pressing
  # Super+1 would have been sent to a monitor they cannot see. Renumbering the
  # new workspace to the desk's makes the desk the visible one without moving
  # anyone's focus (measured).
  local shown
  shown=$(hyprctl monitors all -j | jq -r --arg o "$output" '.[] | select(.name == $o) | .activeWorkspace.id')
  if [[ $shown != "$ARGUS_DESK_WS" ]]; then
    hl_dispatch "hl.dsp.workspace.change_id({ workspace = \"$shown\", id = $ARGUS_DESK_WS })" || {
      hyprctl output remove "$output" >/dev/null 2>&1; return 1; }
  fi

  desk_rules "$output" || return 1

  jq -nc --arg o "$output" --arg w "$ARGUS_DESK_WS" '{output:$o, workspace:$w, peek:null}' > "$ARGUS_DESK_FILE"
  printf 'desk up: virtual monitor %s, workspace %s\n' "$output" "$ARGUS_DESK_WS"
}

desk_close_daemon_lanes() {
  local sock=${ARGUS_SOCKET:-$XDG_RUNTIME_DIR/argus/argus.sock} lane call
  [[ -S $sock ]] || return 0
  call() {
    if [[ -x $ARGUS_ROOT/argusd/dist/argusd && -z $(find "$ARGUS_ROOT/argusd/src" -newer "$ARGUS_ROOT/argusd/dist/argusd" -name '*.ts' -print -quit) ]]; then
      ARGUS_SOCKET=$sock "$ARGUS_ROOT/argusd/dist/argusd" call "$@"
    else
      ARGUS_SOCKET=$sock bun "$ARGUS_ROOT/argusd/src/main.ts" call "$@"
    fi
  }
  for lane in $(call lane.list '{}' 2>/dev/null | jq -r '.lanes[]? | select(.kind == "desk") | .lane'); do
    call lane.close "{\"lane\":\"$lane\"}" >/dev/null 2>&1
  done
}

desk_down() {
  local output; output=$(desk_output)
  [[ -z $output ]] && { echo "desk is not up"; return 0; }
  # Never leave the user staring at a desk that is about to vanish.
  [[ $(jq -r '.peek // empty' "$ARGUS_DESK_FILE" 2>/dev/null) != "" ]] && desk_peek off >/dev/null

  ( ARGUS_DESK=1; pool_shutdown_kind )
  # argusd's desk lanes too: once the monitor is gone, any window still on it
  # would fall onto the person's screen.
  desk_close_daemon_lanes
  sleep 0.4
  # Removing a monitor makes Hyprland warp the cursor to the centre of the
  # focused one (measured: 3144,360 -> 2880,540, the centre of a 1920x1080
  # monitor at x=1920). Put it back -- but only when it landed exactly on a
  # monitor centre, so a real movement by the person is never undone.
  local cursor_before cursor_after
  cursor_before=$(hyprctl cursorpos 2>/dev/null | tr -d ' ')
  hyprctl output remove "$output" >/dev/null 2>&1
  sleep 0.15
  cursor_after=$(hyprctl cursorpos 2>/dev/null | tr -d ' ')
  if [[ -n $cursor_before && $cursor_after != "$cursor_before" ]] \
    && hyprctl monitors -j | jq -e --arg p "$cursor_after" \
      'any(.[]; "\(.x + ((.width / .scale) / 2 | floor)),\(.y + ((.height / .scale) / 2 | floor))" == $p)' >/dev/null; then
    hyprctl eval "return hl.dispatch(hl.dsp.cursor.move({ x = ${cursor_before%,*}, y = ${cursor_before#*,} }))" >/dev/null 2>&1
  fi
  hl_eval "if argus_desk_rule3 then argus_desk_rule3:set_enabled(false) end" 2>/dev/null
  hl_eval "hl.workspace_rule({ workspace = \"$ARGUS_DESK_WS\", persistent = false })" 2>/dev/null
  rm -f "$ARGUS_DESK_FILE"
  printf 'desk down: %s removed\n' "$output"
}

# Pull the desk onto the monitor the user is looking at, or send it home.
# Remembers where they were, so leaving puts them back exactly.
desk_peek() {
  local want=${1:-toggle} output peek user_ws user_mon
  desk_active || { echo "argus: desk is not up (argus desk up)" >&2; return 1; }
  output=$(desk_output)
  peek=$(jq -c '.peek' "$ARGUS_DESK_FILE")

  [[ $want == toggle ]] && { [[ $peek == null ]] && want=on || want=off; }

  if [[ $want == on ]]; then
    [[ $peek != null ]] && { echo "already peeking"; return 0; }
    user_ws=$(hyprctl activeworkspace -j | jq -r .id)
    user_mon=$(hyprctl activeworkspace -j | jq -r .monitor)
    # Move the desk by name, then look at it: the person's focus never passes
    # through the invisible monitor.
    hl_dispatch "hl.dsp.workspace.move({ workspace = \"$ARGUS_DESK_WS\", monitor = \"$user_mon\" })" || return 1
    hl_dispatch "hl.dsp.focus({ workspace = \"$ARGUS_DESK_WS\" })" || return 1
    jq --arg w "$user_ws" --arg m "$user_mon" '.peek = {workspace:$w, monitor:$m}' "$ARGUS_DESK_FILE" > "$ARGUS_DESK_FILE.tmp" \
      && mv "$ARGUS_DESK_FILE.tmp" "$ARGUS_DESK_FILE"
    printf 'peeking: desk workspace %s is on %s (argus peek again to return)\n' "$ARGUS_DESK_WS" "$user_mon"
  else
    [[ $peek == null ]] && { echo "not peeking"; return 0; }
    user_ws=$(jq -r '.peek.workspace' "$ARGUS_DESK_FILE")
    user_mon=$(jq -r '.peek.monitor' "$ARGUS_DESK_FILE")
    local looking stray
    looking=$(hyprctl activeworkspace -j | jq -r .id)
    # Send the desk home by name: workspace.move takes the workspace, so the
    # person's focus is not borrowed for it. (The old way focused the desk
    # first, then jumped to the workspace saved at peek time -- yanking anyone
    # who had since moved on to another workspace.)
    hl_dispatch "hl.dsp.workspace.move({ workspace = \"$ARGUS_DESK_WS\", monitor = \"$output\" })" || return 1
    # While the desk was away its monitor grew a workspace of its own. Give that
    # one to the person's monitor so the desk is what the virtual monitor shows,
    # which is what gets composited. Measured: no focus change.
    stray=$(hyprctl monitors all -j | jq -r --arg o "$output" '.[] | select(.name == $o) | .activeWorkspace.id')
    if [[ -n $stray && $stray != "$ARGUS_DESK_WS" ]]; then
      hl_dispatch "hl.dsp.workspace.move({ workspace = \"$stray\", monitor = \"$user_mon\" })" || return 1
    fi
    # Only someone still looking at the desk is taken back where they were.
    [[ $looking == "$ARGUS_DESK_WS" ]] && { hl_dispatch "hl.dsp.focus({ workspace = \"$user_ws\" })" || return 1; }
    jq '.peek = null' "$ARGUS_DESK_FILE" > "$ARGUS_DESK_FILE.tmp" && mv "$ARGUS_DESK_FILE.tmp" "$ARGUS_DESK_FILE"
    if [[ $looking == "$ARGUS_DESK_WS" ]]; then printf 'back on workspace %s; desk returned to %s\n' "$user_ws" "$output"
    else printf 'desk returned to %s; you stay on workspace %s\n' "$output" "$looking"; fi
  fi
}

# Returns 0 and restores the user if an action left their focus on the desk.
desk_focus_guard() { # <workspace-before-action>
  local before=$1 now
  [[ $(jq -c '.peek' "$ARGUS_DESK_FILE" 2>/dev/null) == null ]] || return 1
  now=$(hyprctl activeworkspace -j | jq -r .id)
  [[ $now == "$ARGUS_DESK_WS" && -n $before && $before != "$ARGUS_DESK_WS" ]] || return 1
  hl_dispatch "hl.dsp.focus({ workspace = \"$before\" })" >/dev/null
  return 0
}

# ---- the compositor delta ----------------------------------------------------
# What the compositor can see that the page cannot: windows opening and closing,
# fullscreen, a title the window manager shows. Scoped to argus-desk windows by
# construction -- the user's own windows never enter an agent's delta.
desk_windows() {
  hyprctl clients -j 2>/dev/null | jq -c --arg c "$ARGUS_DESK_CLASS" '
    [ .[] | select(.class == $c and .mapped)
          | {address, title, fullscreen, floating, workspace: .workspace.name, size} ]'
}

desk_diff() { # <before-json> <after-json>
  jq -nc --argjson a "$1" --argjson b "$2" '
    ($a | map({(.address): .}) | add // {}) as $A |
    ($b | map({(.address): .}) | add // {}) as $B |
    {
      opened:     [ $b[] | select($A[.address] == null) | {title, floating, size} ],
      closed:     [ $a[] | select($B[.address] == null) | {title} ],
      fullscreen: [ $b[] | select($A[.address] != null and $A[.address].fullscreen != .fullscreen)
                         | {title, from: $A[.address].fullscreen, to: .fullscreen} ],
      resized:    [ $b[] | select($A[.address] != null and $A[.address].size != .size)
                         | {title, from: $A[.address].size, to: .size} ]
    }
    | with_entries(select(.value | length > 0))'
}

desk_status() {
  if desk_active; then
    local n; n=$(desk_windows | jq 'length')
    printf 'desk up: %s, workspace %s, %s window(s)%s\n' "$(desk_output)" "$ARGUS_DESK_WS" "$n" \
      "$([[ $(jq -c .peek "$ARGUS_DESK_FILE") != null ]] && echo ", peeking")"
  else
    echo "desk is down"
  fi
}
