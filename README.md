<div align="center">

<img src="docs/media/argus.svg" width="112" alt="Argus">

# Argus

**Computer use for Omarchy.**
Agents see the screen, act on it, and are told the truth about what happened.

[Quick start](#quick-start) · [How it works](#how-it-works) · [Protocol](docs/PROTOCOL.md) · [Benchmarks](#benchmarks) · [Performance](docs/performance.md) · [Architecture](docs/ARCHITECTURE.md)

<br>

<a href="docs/media/demo.mp4"><img src="docs/media/demo.gif" alt="Four agents working at once on an invisible desk, watched live from the Omarchy bar" width="100%"></a>

<sub>Four agents at once: a checkout recovering from a blocked button, a phone-width audit, a layout check, and a native GTK app driven with its own mouse. Recorded in real time. Your screen stays yours.</sub>

</div>

---

## Why Argus

**Nothing is reported as done unless it happened.** Every action is verified. A
click on a covered button does not come back as `Clicked`; it comes back as
covered, with the element on top named:

```console
$ argus click "button:Place order"
> click button:Place order
  x covered  button#pay
  covered by div#scrim  z-index:9998 position:fixed
  Another element is painted over the target. Dismiss the overlay, then retry.
```

**Agents get their own screens.** Browsers and apps run on an invisible desk: a
monitor that exists only for agents. Your focus, your cursor and your workspace
are never touched, and the Omarchy bar shows every agent live when you want to
watch. When an app needs a real mouse, a **nest** gives the agent a whole nested
desktop with a pointer of its own.

**Text first, pixels priced.** After an action, an agent reads what changed:
text that appeared or left, fields that filled, requests that failed, errors
that fired. About 105 tokens instead of 1,334 for a screenshot. When a visual
question needs pixels, only the changed regions are sent, with their cost.

**Built for how software is made.** Scripts state what should happen, waits are
expectations rather than sleeps, a run is a test with a verdict, and a sweep
checks the same flow at every screen size and color scheme in parallel.

## Quick start

Argus runs on [Omarchy](https://omarchy.org). It uses what Omarchy ships:
Chromium, Hyprland and its shell.

```bash
git clone https://github.com/elberacasa/argus && cd argus

bin/argus bar install              # the Argus widget in your bar, and `argus` on your PATH
argus desk up                      # an invisible monitor for agents
test/demo-desk.sh                  # watch four agents from the bar
```

Drive a browser yourself:

```bash
argus open https://example.com
argus click "link:Learn more"
argus audit
```

Connect an agent over MCP (Claude Code, opencode, Codex, any MCP client). Agents
started inside this folder pick up the included `.mcp.json`; elsewhere, point
them at the server:

```json
{
  "mcpServers": {
    "argus": { "command": "/path/to/argus/bin/argus-mcp" }
  }
}
```

## How it works

| | What it is | Command |
|---|---|---|
| **Lanes** | Isolated browsers, many at once. Each action returns a verified delta. | `argus --lane N ...` |
| **Desk** | A Hyprland monitor only agents use, placed where no cursor can reach. Real, headful windows. | `argus desk up`, `argus --desk ...` |
| **Nests** | A nested Hyprland inside the desk with its own seat: real clicks and keys for native apps, read through their accessibility tree. | `argus nest up`, `argus nest click-on ...` |
| **Your browser** | Tabs in your own Chromium, with your logins, through an extension. Only tabs Argus opened. No debugging port. | `argus own install`, `argus --own ...` |
| **The bar** | Live, view-only cards for every agent window, with peek and stop. | `argus bar install` |
| **argusd** | The daemon that speaks the Argus Protocol over a private socket. | `argusd serve` |

### The protocol

The standard is the protocol, not the implementation: JSON-RPC over a unix
socket, with a JSON Schema and examples every implementation must pass. One
action is a script of one step, so batching is the default:

```json
{"method": "act", "params": {"lane": "l1", "steps": [
  {"click": "button:Accept",      "expect": {"disappears": "This site uses cookies."}},
  {"type":  ["textbox:Email", "agent@example.com"]},
  {"click": "button:Place order", "expect": {"appears": "Order placed", "within": "20s"}}
]}}
```

The script stops at the first surprise and says why, from a fixed set of
reasons: `covered`, `disabled`, `hidden`, `offscreen`, `ambiguous`,
`not-found` with near matches, `expectation-failed`, `timeout` and a few more.
[Read the protocol](docs/PROTOCOL.md).

## Performance

Measured on one machine and reproducible from the test suites.
[Full method and numbers](docs/performance.md).

| | |
|---|---:|
| Observing one click (delta vs 1280×800 screenshot) | ~105 vs 1,334 tokens |
| Diagnosing a covered click, naming the blocker | 3 ms |
| Page outline, hit-tested | 5 ms, ≤250 tokens |
| One verified step in argusd | ~160 ms |
| Nested desktop ready | ~300 ms |
| Real click inside a nest | 1–2 ms |
| 12 browser lanes | 4.9 GB |

## Benchmarks

Two head-to-heads against Claude in Chrome on the same machine, with every
call and token counted.

**On Argus's own test pages** ([details](docs/benchmark.md)): across the five
tasks both tools attempted, ~1,880 tokens for Argus and ~5,540 for Claude in
Chrome. Argus named every blocked click and failed request; Claude in Chrome
reported a blocked click as `Clicked`. These pages were written alongside
Argus, so the second benchmark uses a neutral site.

**On [UI Testing Playground](http://uitestingplayground.com)**, a third-party
site built to break automation ([details](docs/benchmark-uitap.md)):

| | Passed | Reported success for something that did not happen |
|---|---:|---:|
| Argus prototype | 7 / 10 | **0** |
| Claude in Chrome | 9 / 10 | 3 |

Token cost was similar on the neutral site. Argus's three misses (shadow DOM,
frames, waiting for a slow element) are the gaps `argusd` was built to close,
and its daemon tests now cover all three; the benchmark will be rerun through
it.

## Safety

- **Never touches what it did not create.** Processes, tabs and windows are
  identified by ownership, never by name.
- **No ports.** Browsers are driven over pipes, the daemon listens on a socket
  only your user can open, and your own browser is reached through native
  messaging.
- **Your session stays yours.** Agents never take your focus or cursor; the
  virtual pointer refuses to drive your own compositor; nests never enter your
  session environment. Each is covered by a test.
- **Secrets never reach a model.** Typing a secret names it; the value is
  resolved only after you approve. *(Approval is designed, not built yet.)*
- **Destructive Omarchy commands** require explicit confirmation.

## Status

Argus is a preview. The `argus` command, desks, nests, the bar widget and the
own-browser bridge work today and are tested on every change. `argusd` speaks
Protocol v0 for browser lanes: verified `act`, outlines, `check` (accessibility,
layout, runtime), priced screenshots and crops, `run`, `sweep` and traces.
Desk, own-browser and native-app lanes are moving into it next, then the
`argus` command becomes a thin client of the daemon. The protocol may change
until v1.

## Development

```bash
./test/run.sh                                            # core suite
ARGUS_TEST_DESK=1 ARGUS_TEST_NESTED=1 ./test/run.sh       # plus desks and nests (takes over nothing on your screen)
cd argusd && bun install && bun test                     # daemon, protocol and scene tests
scripts/record-demo.sh                                   # re-record the demo above
```

## License

[MIT](LICENSE)
