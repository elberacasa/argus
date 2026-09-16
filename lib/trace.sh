# argus trace -- an append-only record of everything a lane did.
#
# A screenshot tells you what a step looked like. A trace tells you what the
# whole run did, in order, with the cause of each change attached -- so a failed
# twenty-step task is twenty readable lines rather than twenty images to scrub.
# It is also the stream `argus watch` renders, and the history an agent can read
# back to correct itself without re-running anything.

ARGUS_TRACE_DIR=${ARGUS_TRACE_DIR:-$ARGUS_STATE/trace}
ARGUS_TRACE_MAX=${ARGUS_TRACE_MAX:-2000}     # lines kept per lane

# Desk lanes and headless lanes are separate browsers, so lane 3 of each must
# not share state, a pool slot or a trace. The kind is part of the identity.
lane_id() {
  if   [[ ${ARGUS_OWN:-0} == 1 ]];  then printf 'own-%s' "$ARGUS_LANE"
  elif [[ ${ARGUS_DESK:-0} == 1 ]]; then printf 'desk-%s' "$ARGUS_LANE"
  else printf '%s' "$ARGUS_LANE"; fi
}

trace_file() { printf '%s/lane-%s.jsonl' "$ARGUS_TRACE_DIR" "${1:-$(lane_id)}"; }

# One line per action, written with a single >> so concurrent lanes cannot
# interleave a partial record. Disabled entirely with ARGUS_TRACE=0.
trace_append() {
  [[ ${ARGUS_TRACE:-1} == 0 ]] && return 0
  local record=$1 file
  file=$(trace_file)
  mkdir -p "$ARGUS_TRACE_DIR"
  jq -ce --argjson t "$(date +%s%3N)" --arg lane "$(lane_id)" \
    '. + {t:$t, lane:$lane}' <<<"$record" >> "$file" 2>/dev/null || return 0

  # Trim in place only when the file has actually grown past the cap; the check
  # is a line count rather than a stat so a long-running lane stays bounded.
  local lines
  lines=$(wc -l < "$file" 2>/dev/null || echo 0)
  if (( lines > ARGUS_TRACE_MAX + 200 )); then
    tail -n "$ARGUS_TRACE_MAX" "$file" > "$file.trim" && mv "$file.trim" "$file"
  fi
}

trace_clear() { rm -f "$(trace_file)"; }

# Lanes that have a trace, newest activity first.
trace_lanes() {
  [[ -d $ARGUS_TRACE_DIR ]] || return 0
  local f
  for f in "$ARGUS_TRACE_DIR"/lane-*.jsonl; do
    [[ -f $f ]] || continue
    local name; name=$(basename "$f" .jsonl)
    printf '%s\t%s\n' "$(stat -c %Y "$f")" "${name#lane-}"
  done | sort -rn | cut -f2
}
