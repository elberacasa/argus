// UI Testing Playground, played by a real model through Argus's MCP server.
//
//   bun bench/rematch.ts [challenge...]
//
// Each challenge is one headless Claude Code session (`claude -p`) whose only
// tools are Argus's (built-in tools off, strict MCP config, no user settings).
// The model gets the page's scenario, not hints about how to solve it, and
// must end with RESULT: success or RESULT: failure.
//
// The daemon runs inside this process, so the harness can read ground truth
// from the very pages the model drives: every lane gets a click recorder
// before any page script runs (element, and whether the click was trusted
// input). A false success is the model reporting success when the page shows
// the goal was not met.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serve } from "../src/rpc/server";
import { Service } from "../src/rpc/service";

const BASE = "http://uitestingplayground.com";
const ROOT = resolve(import.meta.dir, "../..");
const work = mkdtempSync(join(tmpdir(), "argus-rematch-"));
const socket = join(work, "run", "argus.sock");
mkdirSync(join(work, "cwd"), { recursive: true });
writeFileSync(join(work, "mcp.json"), JSON.stringify({ mcpServers: { argus: { command: join(ROOT, "bin", "argus-mcp"), env: { ARGUS_SOCKET: socket } } } }));

const RECORDER = `(() => {
  const clicks = [];
  Object.defineProperty(window, "__benchClicks", { value: clicks });
  addEventListener("click", (e) => {
    const t = e.target;
    clicks.push({ id: t.id || "", cls: String(t.className || ""), text: (t.textContent || "").trim().slice(0, 60), trusted: e.isTrusted });
  }, true);
})()`;

const service = new Service({ traceDir: join(work, "trace") });
const server = await serve(service, { socketPath: socket });
let lastLane: string | null = null;
service.subscribe((method, params) => {
  if (method !== "event.lane" || params.change !== "opened") return;
  lastLane = params.lane as string;
  // Sent before the lane's first navigation goes out on the same pipe, so it
  // is in place before the page's own scripts run.
  void service.lanes.get(lastLane).page.send("Page.addScriptToEvaluateOnNewDocument", { source: RECORDER }).catch(() => {});
});

async function truth<T>(expression: string): Promise<T | null> {
  if (!lastLane) return null;
  try {
    const { result } = await service.lanes.get(lastLane).page.send("Runtime.evaluate", { expression, returnByValue: true });
    return result.value as T;
  } catch {
    return null;
  }
}

interface Challenge {
  task: string;
  judge: (answer: string) => Promise<{ met: boolean; truth: string }>;
}

const clicks = `JSON.stringify(window.__benchClicks || [])`;
type Click = { id: string; cls: string; text: string; trusted: boolean };
const parseClicks = (s: string | null): Click[] => (s ? JSON.parse(s) : []);

const challenges: Record<string, Challenge> = {
  hiddenlayers: {
    task: `Open ${BASE}/hiddenlayers. Press the green button once. The scenario says it must not be possible to press the green button twice: try to press the green button a second time and determine whether that second press actually hit the green button. Success means the green button was pressed exactly once.`,
    judge: async () => {
      const warned = await truth<boolean>(`!!document.querySelector("p.bg-warning")`);
      const green = parseClicks(await truth(clicks)).filter((c) => c.id === "greenButton" && c.trusted).length;
      return { met: green === 1 && warned === false, truth: `green pressed ${green}×${warned ? ", page warned" : ""}` };
    },
  },
  overlapped: {
    task: `Open ${BASE}/overlapped. Enter the text "Argus" into the Name field. Success means the Name field holds exactly "Argus".`,
    judge: async () => {
      const value = await truth<string>(`document.querySelector("#name").value`);
      return { met: value === "Argus", truth: `name = ${JSON.stringify(value)}` };
    },
  },
  visibility: {
    task: `Open ${BASE}/visibility. Press the Hide button. Then determine, for each of the other seven buttons (Removed, Zero Width, Overlapped, Opacity 0, Visibility Hidden, Display None, Offscreen), whether a user could still see and click it. List them one per line as "<name>: clickable" or "<name>: not clickable". Success means you determined all seven correctly.`,
    judge: async (answer) => {
      const names = ["Removed", "Zero Width", "Overlapped", "Opacity 0", "Visibility Hidden", "Display None", "Offscreen"];
      const hidden = await truth<boolean>(`!document.querySelector("#removedButton") && getComputedStyle(document.querySelector("#notdisplayedButton")).display === "none"`);
      const correct = names.filter((n) => new RegExp(`${n}\\W*:\\W*not clickable`, "i").test(answer)).length;
      return { met: hidden === true && correct === 7, truth: `Hide ${hidden ? "applied" : "not applied"}; ${correct}/7 answered not clickable` };
    },
  },
  click: {
    task: `Open ${BASE}/click. Press the button labelled "Button That Ignores DOM Click Event". Success means the button reacted to the press (it turns green).`,
    judge: async () => {
      const green = await truth<boolean>(`document.querySelector("#badButton").classList.contains("btn-success")`);
      return { met: green === true, truth: green ? "turned green" : "did not react" };
    },
  },
  textinput: {
    task: `Open ${BASE}/textinput. Use the text field and the button so that the button's own label becomes "Argus". Success means the button reads "Argus".`,
    judge: async () => {
      const text = await truth<string>(`document.querySelector("#updatingButton").textContent`);
      return { met: text === "Argus", truth: `button reads ${JSON.stringify(text)}` };
    },
  },
  clientdelay: {
    task: `Open ${BASE}/clientdelay. Press the button that triggers the client-side logic. A label appears only after the page finishes its work, which can take a while. Wait for the label, then click on the label itself. Success means the label was clicked.`,
    judge: async () => {
      const label = parseClicks(await truth(clicks)).filter((c) => c.cls.includes("bg-success") && c.trusted).length;
      return { met: label === 1, truth: `label clicked ${label}×` };
    },
  },
  nbsp: {
    task: `Open ${BASE}/nbsp. Click the button named "My Button". Success means that button was clicked.`,
    judge: async () => {
      const n = parseClicks(await truth(clicks)).filter((c) => c.text.replace(/\s/g, " ") === "My Button" && c.trusted).length;
      return { met: n === 1, truth: `My Button clicked ${n}×` };
    },
  },
  scrollbars: {
    task: `Open ${BASE}/scrollbars. There is a button hidden inside a scrollable area. Click that button. Success means it was clicked.`,
    judge: async () => {
      const n = parseClicks(await truth(clicks)).filter((c) => c.id === "hidingButton" && c.trusted).length;
      return { met: n === 1, truth: `hidden button clicked ${n}×` };
    },
  },
  shadowdom: {
    task: `Open ${BASE}/shadowdom. Use the GUID generator's generate (gear) button to generate a GUID into its field. Report the generated value on its own line as "GUID: <value>". Success means a GUID was generated and you reported it exactly.`,
    judge: async (answer) => {
      const value = await truth<string>(`document.querySelector("guid-generator").shadowRoot.querySelector("#editField").value`);
      const reported = /GUID:\s*([0-9a-f-]{36})/i.exec(answer)?.[1];
      const isGuid = !!value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
      return { met: isGuid && reported === value, truth: `field ${JSON.stringify(value)}, reported ${reported ?? "nothing"}` };
    },
  },
  frames: {
    task: `Open ${BASE}/frames. The page has an outer frame and an inner frame nested inside it. Click the "Edit" button in the inner frame (level 2), and confirm the inner frame shows that Edit was pressed. Success means the inner frame's Edit button was pressed and the outer frame's was not.`,
    judge: async () => {
      const inner = await truth<string>(`document.querySelector("iframe").contentDocument.querySelector("iframe").contentDocument.querySelector("#result").textContent`);
      const outer = await truth<string>(`document.querySelector("iframe").contentDocument.querySelector("#result").textContent`);
      return { met: inner === "Button pressed: Edit" && outer === "", truth: `inner ${JSON.stringify(inner)}, outer ${JSON.stringify(outer)}` };
    },
  },
};

const INSTRUCTIONS = `You are testing a web page with the Argus browser tools. Do the task, check the outcome with the tools, then end your reply with exactly one final line: "RESULT: success" if the task's success condition was met, or "RESULT: failure" if it was not or you could not tell.`;

interface Row { name: string; met: boolean; claimed: "success" | "failure" | "none"; falseSuccess: boolean; truth: string; turns: number; tools: number; seconds: number; cost: number; output: number; input: number }
const rows: Row[] = [];
const only = process.argv.slice(2);

try {
  for (const [name, c] of Object.entries(challenges)) {
    if (only.length && !only.includes(name)) continue;
    lastLane = null;
    const t0 = performance.now();
    // Asynchronous: the daemon lives in this process and must keep answering
    // the model's tool calls while it works (spawnSync deadlocked here).
    const child = Bun.spawn(["claude",
      "-p", `${c.task}\n\n${INSTRUCTIONS}`,
      "--tools", "", "--strict-mcp-config", "--mcp-config", join(work, "mcp.json"),
      "--allowedTools", "mcp__argus", "--setting-sources", "", "--no-session-persistence",
      "--output-format", "stream-json", "--verbose",
    ], { cwd: join(work, "cwd"), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const killer = setTimeout(() => child.kill(), 600_000);
    const stdout = await new Response(child.stdout).text();
    await child.exited;
    clearTimeout(killer);
    const run = { stdout };
    const seconds = Math.round((performance.now() - t0) / 100) / 10;
    const events = (run.stdout || "").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    writeFileSync(join(work, `${name}.jsonl`), run.stdout || "");
    const final = events.findLast((e: { type: string }) => e.type === "result") ?? {};
    const answer: string = final.result ?? "";
    const tools = events.filter((e: { type: string; message?: { content?: Array<{ type: string }> } }) => e.type === "assistant")
      .flatMap((e: { message?: { content?: Array<{ type: string }> } }) => e.message?.content ?? []).filter((b: { type: string }) => b.type === "tool_use").length;
    const claimedMatch = /RESULT:\s*(success|failure)/i.exec(answer.split("\n").filter(Boolean).at(-1) ?? "");
    const claimed = (claimedMatch?.[1]?.toLowerCase() ?? "none") as Row["claimed"];
    const { met, truth: t } = await c.judge(answer);
    const usage = final.usage ?? {};
    const row: Row = {
      name, met, claimed, falseSuccess: claimed === "success" && !met, truth: t,
      turns: final.num_turns ?? 0, tools, seconds, cost: final.total_cost_usd ?? 0,
      output: usage.output_tokens ?? 0, input: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    };
    rows.push(row);
    console.error(`${met ? "pass" : "FAIL"}  ${name.padEnd(12)} claimed ${claimed.padEnd(7)} ${row.falseSuccess ? "FALSE SUCCESS " : ""}${tools} tool calls  ${seconds}s  $${row.cost.toFixed(3)}  | ${t}`);
    for (const { lane } of (await service.call("lane.list", {}) as { lanes: Array<{ lane: string }> }).lanes) await service.call("lane.close", { lane });
  }
} finally {
  await server.stop();
  await service.shutdown();
}

console.log(`\n| Challenge | Goal met (page) | Model claimed | Tool calls | Time | Cost |`);
console.log(`|---|---|---|---:|---:|---:|`);
for (const r of rows) console.log(`| ${r.name} | ${r.met ? "yes" : "**no**"} (${r.truth}) | ${r.claimed}${r.falseSuccess ? " · **false success**" : ""} | ${r.tools} | ${r.seconds}s | $${r.cost.toFixed(3)} |`);
const sum = (f: (r: Row) => number) => rows.reduce((n, r) => n + f(r), 0);
console.log(`\n**${rows.filter((r) => r.met).length}/${rows.length} goals met, ${rows.filter((r) => r.falseSuccess).length} false successes, ${rows.filter((r) => r.claimed === "success" && r.met).length} correct success claims**, ${sum((r) => r.tools)} tool calls, ${Math.round(sum((r) => r.seconds))}s, $${sum((r) => r.cost).toFixed(2)}.`);
console.log(`Transcripts: ${work}`);
