# argus eyes -- pixels, but only the pixels that matter.
#
# Text deltas say what an action changed and why, and cost ~100 tokens. Some
# questions are purely visual -- did it render, does it look broken, is the
# layout off -- and there a screenshot is the only honest answer. The mistake
# other tools make is not using screenshots; it is sending the whole screen
# after every step and leaving the model to find the difference.
#
# So the eyes work like the delta: capture before and after an action, find the
# regions that actually changed, and hand back only those, before beside after.
# A two-line status change costs a couple of hundred visual tokens instead of
# ~1,300 for the viewport. And they see what the text delta structurally
# cannot: CSS-only changes -- a colour, an animation, a transform -- that leave
# every text node untouched.
#
# Uses ImageMagick, which Omarchy already ships. No new dependencies.

ARGUS_EYES_DIR=${ARGUS_EYES_DIR:-$ARGUS_STATE/eyes}

# Visual tokens for an image on current Claude models:
# ceil(w/28) * ceil(h/28), downscaled past 2576px long edge or 4784 tokens
# (platform.claude.com/docs/en/build-with-claude/vision).
eyes_tokens() {
  python3 - "$1" "$2" <<'PY'
import math, sys
w, h = int(sys.argv[1]), int(sys.argv[2])
s = min(1.0, 2576 / max(w, h))
while math.ceil(w * s / 28) * math.ceil(h * s / 28) > 4784:
    s *= 0.99
print(math.ceil(w * s / 28) * math.ceil(h * s / 28))
PY
}

# Every capture passes an explicit clip, and in the person's own browser uses a
# timeout ladder. Measured over the bridge on a background tab: an unclipped
# capture waits for a frame the tab may never produce and stalled a full minute.
# A clipped one stalls on the first request and returns in ~50ms on the second,
# every time -- the first appears to wake the renderer. So the first try is given
# half a second, not five.
eyes_capture() { # <file> <params-json>
  local -a ladder=(60)
  own && ladder=(0.5 3 5 5)
  local t
  for t in "${ladder[@]}"; do
    cdp Page.captureScreenshot "$2" "$t" | jq -r '.value.data // empty' | base64 -d > "$1" 2>/dev/null
    [[ -s $1 ]] && return 0
  done
  return 1
}

# The current viewport of the lane, as PNG. Sized to the window, scrollbar
# included, not to the content area: a click that makes the page tall enough to
# grow a scrollbar narrows the content area by ~15px, and a before/after pair of
# different sizes cannot be compared region by region.
eyes_grab() {
  local vp
  vp=$(js_exec 'return {x: scrollX, y: scrollY, width: innerWidth, height: innerHeight, scale: 1}' '[]')
  eyes_capture "$1" "$(jq -nc --argjson c "$vp" '{format:"png", clip:$c}')"
}

# A clipped capture in CSS pixels, clamped to the page.
eyes_clip() { # <file> <x> <y> <w> <h>
  eyes_capture "$1" "$(jq -nc --argjson x "$2" --argjson y "$3" --argjson w "$4" --argjson h "$5" \
    '{format:"png",clip:{x:([$x,0]|max),y:([$y,0]|max),width:$w,height:$h,scale:1}}')"
}

# Compare two viewport captures. Prints a JSON description of what changed and
# writes a contact sheet of the changed regions -- before on the left framed in
# grey, after on the right framed in teal -- when there is anything to show.
eyes_diff() { # <before.png> <after.png> <sheet.png>
  local before=$1 after=$2 sheet=$3 dims w h changed comps
  dims=$(magick identify -format '%w %h' "$after" 2>/dev/null) || { echo '{"error":"unreadable capture"}'; return 1; }
  read -r w h <<<"$dims"

  # A resize changes the size of the frame; there is nothing to align, so say
  # so rather than diffing unrelated pictures. A few pixels of drift is not a
  # resize -- compare the common area instead.
  local bw bh
  read -r bw bh <<<"$(magick identify -format '%w %h' "$before" 2>/dev/null)"
  if [[ $bw != "$w" || $bh != "$h" ]]; then
    if (( ${bw:-0} - w > 32 || w - ${bw:-0} > 32 || ${bh:-0} - h > 32 || h - ${bh:-0} > 32 )); then
      jq -nc '{changed:true, whole:true, reason:"viewport size changed"}'; return 0
    fi
    w=$(( bw < w ? bw : w )); h=$(( bh < h ? bh : h ))
    magick "$before" -crop "${w}x${h}+0+0" +repage "$before"
    magick "$after"  -crop "${w}x${h}+0+0" +repage "$after"
  fi

  # 3% fuzz absorbs antialiasing and compression noise that is not a change.
  changed=$(magick compare -metric AE -fuzz 3% "$before" "$after" null: 2>&1 | awk '{print int($1)}')
  if [[ ${changed:-0} -eq 0 ]]; then
    jq -nc '{changed:false}'; return 0
  fi

  # Difference -> threshold -> dilate so the glyphs of one line of text become
  # one blob -> connected components. Each white component is a changed region.
  comps=$(magick "$before" "$after" -compose difference -composite -colorspace gray -threshold 8% \
            -morphology Dilate Octagon:10 \
            -define connected-components:verbose=true -define connected-components:area-threshold=40 \
            -connected-components 8 null: 2>/dev/null | awk 'NR > 1 && $NF ~ /gray\(255\)|white|#FFFFFF/ {print $2}')

  python3 - "$before" "$after" "$sheet" "$w" "$h" "$changed" <<PY
import json, subprocess, sys
before, after, sheet = sys.argv[1], sys.argv[2], sys.argv[3]
W, H, changed = int(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6])
# Lines are read, not glyphs: when "Order summary" becomes "Order confirmed"
# only the second word's pixels differ, and a tight crop shows "rder confirmed".
# So context is generous across a line and modest down the page.
PADX, PADY, GAP, MAX_REGIONS = 72, 18, 12, 4

regions = []
for geo in """$comps""".split():
    size, x, y = geo.split("+")
    rw, rh = map(int, size.split("x"))
    regions.append([int(x), int(y), rw, rh])

# Pad for context, clamp to the frame, then merge anything that now overlaps:
# a label and the value beside it are one change to a reader.
def pad(r):
    x, y, rw, rh = r
    x0, y0 = max(0, x - PADX), max(0, y - PADY)
    x1, y1 = min(W, x + rw + PADX), min(H, y + rh + PADY)
    return [x0, y0, x1 - x0, y1 - y0]
def overlaps(a, b):
    return not (a[0] + a[2] <= b[0] or b[0] + b[2] <= a[0] or a[1] + a[3] <= b[1] or b[1] + b[3] <= a[1])
regions = [pad(r) for r in regions]
merged = True
while merged:
    merged = False
    for i in range(len(regions)):
        for j in range(i + 1, len(regions)):
            if overlaps(regions[i], regions[j]):
                a, b = regions[i], regions[j]
                x0, y0 = min(a[0], b[0]), min(a[1], b[1])
                x1, y1 = max(a[0] + a[2], b[0] + b[2]), max(a[1] + a[3], b[1] + b[3])
                regions[i] = [x0, y0, x1 - x0, y1 - y0]
                del regions[j]
                merged = True
                break
        if merged:
            break

area = sum(r[2] * r[3] for r in regions)
out = {"changed": True, "changedPx": changed, "changedPct": round(100 * changed / (W * H), 2)}

# When most of the frame moved -- a scroll, a theme switch, a new page -- a
# crop is not smaller than the screen and says less. Report it as whole-frame.
if not regions or area > 0.6 * W * H:
    out.update({"whole": True, "reason": "most of the viewport changed"})
    print(json.dumps(out)); sys.exit(0)

regions.sort(key=lambda r: r[2] * r[3], reverse=True)
dropped = max(0, len(regions) - MAX_REGIONS)
regions = sorted(regions[:MAX_REGIONS], key=lambda r: (r[1], r[0]))

rows = []
for i, (x, y, rw, rh) in enumerate(regions):
    geo = f"{rw}x{rh}+{x}+{y}"
    row = f"{sheet}.row{i}.png"
    subprocess.run(["magick",
        "(", before, "-crop", geo, "+repage", "-bordercolor", "#8b929d", "-border", "2", ")",
        "(", "-size", f"{GAP}x{rh + 4}", "xc:#0f1216", ")",
        "(", after,  "-crop", geo, "+repage", "-bordercolor", "#22a797", "-border", "2", ")",
        "-background", "#0f1216", "+append", row], check=True)
    rows.append(row)
subprocess.run(["magick", *rows, "-background", "#0f1216", "-splice", f"0x{GAP}", "-append", "-chop", f"0x{GAP}", sheet], check=True)
for r in rows:
    subprocess.run(["rm", "-f", r])

sw, sh = map(int, subprocess.run(["magick", "identify", "-format", "%w %h", sheet], capture_output=True, text=True, check=True).stdout.split())
out.update({"regions": [{"x": x, "y": y, "w": rw, "h": rh} for x, y, rw, rh in regions],
            "image": sheet, "imageSize": f"{sw}x{sh}"})
if dropped:
    out["regionsOmitted"] = dropped
print(json.dumps(out))
PY
}

# Numbered marks over every interactive element, and the legend that maps each
# number to the role:name argus can act on. A model that can see "the thing
# under 7" can then click it without guessing coordinates.
read -r -d '' EYES_MARKS_JS <<'JS'
const mode = arguments[0];
const layerId = "__argus_marks";
document.getElementById(layerId)?.remove();
if (mode === "clear") return true;
const INTERACTIVE = "a[href],button,input:not([type=hidden]),select,textarea,summary,label[for],[role=button],[role=link],[role=tab],[role=checkbox],[role=menuitem],[tabindex]:not([tabindex='-1'])";
const layer = document.createElement("div");
layer.id = layerId;
layer.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;font:700 11px/1 ui-monospace,monospace";
const legend = [];
const roleOf = (el) => el.getAttribute("role") || ({ A: "link", BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox", SUMMARY: "button", LABEL: "label" }[el.tagName])
  || (el.tagName === "INPUT" ? ({ checkbox: "checkbox", radio: "radio", submit: "button", button: "button", file: "file" }[el.type] || "textbox") : el.tagName.toLowerCase());
const nameOf = (el) => (el.getAttribute("aria-label") || (el.labels && el.labels[0] && el.labels[0].innerText) || el.innerText || el.value || el.placeholder || el.title || "").replace(/\s+/g, " ").trim().slice(0, 40);
let n = 0;
for (const el of document.querySelectorAll(INTERACTIVE)) {
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
  const cs = getComputedStyle(el);
  if (cs.visibility === "hidden" || cs.display === "none") continue;
  // Only what a real click at its centre would hit: covered controls are not
  // offered as targets, which is the same rule locate.js enforces.
  const hit = document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2)), Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2)));
  const reachable = !!hit && (hit === el || el.contains(hit) || hit.contains(el));
  n++;
  const box = document.createElement("div");
  const color = reachable ? "#22a797" : "#e5484d";
  box.style.cssText = `position:absolute;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;outline:2px solid ${color};outline-offset:1px;border-radius:3px`;
  const tag = document.createElement("span");
  tag.textContent = n;
  tag.style.cssText = `position:absolute;left:-2px;top:-15px;background:${color};color:#fff;padding:2px 4px;border-radius:3px`;
  box.appendChild(tag);
  layer.appendChild(box);
  const name = nameOf(el);
  legend.push({ n, target: roleOf(el) + (name ? ":" + name : ""), reachable });
}
document.documentElement.appendChild(layer);
return legend;
JS
