# Performance

Every number here was measured, on one machine, and says how. Where a figure is
an estimate it is labelled as one. This page is the summary; the complete
record, including what went wrong on the way, is [measurements.md](measurements.md),
and the head-to-head benchmarks are [benchmark.md](benchmark.md) (Argus's own
test pages) and [benchmark-uitap.md](benchmark-uitap.md) (UI Testing Playground,
a neutral third-party site).

**Reference machine:** 24 cores, 31 GB RAM, RTX 3080 Ti, Omarchy on Hyprland
0.56.2, Chromium 152.

**Token figures.** Image tokens are exact, from the published formula for
current Claude models: `ceil(width/28) × ceil(height/28)`. Text tokens are
estimates at about four characters per token and are marked `~`.

## What an agent pays to observe one click

Measured on `news.ycombinator.com`, one click.

| Observation | Size | Relative |
|---|---:|---:|
| Argus delta (what the click changed) | ~105 tokens | 1× |
| Re-reading the page as text | ~1,061 tokens | 10× |
| Screenshot, 1280×800 | 1,334 tokens | 13× |
| Screenshot, 1920×1080 | 2,691 tokens | 26× |
| Re-reading raw HTML | ~10,451 tokens | 99× |

The delta is not only smaller, it is causal: it states the text that appeared,
the text that left, the fields that changed and the requests that failed.

When a visual question needs pixels, Argus sends only the regions that changed:

| Evidence | Size | Image tokens |
|---|---|---:|
| Visual delta for "Place order" (2 regions) | 708×162 | 156 |
| Crop of one covered button | 168×88 | 24 |
| Full 1280×800 screenshot, for comparison | 1280×800 | 1,334 |

## argusd

The daemon, through its socket, against the checkout fixture in
`test/fixture.html` served locally. Headless Chromium owned over a pipe.

| Operation | Time |
|---|---:|
| Open a lane and load a page, browser cold | 438 ms |
| Open a lane and load a page, browser warm | 245 ms |
| Page outline (204 tokens, hit-tested) | 5 ms |
| Diagnose a covered click, naming the blocker | 3 ms |
| One verified click or type | ~160 ms |
| Three verified steps (dismiss, type, place order) | 562 ms |
| `check` on the checkout, all categories (median of 10; ~510 tokens) | 2 ms |
| Crop of one element, waiting for images (`evidence.look`, 18 image tokens) | 51 ms |

About 150 ms of each verified step is the quiet window: the page must show no
network activity and no DOM mutation for 150 ms before a step is judged.

Reproduce: `cd argusd && bun test test/daemon.test.ts`.

## Real sites

`cd argusd && bun bench/speed.ts`: medians of three interleaved rounds per site
in a throwaway lane, in milliseconds. "Browser to DOMContentLoaded" is the same
browser navigating with no Argus work, the floor no tool can beat. The network
swings between runs (Wikipedia's own load went from 1.0 s to 6.1 s between two
runs an hour apart), which is why both columns are measured interleaved.

| Site | Browser to DOMContentLoaded | Argus open | of which settle | Outline | No-op step | Check | Screenshot |
|---|---:|---:|---:|---:|---:|---:|---:|
| example.com | 829 | 592 | 157 | 1 | 158 | 3 | 16 |
| news.ycombinator.com | 2,165 | 1,109 | 155 | 20 | 180 | 26 | 54 |
| en.wikipedia.org (article) | 6,052 | 6,987 | 1,279 | 48 | 246 | 95 | 49 |
| github.com (repository) | 2,739 | 5,231 | 1,773 | 33 | 223 | 67 | 89 |
| youtube.com | 2,549 | 6,953 | 4,015 | 22 | 196 | 40 | 43 |

## Real tasks

`cd argusd && bun bench/flows.ts`: whole tasks, each ending in an expectation
that only holds if the task happened. Medians of three rounds; every round of
every flow passed.

| Task | Steps | Total | Slowest step, and why |
|---|---|---:|---|
| Hacker News: open, go to "new" | open, click | 1,751 | the click, 468: the browser alone takes a median 497 from click to DOMContentLoaded |
| Wikipedia: search for an article | open, type, Enter | 5,212 | Enter, 2,090: the article loads |
| GitHub: repository to its issues | open, click | 12,011 | open, 9,842: GitHub took 8.8 s to return the document that run |
| DuckDuckGo: search | open, type, Enter | 9,424 | Enter, 4,802: results arrive in a script that finishes about 4.4 s after the key |

**Where the time goes.** In every step, Argus's own work (scene before and
after, locating, the hit test, the input events) adds 30 to 150 ms. The rest is
the page: the step waits until what it caused has finished, so the result
describes the page the agent will act on next.

**What an earlier version got wrong, and what fixing it cost.** Settling first
ignored script and stylesheet requests and capped waiting at 1.5 s. That was
fast and wrong on modern apps. A click on GitHub's "Issues" pushes the new URL
at about 0.5 s, then loads the code for the issues view and renders it at 2 to
4 s. Argus reported the click at 0.9 s with the old page still on screen, in 2
of 2 runs. On DuckDuckGo, Enter was reported at 0.55 s, before the results page
had arrived. Now scripts and styles a step started count as the page reacting,
and while any request a step started is still loading, the cap extends up to
6 s. The GitHub click reports the issues page (title and content) whenever
GitHub renders it within that time; the Hacker News click is unchanged. A
regression test reproduces the pattern: a router that fetches, pushes the URL,
then loads its view's code for 3.5 s.

**What changed before that.** The first measurement had YouTube at 19.0 s to
open and 3.0 s for a step that does nothing, and an X page in the person's own
browser at 21.8 s. Navigation waited for the `load` event (every image; 11.7 s
on the Wikipedia article), and settling treated streaming video, beacons, images
and fonts as the page still reacting, so a live page always ran to the 15 s
limit. Now a navigation is ready at DOMContentLoaded, streams, beacons, images
and fonts never count, and requests open for more than 5 s are background
traffic.

**Calling Argus from a shell.** Each `argus` command is a new process: about
85 ms per call on this machine, of which the daemon's work on an outline or a
check is about 10 ms. The first command also starts the daemon and its
browser: 610 ms.

## Desks and nests

| Operation | Time |
|---|---:|
| Nested desktop ready (`argus nest up`) | 242–350 ms |
| Virtual pointer: connect and click | 1–2 ms |
| Type a word into a nested app | 43 ms |
| Frame capture of a desk (raw PPM, 1080p) | 13–17 ms |
| Frame capture inside a nest | 8 ms |
| Accessibility tree of a small GTK app | 3–4 ms |
| Key sent to one window on the shared desk | 3–4 ms |

PNG encoding of a full 1080p frame costs about 620 ms on its own, so Argus
captures raw frames and encodes only the crops it sends.

Reproduce: `ARGUS_TEST_DESK=1 ARGUS_TEST_NESTED=1 ./test/run.sh`.

## Context

| Tool surface | Size |
|---|---:|
| Every Omarchy command as a flat tool list | ~15,031 tokens |
| The Argus MCP surface, progressive | ~542 tokens |
| Eight MCP round trips | 133 ms |

## Memory

| Layout | Resident memory |
|---|---:|
| 12 lanes as separate browser sessions | 13.3 GB |
| 12 lanes as tabs over a pool of 4 browsers | 4.9 GB |
| 8 tabs in one browser | 2.3 GB |

## What the numbers do not claim

- No end-to-end task speed is compared with other tools: an agent's wall time
  is dominated by model turns, which Argus does not control.
- On third-party sites built to break automation, token cost per task is
  similar between text-first and screenshot-driven agents. What differs is
  whether a reported success actually happened.
