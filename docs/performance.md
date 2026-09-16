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
| `check` on the checkout (snapshot rules, frames and shadow roots included) | ~200 ms |

About 150 ms of each verified step is the quiet window: the page must show no
network activity and no DOM mutation for 150 ms before a step is judged.

Reproduce: `cd argusd && bun test test/daemon.test.ts`.

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
