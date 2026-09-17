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

Results: not yet run.
