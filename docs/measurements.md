# Measurements

All taken on the reference box: 24 cores, 31GB RAM, RTX 3080 Ti, Hyprland
0.56.2, Chromium 152.0.7977.82 (chromedriver from the same pacman package).

## The manifest

```
441  omarchy commands total
440  carry # omarchy:summary=          (99%)
367  visible after honouring :hidden=
 63  auto-derived groups
151  declare # omarchy:args=
104  declare # omarchy:examples=
```

The args coverage looks thin at 41%, but that reading is wrong. Of the 216
visible commands with no `args` header, **189 are genuinely zero-argument**
(`omarchy-battery-present`, `omarchy-audio-output-switch`). The real gap is
**27 commands** — 7% of the catalogue, not 75%. Those are upstreamable PRs.

## Context cost

```
367 tools, flat                     60,126 chars   ~15,031 tokens
argus tools/list (4 tools)           1,450 chars      ~362 tokens
omarchy_groups (the whole OS)          722 chars      ~180 tokens
                                                   -------------
                                    28x reduction
8 MCP round trips                                        133 ms
```

## Browser

```
chromedriver cold start                                  162 ms
omarchy-browse cold                                      629 ms
omarchy-browse warm                                      360 ms
CDP Accessibility.getFullAXTree                            9 ms
8 pages fetched + text-extracted (parallel)             1.03 s
```

## Page projections — same Wikipedia article

```
raw AX tree            1,264,305 chars   ~316k tokens   unusable
raw HTML                 276,262 chars    ~69k tokens
AX slim (role+name)       72,086 chars    ~18k tokens
argus markdown            34,439 chars    ~8.6k tokens  keeps links
argus --text              15,864 chars    ~4.0k tokens  17x vs HTML
```

Correcting a plausible assumption: the raw accessibility tree is **4.5x larger
than the HTML**, not smaller, because CDP attaches full `sources` metadata to
every node. The AX tree is not the reading primitive. It is the *interaction*
primitive — `--json` on example.com is 128 bytes and names exactly what is
clickable. **Read with text, act with AX.**

## Memory — why tabs, not sessions

```
8 separate chromedriver sessions    9.6 GB   true parallelism
8 tabs inside one session           2.3 GB   4x cheaper, serialized commands
one warm session, idle              1.0 GB
```

WebDriver serializes commands per session, so the pool is two-dimensional:
K sessions for parallelism × M tabs for cheap capacity. K≈4-6 on 31GB gives
30+ concurrent pages.

## Compositor

Hyprland's `.socket2.sock` emits the desktop as a structured stream:

```
createworkspace>>3
monitoradded>>HEADLESS-2
openlayer>>omarchy-bar
```

`hyprctl output create headless` works and costs nothing until apps run on it.

## The delta engine

Measured against `news.ycombinator.com`, one click:

```
argus delta (one action)        421 chars    ~105 tokens
re-read page text             4,244 chars  ~1,061 tokens   10x
screenshot @1280x800                        1,334 tokens   13x
screenshot @1920x1080                       2,691 tokens   26x
re-read raw HTML             41,807 chars ~10,451 tokens   99x
```

Text figures are estimates at ~4 characters per token (no token-counting
credentials on the reference box). Screenshot figures are exact, from the
published formula for current models: `ceil(width/28) * ceil(height/28)` visual
tokens, with no downscaling below 2576px on the long edge
(platform.claude.com/docs/en/build-with-claude/vision). An earlier version of
this table used ~1,750 tokens for a 1280x800 screenshot and claimed 17x; that
figure was an unmeasured estimate and overstated the ratio.

The delta is not merely smaller. It is *causal* — it says what the action did,
which a screenshot of the resulting page never states. On `test/fixture.html`
a full click delta is 82 tokens and contains the text that appeared, the text
that left, and the request that failed.

Parallel lanes, 4 sites at once: **1.39s wall clock**, ~2.8GB per lane. Lanes
are separate chromedriver sessions, so they are genuinely concurrent; the tab
pool (4x cheaper, serialized) is the next optimisation.

## Diagnosis coverage

`test/run.sh` asserts all of these against planted defects, 22 checks:

| Situation | What argus says instead of "click failed" |
|---|---|
| modal scrim over the target | `covered` + `div#scrim` + `z-index:9998 position:fixed` |
| disabled control | `disabled` + "something upstream must enable it first" |
| misspelled name | `not-found` + `did you mean: button:place order` |
| two controls share a name | `ambiguous` + both candidates, refuses to guess |
| `pointer-events:none` | named explicitly |
| element scrolled out of view | scrolled into view first, then `offscreen` if still unreachable |

## Audit accuracy

Against `test/fixture.html`, which plants one of each defect:

```
contrast         p.muted        2.07:1  (hand-checked: #adb5bd on #fff)
tap-target       button#help    16x16
overflow-x       div.wide       +552px past a 1280px viewport
unnamed-control  button#help, input#email
heading-order    h1 -> h4
tiny-text        p.fineprint    9px
score            52/100
```

The audit also flags `input#email` as unnamed despite its placeholder, which is
correct: a placeholder is not an accessible name.

## Trace and dashboard

A run that fails and recovers, as `argus trace` replays it -- eight lines in
place of eight screenshots:

```
02:59:50 open  fixture.html                 318ms  1 err
02:59:50 click button:Place order   x covered by div#scrim
02:59:50 click button:Chekout       x not-found
02:59:50 click button:Pay later     x disabled
02:59:50 audit score 52/100  3 error(s), 3 warning(s)
02:59:50 click button:Accept                291ms
02:59:51 type  textbox:Email address         28ms
02:59:51 click button:Place order           289ms  1 net
```

`argus watch` renders every lane side by side from those same files, so
watching costs nothing and a lane that dies is a pane that stops moving.

Two bugs worth recording, both of which produced plausible-looking output:

- `local a=$1 b=$2 c=$(( a * b ))` expands every right-hand side *before* it
  assigns any of them, so `c` was silently zero and every score bar rendered
  empty. Split the assignment.
- The audit-score assertion matched a trace row containing the word "audit"
  rather than the footer bar, so it passed on text that had no bar in it. The
  test now asserts the bar has both filled and empty cells -- all-or-nothing is
  exactly the failure mode the arithmetic bug produced.

## Pool design: the spike that changed the answer

`test/spike-pool.sh`, 8 pages opened and text-extracted three ways:

```
A. tab-switch latency                 8.9 ms each

design                              wall ms    peak MB
1 session x 8 tabs (serialized)        1665       2141
8 sessions (parallel)                   921       9099
4 sessions x 2 tabs (hybrid)           1053       5166
```

The surprise is how little parallelism buys. Eight concurrent sessions return
only **1.8x** the throughput of one serialized session, for **4.2x** the memory
-- the work is latency-bound on the network and chromedriver itself serializes
more than expected, so eight browsers spend their lives waiting in parallel.

That inverts the design. K x M is justified, but **K should be small**: four
sessions recover most of the speed at a little over half the memory. So a lane
became a *tab*, spread round-robin over four browsers:

```
per-tab cost        170 MB
per-session cost    780 MB

20 lanes as separate sessions      22.2 GB
20 lanes as 4 sessions x 5 tabs     6.4 GB
```

Measured in practice at 12 lanes: **4.9 GB**, against 13.3 GB projected for 12
sessions, and 12 lanes each doing open + audit finish in 2.15s.

Sessions are shared and the current window is session-global, so every command
takes an exclusive `flock` on its slot for its whole run. Lanes on different
slots never contend; lanes sharing a slot queue behind each other, which the
spike says costs about 9ms.

## Two more bugs worth recording

- jq's `strftime` is UTC while `date(1)` is local, so the dashboard header read
  `12:09:06` above rows stamped `16:08:59`. `strflocaltime` fixes it, and a test
  now pins a trace timestamp to the local hour.
- The score-bar assertion grepped the first line containing a bar, which after
  the pool landed was a lane scoring 100/100 -- legitimately all-filled, so the
  check passed on output that could not have proven the arithmetic. It now
  unit-tests `bar()` at 0, 50 and 100 instead of inspecting a rendered frame.

## The desk: a real browser on a monitor that does not exist

`argus desk up` creates a Hyprland headless output, pins workspace 91 to it,
and routes every window of class `argus-desk` there silently. A `--desk` lane
is then a normal, headful Chromium -- real Wayland window, GPU, fonts -- that
no one sees until they `argus peek`.

Because it is a real window, its delta can include what the *compositor* saw,
which no page-level tool can observe:

```
> click button:Open payment window                    84ms
  [] window opened  "Argus popup - Chromium"  941x960
  [] window resized  1896x960 -> 941x960
> click button:Present fullscreen                     47ms
  [] window went fullscreen  "Argus fixture - Chromium"
  [] window resized  941x960 -> 1920x1080
```

The compositor delta is a diff of a snapshot of *argus-desk windows only*,
taken before and after each action, not a tap on the event socket. The socket
carries the user's own window activity too, and none of that belongs in an
agent's delta.

### The focus invariant, and how it broke

The one thing that must never happen is the user's focus moving to a monitor
they cannot see. The first desk spike held that invariant -- and the first real
run broke it: focus ended on workspace 91. Omarchy sets
`misc:focus_on_activate = true`, so a desk browser that opens a popup, goes
fullscreen or is raised over CDP requests activation and Hyprland follows it to
the virtual monitor. The spike never triggered activation, so it could not see
this.

The fix is scoped to our windows, leaving the user's global preference alone:
the desk window rule sets `focus_on_activate = false`. Verified passively --
the test listens on Hyprland's event socket and dispatches nothing:

```
open + popup + fullscreen + second lane
compositor events watched   45
focus arrivals at the desk   0
```

Hardening around it:

- Hyprland drops runtime rules on a config reload, and Omarchy reloads on theme
  and settings changes. The rules are re-asserted on every desk command. The
  window rule is held by handle in a Lua global (globals persist across
  `hyprctl eval`, measured), so re-assertion cannot accumulate duplicates, and
  a reload wipes the global exactly when it wipes the rule. Workspace rules are
  keyed by workspace and do not duplicate (3 re-declarations: still 1 rule).
- A narrow guard: if an action leaves focus *on the desk workspace* while no
  one is peeking, focus goes back to where it was before that action and the
  record carries `focusRestored`. It acts only on the desk workspace. An
  earlier, broader version of this guard restored to a fixed workspace and
  ended up dragging the user away from their own terminal -- the Claude Code
  session's terminal requests activation too, under the same Omarchy setting.

Desk tests are gated behind `ARGUS_TEST_DESK=1` so a default test run never
creates a monitor on someone's machine.

## A bash bug class, and the lint that now catches it

```
local k=$1 file=/pool/session-$k
```

bash expands every right-hand side before it creates any of the locals, so
`$k` is not the `k` being declared -- it is whatever `k` dynamic scope exposes.
Measured on bash 5.3.15: `local a=7 b=$a` gives `b` empty. In argus this was:

- the score bar, which rendered *full* inside `argus watch` (the caller's
  `width` was 46 while the bar was 28) and *empty* in isolation -- the same
  bug producing opposite symptoms depending on the caller;
- the pool slot lookup, which worked only because its caller also happened to
  hold a variable named `k` with the right value.

`test/lint-locals.py` finds the pattern, including inside one-liner functions.
Its first draft only read statements at the start of a line and passed a
known-bad file; it now self-tests against both shapes before being trusted.

## Nothing modal escapes

Baseline, before this work, on `test/dialogs.html`:

```
> click button:Delete account
  + "Deletion cancelled."
  settled nullms . null
```

chromedriver dismisses a `confirm()` by default, so a destructive question got a
silent "no": the agent saw "Deletion cancelled." with nothing saying a question
had been asked, and concluded the button was broken. The dialog also broke
settle detection. A styled upload label could not be located at all.

Now every modal a page can raise is intercepted in the probe, before any page
script runs, and reported:

```
> click button:Delete account
  + "Deletion cancelled."
  ? confirm  "Delete your account? This cannot be undone."  -> dismissed  (argus dialog accept, then retry)
  settled 251ms . network-idle+dom-quiet
```

- **confirm / prompt** are answered safely by default (dismiss) and reported.
  Accepting takes an explicit, one-shot `argus dialog accept [text]`, so an
  agent cannot confirm something destructive by accident. An `alert` asks
  nothing and does not consume a pending accept -- an early version let an
  alert eat the "yes" meant for the confirm behind it.
- **print** is suppressed and reported.
- **file pickers** never open. Clicks on file inputs are cancelled in the
  capture phase (including the synthetic click a `<label for>` forwards), and
  `showPicker` / the File System Access pickers are wrapped, with CDP's
  file-chooser interception as a backstop. `argus upload [target] <file>...`
  sets files on the input directly -- hidden inputs included -- addressed by the
  label a person reads.
- **downloads** go to a per-slot directory under `$XDG_RUNTIME_DIR`, never
  `~/Downloads` (a desk browser is a real Chromium and would otherwise write
  into the user's own folder), and the delta names the file that landed.

On a desk lane, verified with a D-Bus monitor on the portal plus a watchdog
ready to close any new portal window:

```
click label:Upload avatar
FileChooser requests to the portal    0
portal windows that appeared          0
```

The monitor was validated rather than trusted: it captured 2,842 messages in
that window including the desk browser's real portal traffic, and a deliberate
FileChooser call as a positive control was captured.

### The false success, and the chain behind it

The first `argus upload` returned `ok:true` and set nothing. Four quiet
failures in a row:

1. `js()` coerced every all-digit argument to a number, for click indices. A
   19-digit nanosecond token cannot survive a JS number: `...346799` arrived as
   `...346800`.
2. The page tagged the input with the rounded token, so the lookup missed.
3. The miss returned `{"error":"no such element"}`, and the element id was read
   as "the first value of the object" -- so the id became `no such element`.
4. The upload was sent to that id, the error field was read from the wrong
   place, and the command reported success.

Fixed at every link: only short integers are coerced, the token is not numeric,
the W3C element key is read by name, errors are read from `value.error` -- and
the command now reads the input's `files.length` afterwards and fails if it does
not match, because success is what the page holds, not what the transport said.

Generalised: WebDriver reports failure as ordinary JSON, so any delta built from
an error object used to render as "no observable change". A delta is now refused
if the probe did not answer, and the record says `probe-error` with the page's
own message instead.

### Downloads overwrite

Detection first compared file *names* before and after. Chrome overwrites a
download that has the same name as an existing file, so every re-download was
invisible. Detection now compares name, mtime and size, and when the probe saw a
download start it waits -- bounded, on that signal -- for the file to land.

## Dogfooding: argus on its own landing page

`site/index.html` was built and then tested with argus at 1280, 768, 390 and
320 px wide, in light and dark. What that surfaced, in order:

**The audit was blind, and said 100/100.** At 390 px the page reported a
539 px layout. The overflow check compared elements against `innerWidth`,
and on a phone the overflow itself inflates `innerWidth`, so the page was
measured against its own mistake and passed. It now uses `clientWidth` (the
device width), skips content inside scroll/clip containers (a wide table in
an `overflow-x:auto` box is correct), and deliberately includes
visually-hidden elements. Pinned by `test/overflow.html`, which has both the
defect and the legitimate case.

**The defect it then found was mine.** A screen-reader-only data table for the
chart used the usual `.visually-hidden` class -- which cannot size a `<table>`:
tables lay out to their content, so the invisible table was 503 px wide and
pushed the page 149 px past a phone screen. The hiding moved to a wrapper div.

**One conclusion drawn from that was wrong.** The page had rendered at
`visualViewport.scale` 0.72, which looked like "phones zoom this page out".
Reloaded fresh at phone width it renders at scale 1: the zoom was an artifact
of switching the emulated viewport from desktop to phone after load. A
`zoomed-out` rule written from that observation was removed, and
`argus viewport` now resets page scale so an audit after a width change matches
a page loaded at that width.

**Screenshots found six defects the audit has no rule for**, on a page it
scored 100/100:

- both theme icons rendered at once (`svg { display:block }` beat the UA
  `[hidden]` rule);
- the skip link's last 3 px peeked in at the top;
- the terminal demo was blank until scrolled 35% into view, so any capture that
  does not scroll -- a crawler, a link preview, an agent screenshot -- saw an
  empty box. It is now content-first: visible by default, hidden only by the
  replay's backwards fill;
- stacked section paddings left ~200 px gaps;
- monospace figures wrapped mid-phrase in narrow cards;
- the logo's scanning arc, frozen under reduced motion, read as a stray line.

Then, in dark mode: pupils and eye outlines were themed with `--ink`, which
turns near-white, on eye-whites that stay light -- white-pupilled eyes.

**The theme toggle never worked, and the first check said it did.** `hidden`
is an `HTMLElement` IDL attribute; `SVGElement` has none, so `svg.hidden = true`
sets an expando nothing reads. The icons never switched. A state check that
read `.hidden` back confirmed the script's intent, not the rendering; the
verification that caught it read `getComputedStyle(...).display` before and
after a real click.

**Keyboard focus was invisible to argus.** A delta now reports focus moves.
It immediately showed Enter on the skip link sending focus to nothing, because
`<main>` was not focusable; it now takes `tabindex="-1"`.

**A number on this page was wrong before it was published.** The comparison
used ~1,750 tokens for a 1280x800 screenshot. Checked against the published
formula, `ceil(w/28) * ceil(h/28)`, it is 1,334 -- the claimed 17x was 13x.

The landing page is now part of `test/run.sh`: clean audits at four widths, the
skip link moving focus into content, and the theme toggle rendering exactly one
icon after a real click.

Palette for the chart was validated with the dataviz validator rather than by
eye. The context bars are a deliberate neutral and fail only the chroma floor
by design; every other check passes in both themes (light `#007c64`/`#8b929d`,
dark `#22a797`/`#5f6671`), after the first choices failed CVD separation.

## Eyes

Text deltas cannot answer visual questions -- did it render, does it look
broken -- and the head-to-head with Claude in Chrome showed the screenshot was
its only way to see a covering scrim. So argus has eyes, built the way the delta
is: pixels only where they pay.

`--see` on any action captures the viewport before and after, diffs them with
ImageMagick (already on Omarchy), clusters changed pixels into regions
(threshold, dilate so a line of glyphs becomes one blob, connected components,
merge overlaps), and returns only those regions, before beside after.

```
click "Place order", fixture         2 regions   708x162    156 visual tokens
full 1280x800 viewport screenshot                          1,334 visual tokens
look "button:Place order" (covered)              168x88      24 visual tokens
```

Over MCP the image is returned as an image block, not a path -- a path is
useless to a model that cannot open files.

`look` crops to one element, and works on elements that cannot be clicked: the
locator now returns a box with its covered/disabled diagnoses, because a covered
control is the thing worth looking at. `marks` numbers every interactive element
and draws unreachable ones in red, with a legend of role:name targets.

Two things the first versions got wrong:

- Crops were tight around changed pixels, so "Order summary" -> "Order
  confirmed" read as "rder confirmed": only the second word's pixels differ.
  Horizontal context is now 72px, vertical 18px.
- A test asserted that pressing Escape changes nothing on screen. The eyes
  disagreed, and were right: a key press after a mouse click switches Chrome to
  keyboard focus styling, and the clicked button gained its focus ring. That is
  now a positive test -- a CSS-only change no text delta can represent -- and the
  no-change test clears focus first.

## Process ownership: the bug that broke the benchmark

During development, cleanup ran `pkill -9 -x chromium`. That matches every
process named chromium -- including the person's own browser, with its tabs and
the Claude in Chrome extension driving it. It was run repeatedly, and it is what
made the benchmark's Claude in Chrome tab drop out of its group and every later
tab render an error page. The write-up first attributed that to the machine
being in use; the cause was the cleanup.

`argus shutdown` now finds its driver by the socket on argus's port, not by
name, and stops only processes it can prove it owns: those in the driver's own
session (argus starts it with `setsid`, so the session is argus's alone; a
driver someone runs from a terminal shares that terminal's session and is left
untouched), plus browsers on chromedriver's throwaway `/tmp` profile whose
session leader has already died.

Verified against a live machine: with three argus lanes running (30 processes in
the driver's session), a decoy process named `chromium`, and the user's real
Chromium, shutdown stopped all 30 and left the decoy and the user's browser
alive. The decoy check is in `test/run.sh`.

## argusd foundation spike

The stack chosen in `docs/ARCHITECTURE.md` (TypeScript on Bun, Chromium over a
private pipe, a Scene from DOMSnapshot), proven before anything depends on it.

```
compiled binary                     77.6 MB, no bun/node needed at runtime
compile time                        85 ms
browser up over the pipe            124 ms, 0 TCP ports
scene capture, UITAP frames page    4 ms, 3 documents in one call
```

On the two UI Testing Playground pages the bash prototype could not see into:

- **Frames**: all 8 buttons inside the outer and inner frames, with frame paths
  `0>1` and `0>1>2` and page coordinates.
- **Shadow DOM**: the GUID generator's textbox and both buttons, marked as inside
  an open shadow root. Their names are empty, which is correct: they are icon
  buttons with no accessible name.

One bug was found by looking at real data rather than the docs' wording:
DOMSnapshot's `shadowRootType` marks every node *inside* a shadow tree, not the
shadow root node, and the parent chain skips the root. The first version walked
ancestors looking for root nodes and missed the generator's elements.

The CDP client is typed from Chromium's protocol definition: a misspelled method,
a wrong parameter name and a wrong result type were each rejected at compile
time. Scene tests run offline against recorded snapshots, and a mutation check
confirmed they fail when shadow detection, frame offsets or frame paths break.

## Invisible desks: native apps and the view-only bar

Question: must an agent's desktop be on the person's screen? No. Measured on
this machine (Hyprland 0.56.2, Quickshell 0.3.1, GTK 4.22), with the person's
active window and workspace compared before and after every run.

```
native GTK4 app mapped on the desk       384-441 ms after spawn, on HEADLESS-n ws 91
AT-SPI tree read (13 nodes)              3-4 ms
frame capture of the desk (grim, PPM)    13-17 ms   (PNG: ~620 ms, all compression;
                                                     JPEG q80: 16 ms)
set text through EditableText            <1 ms
click through an AT-SPI action           <1 ms
key to one window (hl.dsp.send_shortcut) 3-4 ms per key, no focus change
effect visible in the AT-SPI tree        ~260 ms (GTK publishes changes in batches)
person's window / workspace              unchanged in every run
```

- **Semantic first, keys second.** GTK4 gives buttons a `click` action and
  entries `EditableText`, but a check box exposes **no action at all**. Keys
  sent by Hyprland to that one window (Tab, Tab, Space) checked it, confirmed
  by its `CHECKED` state. `send_shortcut` with an unknown window is an error,
  not a fallback to whatever has focus (checked with a bogus address first).
- **What is still missing:** pointer input to a window nobody focuses. The
  compositor has one seat cursor; moving it would move the person's. Widgets
  reachable only by pointer need a nested compositor with its own seat
  (designed, not built). Keyboard focus inside an inactive window is also not
  reported (`FOCUSED` stays empty), so key navigation is verified by effect.
- **Bug found: the desk was never drawn.** A new headless monitor shows the
  lowest free workspace (1), not the desk's (91). Only a monitor's visible
  workspace is composited, so desk windows existed but compositor captures
  showed wallpaper (CDP screenshots hid this). It also meant Super+1 would have
  sent the person to a monitor they cannot see. Fixed by renumbering the new
  monitor's workspace to 91 (`hl.dsp.workspace.change_id`): no focus change.
  Test: "the virtual monitor shows the desk".
- **Bug found: tiled desk windows resized each other.** A lane's window went
  from 1896 to 941 px wide when a second agent opened a window, flipping
  responsive layouts under an agent that did nothing. Desk windows now float at
  1280x800. Test: "a second agent window does not resize the first".

**The bar.** `omarchy/argus.desk` is an Omarchy shell bar widget: an eye with
the number of agent windows, and a panel with one live card per window
(Quickshell `ScreencopyView` on the Wayland toplevel). Captures are pixels, so
the cards cannot send input: watching can never disturb an agent. Windows are
selected by the `argus-desk` app id -- the same rule that routes them to the
desk -- because Quickshell's Hyprland toplevel model returned no workspace for
them. The shell caches QML by path: a symlinked plugin never reloaded, so
`argus bar install` copies it and restarts the shell once when it changed.

`test/demo-desk.sh` runs four agents at once on the desk (checkout recovery,
phone-width audit, overflow check, native app); all four finished in 3.7 s at
full speed with the person's workspace untouched. Its first version printed
"verified" after reading a label GTK had not updated yet; it now waits for the
new count and fails loudly otherwise.

## argusd daemon v0.1

Protocol v0 over a 0600 unix socket; requests validated against the schema
before any code runs, results validated in tests. Measured against the
checkout fixture through the socket (headless Chromium over a pipe):

```
lane.open + load, cold browser       438 ms
lane.open + load, warm               245 ms   (new browser context per lane)
scene.outline                          5 ms   (204 tokens, hit-tested: "covered by div#scrim")
covered click, diagnosed               3 ms   (~125 tokens)
verified click / type                ~160 ms  (150 ms of it is the quiet window)
3-step checkout script               562 ms   (~278 tokens)
bash prototype click, for reference  ~820 ms
```

51 argusd tests: protocol examples, scene fixtures, and 25 end-to-end daemon
tests (shadow DOM, frames, scroll-to-reach, waits, cookie isolation between
lanes, busy lanes, run verdicts, sweeps across 4 conditions). Mutation checks:
disabling the hit test, dropping a failed step's diagnosis (caught only by the
schema) and disabling effect detection each fail the suite.

Found while building it: Chromium keeps writing to its profile until it exits,
so deleting the profile right after `Browser.close` left it behind (8
directories). Shutdown now waits for exit first; a test asserts nothing is left.

## Nests: a whole desktop with its own mouse

The desk shares the person's compositor, so agents could send keys to a window
but never click. A nest is a nested Hyprland (Aquamarine's Wayland backend)
launched through the person's compositor with exec rules
`[workspace 91 silent; float; size W H]`, so it maps on the desk and never on
the person's screen. It has its own seat, cursor and focus.

```
nest up (nested Hyprland ready)          242-350 ms
virtual pointer connect + click          1-2 ms   (wlr-virtual-pointer, spoken on the wire, no library)
type "Sourdough" (wtype, nested)         43 ms
frame capture inside the nest (PPM)      8 ms
AT-SPI tree                              reports FOCUSED inside a nest (it never did on the shared desk)
```

- A GTK4 check box, which has no accessibility action, is clicked with the
  nest's pointer and verified `checked` in the tree.
- Coordinates must be fresh: adding one list item moved the check box from
  y=130 to y=152.
- The pointer refuses the person's own compositor socket (tested).
- The person's active window and workspace are compared before and after
  (tested); the person's cursor moved during the run only because they were
  using the mouse, never to a click coordinate.

**Two bugs found by running everything together.**

- The desk monitor was placed at x=1920, touching the person's screen: a mouse
  pushed past the right edge wandered onto an invisible monitor and took focus
  (the focus spy caught `focusedmon>>HEADLESS-19` while the person used the
  mouse). The desk now sits at -20000,-20000; a test asserts it touches no real
  monitor, and fails when the desk is placed adjacent.
- `argus peek` returned the desk by focusing it and jumping back to the
  workspace saved at peek time, yanking anyone who had moved on. Workspaces now
  move by name; focus changes only for someone still looking at the desk.

During development a monitor rule was applied with an empty output name while
the desk was down, which overrides the default monitor rule at runtime; the
person's named DP-2 rule was unaffected and `hyprctl reload` restored the
default. `desk_rules` now refuses any output that is not `HEADLESS-*`.
