# argus pool -- many lanes, few browsers.
#
# A lane used to be a whole chromedriver session at ~1.1GB, which capped the box
# at about six. Measured (test/spike-pool.sh): a tab costs 170MB against a
# session's 780MB, a tab switch costs 8.9ms, and eight parallel sessions buy
# only 1.8x the throughput of one session driving eight tabs -- for 4.2x the
# memory. Concurrency is not where the time goes.
#
# So a lane is a *tab*, and tabs are spread round-robin across a small number of
# sessions. Twenty lanes cost 6.4GB this way instead of 22.2GB.
#
# Sessions are shared, and the current window is session-global state, so every
# command holds an exclusive lock on its session for its whole run. Lanes on
# different sessions never contend; lanes sharing one queue behind each other,
# which the spike says costs almost nothing.

ARGUS_POOL_SIZE=${ARGUS_POOL_SIZE:-4}

# Headless and desk browsers are different processes with different flags, so
# each kind keeps its own slots. Resolved at call time: flags parse after source.
pool_dir()  { if [[ ${ARGUS_DESK:-0} == 1 ]]; then printf '%s/pool-desk' "$ARGUS_STATE"; else printf '%s/pool' "$ARGUS_STATE"; fi; }
lane_file() { printf '%s/lane-%s' "$ARGUS_STATE" "$(lane_id)"; }

pool_session_index() { echo $(( ${1:-$ARGUS_LANE} % ARGUS_POOL_SIZE )); }

# Held for the lifetime of the process: bash releases the descriptor on exit, so
# a crashed command cannot leave a session locked.
pool_lock() {
  local k=$1
  mkdir -p "$(pool_dir)"
  exec {ARGUS_LOCK_FD}>"$(pool_dir)/session-$k.lock" || return 1
  flock "$ARGUS_LOCK_FD"
}

session_alive() { [[ -n ${1:-} ]] && curl -sf --max-time 2 "$ARGUS_BASE/session/$1/url" >/dev/null 2>&1; }

# Reuse the session for this lane's slot, or start one. The caller must already
# hold the slot's lock.
pool_session() {
  local k=$1 file sid
  file=$(pool_dir)/session-$k
  sid=$(cat "$file" 2>/dev/null || true)
  if session_alive "$sid"; then printf '%s' "$sid"; return 0; fi
  sid=$(session_new)
  [[ -z $sid ]] && return 1
  printf '%s' "$sid" > "$file"
  printf '%s' "$sid"
}

handle_exists() {
  local sid=$1 handle=$2
  curl -s "$ARGUS_BASE/session/$sid/window/handles" \
    | jq -e --arg h "$handle" '.value | index($h)' >/dev/null 2>&1
}

window_switch() {
  curl -s -X POST "$ARGUS_BASE/session/$1/window" -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg h "$2" '{handle:$h}')" >/dev/null
}

# Resolve this lane to a live (session, tab) and make that tab current.
# Sets SID and ARGUS_HANDLE.
pool_session_open() {
  driver_up || return 1
  local k lane_file sid handle fresh=false
  if [[ ${ARGUS_DESK:-0} == 1 ]]; then
    desk_active || { echo "argus: desk is not up (run: argus desk up)" >&2; return 1; }
    desk_rules "$(desk_output)" || return 1       # survive a config reload
  fi
  k=$(pool_session_index)
  pool_lock "$k" || { echo "argus: could not lock pool slot $k" >&2; return 1; }

  sid=$(pool_session "$k") || { echo "argus: could not start chromium" >&2; return 1; }
  lane_file=$(lane_file)
  handle=""
  if [[ -f $lane_file ]]; then
    local recorded_sid recorded_handle
    IFS=$'\t' read -r recorded_sid recorded_handle < "$lane_file"
    # A lane is only still valid if its session survived too; a restarted
    # session hands out fresh handles that happen to look identical.
    [[ $recorded_sid == "$sid" ]] && handle_exists "$sid" "$recorded_handle" && handle=$recorded_handle
  fi

  if [[ -z $handle ]]; then
    # The first lane on a session adopts the window it was born with rather than
    # stranding a blank tab; later lanes open their own.
    if [[ ! -f $(pool_dir)/session-$k.claimed ]]; then
      handle=$(curl -s "$ARGUS_BASE/session/$sid/window" | jq -r '.value')
      : > "$(pool_dir)/session-$k.claimed"
    else
      handle=$(curl -s -X POST "$ARGUS_BASE/session/$sid/window/new" \
        -H 'Content-Type: application/json' -d '{"type":"tab"}' | jq -r '.value.handle')
    fi
    [[ -z $handle || $handle == null ]] && { echo "argus: could not open a tab" >&2; return 1; }
    printf '%s\t%s' "$sid" "$handle" > "$lane_file"
    fresh=true
  fi

  SID=$sid
  ARGUS_HANDLE=$handle
  window_switch "$sid" "$handle"
  # On a desk someone may be watching, and WebDriver switching a handle does not
  # raise the tab. Bring the lane that is acting to the front so peek shows it.
  [[ ${ARGUS_DESK:-0} == 1 ]] && cdp Page.bringToFront >/dev/null
  # addScriptToEvaluateOnNewDocument is per-target, so a new tab needs its own
  # probe registration even though the session already has one.
  [[ $fresh == true ]] && probe_install
  return 0
}

# Close just this lane's tab. The session stays warm for its other lanes, and is
# dropped only when its last tab goes.
pool_session_drop() {
  local lane_file k sid handle remaining
  lane_file=$(lane_file)
  [[ -f $lane_file ]] || return 0
  IFS=$'\t' read -r sid handle < "$lane_file"
  k=$(pool_session_index)
  pool_lock "$k"
  if session_alive "$sid"; then
    remaining=$(curl -s "$ARGUS_BASE/session/$sid/window/handles" | jq -r '.value | length')
    if [[ ${remaining:-0} -le 1 ]]; then
      curl -s -X DELETE "$ARGUS_BASE/session/$sid" >/dev/null
      rm -f "$(pool_dir)/session-$k" "$(pool_dir)/session-$k.claimed"
    else
      window_switch "$sid" "$handle"
      curl -s -X DELETE "$ARGUS_BASE/session/$sid/window" >/dev/null
    fi
  fi
  rm -f "$lane_file"
}

# Tear down every session and lane of the current kind.
pool_shutdown_kind() {
  local f sid dir; dir=$(pool_dir)
  for f in "$dir"/session-[0-9]*; do
    [[ -f $f && $f != *.lock && $f != *.claimed ]] || continue
    sid=$(cat "$f" 2>/dev/null)
    [[ -n $sid ]] && curl -s -X DELETE "$ARGUS_BASE/session/$sid" >/dev/null 2>&1
  done
  rm -f "$dir"/session-*
  if [[ ${ARGUS_DESK:-0} == 1 ]]; then rm -f "$ARGUS_STATE"/lane-desk-*
  else find "$ARGUS_STATE" -maxdepth 1 -name 'lane-*' ! -name 'lane-desk-*' -delete; fi
}

# Both kinds.
pool_shutdown() { ( ARGUS_DESK=0; pool_shutdown_kind ); ( ARGUS_DESK=1; pool_shutdown_kind ); }

# What the pool is holding right now.
pool_status() {
  local k file sid n lanes=0 f
  driver_up 2>/dev/null || { echo "pool: chromedriver not running"; return 0; }
  for (( k = 0; k < ARGUS_POOL_SIZE; k++ )); do
    file=$(pool_dir)/session-$k
    sid=$(cat "$file" 2>/dev/null || true)
    if session_alive "$sid"; then
      n=$(curl -s "$ARGUS_BASE/session/$sid/window/handles" | jq -r '.value|length')
      printf 'slot %d  %s  %s tab(s)\n' "$k" "${sid:0:12}" "$n"
    else
      printf 'slot %d  %s\n' "$k" "-"
    fi
  done
  for f in "$ARGUS_STATE"/lane-*; do
    [[ -f $f ]] || continue
    if [[ ${ARGUS_DESK:-0} == 1 ]]; then [[ $f == */lane-desk-* ]] && lanes=$((lanes+1))
    else [[ $f != */lane-desk-* ]] && lanes=$((lanes+1)); fi
  done
  printf '%d lane(s) mapped, pool size %d, %s MB resident\n' \
    "$lanes" "$ARGUS_POOL_SIZE" "$(ps -o rss= -C chromium 2>/dev/null | awk '{s+=$1} END {printf "%d", s/1024}')"
}
