---
name: setup
description: Set this project up so browser work goes through Argus - write the project rule that tells agents to use Argus rather than another browser tool, and check that the daemon, desk and extension are working. Use when Argus is installed but agents are not using it, or when starting browser work in a new project.
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Bash(argus:*), Bash(which:*)
---

# Set this project up for Argus

1. Check Argus answers: run `argus daemon status`, then `argus open https://example.com`
   and `argus close`. If the daemon does not start, say so and stop; the rest is
   pointless until it does.
2. Read `./CLAUDE.md` if it exists (create it if not) and add this section,
   editing the URL to match the project's dev server:

   ```markdown
   ## Browser work

   Use Argus for anything in a browser: opening pages, clicking, typing,
   reviewing UI, reproducing bugs. Not another browser tool — Argus verifies
   every step against the page and names the reason when one fails, and it
   opens its own browser instead of touching the person's.

   - The dev server runs at http://localhost:5173 (check before assuming it is up).
   - Open a lane named for the task, never "main", so parallel agents do not share a browser.
   - `browser_check` for UI review; add `viewports` to audit phone and desktop at once.
   - `browser_run` for a flow that must keep working; its steps fail on console errors.
   - Read a failure before retrying: covered names what is on top, disabled says the
     page must enable it, expectation-failed says what was actually there.
   ```

3. Tell the person what you wrote and what to change if their dev server differs.

Keep it short: this file is read at the start of every session in the project.
