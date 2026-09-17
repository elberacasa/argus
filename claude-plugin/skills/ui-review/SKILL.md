---
name: ui-review
description: Review a page or route for accessibility, layout and runtime problems with Argus - contrast, unnamed controls, missing alt text, overflow at phone width, console errors and failed requests - and report each with the element and a crop. Use when asked to review, audit or check a page, a design or a component in the browser, or to see whether something looks right on mobile.
allowed-tools: mcp__argus__browser_open, mcp__plugin_argus_argus__browser_open, mcp__argus__browser_check, mcp__plugin_argus_argus__browser_check, mcp__argus__browser_sweep, mcp__plugin_argus_argus__browser_sweep, mcp__argus__browser_look, mcp__plugin_argus_argus__browser_look, mcp__argus__browser_outline, mcp__plugin_argus_argus__browser_outline, mcp__argus__browser_find, mcp__plugin_argus_argus__browser_find, mcp__argus__browser_act, mcp__plugin_argus_argus__browser_act, mcp__argus__browser_close, mcp__plugin_argus_argus__browser_close
---

# Review a page with Argus

The page to review: $ARGUMENTS (ask for a URL if none is given; a dev server
usually runs on localhost).

1. `browser_open` the URL in a lane named for this review, not "main", so other
   agents keep their own browsers: `{"url": ..., "lane": "review"}`.
2. `browser_check` — it measures contrast ratios, tap targets, unnamed controls,
   missing alt text, heading order, duplicate ids, horizontal overflow, tiny
   text, console errors, exceptions and failed or slow requests. Report what it
   finds; do not guess at problems it did not report.
3. For anything that depends on size, pass `viewports` to `browser_check`:
   `{"viewports": [{"w": 390, "h": 844}, {"w": 1280, "h": 800}]}` audits the
   page at each size in parallel and says which rules differ and which elements
   fail at one size only. A control that is only covered or too small on a
   phone is the classic case, and only this shows it. (`browser_sweep` runs
   *steps* across sizes and reports which conditions fail an expectation; use
   it for flows, not for audits.)
4. `browser_look` at the element behind a finding when a picture helps a person
   decide. Crops cost image tokens and the result says how many; a whole
   screenshot is 1,334, so prefer a crop or the text.
5. Close the lane when done.

Report each problem as: what it is, which element (with its ref), the measured
value, and what to change. Say plainly when the page is clean: `check` returning
nothing is a result worth reporting, not a reason to hunt.
