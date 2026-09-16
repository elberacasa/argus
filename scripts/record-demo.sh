#!/bin/bash

# Record the README demo: four agents on the invisible desk, watched from the
# Omarchy bar, with the timeline in a terminal.
#
#   scripts/record-demo.sh [OUT_DIR]      default docs/media
#
# Writes demo.mp4 (1080p, H.264) and demo.gif (960px, for the README). Takes
# over the screen for about half a minute on an empty workspace, then puts you
# back on the workspace you were on.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
ROOT=$PWD
OUT=${1:-docs/media}
WS=${DEMO_WORKSPACE:-8}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT"

command -v ffmpeg >/dev/null || { echo "record-demo: ffmpeg is required" >&2; exit 1; }
[[ $(hyprctl workspaces -j | jq --argjson w "$WS" '[.[] | select(.id == $w)][0].windows // 0') == 0 ]] \
  || { echo "record-demo: workspace $WS has windows; set DEMO_WORKSPACE to an empty one" >&2; exit 1; }

monitor=$(hyprctl activeworkspace -j | jq -r .monitor)
back=$(hyprctl activeworkspace -j | jq -r .id)

# The terminal the viewer reads: a title, then the agents' timeline.
cat > "$WORK/run.sh" <<SCRIPT
#!/bin/bash
printf '\033[?25l\033[2J\033[H'
printf '\n  \033[1margus\033[0m  four agents, one invisible desk\n'
printf '  \033[2mThey click, type and check pages on a monitor nobody looks at.\n'
printf '  Your screen stays yours. Watch them live from the bar.\033[0m\n\n'
sleep 2.4
DEMO_PACE=\${DEMO_PACE:-0.9} bash "$ROOT/test/demo-desk.sh" --keep
touch "$WORK/finished"
sleep 30
SCRIPT
chmod +x "$WORK/run.sh"

cursor=$(hyprctl cursorpos | tr -d ' ')
hyprctl dispatch "hl.dsp.focus({ workspace = \"$WS\" })" >/dev/null
read -r mon_x mon_y mon_w mon_h < <(hyprctl monitors -j | jq -r --arg m "$monitor" '.[] | select(.name == $m) | "\(.x) \(.y) \(.width) \(.height)"')
# A floating terminal on the left leaves the bar panel's live cards clear on the right.
hyprctl eval "return hl.dispatch(hl.dsp.exec_cmd(\"[workspace $WS; float; size 1010 640; move 36 100] foot --app-id argus-demo-term -o font=monospace:size=13 -o pad=30x26 $WORK/run.sh\"))" >/dev/null
for _ in $(seq 1 50); do hyprctl clients -j | jq -e 'any(.[]; .class == "argus-demo-term")' >/dev/null && break; sleep 0.1; done
term=$(hyprctl clients -j | jq -r '[.[] | select(.class == "argus-demo-term")][0].pid')
# Park the pointer in a corner for the take; it goes back afterwards.
hyprctl eval "return hl.dispatch(hl.dsp.cursor.move({ x = $((mon_x + mon_w - 2)), y = $((mon_y + mon_h - 2)) }))" >/dev/null
sleep 0.6

# Frames straight from the compositor, timestamped on arrival; the first pass
# is fast and nearly lossless, the second makes the files people download.
(
  while [[ ! -e $WORK/stop ]]; do grim -t ppm -o "$monitor" -; done
) | ffmpeg -y -loglevel error -f image2pipe -use_wallclock_as_timestamps 1 -c:v ppm -i - \
      -vf fps=30 -c:v libx264 -preset ultrafast -crf 10 -pix_fmt yuv420p "$WORK/raw.mp4" &
rec=$!

for _ in $(seq 1 1200); do [[ -e $WORK/finished ]] && break; sleep 0.1; done
sleep 4
touch "$WORK/stop"
wait "$rec"

# Clean up the demo and give the person their screen back.
omarchy-shell -q argus close
for lane in 11 12 13; do "$ROOT/bin/argus" --desk --lane "$lane" close >/dev/null 2>&1; done
"$ROOT/bin/argus" nest down demo >/dev/null 2>&1
kill "$term" 2>/dev/null
hyprctl dispatch "hl.dsp.focus({ workspace = \"$back\" })" >/dev/null
hyprctl eval "return hl.dispatch(hl.dsp.cursor.move({ x = ${cursor%,*}, y = ${cursor#*,} }))" >/dev/null

ffmpeg -y -loglevel error -i "$WORK/raw.mp4" -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -movflags +faststart "$OUT/demo.mp4"
ffmpeg -y -loglevel error -i "$WORK/raw.mp4" -vf "fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle" "$OUT/demo.gif"
ls -la "$OUT/demo.mp4" "$OUT/demo.gif" | awk '{printf "%s %.1f MB\n", $9, $5/1048576}'
