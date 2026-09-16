// argus: the command line, a thin client of argusd.
//
// Browser work goes to the daemon over the Argus Protocol, so a person at a
// terminal gets exactly what an agent gets: verified steps, named failures,
// priced evidence. Output is the same compact text the MCP tools return;
// --json prints the protocol result itself.
//
// Exit status: 0 when every step held, 3 when a step failed with a diagnosis
// (a result to read, not a crash), 1 for usage or transport errors.

import { existsSync, readFileSync } from "node:fs";
import { ArgusError, type Client } from "../rpc/client";
import { connect } from "../rpc/connect";
import { defaultSocketPath } from "../rpc/server";
import type { ActResult, Target } from "../protocol/types";
import { renderAct, renderCheck, renderFind, renderObservation, renderRun, renderSweep } from "../render/text";

const USAGE = `argus -- drive browsers and be told the truth about what happened.

usage: argus [--lane NAME] [--json] [--expect JSON] <command>

  open <url>                    load a page; prints what loaded and an outline
  click <target> [nth]          click with a real pointer, or say why it cannot
  type <target> <text>          replace a field's text, verified
  press <key>                   Enter, Tab, Escape, Control+a, ...
  select <target> <option>      choose an option
  hover <target>
  scroll <target> | by <dy>     scroll until the target's centre is uncovered
  upload <target> <file>...     set files without opening a picker
  wait <text> [within]          wait until text appears, e.g. wait "Saved" 20s
  dialog accept [text] | dismiss   answer the next dialog
  viewport <WxH> | reset        emulate a screen size (under 600 wide is a phone)

  outline [budget]              the page in a few hundred tokens, with refs
  find <target>                 elements matching a target, in frames and shadow roots too
  check [a11y|layout|runtime|perf]...   what is wrong with the page
  look [target]                 crop one element (or the viewport) to a PNG, priced
  shot [--full]                 screenshot to a PNG, priced

  act <json | @file>            a script of steps, stops at the first surprise
  run <json | @file>            a script as a test in a fresh lane: pass or fail
  sweep <json | @file>          one script across viewports and color schemes

  lanes                         open lanes
  close                         close this lane
  trace [-n N]                  what this lane did
  daemon status|stop            the argusd process

A target is role:name ("button:Sign in"), a ref from an outline ("e0.57"),
text:... for plain text, or JSON ({"role":"button","name":"Save","nth":2}).
Lanes are named; the default is "main" (or $ARGUS_LANE).

Desks, your own browser, nests and the bar: argus desk|peek|own|nest|bar ...
`;

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (s: string) => !color ? s : s
  .replace(/^(\s*)✓/gm, "$1\x1b[32m✓\x1b[0m").replace(/^(\s*)✗/gm, "$1\x1b[31m✗\x1b[0m")
  .replace(/^(\s*)\+ /gm, "$1\x1b[32m+\x1b[0m ").replace(/^(\s*)− /gm, "$1\x1b[31m−\x1b[0m ")
  .replace(/^(\s*)(!|~) /gm, "$1\x1b[33m$2\x1b[0m ").replace(/^PASS/gm, "\x1b[32mPASS\x1b[0m").replace(/^FAIL/gm, "\x1b[31mFAIL\x1b[0m");

export function parseTarget(raw: string): Target {
  if (raw.startsWith("{")) return JSON.parse(raw) as Target;
  if (raw.startsWith("text:")) return { text: raw.slice(5) };
  return raw;
}

function parseJsonArg(raw: string | undefined, what: string): unknown {
  if (!raw) throw new UsageError(`${what} needs JSON or @file`);
  const source = raw.startsWith("@") ? readFileSync(raw.slice(1), "utf8") : raw;
  return JSON.parse(source);
}

class UsageError extends Error {}

interface Options { lane: string; json: boolean; expect?: unknown }

async function laneId(c: Client, label: string, openUrl?: string): Promise<{ id: string; opened?: Record<string, unknown> } | null> {
  const { lanes } = await c.call<{ lanes: Array<{ lane: string; label: string }> }>("lane.list");
  const found = lanes.find((l) => l.label === label);
  if (found) return { id: found.lane };
  if (!openUrl) return null;
  const opened = await c.call<Record<string, unknown>>("lane.open", { kind: "throwaway", label, url: openUrl });
  return { id: opened.lane as string, opened };
}

async function needLane(c: Client, o: Options): Promise<string> {
  const l = await laneId(c, o.lane);
  if (!l) throw new UsageError(`no lane "${o.lane}": start with argus${o.lane === "main" ? "" : ` --lane ${o.lane}`} open <url>`);
  return l.id;
}

async function step(c: Client, o: Options, s: Record<string, unknown>): Promise<number> {
  const lane = await needLane(c, o);
  const r = await c.call<ActResult>("act", { lane, steps: [o.expect ? { ...s, expect: o.expect } : s] });
  print(o, r, () => renderAct(r, 1));
  return r.ok ? 0 : 3;
}

function print(o: Options, result: unknown, text: () => string): void {
  console.log(o.json ? JSON.stringify(result, null, 2) : paint(text()));
}

export async function cli(argv: string[]): Promise<number> {
  const o: Options = { lane: process.env.ARGUS_LANE || "main", json: false };
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--lane") o.lane = argv[++i] ?? o.lane;
    else if (a === "--json") o.json = true;
    else if (a === "--expect") o.expect = JSON.parse(argv[++i] ?? "{}");
    else if (a === "-h" || a === "--help" || a === "help") { console.log(USAGE); return 0; }
    else args.push(a);
  }
  const command = args.shift();
  if (!command) { console.log(USAGE); return 0; }

  try {
    if (command === "daemon") return await daemon(args[0] ?? "status");
    const c = await connect({ name: "argus-cli" });
    try {
      return await dispatch(c, o, command, args);
    } finally {
      c.close();
    }
  } catch (error) {
    if (error instanceof UsageError) { console.error(`argus: ${error.message}`); return 1; }
    if (error instanceof ArgusError) { console.error(`argus: ${error.message}`); return 1; }
    console.error(`argus: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function dispatch(c: Client, o: Options, command: string, args: string[]): Promise<number> {
  const need = (n: number, usage: string) => { if (args.length < n) throw new UsageError(`usage: argus ${usage}`); };
  switch (command) {
    case "open": {
      need(1, "open <url>");
      const url = args[0]!;
      const found = await laneId(c, o.lane, url);
      if (found!.opened) {
        const { outline } = await c.call<{ outline: string }>("scene.outline", { lane: found!.id });
        print(o, found!.opened, () => [`lane ${o.lane} opened`, ...renderObservation((found!.opened!.observation ?? {}) as never), "", outline].join("\n"));
        return 0;
      }
      const r = await c.call<ActResult>("act", { lane: found!.id, steps: [o.expect ? { open: url, expect: o.expect } : { open: url }] });
      if (!r.ok || o.json) { print(o, r, () => renderAct(r, 1)); return r.ok ? 0 : 3; }
      const { outline } = await c.call<{ outline: string }>("scene.outline", { lane: found!.id });
      print(o, r, () => `${renderAct(r)}\n\n${outline}`);
      return 0;
    }
    case "click": {
      need(1, "click <target> [nth]");
      let target = parseTarget(args[0]!);
      if (args[1]) {
        const nth = Number(args[1]);
        const base = typeof target === "string" ? (target.includes(":") ? { role: target.split(":")[0], name: target.slice(target.indexOf(":") + 1) } : { role: target }) : target;
        target = { ...base, nth } as Target;
      }
      return step(c, o, { click: target });
    }
    case "type": need(2, "type <target> <text>"); return step(c, o, { type: [parseTarget(args[0]!), args.slice(1).join(" ")] });
    case "press": case "key": need(1, "press <key>"); return step(c, o, { press: args[0] });
    case "select": need(2, "select <target> <option>"); return step(c, o, { select: [parseTarget(args[0]!), args.slice(1).join(" ")] });
    case "hover": need(1, "hover <target>"); return step(c, o, { hover: parseTarget(args[0]!) });
    case "scroll":
      need(1, "scroll <target> | by <dy>");
      return args[0] === "by" ? step(c, o, { scroll: { by: { x: 0, y: Number(args[1] ?? 0) } } }) : step(c, o, { scroll: parseTarget(args[0]!) });
    case "upload": need(2, "upload <target> <file>..."); return step(c, o, { upload: [parseTarget(args[0]!), ...args.slice(1)] });
    case "wait": need(1, "wait <text> [within]"); return step(c, o, { wait: { appears: args[0], ...(args[1] ? { within: args[1] } : {}) } });
    case "dialog":
      need(1, "dialog accept [text] | dismiss");
      return step(c, o, { dialog: args[0] === "accept" && args[1] !== undefined ? { accept: args.slice(1).join(" ") } : args[0] });
    case "viewport": {
      need(1, "viewport <WxH> | reset");
      if (args[0] === "reset") return step(c, o, { viewport: "reset" });
      const m = /^(\d+)x(\d+)$/.exec(args[0]!);
      if (!m) throw new UsageError("usage: argus viewport <WxH> | reset");
      return step(c, o, { viewport: { w: Number(m[1]), h: Number(m[2]) } });
    }

    case "outline": {
      const r = await c.call<{ outline: string; tokens: number }>("scene.outline", { lane: await needLane(c, o), ...(args[0] ? { budget: Number(args[0]) } : {}) });
      print(o, r, () => r.outline);
      return 0;
    }
    case "find": {
      need(1, "find <target>");
      const r = await c.call<{ matches: never[]; match: string }>("scene.find", { lane: await needLane(c, o), target: parseTarget(args[0]!) });
      print(o, r, () => renderFind(r));
      return r.matches.length ? 0 : 3;
    }
    case "check": case "audit": {
      const r = await c.call<{ score: number; findings: never[]; scanned: number }>("check", { lane: await needLane(c, o), ...(args.length ? { only: args } : {}) });
      print(o, r, () => renderCheck(r));
      return 0;
    }
    case "look": case "shot": {
      const lane = await needLane(c, o);
      const r = command === "look"
        ? await c.call<{ image: string; w: number; h: number; tokens: number }>("evidence.look", { lane, ...(args[0] ? { target: parseTarget(args[0]) } : {}) })
        : await c.call<{ image: string; w: number; h: number; tokens: number }>("evidence.shot", { lane, ...(args.includes("--full") ? { full: true } : {}) });
      print(o, r, () => `${r.image}  ${r.w}x${r.h}  ${r.tokens} image tokens`);
      return 0;
    }

    case "act": {
      const parsed = parseJsonArg(args[0], "act");
      const steps = Array.isArray(parsed) ? parsed : (parsed as { steps: unknown[] }).steps;
      const r = await c.call<ActResult>("act", { lane: await needLane(c, o), steps });
      print(o, r, () => renderAct(r, steps.length));
      return r.ok ? 0 : 3;
    }
    case "run": {
      const spec = parseJsonArg(args[0], "run") as Record<string, unknown>;
      const r = await c.call<{ verdict: string } & Parameters<typeof renderRun>[0]>("run", { name: spec.name ?? "run", steps: spec.steps ?? spec });
      print(o, r, () => renderRun(r));
      return r.verdict === "pass" ? 0 : 3;
    }
    case "sweep": {
      const spec = parseJsonArg(args[0], "sweep") as Record<string, unknown>;
      const r = await c.call<Parameters<typeof renderSweep>[0]>("sweep", spec);
      print(o, r, () => renderSweep(r));
      return r.verdict === "pass" ? 0 : 3;
    }

    case "lanes": {
      const r = await c.call<{ lanes: Array<{ label: string; url: string; title: string; busy: boolean }> }>("lane.list");
      print(o, r, () => r.lanes.map((l) => `${(l.label || "(unnamed)").padEnd(12)} ${l.title || l.url}${l.busy ? "  busy" : ""}`).join("\n") || "(no lanes)");
      return 0;
    }
    case "close": {
      const l = await laneId(c, o.lane);
      if (!l) { console.log(`no lane "${o.lane}"`); return 0; }
      const r = await c.call("lane.close", { lane: l.id });
      print(o, r, () => `lane ${o.lane} closed`);
      return 0;
    }
    case "trace": {
      const n = args[0] === "-n" ? Number(args[1] ?? 20) : 20;
      const l = await laneId(c, o.lane);
      const r = await c.call<{ entries: Array<{ id: string; method: string; ok: boolean; ms: number; at: string }> }>("trace.list", { ...(l ? { lane: l.id } : {}), limit: n });
      print(o, r, () => r.entries.map((e) => `${new Date(e.at).toLocaleTimeString([], { hour12: false })} ${e.ok ? "✓" : "✗"} ${e.method.padEnd(10)} ${String(e.ms).padStart(5)}ms  ${e.id}`).join("\n") || "(nothing yet)");
      return 0;
    }
    default:
      throw new UsageError(`unknown command "${command}" (argus --help)`);
  }
}

async function daemon(action: string): Promise<number> {
  const socket = process.env.ARGUS_SOCKET ?? defaultSocketPath();
  const pidFile = `${socket}.pid`;
  const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : null;
  const alive = pid !== null && (() => { try { process.kill(pid, 0); return true; } catch { return false; } })();
  if (action === "status") {
    console.log(alive ? `argusd running (pid ${pid}) on ${socket}` : "argusd is not running (it starts on first use)");
    return 0;
  }
  if (action === "stop") {
    if (!alive) { console.log("argusd is not running"); return 0; }
    // The pid recorded by the daemon that owns this socket; nothing matched by name.
    process.kill(pid!, "SIGTERM");
    for (let i = 0; i < 100 && existsSync(pidFile); i++) await Bun.sleep(50);
    console.log(existsSync(pidFile) ? `argusd (pid ${pid}) did not stop` : `argusd stopped (pid ${pid})`);
    return existsSync(pidFile) ? 1 : 0;
  }
  console.error("usage: argus daemon status|stop");
  return 1;
}
