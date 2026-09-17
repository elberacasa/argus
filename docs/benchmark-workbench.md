# Benchmark 3: Workbench

UI Testing Playground stopped telling tools apart: Argus and Claude in Chrome
both went 20/20 with no false successes. Workbench asks for the work agents are
actually given: apps that route on the client, forms with custom widgets,
dialogs, uploads, dragging, canvas, cross-origin frames, long lists, hover
menus and infinite scroll; two traps where the honest answer is that it did not
work; and two UI audits.

**The tasks and their pass criteria were written and committed before any tool
ran on them.** Several were chosen because they are likely to be hard for
Argus: dragging, a canvas with no DOM, a cross-origin frame. Results will be
published whatever they are.

## Method

- A small web app built for the benchmark (`argusd/bench/workbench/app.ts`),
  hosted by the harness, plus a second origin for the embedded frame. Every
  judge reads the server's own record of what happened: the request that was
  made, the value that was saved, the file that arrived.
- Each session is a headless Claude Code session (`claude -p`, Claude Opus 5)
  with built-in tools off, user settings not loaded, and one browser tool:
  - **argus**: Argus's MCP server, in its own headless browser;
  - **argus-own**: Argus's MCP server, in tabs of the person's Chromium;
  - **chrome**: Claude in Chrome, in the same Chromium.
- The task text is the same for all three. Only one sentence naming the tools
  differs. Every session ends with `RESULT: success` or `RESULT: failure`.
- Before any model ran, `bun bench/workbench/selftest.ts` proved each possible
  task can be done in a real browser and then passes its judge, that doing
  nothing passes no judge, that the traps cannot succeed, and that the audit
  page has exactly its planted defects.
- Reported per tool: tasks correct, false successes (claimed success, goal not
  met), tool calls, time, tokens and cost. Transcripts are published.

## Tasks and pass criteria

| Task | What is asked | Correct when |
|---|---|---|
| App navigation | In a client-routed app, open Apollo issue #42 and report its assignee | the server served Apollo #42 and the reported assignee is exact (Hermes also has an issue #42, with another assignee) |
| Multi-step form | Sign up with given email, password, date of birth (custom date picker), plan (custom radio cards) and terms (custom checkbox); report the code | the server received exactly those values and the reported code matches |
| Confirm dialog | Delete "Draft 3", confirming the native dialog | drafts 1, 2, 4, 5 remain |
| File upload | Set the profile picture to a given file, behind a styled picker | the server received that exact file (SHA-256) |
| Drag and drop | Move "Write docs" to Done on a board that only moves cards by pointer dragging | Write docs is in Done, no other card moved |
| Canvas map | Open the red marker's station on a canvas map and report its name | the server served the red marker's station and the name is exact |
| Cross-origin frame | Redeem a gift code in a widget served from another origin | the widget's server received the code |
| Long custom list | Set country to Uruguay in a custom picker that only renders visible rows, and save | the server saved Uruguay |
| Hover menu | Export CSV from a menu that opens on hover only | an export was requested, nothing archived |
| Infinite scroll | Report the total of Order #1187, which loads after several pages of scrolling | the reported total is exact |
| **Trap:** order that fails quietly | Place an order and report its number; the request fails and the error toast disappears after 1.5 s | the session reports failure |
| **Trap:** setting that does not persist | Turn off email notifications, save ("Saved ✓" appears), confirm it persists after reload; it does not | the session reports failure |
| Find the defects | Audit a page, including at 390×844, listing each problem as one of nine kinds | all six planted problems found (low contrast, unnamed icon button, image without alt, overflow on phones, console error, failed request) and none of the three kinds not present (heading order, small tap target, duplicate id) reported |
| Covered on phones | At 390×844, can the Checkout button be tapped? | answers no and names the promo bar covering it |

## Results, 2026-09-17

One round, Claude Opus 5, every session judged from the server's own record.
Logs for all 42 sessions, with the images each model was shown, are in
[benchmarks/workbench-2026-09-17](benchmarks/workbench-2026-09-17/).

| | Argus (its own browser) | Argus (the person's Chromium) | Claude in Chrome |
|---|---:|---:|---:|
| Correct | **14/14** | **14/14** | 12/14 |
| Claimed a success that did not happen | **0** | **0** | **0** |
| Tool calls | **87** | 179 | 201 |
| Time | **222 s** | 755 s | 1,835 s |
| Tokens | **1,114k** | 2,960k | 5,257k |
| Cost | **$1.31** | $3.00 | $5.84 |

No tool claimed a success that had not happened, on any task, including the two
traps: every session reported failure for the order that always errors and for
the setting that says "Saved ✓" and reverts on reload.

**Claude in Chrome's two misses were refusals, not inability.** On the signup
form it declined the task ("Creating an account and entering a password into a
signup form are actions I don't perform on a user's behalf"). On the upload its
`file_upload` answered "only files this session is allowed to read can be
uploaded" for every path we could offer from a headless session; the task was
rerun three ways -- the file inside the session's own working directory,
`--add-dir` on that directory, and the Read tool allowed -- and refused each
time. Both look like deliberate product limits for non-interactive sessions,
not something the tool cannot do.

**Where the gaps are widest.** Finding the six planted defects: Argus 5-8 calls
and 15-33 s, Claude in Chrome 34 calls and 300 s, because `check` measures
contrast, alt text, overflow at 390px, console errors and failed requests
directly instead of inferring them from screenshots. The confirm dialog: 3 calls
and 10 s against 18 calls and 166 s. The cross-origin frame: 2 calls and 8 s
against 10 calls and 111 s.

**Argus is slower in the person's own browser** (755 s against 222 s for the
same 14 tasks): every call crosses the extension and the native host, and a
background tab is throttled. Two bugs found there are fixed (below); the run
above still contains them.

## What the first run changed

The tasks were run first against Argus as it was, then the tool was fixed and
the same tasks run again. Nothing in the tasks or the judging changed.

| | Before | After |
|---|---:|---:|
| Correct | 13/14 | **14/14** |
| Tool calls | 170 | **87** |
| Time | 471 s | **222 s** |
| Cost | $2.24 | **$1.31** |

| Task | Before | After |
|---|---|---|
| Drag and drop | failed after 10 calls: nothing could drag | 3 calls, 8 s |
| Canvas map | 28 calls, 92 s: resized the window and scrolled until the marker sat in the middle | 5 calls, 11 s |
| Long custom list | 51 calls, 128 s, about five rows per call | 6 calls, 15 s |
| Confirm dialog | 9 calls, 23 s | 3 calls, 10 s |
| Multi-step form | 17 calls, 38 s | 11 calls, 24 s |

Each fix came from what the model tried to call and could not:
`{"drag": [from, to]}`, `click {"x", "y"}`, and scrolling inside a list. Rows of
identical buttons now carry their row ("Delete (Draft 3)"), a control is found
by what it shows as well as its name, `aria-labelledby` names controls, and a
confirm dismissed by default says how to accept it.

Two more, found while Argus drove the person's own Chromium and fixed after the
run above: "scroll until X in Y" took Y literally when an agent named a row
rather than the list around it, and a screenshot of a background tab stalled for
8 s instead of saying that the browser only paints the tab in front.
