# Argus architecture

**Argus is the eyes and hands layer of the operating system.** Any agent, any
model, any browser tab or desktop app: one protocol to see what is there, act on
it, and be told the truth about what happened.

This document is the blueprint. Everything in it is either measured on this
machine or marked as a decision still to be made. The bash implementation in
`bin/` and `lib/` is the reference implementation of v0; its test suite and the
two benchmarks are the executable specification the foundation must pass.

---

## 1. What the evidence says

Every design decision below traces to something we measured.

| Finding | Evidence | Consequence |
|---|---|---|
| **The browser is not the bottleneck. Model turns are.** | Argus tool time ~0.3s/step; Claude in Chrome 37s for 4 steps, almost all model turns | Speed comes from fewer model turns: scripts, a fast decision tier, recipes |
| **A false "success" is the most expensive failure** | Claude in Chrome: `Clicked` on a covered button, `Typed` into nothing, `resized` a window that did not resize | Every action must be verified. No silent success, ever |
| **Text first, pixels on demand** | Delta ~105 tokens vs 1,334 for a 1280x800 screenshot; visual delta 156 tokens for 2 changed regions | Observations are text; images are cropped evidence, requested and priced |
| **On neutral sites, token cost converges** | UITAP: ~4.5k tokens each; Argus 7/10 with zero false successes, Claude in Chrome 9/10 with three | The edge is truthfulness and reach, not only size. Reach must be fixed |
| **In-page locators cannot see shadow DOM or frames** | UITAP T9/T10 failed | Perception must come from the browser, not from page JavaScript |
| **The browser's own snapshot can** | `DOMSnapshot.captureSnapshot`: shadow-root input found; frames page returned 3 documents in one call | The Scene is built from DOMSnapshot + accessibility + hit-testing |
| **A private pipe beats a port and a driver** | `--remote-debugging-pipe`: 125ms, 0 TCP ports | argusd owns browsers over pipes. No chromedriver, no ports |
| **Native apps have the same kind of tree** | `at-spi2-core` bus live | One Scene model for web pages and desktop apps |
| **Per-call CLI processes do not scale** | Each argus call spawns dozens of curl/jq processes and re-discovers its session | A long-lived daemon holds connections, events and state |
| **Ownership mistakes are catastrophic** | `pkill chromium` killed the user's browser; the extension then drove a different computer | Ownership and targeting are explicit, checked, and tested |

---

## 2. The constitution

Seven invariants. A change that breaks one is a bug, whatever else it improves.

1. **No silent success.** Every action returns verified evidence of its effect or a diagnosis of why there was none.
2. **Never touch what argus did not create.** Processes, tabs, windows, files. Ownership is proven, never inferred from a name.
3. **No ports.** Private channels only: pipes, unix sockets with 0600, native messaging.
4. **Text first, pixels on demand, cost always reported.**
5. **One protocol.** The CLI, MCP, and every SDK are adapters. Nothing talks to browsers except argusd.
6. **The executor is deterministic. Models only decide.** Clicking, waiting, verifying are code. Choosing is a model.
7. **Everything is traced and replayable.**

---

## 3. The shape

```
  agents:  Claude Code · opencode · codex · any MCP client · scripts · humans
                │                  │                    │
           argus CLI          argus-mcp             SDKs (TS, py)
                └──────────────────┼────────────────────┘
                                   │  Argus Protocol (JSON-RPC 2.0)
                                   │  $XDG_RUNTIME_DIR/argus/argus.sock  (0600)
  ┌────────────────────────────────▼─────────────────────────────────────────┐
  │ argusd  (systemd --user service, one per person)                         │
  │                                                                          │
  │  Executor ── scripts, expectations, waits, verification, diagnosis       │
  │  Scene ───── DOMSnapshot + accessibility + hit-test → refs, outline      │
  │  Eyes ────── crops, visual deltas, marks, compositor deltas              │
  │  Decider ─── typed questions → none | local model | Jev | frontier       │
  │  Recipes ─── record, replay, repair, share                               │
  │  Trace ───── every step, every observation, streamable                   │
  │  Policy ──── lane kinds, scopes, destructive gates, secrets              │
  │                                                                          │
  │  Backends:                                                               │
  │   chromium (pipe)   own browser (extension)   desk (Hyprland)            │
  │   native apps (AT-SPI)   Omarchy commands   compositor (Hyprland IPC)    │
  └──────────────────────────────────────────────────────────────────────────┘
```

---

## 4. The Argus Protocol

The standard is the protocol, not the implementation. Versioned, with a JSON
Schema, so a Firefox backend or a macOS implementation could conform to it.
**The normative v0 spec is [PROTOCOL.md](PROTOCOL.md)** with
[`protocol/argus.schema.json`](../protocol/argus.schema.json); this section is
the rationale. Beyond driving, v0 makes debugging and testing first-class:
`check` (a11y, layout, runtime, perf findings with standard rule ids), `run`
(a script as a test with a verdict) and `sweep` (one script across viewports
and color schemes in parallel lanes).

**Transport.** JSON-RPC 2.0, newline-delimited, over a unix socket (0600 in a
0700 directory). `hello` negotiates version and capabilities.

### 4.1 Targets and lanes

A **lane** is an isolated place an agent works. Kinds:

| Kind | What it is | Can act on the person's accounts |
|---|---|---|
| `throwaway` | headless Chromium over a pipe, temporary profile | no |
| `desk` | headful Chromium on a Hyprland virtual monitor | no |
| `own` | a tab argus opened in the person's own browser, via the extension | **yes**, scoped to that tab |
| `app` | a native window, through AT-SPI and Hyprland | as the app allows |

`lane.open {kind, url?}` · `lane.close` · `lane.list`

### 4.2 The Scene: how agents see

One model for pages and apps, built from the source of truth rather than page
JavaScript.

- **Elements** carry a **ref** (`e<n>`), role, accessible name, bounds, frame
  path, and **reachability**: whether a real click at its centre would hit it,
  and if not, what would.
- Refs are stable while the node lives, and re-resolve after a re-render through
  a fingerprint (role, name, structural path).
- `scene.outline` returns landmarks, headings, forms and actions in about 250
  tokens. `scene.expand {ref}` opens one region. Progressive disclosure, the same
  way argus-mcp serves 367 Omarchy commands in 542 tokens.
- `scene.find {role?, name?, text?, near?}` returns refs. Plain text is findable
  and actionable, not only controls (UITAP T6).

### 4.3 Acting: every call is a script

There is no separate single-step API. One action is a script of length one, so
batching is the default rather than an optimisation.

```json
{"method": "act", "params": {"lane": "l1", "steps": [
  {"click": "button:Accept",      "expect": {"disappears": "cookies"}},
  {"type":  ["textbox:Email", "a@b.c"], "expect": {"field": "a@b.c"}},
  {"click": "button:Place order", "expect": {"appears": "Order confirmed", "within": "20s"}}
]}}
```

The executor runs steps at machine speed, verifies each expectation, and stops
at the **first surprise**, returning the observations so far plus a diagnosis.
The model is called again only when reality differs from the plan.

**Waiting is an expectation**, not a sleep: `{"appears": "...", "within": "30s"}`
watches deltas until it holds (UITAP T6).

### 4.4 What comes back

- **Observation** -- the delta: text added/removed, fields, focus, dialogs,
  downloads, failed requests, console errors, layout shift, compositor changes,
  settle time, and `verified: true|false` against the step's expectation.
- **Diagnosis** -- a closed set of reasons: `covered` (with the blocker's ref),
  `disabled`, `hidden`, `offscreen`, `zero-size`, `ambiguous` (with candidates),
  `not-found` (with near matches), `detached`, `expectation-failed`, `timeout`,
  `probe-error`. Each carries evidence.
- **Evidence** -- pixels only when asked or when a diagnosis needs them: an
  element crop, a visual delta, marks. Always with its visual-token cost.

### 4.5 Deciding: the fast tier

Most per-step judgments do not need a frontier model. They are typed questions:

| Question | Type | Example |
|---|---|---|
| Which element is meant? | choice (≤255 refs) | ambiguous "Save" |
| Did this step achieve its goal? | yes/no | expectation stated loosely |
| Is the thing I am waiting for there yet? | yes/no over a delta | long client-side work |
| Which results matter? | score | search results, listings |

Following TypeSafe's design, independent questions are asked **together over
one shared state** and combined deterministically in code: verifying a step
sends every expectation about one observation in a single call, not one call per
expectation.

`decide {state, questions: [{kind, question, options?}]}` goes to a pluggable **decider**:
`none` (fail with a diagnosis), `local` (a small model on the machine's GPU),
`jev` (TypeSafe's typed-decision model), `frontier`. The Scene is text, so
text-only deciders work; argus never has to send pixels to decide.

### 4.6 Confidence-gated autonomy

Every fuzzy judgment argus makes carries a confidence: which element a name
meant, whether a step achieved its goal, whether a recipe repair is right. The
policy turns confidence into one of four outcomes:

| Confidence | Outcome |
|---|---|
| at or above the lane's act threshold | act |
| below it, a decider is configured | ask the decider |
| still below | escalate to the frontier model with the diagnosis |
| the step is destructive, or touches secrets | ask the person, whatever the confidence |

Thresholds depend on the lane kind: a throwaway browser may act on less
certainty than a tab logged into the person's accounts. Calibration is a
property of many decisions, not one, so traces record every judgment and its
outcome, and conformance checks that argus's own confidences are calibrated.

### 4.7 Recipes: doing it twice costs nothing

A script that ran to completion can be saved as a recipe for its origin,
with the expectations that proved it worked. Replaying one costs no frontier
tokens. When a step drifts -- a renamed button -- the decider repairs it as a
choice among the Scene's refs, and the recipe is updated. The frontier model is
called only when the repair fails.

Every Omarchy machine is the same machine, so a recipe that works on one works
on the next. Recipes are shareable.

### 4.8 The rest of the machine

| Namespace | What it reaches |
|---|---|
| `os.*` | the Omarchy command catalogue, served progressively, destructive commands gated |
| `desk.*` | Hyprland virtual monitors, silent window routing, `peek` |
| `app.*` | native windows through AT-SPI, with the same Scene and `act` |
| `trace.*` | replay and live subscription |
| `recipe.*` | save, run, list, share |

### 4.9 Invisible desks: where agents work

Agents do not need the person's screen. A **desk** is a Hyprland headless
monitor: windows on it are real (GPU, fonts, Wayland), composited, capturable,
and never shown unless someone looks. Measured in `docs/performance.md`
("Desks and nests"); the full record is `docs/measurements.md`.

| Layer | Browser windows | Native apps |
|---|---|---|
| eyes | CDP screenshots; compositor capture (13ms raw frame) | compositor capture |
| tree | Scene (DOMSnapshot) | AT-SPI (3-4ms for a small app) |
| hands | CDP input, focus-free | AT-SPI actions and EditableText; keys to one window via `hl.dsp.send_shortcut`, focus-free |
| verify | deltas | tree state re-read |
| pointer | -- | **nests**: a nested Hyprland with its own seat; wlr-virtual-pointer clicks, wtype keys (`argus nest`) |

Rules the desk keeps: its monitor always shows the desk workspace (so it is
drawn, and no workspace key sends the person there); every desk window floats
at a fixed size (a lane's viewport never changes because another agent opened a
window); routing is by the `argus-desk` class, set before a window maps.

**Watching** is a first-class Omarchy surface, not a screenshot tool: the
`argus.desk` bar widget shows every agent window as a live, view-only card.
Screencopy is pixels, so watching can never send input to an agent. `Peek`
brings the whole desk onto the person's monitor; `Stop agents` ends the desk.

A **nest** is a whole desktop for one agent: a nested Hyprland launched on the
desk through exec rules, with its own seat, cursor and focus. Pointer input is
spoken to the nest's socket only (the pointer refuses the person's own
compositor), so pointer-only widgets are reachable without touching the
person's session. The desk monitor sits far from every real monitor, so the
person's mouse cannot wander onto it.

Next: `app` lanes in the protocol (AT-SPI Scene, nest pointer and keys, the
same act/expect/diagnosis model); live cards captioned with argusd step events.

---

## 5. Omarchy-first, concretely

Every integration point below was verified on this machine.

| Surface | How Omarchy does it | What argus uses it for |
|---|---|---|
| **Quickshell shell** | `omarchy-shell` hosts the bar and panels as plugins, loading third-party plugins from disk (`manifest.json`, QML entry points). Omarchy already ships an `omarchy.agents` bar plugin | **built:** `argus.desk` bar widget, live view-only cards per agent window, peek, stop (`argus bar install`) |
| **polkit plugin** | Omarchy's native prompt for privileged actions | the approval surface for secrets and destructive steps |
| **systemd user services** | session services | `argusd` as a per-user service |
| **Hooks** | `omarchy hook install post-update <file>` | surviving Omarchy updates (already used by `argus own install`) |
| **Chromium extensions** | `--load-extension` in `chromium-flags.conf` plus native messaging hosts | own lanes (built) |
| **Hyprland** | Lua config, runtime `hl.window_rule`, IPC sockets, headless outputs | the desk, compositor deltas, peek, keybindings |
| **Command catalogue** | 440 `omarchy-*` commands with `# omarchy:` metadata | `os.*`, served progressively (built) |
| **Keyring** | Chromium uses `gnome-libsecret` | resolving named secrets after approval |
| **Accessibility bus** | `at-spi2-core` running | native app lanes |

## 6. Trust

Agents here can reach everything the person can. That is the point, and it is
why trust is designed rather than hoped for.

- **Lane kinds are capabilities.** Only `own` lanes can act on accounts, only in
  tabs argus opened, only while the person's browser shows it is being debugged.
- **Destructive operations are gated**: 103 Omarchy commands today, the same
  mechanism for app actions later.
- **Secrets never pass through an agent.** A step says `{"type": ["textbox:Password", {"secret": "github"}]}`;
  argusd resolves it from the system keyring (Omarchy's Chromium already uses
  gnome-libsecret) only after the person approves that use. The model never sees
  the value. *(Designed; not built. Needs an approval surface.)*
- **Visible and stoppable.** An indicator for active lanes, a keybinding that
  stops every agent, and `peek` to watch any desk. *(Designed; Omarchy
  integration points to be confirmed.)*
- **Everything is traced.**

---

## 7. Conformance

A standard is what other implementations can be checked against.

| Level | Proves | Source today |
|---|---|---|
| Core | lanes, scene, act, observations, diagnoses | `test/run.sh` (93 assertions) |
| Eyes | crops, visual deltas, marks | `test/run.sh` eyes section |
| Own | extension bridge, scoping, shutdown | `ARGUS_TEST_OWN=1` (12) |
| Desk | virtual monitors, focus safety | `ARGUS_TEST_DESK=1` (9) |
| Ownership | never touches foreign processes | decoy test |
| Field | neutral sites with published answer keys | UITAP (10 challenges), W3C BAD demo |

**Budgets** the foundation is held to: action overhead under 100ms beyond the
page's own work; a typical observation under 150 tokens; an outline under 250;
no call that hangs without a timeout; UITAP 10/10 with no false successes.

---

## 8. Build order

Each phase ends with the conformance suite green. The bash implementation stays
until argusd passes everything it passes.

1. **Protocol v0 and schema.** Written before code, versioned.
2. **argusd core.** Chromium over a pipe, CDP client, lanes, the Scene from
   DOMSnapshot, `act` with expectations and verification, CLI adapter. Gate:
   the current suite passes through the CLI.
3. **Reach.** Shadow DOM, frames, text targets, `within` waits. Gate: UITAP 10/10.
4. **Eyes, desk, own browser** ported onto the daemon.
5. **Decider interface** with `none` and `local`; `jev` when access exists.
6. **Recipes.**
7. **Native apps** through AT-SPI.
8. **Omarchy packaging**: a single binary, a systemd user unit, the MCP adapter
   registered for every agent `omarchy-agent` supports.

---

## 9. Decisions still open

1. ~~**Implementation language for argusd.**~~ Decided: TypeScript on Bun. See §9.1.
2. **Local decider model** -- which small model, measured for latency and
   accuracy on Scene questions, on this GPU.
3. ~~**Approval surface**~~ -- a Quickshell prompt following Omarchy's polkit plugin.
4. ~~**Where the lane indicator lives**~~ -- an Omarchy bar widget plugin, beside `omarchy.agents`.

### 9.1 Language: TypeScript on Bun

Decided with Omarchy as the lens. Omarchy's own layers are bash (commands),
Quickshell -- QML with JavaScript -- (the shell, bar and panels), Lua (Hyprland),
and Ruby. Argus touches four surfaces: page code inside Chromium, the browser
extension, the Omarchy shell plugin, and the daemon. **JavaScript is the only
language that runs on all four**, so argus is one typed codebase end to end, with
CDP types generated from Chromium's own protocol definition. Bun is installed and
compiles to a single binary, so people installing argus need no runtime. The
cost is a larger daemon than Go or Rust would produce; the browser, not the
daemon, dominates memory.

Options considered:

The page-side code (probe, audit, locate, marks) and the extension are
JavaScript today and will stay JavaScript: they run inside Chromium.

| | TypeScript on Bun | Go | Rust |
|---|---|---|---|
| Ships as | single compiled binary | single static binary | single static binary |
| On this machine | installed | not installed (build-time only) | not installed (build-time only) |
| CDP types | generated from Chromium's protocol definition | generated (cdproto) | available, less mature |
| One language with page code and extension | **yes** | no | no |
| Daemon footprint | higher | **low** | **lowest** |
| Contributors in browser automation | **largest** | medium | smaller |
