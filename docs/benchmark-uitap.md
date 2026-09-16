# Benchmark 2: UI Testing Playground

A neutral benchmark. The first one (`docs/benchmark.md`) ran on pages written
alongside argus. This one uses [uitestingplayground.com](http://uitestingplayground.com),
a third-party site built to break browser automation, where every page states
its own trap and what success means. Tasks and pass criteria were fixed from
those descriptions before either tool ran.

Claude in Chrome ran in the user's Chromium, driven as its tools recommend
(`find` refs, `browser_batch`), with coordinate clicks allowed as the fallback
its `computer` tool offers. Argus ran headless. Same retry policy for both: a
failure that looked intermittent was rerun once; structural failures were not.

## Results

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

## What this benchmark says that the first one did not

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
