# Head-to-head: argus vs Claude in Chrome

Same pages, served over local HTTP, same goals, on the same Omarchy machine.
Claude in Chrome was driven the efficient way its own tool descriptions
recommend -- `find` for element refs, clicks by ref, `browser_batch` to cut
round trips -- not by screenshot-and-click. Argus was measured as an agent sees
it over MCP: `--json` output.

## Results

| Task | Claude in Chrome | | Argus | |
|---|---|---|---|---|
| | calls · tokens | outcome | calls · tokens | outcome |
| **T1** click blocked by a cookie scrim, then recover | 4 · ~1,450 | done; blocked click reported as `Clicked`; failed request **missed** | 4 · ~421 | done; `covered by div#scrim`; `GET /api/receipt 404` |
| **T2** find out what a button behind `confirm()` does | -- | **not attempted**: its guidance says a native dialog freezes the extension | 4 · ~336 | confirm reported and dismissed; accepted on retry |
| **T3** upload to a hidden file input | 2 · ~212 | done, verified in page | 2 · ~200 | done, verified in page |
| **T4** find UI/UX defects on a checkout | 1 · ~1,270 | 1 of 6 stated; 3 inferable from pixels; 2 unavailable | 2 · ~522 | all 6 stated, with measured values |
| **T5** sideways overflow at phone width | 1 · ~555 | resize reported success, window unchanged; overflow inferable, cause not | 4 · ~208 | `table.visually-hidden +490px` at emulated 390px |
| **T6** what visibly changed after an action | 2 · ~2,050 | two full screenshots for the model to compare | 3 · ~527 | changes stated in text; 2 cropped regions |

Across the five tasks both tools attempted (T1, T3-T6): **~5,540 tokens for
Claude in Chrome, ~1,880 for argus** -- about 2.9x fewer -- before counting
what each was told.

Token figures: images exact by the published formula `ceil(w/28) * ceil(h/28)`
on the size each tool actually returned; text at ~4 characters per token
(Claude in Chrome's text lengths are approximate). Wall time is not compared:
Claude in Chrome's includes model turns between calls, and `find` is itself a
model call on the extension's side.

## Where Claude in Chrome did well

- **T3 was a tie.** `find` resolved the hidden file input from its label and
  `file_upload` set the file in one step, verified in the page.
- `find` resolved every target on the first try, including "Accept cookies
  button, and the Place order button" as two refs in one call.
- `browser_batch` genuinely reduced round trips.
- It finished every task it attempted.

## Where argus did better, and why

**T1 -- a failed click reported as success.** `left_click` on a covered button
returned `Clicked on element ref_7`. The block was only visible as a grey tint
in a screenshot. Argus hit-tests the target first and returned
`reason: covered, coveredBy: div#scrim`. The page's failing `/api/receipt`
request was missed by Claude in Chrome because `read_network_requests` starts
tracking when it is first called; argus's probe is installed before any page
script runs.

**T2 -- dialogs.** Not a scoring loss for Claude in Chrome so much as a gap it
documents itself: a button that asks "Delete your account?" cannot be
explored without freezing the browser.

**T4 -- what the tools state, versus what a model must infer.** From the
accessibility tree and a screenshot:

| Defect | Claude in Chrome | Argus |
|---|---|---|
| unnamed icon button | stated (`button [ref_10]`, no name) | stated |
| sideways overflow | inferable: scrollbar in screenshot | `+552px`, element named |
| 9px text | inferable: visibly small | `9px`, element named |
| low contrast | inferable, but the scrim dims the whole screenshot | `2.07:1`, needs 4.5:1 |
| h1 → h4 skip | **unavailable**: tree shows `heading` without levels | stated |
| email field has no accessible name | **hidden**: tree labels it from its placeholder | stated |

**T5 -- a success that did not happen.** `resize_window` returned
`Successfully resized window ... to 390x844`; Hyprland kept the tiled window at
941x960 and the screenshot came back 555x666 (scaled). A scrollbar showed the
page overflows, but the cause -- an invisible screen-reader table -- cannot be
seen or found in the tree. Argus emulates a 390px mobile viewport and names it.

**T6 -- the model as a diff engine.** Two 941x783 screenshots at 952 visual
tokens each, and the click marker the extension draws moved between them, a
difference that is not in the page. Argus's text delta already said what
changed, and `--see` returned only the two changed regions: 156 visual tokens.

## Caveats

- **The test pages were written alongside argus**, to exercise the failure
  modes it was built to diagnose. They are real, common failures -- cookie
  scrims, confirm dialogs, hidden file inputs, contrast -- but they are not a
  neutral sample, and a benchmark on pages chosen by someone else could differ.
- The same model drove both tools and knew the planted defects. T4 is scored on
  what the tools' output states, not on what that model then concluded.
- The user's mouse was over the Claude in Chrome window during T4-T6; the
  screenshots were checked and show no hover state.

## What went wrong running it

The first attempt stalled after T1, and the first write-up blamed the machine
being in use. Two actual causes:

1. **Cleanup killed the user's browser.** It ran `pkill -9 -x chromium`, which
   matches every Chromium on the machine -- including the user's, with the
   extension in it. This happened repeatedly during development. Argus now stops
   only processes it can prove it started (see `docs/measurements.md`).
2. **The extension then fell back to a different computer.** Two browsers were
   connected: this machine and the user's Mac. With the local browser gone,
   later calls went to the Mac, where `127.0.0.1:8765` is the Mac itself and
   nothing listens -- hence error pages, while the server here saw no requests
   and `https://example.com` loaded fine. Tab IDs changed series, which was the
   visible clue. Selecting the local browser explicitly fixed it.

## To rerun

```
cd ~/Work/argus && python3 -m http.server 8765 --bind 127.0.0.1
```

and select this machine's browser in Claude in Chrome before the first call.
