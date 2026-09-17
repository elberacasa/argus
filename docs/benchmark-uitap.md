# Benchmark 2: UI Testing Playground

A neutral benchmark: [uitestingplayground.com](http://uitestingplayground.com)
is a third-party site built to break browser automation, where every page
states its own trap and what success means. The first benchmark
(`docs/benchmark.md`) ran on pages written alongside Argus.

## Head to head: Argus and Claude in Chrome, same model, same judge

Run on 2026-09-17 with `cd argusd && bun bench/h2h.ts --rounds 2`. Every run
is a separate headless Claude Code session (`claude -p --model claude-opus-5`)
whose only tools are one browser tool's: Argus's MCP server, or Claude in
Chrome (`--chrome`, driving the person's own Chromium). Built-in tools are off
and user settings are not loaded. Both get the same task text; the only
difference is one sentence naming the tools. Each challenge runs on both tools
back to back, alternating which goes first.

Neither tool grades itself. Both open the pages through a local proxy that
injects a reporter into every page: it records trusted clicks and sends the
page's real state to the harness, which decides whether the goal was met.

| Challenge | Argus: calls · time, round 1 / round 2 | Claude in Chrome: calls · time, round 1 / round 2 |
|---|---|---|
| Hidden Layers | 5 · 15 s / 5 · 15 s | 5 · 26 s / 4 · 24 s |
| Overlapped | 4 · 12 s / 4 · 12 s | 4 · 24 s / 4 · 21 s |
| Visibility | 6 · 17 s / 5 · 12 s | 4 · 33 s / 4 · 30 s |
| Click | 3 · 10 s / 3 · 10 s | 4 · 24 s / 4 · 25 s |
| Text Input | 2 · 9 s / 2 · 8 s | 3 · 21 s / 3 · 19 s |
| Client Side Delay | 2 · 23 s / 2 · 24 s | 5 · 43 s / 10 · 134 s |
| Non-Breaking Space | 2 · 9 s / 2 · 9 s | 3 · 21 s / 4 · 23 s |
| Scrollbars | 3 · 11 s / 3 · 11 s | 4 · 26 s / 4 · 23 s |
| Shadow DOM | 4 · 12 s / 4 · 12 s | 3 · 18 s / 4 · 52 s |
| Frames | 3 · 11 s / 3 · 11 s | 3 · 16 s / 3 · 18 s |

| 20 runs each | Argus | Claude in Chrome |
|---|---:|---:|
| Goals met (read from the page) | **20 / 20** | **20 / 20** |
| Reported success for something that did not happen | **0** | **0** |
| Tool calls | 67 | 82 |
| Time, total | **252 s** | 620 s |
| Time, median run | **11.5 s** | 23.7 s |
| Tokens (input incl. cache · output) | **756k · 7.5k** | 1,622k · 17.7k |
| Cost | **$0.85** | $1.87 |

**What this says.** On this site, driven by the same model, both tools get
every goal right and neither claims a success that did not happen. Argus does
it in less than half the time, tokens and cost: 2.5× faster in total, 2.1×
faster in the median run, 2.2× cheaper.

**Where the difference comes from, from the transcripts.** On Client Side Delay,
Argus's session made one call that clicked, waited for the label to appear and
clicked it (`{"wait": {"appears": "Data calculated on the client side."}}`).
Claude in Chrome's round-2 session clicked by coordinates, took three
screenshots while the page worked, ran `find`, ran JavaScript to locate the
label, clicked, and ran JavaScript again to confirm what was under the click:
10 calls, 134 s. Across all 20 runs, Argus's sessions took 1 full screenshot and
10 element crops, ran no JavaScript and clicked by element, since each result
already says what changed. Claude in Chrome's sessions took 41 screenshots and
6 zooms, ran JavaScript 30 times to check the page, and clicked by screen
coordinates 27 times.

**Conditions that differ.** Argus ran in a headless browser it launched;
Claude in Chrome ran in a visible tab of the person's Chromium, which is how it
works. Time includes starting each `claude -p` session. Two rounds is a small
sample: Claude in Chrome's time on the same challenge varied from 18 s to 52 s
(Shadow DOM), Argus's by at most 5 s.

**Correction to the earlier comparison below.** Earlier notes and posts said
Claude in Chrome "got 9/10 with 3 false successes". That run was against the
Argus prototype, driven interactively; the three were first attempts later
retried. In this controlled run it had none. Use these numbers.

## A real model through Argus: 10/10, zero false successes

Run on 2026-09-16 with `cd argusd && bun bench/rematch.ts`. Each challenge is a
separate headless Claude Code session (`claude -p`, Claude Opus 5) whose only
tools are Argus's MCP tools: built-in tools off, strict MCP config, no user
settings. The model gets the page's scenario, not hints about how to solve it,
and must end with `RESULT: success` or `RESULT: failure`. The harness hosts the
daemon, installs a click recorder in every page before the page's own scripts
run, and judges the goal from the page itself.

| Challenge | Goal met (read from the page) | Model claimed | Tool calls | Time | Cost |
|---|---|---|---:|---:|---:|
| Hidden Layers | yes: green pressed once | success | 5 | 15.4 s | $0.074 |
| Overlapped | yes: name = "Argus" | success | 4 | 12.0 s | $0.050 |
| Visibility | yes: 7/7 judged not clickable | success | 7 | 16.1 s | $0.078 |
| Click | yes: turned green | success | 3 | 11.7 s | $0.039 |
| Text Input | yes: button reads "Argus" | success | 3 | 10.5 s | $0.042 |
| Client Side Delay | yes: label clicked once | success | 3 | 24.4 s | $0.043 |
| Non-Breaking Space | yes: clicked once | success | 3 | 12.2 s | $0.042 |
| Scrollbars | yes: hidden button clicked once | success | 3 | 11.2 s | $0.043 |
| Shadow DOM | yes: GUID generated and reported exactly | success | 4 | 11.0 s | $0.046 |
| Frames | yes: inner Edit pressed, outer untouched | success | 5 | 14.3 s | $0.068 |

**10/10 goals met, 0 false successes, 40 tool calls, 139 s, $0.53 in total.**
Time includes starting each session; the tool calls include opening the page.

From the transcripts: on Hidden Layers the second press came back
`✗ click button:Button e0.57 · covered`, naming the blue button on top, and the
model confirmed with a 12-image-token crop. On Overlapped the outline had
already flagged the Name field as covered, so the model scrolled it clear
before typing; Argus verified the field held "Argus".

This is one run. The Claude in Chrome figures further down come from an earlier
session driven through its own tools and were not rerun on the same day.

## A scripted agent through argusd: 10/10, zero false successes

Run on 2026-09-16 with `cd argusd && bun bench/uitap.ts`, three times in a row
with identical results.

| Challenge | Result | Argus reported | Ground truth (read from the page) | Calls | Tokens (~) |
|---|---|---|---|---:|---:|
| Hidden Layers | pass | 1st ok, 2nd covered | second click did not land | 4 | 570 |
| Overlapped | pass | expectation-failed → ok | name = "Argus" | 3 | 469 |
| Visibility | pass | Removed: not-found, Zero Width: zero-size, Overlapped: covered, Opacity 0: hidden, Visibility Hidden: hidden, Display None: hidden, Offscreen: offscreen | all 7 unusable after Hide | 9 | 1,034 |
| Click | pass | ok | turned green | 2 | 291 |
| Text Input | pass | ok | button reads "Argus" | 2 | 419 |
| Client Side Delay | pass | ok → ok → ok | label clicked 1× | 2 | 388 |
| Non-Breaking Space | pass | ok | button clicked 1× | 2 | 297 |
| Scrollbars | pass | ok | button clicked 1× | 2 | 272 |
| Shadow DOM | pass | ok, field reported the new GUID | GUID matches the reported value | 3 | 465 |
| Frames | pass | ok on the inner frame's button | inner frame shows "Button pressed: Edit", outer unchanged | 2 | 300 |

**10/10 passed, 0 false successes, 31 calls, ~4,505 tokens.**

**How it is judged.** Each challenge is played through the Argus Protocol, the
way an agent would: from outlines and diagnoses, never page internals. Then the
harness reads the page itself (input values, classes, the page's own warning,
click counters it installed, the text inside the frames) and compares. A false
success is Argus reporting a step as done when the page shows it did not happen.
Tokens are every protocol result the agent reads, at ~4 characters per token;
the harness's own checks are not counted.

**What is scripted.** The agent side is a script that reacts to what Argus
returns, including the one recovery the benchmark needed (Overlapped: the
diagnosis said the field's centre was covered and to scroll it clear, and the
script did). It is not a model. The Claude in Chrome run below was driven by a
model through its tools, on an earlier day, and has not been rerun.

**What changed since the prototype's 7/10.** The Scene comes from the
browser's snapshot, so shadow roots and frames are visible; waits are
expectations; plain text is a target; field values the page fills are reported
(the GUID); a partly covered element is clicked where it is visible; scrolling
to a target continues until its centre is uncovered. The run also exposed a
real bug: `DOM.getNodeForLocation` takes document coordinates, not viewport
ones, so every hit test on a scrolled page had looked at the wrong spot. That
was fixed and a regression test was added.

---

## The prototype against Claude in Chrome (earlier run)

Claude in Chrome ran in the user's Chromium, driven as its tools recommend
(`find` refs, `browser_batch`), with coordinate clicks allowed as the fallback
its `computer` tool offers. The bash prototype ran headless. Same retry policy
for both: a failure that looked intermittent was rerun once; structural
failures were not. Tasks and pass criteria were fixed from the page
descriptions before either tool ran.

### Results

| # | Challenge | Argus | Claude in Chrome |
|---|---|---|---|
| T1 | Hidden Layers: a 2nd click on the green button must not land | **pass** · `covered by button#blueButton` | **fail** · both clicks `Clicked on element ref_18` |
| T2 | Overlapped: type into a partly covered field | **pass** | pass on 2nd try · 1st: `Clicked`, `Typed "Alejo"`, field empty, focus on body |
| T3 | Visibility: judge 7 buttons after Hide | **pass** · text delta caught 2/7, the visual delta showed all 7 gone | pass on 2nd try · 1st: `Clicked`, nothing hid |
| T4 | Click: button that ignores DOM click events | **pass** · seen turning green (136 visual tokens) | **pass** |
| T5 | Text Input: rename a button by typing | **pass** | **pass** |
| T6 | Client Side Delay: wait ~15s, click the label | **fail** · no wait primitive; label is plain text, not a control | **pass** · fixed 17s wait, `find` reached plain text |
| T7 | Non-Breaking Space in a button name | **pass** | **pass** |
| T8 | Scrollbars: button hidden in a scroll view | **pass** | **pass** |
| T9 | Shadow DOM: generate a GUID | **fail** · locator cannot enter shadow roots | **pass** · `find` failed too; screenshot + coordinate click |
| T10 | Frames: click inside nested frames | **fail** · locator cannot enter frames | **pass** · `find` failed too; screenshot + coordinate click |

**Argus 7/10, every pass on the first attempt, and no false successes.**
**Claude in Chrome 9/10 eventually; 7/10 on first attempts, with three
first-attempt results that reported success for something that did not happen**
(T1 structurally, T2 and T3 intermittently).

Cost was comparable. Argus: 24 calls, ~3,700 text tokens and ~800 visual tokens,
plus 14 full-page text polls while waiting in T6. Claude in Chrome: ~29 calls
and a similar total, with roughly 1,500 visual tokens from screenshots and
several `find` calls that are themselves model calls on the extension's side.
No speed ratio is claimed.

### What that run said

**Argus's advantage is the truth of its signals, not token count.** On a neutral
site the costs converged. What did not converge: when a click missed, argus said
why; Claude in Chrome said `Clicked`. An agent acting on "Clicked" builds on a
step that never happened.

**Claude in Chrome is more capable where the DOM is awkward.** Two of its passes
came from a fallback argus does not have: when `find` could not see inside a
shadow root or a frame, it clicked by coordinates from a screenshot. And `find`
reached a plain-text label that argus's role-based locator refuses to consider.

**Argus's gaps, found here and not on its own pages:**

1. Shadow DOM -- the locator uses `document.querySelectorAll`, which does not
   enter shadow roots.
2. Frames -- same, and the probe runs only in the top document.
3. No way to wait for a condition. Settle detection reports network-idle and a
   quiet DOM, which is not the same as "the thing I need exists".
4. Non-interactive text cannot be clicked.
5. An `open` delta returns whole paragraphs uncut in JSON, so the first read of
   a text-heavy page is larger than it needs to be.

A likely fix for 1, 2 and part of 4 without guessing coordinates: `argus marks`
already numbers what a real click would hit via `elementFromPoint`; letting an
agent click by mark number would reach anything visible, whatever DOM structure
sits underneath.
