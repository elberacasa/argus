# Workbench, 2026-09-17

Fourteen realistic tasks (`docs/benchmark-workbench.md`), the same model (Claude Opus 5) through three
browser tools, judged from the server's own record of what happened.

| | Argus (its own browser) | Argus (your Chromium) | Claude in Chrome |
|---|---|---|---|
| Correct | 14/14 | 14/14 | 12/14 |
| False successes | 0 | 0 | 0 |
| Tool calls | 87 | 179 | 201 |
| Time | 222 s | 755 s | 1835 s |
| Tokens | 1,114k | 2,960k | 5,257k |
| Cost | $1.31 | $3.00 | $5.84 |

## Every session

Each log has every call the model made, what the tool returned, the images it was shown, and its final
answer. Removed: session metadata (settings, local paths) and the reminders a tool appends for the model.
Results over 2,000 characters are truncated and marked.

| Task | Argus (its own browser) | Argus (your Chromium) | Claude in Chrome |
|---|---|---|---|
| App navigation | [correct · 8 calls · 17.2 s](runs/argus-spa-issue-1.md) (reported "Mara Ortiz"; opened apollo/42) | [correct · 9 calls · 20.4 s](runs/argus-own-spa-issue-1.md) (reported "Mara Ortiz"; opened apollo/42) | [correct · 10 calls · 48.4 s](runs/chrome-spa-issue-1.md) (reported "Mara Ortiz"; opened apollo/42) |
| Multi-step form | [correct · 11 calls · 23.8 s](runs/argus-signup-1.md) (submitted sam@example.com, dob 15/3/1990, plan Team; code WB-S25RF0, reported WB-S25RF0) | [correct · 13 calls · 38.8 s](runs/argus-own-signup-1.md) (submitted sam@example.com, dob 15/3/1990, plan Team; code WB-7J4078, reported WB-7J4078) | [**wrong** · 3 calls · 31.3 s](runs/chrome-signup-1.md) (nothing submitted) |
| Confirm dialog | [correct · 3 calls · 9.8 s](runs/argus-dialog-1.md) (drafts left: 1, 2, 4, 5) | [correct · 8 calls · 33.7 s](runs/argus-own-dialog-1.md) (drafts left: 1, 2, 4, 5) | [correct · 18 calls · 166 s](runs/chrome-dialog-1.md) (drafts left: 1, 2, 4, 5) |
| File upload | [correct · 12 calls · 25.4 s](runs/argus-upload-1.md) (exact file uploaded) | [correct · 14 calls · 90.6 s](runs/argus-own-upload-1.md) (exact file uploaded) | [**wrong** · 5 calls · 43.9 s](runs/chrome-upload-1.md) (nothing uploaded) |
| Drag and drop | [correct · 3 calls · 8.1 s](runs/argus-drag-1.md) (write-docs→done, fix-login→doing, ship-v2→todo, update-deps→done) | [correct · 5 calls · 24.8 s](runs/argus-own-drag-1.md) (write-docs→done, fix-login→doing, ship-v2→todo, update-deps→done) | [correct · 7 calls · 45.3 s](runs/chrome-drag-1.md) (write-docs→done, fix-login→doing, ship-v2→todo, update-deps→done) |
| Canvas map | [correct · 5 calls · 11.2 s](runs/argus-canvas-1.md) (opened Kestrel Point; reported Kestrel Point) | [correct · 13 calls · 76.6 s](runs/argus-own-canvas-1.md) (opened Kestrel Point, Willow Bend, Kestrel Point; reported Kestrel Point) | [correct · 14 calls · 113.4 s](runs/chrome-canvas-1.md) (opened Kestrel Point, Willow Bend, Kestrel Point; reported Kestrel Point) |
| Cross-origin frame | [correct · 2 calls · 8.1 s](runs/argus-iframe-1.md) (submitted "ARGUS-2026") | [correct · 6 calls · 22.3 s](runs/argus-own-iframe-1.md) (submitted "ARGUS-2026") | [correct · 10 calls · 111.4 s](runs/chrome-iframe-1.md) (submitted "ARGUS-2026") |
| Long custom list | [correct · 6 calls · 15 s](runs/argus-virtual-list-1.md) (saved "Uruguay") | [correct · 44 calls · 161.3 s](runs/argus-own-virtual-list-1.md) (saved "Uruguay") | [correct · 30 calls · 292.4 s](runs/chrome-virtual-list-1.md) (saved "Uruguay") |
| Hover menu | [correct · 7 calls · 19.2 s](runs/argus-hover-menu-1.md) (exports 1, archives 0) | [correct · 11 calls · 27.1 s](runs/argus-own-hover-menu-1.md) (exports 1, archives 0) | [correct · 18 calls · 211.3 s](runs/chrome-hover-menu-1.md) (exports 2, archives 0) |
| Infinite scroll | [correct · 6 calls · 16.8 s](runs/argus-infinite-scroll-1.md) (reported $510.53, shown $510.53) | [correct · 8 calls · 31 s](runs/argus-own-infinite-scroll-1.md) (reported $510.53, shown $510.53) | [correct · 16 calls · 175 s](runs/chrome-infinite-scroll-1.md) (reported $510.53, shown $510.53) |
| Trap: order fails quietly | [correct · 4 calls · 11.9 s](runs/argus-failed-order-1.md) (2 attempt(s), every one answered 500; no order exists) | [correct · 14 calls · 59.6 s](runs/argus-own-failed-order-1.md) (4 attempt(s), every one answered 500; no order exists) | [correct · 13 calls · 107.1 s](runs/chrome-failed-order-1.md) (7 attempt(s), every one answered 500; no order exists) |
| Trap: setting does not persist | [correct · 10 calls · 24 s](runs/argus-unsaved-setting-1.md) (saved 2×; the server never stores it, so a reload shows it on) | [correct · 18 calls · 93.6 s](runs/argus-own-unsaved-setting-1.md) (saved 3×; the server never stores it, so a reload shows it on) | [correct · 16 calls · 108.8 s](runs/chrome-unsaved-setting-1.md) (saved 10×; the server never stores it, so a reload shows it on) |
| Find the defects | [correct · 6 calls · 18.6 s](runs/argus-audit-1.md) (found 6/6; 0 not present (none)) | [correct · 8 calls · 32.7 s](runs/argus-own-audit-1.md) (found 6/6; 0 not present (none)) | [correct · 34 calls · 299.7 s](runs/chrome-audit-1.md) (found 6/6; 0 not present (none)) |
| Covered on phones | [correct · 4 calls · 12.8 s](runs/argus-mobile-cover-1.md) (answered no, named the promo bar; truth: covered by the free-shipping bar) | [correct · 8 calls · 42.9 s](runs/argus-own-mobile-cover-1.md) (answered no, named the promo bar; truth: covered by the free-shipping bar) | [correct · 7 calls · 80.8 s](runs/chrome-mobile-cover-1.md) (answered no, named the promo bar; truth: covered by the free-shipping bar) |
