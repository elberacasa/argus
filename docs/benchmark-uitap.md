# Benchmark 2: UI Testing Playground

A neutral benchmark: [uitestingplayground.com](http://uitestingplayground.com)
is a third-party site built to break browser automation, where every page
states its own trap and what success means. The first benchmark
(`docs/benchmark.md`) ran on pages written alongside Argus.

## argusd: 10/10, zero false successes

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
