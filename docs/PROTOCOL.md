# The Argus Protocol, v0

**Status:** draft 0, the contract argusd is built against. Machine-readable
form: [`protocol/argus.schema.json`](../protocol/argus.schema.json). Examples
that must validate: [`protocol/examples/`](../protocol/examples/).

Argus exists so an agent building software can **see, act, and be told the
truth** fast enough to debug, test and polish a UI inside its normal loop. The
protocol is shaped around three jobs, not around browser APIs:

| Job | The agent asks | Methods |
|---|---|---|
| **Drive** | do this, tell me what happened | `act` |
| **Debug** | why didn't it work, what is broken | diagnoses, `observe`, `check`, `trace.*` |
| **Test & polish** | does it still work, at every size, and is it good | `run`, `sweep`, `check`, `evidence.*` |

One rule from [ARCHITECTURE.md](ARCHITECTURE.md) section 2 governs everything
here: **no silent success.** Every response states whether what was expected
actually happened.

---

## 1. Transport

- JSON-RPC 2.0, one JSON object per line (`\n`-delimited), UTF-8.
- Unix socket `$XDG_RUNTIME_DIR/argus/argus.sock`, mode `0600`, directory
  `0700`. No TCP, ever.
- The first call on a connection must be `hello`. Anything else returns
  error `-32002 not-negotiated`.
- Server-to-client notifications carry no `id` and use method names
  `event.*` (section 9).
- Every request that can wait takes a budget (`within`, `timeoutMs`), and has a
  server-side ceiling of 120s. No call can hang.

### 1.1 hello

```json
→ {"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol":"0","client":{"name":"claude-code","version":"2.1"}}}
← {"jsonrpc":"2.0","id":1,"result":{"protocol":"0","server":{"name":"argusd","version":"0.1.0"},
   "capabilities":{"lanes":["throwaway","desk","own"],"eyes":true,"decider":"none","check":["a11y","layout","runtime","perf"]}}}
```

Capabilities are facts about this machine, not promises: `own` appears only if
the extension is connected, `desk` only if Hyprland is reachable.

### 1.2 Errors

Protocol failures are JSON-RPC errors. **Action failures are not** — a click
that hit a covered button is a successful call whose result says `ok: false`
with a diagnosis. Agents never need to parse error strings to learn why.

| code | name | meaning |
|---|---|---|
| -32700 / -32600 / -32601 / -32602 | JSON-RPC standard | parse, request, method, params |
| -32001 | `unknown-lane` | lane id does not exist or was closed |
| -32002 | `not-negotiated` | `hello` not sent |
| -32003 | `capability-missing` | e.g. `own` lane without the extension |
| -32004 | `forbidden` | policy refused (lane kind, destructive gate) |
| -32005 | `browser-lost` | the lane's browser exited; the lane is closed |
| -32006 | `busy` | lane is running another `act`; lanes are serial, open another lane for parallelism |

---

## 2. Lanes

A lane is one isolated place to work: one page, its history, its trace.
Parallelism is more lanes.

| kind | what | person's accounts |
|---|---|---|
| `throwaway` | headless Chromium over a pipe, temporary profile | no |
| `desk` | headful Chromium on a Hyprland virtual monitor | no |
| `own` | a tab argus opened in the person's Chromium, via the extension | yes, that tab only |
| `app` | a native window via AT-SPI *(reserved, not in v0)* | — |

```
lane.open  {kind, url?, viewport?, label?}  → {lane, kind, url, observation?}
lane.close {lane}                           → {closed: true}
lane.list  {}                               → {lanes: [{lane, kind, url, title, label, busy, opened}]}
```

`viewport` is `{w, h, mobile?, scale?}`; widths under 600 imply `mobile: true`
unless stated. Lanes of kind `throwaway` in one daemon share a browser process
but never a profile context (`Target.createBrowserContext`): no cookies leak
between lanes.

---

## 3. Targets

Everywhere an element is named, a **Target** is accepted:

| form | example | meaning |
|---|---|---|
| role:name | `"button:Place order"` | accessible role and name; a bare role (`"dialog"`) matches any name |
| ref | `"e0.412"` | a ref from a Scene or diagnosis |
| text | `{"text": "Welcome back"}` | plain text, not only controls |
| structured | `{"role":"link","name":"Docs","near":"heading:API","nth":1}` | disambiguation |

Names match **exact → case-insensitive → substring**, in that order, and the
match level is reported. A substring match that yields several candidates is
`ambiguous`, never a guess.

Refs (`e<document>.<backendNodeId>`) are stable while the node lives. If the
node is replaced by a re-render, argus re-resolves by fingerprint (role, name,
structural path) and reports `rebound: true` in the observation.

---

## 4. Seeing: the Scene

```
scene.outline {lane, budget?}          → {url, title, outline, tokens}
scene.find    {lane, target, limit?}   → {matches: [Element], match: "exact"|"ci"|"substring"|"none", near?: [Element]}
scene.expand  {lane, ref, budget?}     → {outline, tokens}
```

`outline` is text, landmarks → headings → forms → actions, within `budget`
tokens (default 250), collapsing what does not fit into `expand`-able refs:

```
main "Checkout"
  h1 Checkout
  form "Shipping" e0.88 (6 fields, 2 empty required)
  button:Place order e0.131 [covered by e0.402 dialog "Cookies"]
  … 14 links in nav e0.12
```

An **Element**: `{ref, role, name, bounds:{x,y,w,h}|null, frames:[int], shadow:"open"|"closed"|null, state:[…], reach}`

- `state` ⊆ `disabled checked expanded selected focused required invalid readonly`
- `reach` is the hit-test at the element's centre: `"ok"`, or
  `{blocked: Element}`, or `"offscreen"`, `"hidden"`, `"zero-size"`.

Every token count the protocol reports is labelled: `tokens` is measured
(image formula `ceil(w/28)*ceil(h/28)`) or `tokensEst` is chars/4.

---

## 5. Acting: `act`

Every action is a script. One step is a script of length one.

```
act {lane, steps: [Step], stopOnSurprise?: true, evidence?: "none"|"on-failure"|"always"}
  → {ok, steps: [StepResult], ms, tokensEst}
```

### 5.1 Steps

Exactly one verb per step, plus optional `expect`:

| verb | value | notes |
|---|---|---|
| `open` | url | navigate; waits for load, then settle |
| `click` | Target | real input at the reachable centre, never `el.click()` |
| `type` | `[Target, text \| {secret: name}]` | focus, clear, insert; secrets resolved in argusd after approval |
| `press` | key chord, e.g. `"Enter"`, `"Control+a"` | |
| `select` | `[Target, option-name]` | |
| `upload` | `[Target, path…]` | no file picker opens |
| `hover` | Target | |
| `scroll` | Target \| `{by: {x, y}}` | |
| `dialog` | `"accept" \| "dismiss" \| {accept: text}` | armed for the next dialog of this step |
| `viewport` | `{w, h, mobile?}` \| `"reset"` | |
| `wait` | Expectation | a pure wait: the step is its expectation |

### 5.2 Expectations

Expectations are how an agent says what *should* happen, and how waits work.
In `appears` and `disappears` a string is always text; an element is named with
an object, e.g. `{"role": "dialog"}`.
All listed conditions must hold. `within` (default `"5s"`, max `"120s"`)
turns the check into a watch that resolves the moment they hold.

```json
{"appears": "Order confirmed", "within": "20s"}
{"disappears": {"role": "dialog"}}
{"url": {"matches": "/orders/\\d+"}}
{"field": ["textbox:Email", "a@b.c"]}
{"state": ["button:Save", "disabled"]}
{"count": ["listitem", {"gte": 3}]}
{"noErrors": true}
{"request": {"url": "/api/orders", "status": 201}}
```

`noErrors` means: no console errors, no uncaught exceptions, no failed
requests (status 0 or ≥ 400) during the step. It is on by default in `run`
(section 7) and off in `act`, where errors are reported but do not fail the step.

If a step has no `expect`, argus still verifies the **effect exists**: a click
that produced no DOM mutation, navigation, dialog, request or focus change is
`ok: true` with `effect: "none"` — reported, never dressed up as success.

### 5.3 StepResult

```
{i, verb, ok, target?: Element, match?, observation, diagnosis?, evidence?}
```

### 5.4 Observation — what changed

Only non-empty keys are present. Lists are capped (default 12) with `…More`
counts.

| key | content |
|---|---|
| `ms` | wall time of the step including settle |
| `settled` | `{quietMs, waitedMs}` or `"timeout"` |
| `url`, `title` | `{from, to}` |
| `added`, `removed` | visible text blocks, whole paragraphs, not truncated sentences |
| `fields` | `[{target, from, to}]` |
| `focus` | `{from, to, offscreen?}` |
| `dialogs` | `[{type, message, answered}]` |
| `console` | `[{level, text, source?}]` warnings and errors only |
| `exceptions` | `[{message, stack?}]` |
| `network` | failed or slow (>1s) requests only: `[{method, url, status, ms, error?}]` |
| `downloads` | `[{path, bytes}]` |
| `layoutShift` | CLS during the step, if > 0.01 |
| `longTasks` | count of main-thread tasks > 50ms |
| `compositor` | desk lanes: windows opened/closed/moved |
| `effect` | `"none"` when nothing at all changed |
| `expect` | `{held: bool, failed?: [{condition, actual}]}` |

### 5.5 Diagnosis — why not

A **closed set**. An implementation may not invent reasons; unknown failures
are `probe-error` with detail.

| reason | carries |
|---|---|
| `not-found` | `didYouMean: [Element]` |
| `ambiguous` | `candidates: [Element]` |
| `covered` | `blocker: Element` |
| `disabled` | — |
| `hidden` | `why: "display"|"visibility"|"opacity"|"inert"|"aria-hidden"` |
| `offscreen` | `scrollable: bool` |
| `zero-size` | — |
| `detached` | the node went away between find and act |
| `expectation-failed` | `failed: [{condition, actual}]` |
| `timeout` | `waitedMs`, last observation |
| `navigation-failed` | `errorText` |
| `dialog-blocked` | a dialog is open and was not armed for |
| `forbidden` | policy refused the step |
| `probe-error` | `detail` |

Every diagnosis includes `hint`: one sentence an agent can act on, e.g.
*"Dismiss dialog 'Cookies' (e0.402) first."*

### 5.6 Evidence — pixels, on demand, priced

```
evidence.look  {lane, target?, pad?}         → {image: path, w, h, tokens}
evidence.delta {lane, since: step-id}        → {image: path, regions: [{x,y,w,h}], tokens}
evidence.marks {lane}                        → {image: path, legend: [{n, ref, name, reach}], tokens}
evidence.shot  {lane, full?}                 → {image: path, w, h, tokens}
```

Images are files under `$XDG_RUNTIME_DIR/argus/evidence/`, never inline
base64: an agent that doesn't need to look pays nothing. `act` with
`evidence: "on-failure"` attaches a crop of the target and its blocker to a
diagnosis automatically.

---

## 6. Debugging: `observe` and `check`

```
observe {lane, since?: step-id | "open"}  → Observation
```
Everything that happened on the page since a point, including things no step
caused: background fetches that failed, errors on a timer, a toast that came
and went.

```
check {lane, only?: [Category], target?: Target} → {score, findings: [Finding], scanned, tokensEst}
```

A **Finding**: `{rule, category, severity: "error"|"warn", hint, count, examples: [{ref?, text?, detail}]}`.

| category | rules (v0) |
|---|---|
| `a11y` | `contrast`, `unnamed-control`, `img-alt`, `heading-order`, `duplicate-id`, `tap-target` |
| `layout` | `overflow-x`, `tiny-text`, `clipped-text`, `overlap` |
| `runtime` | `console-error`, `exception`, `failed-request`, `mixed-content` |
| `perf` | `layout-shift`, `long-task`, `slow-request`, `large-image` |

Rule ids are part of the standard: a new rule is a protocol minor version.
`check` is side-effect free and never scrolls the person's `own` tab.

---

## 7. Testing: `run` and `sweep`

A `run` is an `act` treated as a test: `noErrors` defaults to true, every step
must have an effect, and the result is a verdict.

```
run {lane?, kind?, name, steps: [Step], check?: [Category]}
  → {name, verdict: "pass"|"fail", failedAt?: i, steps: [StepResult], findings?: [Finding], ms, trace: id}
```

If `lane` is omitted, `run` opens a throwaway lane and closes it after.

A `sweep` runs the same script across many conditions **in parallel lanes**:

```
sweep {name, steps, across: {viewports?: [Viewport], kinds?: [LaneKind], colorScheme?: ["light","dark"]}, check?: [Category]}
  → {name, verdict, results: [{condition, verdict, failedAt?, findings?, evidence?}], ms}
```

```json
{"method":"sweep","params":{"name":"checkout",
  "steps":[{"open":"http://localhost:5173/checkout"},{"click":"button:Place order","expect":{"appears":"Order confirmed"}}],
  "across":{"viewports":[{"w":375,"h":812},{"w":768,"h":1024},{"w":1440,"h":900}],"colorScheme":["light","dark"]},
  "check":["a11y","layout"]}}
```

Six lanes, one call, one answer: *pass at 768 and 1440 in both schemes; fail at
375 — "Place order" covered by the sticky footer (e0.77), overflow-x 42px.*
That is the loop the protocol exists to make fast.

A passing run can be saved as a recipe (`recipe.*`, v1) and replayed as a
regression test with zero model tokens.

---

## 8. Trace

```
trace.list {lane?, limit?}   → {entries: [{id, lane, method, ok, ms, at}]}
trace.get  {id}              → the full request, result, and evidence paths
```

Every `act`, `run`, `sweep` and `check` is traced under
`$XDG_STATE_HOME/argus/trace/`. Traces never contain resolved secret values.

---

## 9. Events

After `event.subscribe {lanes?: [id] | "all", kinds: [...]}`, the server sends notifications:

| method | when |
|---|---|
| `event.step` | a step finished (live progress for `act`/`run`/`sweep`) |
| `event.console` | error-level console message or exception on a lane |
| `event.network` | a failed request on a lane |
| `event.lane` | lane opened, closed, lost |

This is what the Omarchy bar widget and `argus watch` render.

---

## 10. Reserved for later versions

`decide` (typed questions to a decider), `recipe.*`, `app.*` (AT-SPI),
`desk.*`, `os.*`, `approve` (secrets and destructive gates via Omarchy's
polkit surface). Names are reserved now so v0 clients do not collide.

## 11. Versioning

`protocol` is a string. v0 is unstable: any change is allowed, recorded in
this file. From v1, additive changes (new optional fields, new rules, new
methods) are minor; removing or changing meaning is major. Closed sets
(diagnosis reasons, check rules, lane kinds) only grow in minor versions.
