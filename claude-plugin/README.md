# Argus for Claude Code

Give each agent its own browser. Every step is verified against the page, and a
failure says why: covered (with the element on top named), disabled, hidden,
ambiguous, expectation-failed.

## Install

From this repository, for one session:

```bash
claude --plugin-dir /path/to/argus/claude-plugin
```

Or add the marketplace once and install it:

```
/plugin marketplace add elberacasa/argus
/plugin install argus@argus
```

Argus itself must be on the machine (this plugin runs `bin/argus-mcp` from the
repository beside it, or `argus-mcp` from your PATH). See the repository README
for the daemon, desks and the browser extension.

## What it adds

**Skills** (also slash commands):

- `/argus:ui-review <url>` — accessibility, layout and runtime problems, with
  the element and the measured value for each, and a sweep across viewports.
- `/argus:browser-test <what>` — drive a flow with every step verified, and a
  reason when one fails.
- `/argus:debug-page <problem>` — console errors, exceptions, failed requests,
  and why a click will not land.

**Agents**, for work in parallel — each opens a browser of its own:

- `ui-reviewer` — reviews one page and reports findings with evidence.
- `web-tester` — drives one flow and reports whether it really worked.

Fan several out at once: one per route or per flow. Lanes are named, and two
sessions asking for the same name get different browsers, so agents never share
one.
