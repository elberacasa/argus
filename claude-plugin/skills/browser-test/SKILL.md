---
name: browser-test
description: Write and run a browser test with Argus, where every step is verified against the page and a failure says why (covered, disabled, hidden, ambiguous, expectation-failed). Use when asked to test a flow end to end, to reproduce a bug in the browser, or to check that a fix works in the real app rather than only in unit tests.
allowed-tools: mcp__argus__browser_open, mcp__plugin_argus_argus__browser_open, mcp__argus__browser_run, mcp__plugin_argus_argus__browser_run, mcp__argus__browser_act, mcp__plugin_argus_argus__browser_act, mcp__argus__browser_outline, mcp__plugin_argus_argus__browser_outline, mcp__argus__browser_find, mcp__plugin_argus_argus__browser_find, mcp__argus__browser_click, mcp__plugin_argus_argus__browser_click, mcp__argus__browser_type, mcp__plugin_argus_argus__browser_type, mcp__argus__browser_press, mcp__plugin_argus_argus__browser_press, mcp__argus__browser_wait, mcp__plugin_argus_argus__browser_wait, mcp__argus__browser_look, mcp__plugin_argus_argus__browser_look, mcp__argus__browser_sweep, mcp__plugin_argus_argus__browser_sweep, mcp__argus__browser_close, mcp__plugin_argus_argus__browser_close
---

# Test a flow with Argus

What to test: $ARGUMENTS

1. Learn the page first: `browser_open` (in a lane of its own, named for the
   test) returns an outline with refs, and flags covered or disabled controls.
2. Write the flow as steps and run them with `browser_run`, which uses a fresh
   lane and fails the test on console errors and failed requests by default:

   ```json
   {"name": "checkout", "steps": [
     {"open": "http://localhost:3000/cart"},
     {"click": "button:Checkout"},
     {"type": ["textbox:Email", "sam@example.com"]},
     {"click": "button:Place order", "expect": {"appears": "Order confirmed"}}
   ]}
   ```

3. Every step is verified. When one fails, read the reason before retrying: a
   `covered` click names what is on top, `ambiguous` lists the candidates,
   `expectation-failed` says what was actually there.
4. State what must be true with `expect` rather than sleeping, and wait for
   outcomes with `{"wait": {"appears": "..."}}`.
5. Useful steps for real apps: `{"drag": [from, to]}`, a point on a canvas
   (`{"click": {"x": 40, "y": 30, "in": "e0.28"}}`), and
   `{"scroll": {"until": target, "in": list}}` for long lists and feeds.

Report the verdict, the step that failed and its reason. A test that passes
because the page never changed is not a pass: Argus says `(nothing changed on
the page)`, and that means the step did nothing.
