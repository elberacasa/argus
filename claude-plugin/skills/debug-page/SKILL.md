---
name: debug-page
description: Find out why a page misbehaves with Argus - console errors, exceptions, failed or slow requests, an element that will not take a click, or something that looks wrong only at one size. Use when a user reports a bug in a web page, when a click does nothing, or when something works locally but not in the browser.
allowed-tools: mcp__argus__browser_open, mcp__plugin_argus_argus__browser_open, mcp__argus__browser_act, mcp__plugin_argus_argus__browser_act, mcp__argus__browser_outline, mcp__plugin_argus_argus__browser_outline, mcp__argus__browser_find, mcp__plugin_argus_argus__browser_find, mcp__argus__browser_check, mcp__plugin_argus_argus__browser_check, mcp__argus__browser_look, mcp__plugin_argus_argus__browser_look, mcp__argus__browser_screenshot, mcp__plugin_argus_argus__browser_screenshot, mcp__argus__browser_trace, mcp__plugin_argus_argus__browser_trace, mcp__argus__browser_close, mcp__plugin_argus_argus__browser_close
---

# Debug a page with Argus

The problem: $ARGUMENTS

1. `browser_open` the page in its own lane. The result already carries the
   console errors, exceptions and failed requests the load produced.
2. Reproduce the action with `browser_act`. The result says what changed on the
   page, what the console said, and which requests failed or were slow.
3. When a click will not land, the reason is in the result: `covered` names the
   element on top with its ref, `disabled` says the page has to enable it,
   `hidden` says how it is hidden, `offscreen` says scrolling did not reach it.
   Fix the cause named; do not retry the same click.
4. `browser_check` for problems the page does not announce: contrast, overflow
   at phone width, unnamed controls, failed requests.
5. `browser_trace` lists what was done in the lane, most recent first, when you
   need to retrace your own steps.

Report the cause and the evidence for it. If the page is fine and the bug is
elsewhere, say so.
