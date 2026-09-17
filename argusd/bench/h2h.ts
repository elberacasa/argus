// Head to head: the same model, the same tasks, the same judge, two browser tools.
//
//   bun bench/h2h.ts [--tools argus,chrome] [--rounds N] [challenge...]
//
// Each run is one headless Claude Code session (`claude -p`) whose only tools
// are one browser tool's: Argus's MCP server, or Claude in Chrome (`--chrome`,
// driving the person's own browser). Built-in tools are off and user settings
// are not loaded. Challenges alternate between the tools so network swings
// hit both.
//
// Neither tool grades itself. Both open UI Testing Playground through a local
// proxy that injects a reporter into every page: it records trusted clicks and
// posts the page's real state to the harness, which judges from that. A false
// success is a session reporting success when the page shows the goal was not
// met.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "../src/rpc/client";
import { connect } from "../src/rpc/connect";
import { ENDING, runSession } from "./lib/session";

const UPSTREAM = "http://uitestingplayground.com";
const ROOT = resolve(import.meta.dir, "../..");
const MODEL = process.env.MODEL ?? "claude-opus-5";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i === -1 ? undefined : args.splice(i, 2)[1]; };
const TOOLS = (flag("--tools") ?? "argus,chrome").split(",") as Array<"argus" | "chrome">;
const ROUNDS = Number(flag("--rounds") ?? 1);
const only = args;

const work = mkdtempSync(join(tmpdir(), "argus-h2h-"));
const socket = join(work, "run", "argus.sock");
mkdirSync(join(work, "cwd"), { recursive: true });
mkdirSync(join(work, "run"), { recursive: true });
writeFileSync(join(work, "mcp.json"), JSON.stringify({ mcpServers: { argus: { command: join(ROOT, "bin", "argus-mcp"), env: { ARGUS_SOCKET: socket } } } }));

// ---- ground truth ------------------------------------------------------------

/** What the reporter evaluates in the page, per challenge. Plain page JS. */
const PROBES: Record<string, Record<string, string>> = {
  hiddenlayers: { warned: `!!document.querySelector("p.bg-warning")` },
  overlapped: { name: `document.querySelector("#name") && document.querySelector("#name").value` },
  visibility: { hidden: `!document.querySelector("#removedButton") && !!document.querySelector("#notdisplayedButton") && getComputedStyle(document.querySelector("#notdisplayedButton")).display === "none"` },
  click: { green: `!!document.querySelector("#badButton.btn-success")` },
  textinput: { label: `document.querySelector("#updatingButton") && document.querySelector("#updatingButton").textContent` },
  clientdelay: {},
  nbsp: {},
  scrollbars: {},
  shadowdom: { guid: `(() => { const g = document.querySelector("guid-generator"); return g && g.shadowRoot ? g.shadowRoot.querySelector("#editField").value : null; })()` },
  frames: {
    inner: `(() => { try { return document.querySelector("iframe").contentDocument.querySelector("iframe").contentDocument.querySelector("#result").textContent; } catch { return null; } })()`,
    outer: `(() => { try { return document.querySelector("iframe").contentDocument.querySelector("#result").textContent; } catch { return null; } })()`,
  },
};

const reporter = (challenge: string) => `<script>(() => {
  if (window.top !== window) return;
  const clicks = [];
  addEventListener("click", (e) => { const t = e.target; clicks.push({ id: t.id || "", cls: String(t.className || ""), text: (t.textContent || "").trim().slice(0, 60), trusted: e.isTrusted }); setTimeout(send, 30); }, true);
  const probes = ${JSON.stringify(PROBES[challenge] ?? {})};
  function send() {
    const values = {};
    for (const [k, x] of Object.entries(probes)) { try { values[k] = (0, eval)(x); } catch { values[k] = null; } }
    navigator.sendBeacon("/__truth", JSON.stringify({ challenge: ${JSON.stringify(challenge)}, clicks, values }));
  }
  setInterval(send, 250);
})()</script>`;

interface Truth { clicks: Array<{ id: string; cls: string; text: string; trusted: boolean }>; values: Record<string, unknown> }
const truths = new Map<string, Truth>();

// The proxy: /<challenge>/... serves UI Testing Playground's /<page>/... with the reporter injected.
const proxy = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/__truth") {
      const body = await req.json() as Truth & { challenge: string };
      truths.set(body.challenge, body);
      return new Response("");
    }
    const upstream = await fetch(UPSTREAM + url.pathname + url.search, { headers: { "accept-encoding": "identity", "user-agent": req.headers.get("user-agent") ?? "" }, redirect: "manual" });
    const headers = new Headers(upstream.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    headers.delete("content-security-policy");
    const type = headers.get("content-type") ?? "";
    if (!type.includes("text/html")) return new Response(upstream.body, { status: upstream.status, headers });
    // The challenge is the first path segment of the page being served (frames' inner documents included).
    const challenge = url.pathname.split("/")[1] ?? "";
    let html = (await upstream.text()).replaceAll(UPSTREAM, "");
    html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + reporter(challenge)) : reporter(challenge) + html;
    return new Response(html, { status: upstream.status, headers });
  },
});
const BASE = `http://127.0.0.1:${proxy.port}`;

const trusted = (challenge: string, pick: (c: Truth["clicks"][number]) => boolean) =>
  (truths.get(challenge)?.clicks ?? []).filter((c) => c.trusted && pick(c)).length;
const value = (challenge: string, key: string) => truths.get(challenge)?.values[key];

interface Challenge { task: string; judge: (answer: string) => { met: boolean; truth: string } }

const challenges: Record<string, Challenge> = {
  hiddenlayers: {
    task: `Open ${BASE}/hiddenlayers. Press the green button once. The scenario says it must not be possible to press the green button twice: try to press the green button a second time and determine whether that second press actually hit the green button. Success means the green button was pressed exactly once.`,
    judge: () => {
      const green = trusted("hiddenlayers", (c) => c.id === "greenButton");
      const warned = value("hiddenlayers", "warned");
      return { met: green === 1 && warned === false, truth: `green pressed ${green}×${warned ? ", page warned" : ""}` };
    },
  },
  overlapped: {
    task: `Open ${BASE}/overlapped. Enter the text "Argus" into the Name field. Success means the Name field holds exactly "Argus".`,
    judge: () => { const v = value("overlapped", "name"); return { met: v === "Argus", truth: `name = ${JSON.stringify(v)}` }; },
  },
  visibility: {
    task: `Open ${BASE}/visibility. Press the Hide button. Then determine, for each of the other seven buttons (Removed, Zero Width, Overlapped, Opacity 0, Visibility Hidden, Display None, Offscreen), whether a user could still see and click it. List them one per line as "<name>: clickable" or "<name>: not clickable". Success means you determined all seven correctly.`,
    judge: (answer) => {
      const names = ["Removed", "Zero Width", "Overlapped", "Opacity 0", "Visibility Hidden", "Display None", "Offscreen"];
      const hidden = value("visibility", "hidden");
      const correct = names.filter((n) => new RegExp(`${n}\\W*:\\W*not clickable`, "i").test(answer)).length;
      return { met: hidden === true && correct === 7, truth: `Hide ${hidden ? "applied" : "not applied"}; ${correct}/7 answered not clickable` };
    },
  },
  click: {
    task: `Open ${BASE}/click. Press the button labelled "Button That Ignores DOM Click Event". Success means the button reacted to the press (it turns green).`,
    judge: () => { const g = value("click", "green"); return { met: g === true, truth: g ? "turned green" : "did not react" }; },
  },
  textinput: {
    task: `Open ${BASE}/textinput. Use the text field and the button so that the button's own label becomes "Argus". Success means the button reads "Argus".`,
    judge: () => { const t = value("textinput", "label"); return { met: t === "Argus", truth: `button reads ${JSON.stringify(t)}` }; },
  },
  clientdelay: {
    task: `Open ${BASE}/clientdelay. Press the button that triggers the client-side logic. A label appears only after the page finishes its work, which can take a while. Wait for the label, then click on the label itself. Success means the label was clicked.`,
    judge: () => { const n = trusted("clientdelay", (c) => c.cls.includes("bg-success")); return { met: n === 1, truth: `label clicked ${n}×` }; },
  },
  nbsp: {
    task: `Open ${BASE}/nbsp. Click the button named "My Button". Success means that button was clicked.`,
    judge: () => { const n = trusted("nbsp", (c) => c.text.replace(/\s/g, " ") === "My Button"); return { met: n === 1, truth: `My Button clicked ${n}×` }; },
  },
  scrollbars: {
    task: `Open ${BASE}/scrollbars. There is a button hidden inside a scrollable area. Click that button. Success means it was clicked.`,
    judge: () => { const n = trusted("scrollbars", (c) => c.id === "hidingButton"); return { met: n === 1, truth: `hidden button clicked ${n}×` }; },
  },
  shadowdom: {
    task: `Open ${BASE}/shadowdom. Use the GUID generator's generate (gear) button to generate a GUID into its field. Report the generated value on its own line as "GUID: <value>". Success means a GUID was generated and you reported it exactly.`,
    judge: (answer) => {
      const v = value("shadowdom", "guid") as string | null | undefined;
      const reported = /GUID:\s*([0-9a-f-]{36})/i.exec(answer)?.[1];
      const isGuid = !!v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
      return { met: isGuid && reported === v, truth: `field ${JSON.stringify(v)}, reported ${reported ?? "nothing"}` };
    },
  },
  frames: {
    task: `Open ${BASE}/frames. The page has an outer frame and an inner frame nested inside it. Click the "Edit" button in the inner frame (level 2), and confirm the inner frame shows that Edit was pressed. Success means the inner frame's Edit button was pressed and the outer frame's was not.`,
    judge: () => {
      const inner = value("frames", "inner"), outer = value("frames", "outer");
      return { met: inner === "Button pressed: Edit" && outer === "", truth: `inner ${JSON.stringify(inner)}, outer ${JSON.stringify(outer)}` };
    },
  },
};

// ---- sessions ----------------------------------------------------------------

const SETUP = {
  argus: { intro: "You are testing a web page with the Argus browser tools.", flags: ["--strict-mcp-config", "--mcp-config", join(work, "mcp.json"), "--allowedTools", "mcp__argus"] },
  // Claude in Chrome serves every connected browser; the page is on this machine.
  chrome: { intro: "You are testing a web page with the Claude in Chrome browser tools. The page is served on this machine: use the local (Linux) browser.", flags: ["--chrome", "--strict-mcp-config", "--allowedTools", "mcp__claude-in-chrome"] },
};

interface Row { tool: string; name: string; round: number; met: boolean; claimed: "success" | "failure" | "none"; falseSuccess: boolean; truth: string; tools: number; seconds: number; cost: number; input: number; output: number }
const rows: Row[] = [];

async function session(tool: "argus" | "chrome", name: string, round: number, c: Challenge): Promise<Row> {
  truths.delete(name);
  const r = await runSession({ prompt: `${c.task}\n\n${SETUP[tool].intro} ${ENDING}`, model: MODEL, flags: SETUP[tool].flags, cwd: join(work, "cwd"), transcript: join(work, `${tool}-${name}-${round}.jsonl`) });
  // Let the reporter's last beacon arrive.
  await Bun.sleep(600);
  const { met, truth } = c.judge(r.answer);
  return { tool, name, round, met, claimed: r.claimed, falseSuccess: r.claimed === "success" && !met, truth, tools: r.tools, seconds: r.seconds, cost: r.cost, input: r.input, output: r.output };
}

// Start Argus's daemon and browser first: Claude in Chrome's browser is already running.
if (TOOLS.includes("argus")) {
  const client = await connect({ socketPath: socket });
  const { lane } = await client.call<{ lane: string }>("lane.open", { kind: "throwaway" });
  await client.call("lane.close", { lane });
  client.close();
}

try {
  for (let round = 1; round <= ROUNDS; round++) {
    for (const [name, c] of Object.entries(challenges)) {
      if (only.length && !only.includes(name)) continue;
      // Alternate which tool goes first, so neither always meets a warm cache.
      const order = (round + Object.keys(challenges).indexOf(name)) % 2 ? [...TOOLS].reverse() : TOOLS;
      for (const tool of order) {
        const row = await session(tool, name, round, c);
        rows.push(row);
        console.error(`${row.met ? "pass" : "FAIL"}  ${tool.padEnd(6)} ${name.padEnd(12)} r${round} claimed ${row.claimed.padEnd(7)} ${row.falseSuccess ? "FALSE SUCCESS " : ""}${row.tools} calls  ${row.seconds}s  $${row.cost.toFixed(3)}  | ${row.truth}`);
        if (tool === "argus") {
          try {
            const client = await Client.connect(socket);
            for (const { lane } of (await client.call<{ lanes: Array<{ lane: string }> }>("lane.list", {})).lanes) await client.call("lane.close", { lane });
            client.close();
          } catch { /* no daemon yet */ }
        }
      }
    }
  }
} finally {
  proxy.stop(true);
  // Stop this run's daemon by the pid it wrote, never by name.
  try { process.kill(Number(readFileSync(`${socket}.pid`, "utf8").trim()), "SIGTERM"); } catch { /* not running */ }
}

writeFileSync(join(work, "rows.json"), JSON.stringify(rows, null, 2));
console.log(`\n| Challenge | Round | ${TOOLS.map((t) => `${t} goal · claimed · calls · time · cost`).join(" | ")} |`);
console.log(`|---|---:|${TOOLS.map(() => "---").join("|")}|`);
const names = [...new Set(rows.map((r) => r.name))];
for (let round = 1; round <= ROUNDS; round++)
  for (const n of names) {
    const cells = TOOLS.map((t) => { const r = rows.find((x) => x.tool === t && x.name === n && x.round === round); return r ? `${r.met ? "met" : "**not met**"} (${r.truth}) · ${r.claimed}${r.falseSuccess ? " **FALSE**" : ""} · ${r.tools} · ${r.seconds}s · $${r.cost.toFixed(2)}` : "-"; });
    console.log(`| ${n} | ${round} | ${cells.join(" | ")} |`);
  }
console.log("");
for (const t of TOOLS) {
  const rs = rows.filter((r) => r.tool === t);
  const sum = (f: (r: Row) => number) => rs.reduce((s, r) => s + f(r), 0);
  console.log(`**${t}**: ${rs.filter((r) => r.met).length}/${rs.length} goals met, ${rs.filter((r) => r.falseSuccess).length} false successes, ${sum((r) => r.tools)} tool calls, ${Math.round(sum((r) => r.seconds))}s, ${Math.round(sum((r) => r.input) / 1000)}k input + ${Math.round(sum((r) => r.output) / 1000)}k output tokens, $${sum((r) => r.cost).toFixed(2)}`);
}
console.log(`Transcripts: ${work}`);
