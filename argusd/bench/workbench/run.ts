// Workbench: realistic tasks, one model, three ways to drive a browser.
//
//   bun bench/workbench/run.ts [--tools argus,argus-own,chrome] [--rounds N] [task...]
//
// Each session is a headless Claude Code session (`claude -p`) whose only tools
// are one browser tool's. "argus" opens lanes in Argus's own headless browser;
// "argus-own" opens them as tabs in the person's Chromium through the Argus
// extension; "chrome" is Claude in Chrome in the same Chromium. The task text
// is identical; only the sentence naming the tools differs.
//
// The harness hosts the Workbench app, so judges read the server's record of
// what happened. Traps (tasks that cannot succeed) count as correct only when
// the session reports failure.

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "../../src/rpc/client";
import { connect } from "../../src/rpc/connect";
import { ENDING, runSession } from "../lib/session";
import { AVATAR_PATH, startWorkbench } from "./app";
import { TASKS } from "./tasks";

type Tool = "argus" | "argus-own" | "chrome";
const ROOT = resolve(import.meta.dir, "../../..");
const MODEL = process.env.MODEL ?? "claude-opus-5";
const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i === -1 ? undefined : args.splice(i, 2)[1]; };
const TOOLS = (flag("--tools") ?? "argus,argus-own,chrome").split(",") as Tool[];
const ROUNDS = Number(flag("--rounds") ?? 1);
const only = args;

const work = mkdtempSync(join(tmpdir(), "argus-workbench-"));
const socket = join(work, "run", "argus.sock");
mkdirSync(join(work, "cwd"), { recursive: true });
// The file a session is asked to upload lives in that session's own working
// directory: a tool that may only read what the session may read is not being
// measured on where the harness happened to put a file.
copyFileSync(AVATAR_PATH, join(work, "cwd", "avatar.png"));
process.env.ARGUS_BENCH_AVATAR = join(work, "cwd", "avatar.png");
mkdirSync(join(work, "run"), { recursive: true });
writeFileSync(join(work, "mcp.json"), JSON.stringify({ mcpServers: { argus: { command: join(ROOT, "bin", "argus-mcp"), env: { ARGUS_SOCKET: socket } } } }));

const SETUP: Record<Tool, { intro: string; flags: string[] }> = {
  argus: { intro: "You are working in a web browser with the Argus browser tools.", flags: ["--strict-mcp-config", "--mcp-config", join(work, "mcp.json"), "--allowedTools", "mcp__argus"] },
  "argus-own": { intro: "You are working in a web browser with the Argus browser tools. Open pages in the person's own browser (browser_open with own: true).", flags: ["--strict-mcp-config", "--mcp-config", join(work, "mcp.json"), "--allowedTools", "mcp__argus"] },
  chrome: { intro: "You are working in a web browser with the Claude in Chrome browser tools. The pages are served on this machine: use the local (Linux) browser.", flags: ["--chrome", "--strict-mcp-config", "--allowedTools", "mcp__claude-in-chrome"] },
};

interface Row { tool: Tool; task: string; round: number; possible: boolean; met: boolean; claimed: string; correct: boolean; falseSuccess: boolean; truth: string; tools: number; seconds: number; cost: number; input: number; output: number }
const rows: Row[] = [];
const wb = startWorkbench();

async function closeLanes() {
  try {
    const client = await Client.connect(socket);
    for (const { lane } of (await client.call<{ lanes: Array<{ lane: string }> }>("lane.list", {})).lanes) await client.call("lane.close", { lane });
    client.close();
  } catch { /* no daemon */ }
}

if (TOOLS.some((t) => t.startsWith("argus"))) {
  const client = await connect({ socketPath: socket });
  const kinds = TOOLS.filter((t) => t.startsWith("argus")).map((t) => (t === "argus-own" ? "own" : "throwaway"));
  for (const kind of kinds) {
    const { lane } = await client.call<{ lane: string }>("lane.open", { kind });
    await client.call("lane.close", { lane });
  }
  client.close();
}

try {
  const tasks = TASKS.filter((t) => !only.length || only.includes(t.id));
  for (let round = 1; round <= ROUNDS; round++) {
    for (const [i, t] of tasks.entries()) {
      // Rotate which tool goes first.
      const shift = (round + i) % TOOLS.length;
      const order = [...TOOLS.slice(shift), ...TOOLS.slice(0, shift)];
      for (const tool of order) {
        const transcript = join(work, `${tool}-${t.id}-${round}.jsonl`);
        let r;
        // A session whose browser tool never connected measured nothing: retry it, never score it.
        for (let attempt = 1; ; attempt++) {
          wb.reset();
          // Every tool is given the session directory holding the file a task
          // may ask it to upload: the same permission for all of them.
          r = await runSession({ prompt: `${t.task(wb.base)}\n\n${SETUP[tool].intro} ${ENDING}`, model: MODEL, flags: [...SETUP[tool].flags, "--add-dir", join(work, "cwd"), "--allowedTools", "Read"], cwd: join(work, "cwd"), transcript });
          if (!readFileSync(transcript, "utf8").includes("Browser extension is not connected")) break;
          console.error(`skip  ${tool} ${t.id} r${round}: the browser extension was not connected (attempt ${attempt})`);
          if (attempt === 3) throw new Error(`${tool}: the browser extension is not connected; reconnect it and rerun`);
          await Bun.sleep(30_000);
        }
        await Bun.sleep(300);
        const { met, truth } = t.judge(r.answer, wb.state);
        const correct = t.possible ? met : r.claimed === "failure";
        const row: Row = { tool, task: t.id, round, possible: t.possible, met, claimed: r.claimed, correct, falseSuccess: r.claimed === "success" && !met, truth, tools: r.tools, seconds: r.seconds, cost: r.cost, input: r.input, output: r.output };
        rows.push(row);
        writeFileSync(join(work, "rows.json"), JSON.stringify(rows, null, 2));
        console.error(`${correct ? "pass" : "FAIL"}  ${tool.padEnd(9)} ${t.id.padEnd(16)} r${round} claimed ${r.claimed.padEnd(7)} ${row.falseSuccess ? "FALSE SUCCESS " : ""}${r.tools} calls  ${r.seconds}s  $${r.cost.toFixed(3)}  | ${truth}`);
        if (tool.startsWith("argus")) await closeLanes();
      }
    }
  }
} finally {
  wb.stop();
  try { process.kill(Number(readFileSync(`${socket}.pid`, "utf8").trim()), "SIGTERM"); } catch { /* not running */ }
}

console.log(`\n| Tool | Correct | False successes | Tool calls | Time | Tokens | Cost |\n|---|---:|---:|---:|---:|---:|---:|`);
for (const tool of TOOLS) {
  const rs = rows.filter((r) => r.tool === tool);
  const sum = (f: (r: Row) => number) => rs.reduce((s, r) => s + f(r), 0);
  console.log(`| ${tool} | ${rs.filter((r) => r.correct).length}/${rs.length} | ${rs.filter((r) => r.falseSuccess).length} | ${sum((r) => r.tools)} | ${Math.round(sum((r) => r.seconds))} s | ${Math.round(sum((r) => r.input + r.output) / 1000)}k | $${sum((r) => r.cost).toFixed(2)} |`);
}
console.log(`Transcripts: ${work}`);
