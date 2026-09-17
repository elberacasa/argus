// argusd as an MCP server: the tools agents actually call.
//
//   argusd mcp            stdio, for any MCP client (Claude Code, opencode, Codex, ...)
//
// Every browser tool is a thin call into the daemon over the Argus Protocol, so
// what an agent gets through MCP is exactly what the protocol guarantees:
// verified steps, named failures, priced evidence. Results come back as compact
// text (about a third of the tokens of the JSON); crops and screenshots come
// back as images, because a file path is useless to a model that cannot open it.
//
// Lanes are named. The first browser_open on a name opens it; later calls with
// the same name reuse it. The default name is "main".

import { readFileSync } from "node:fs";
import type { Client } from "../rpc/client";
import { ArgusError } from "../rpc/client";
import { connect } from "../rpc/connect";
import { Omarchy } from "../os/omarchy";
import type { ActResult } from "../protocol/types";
import { renderAct, renderCheck, renderCheckAcross, renderFind, renderObservation, renderRun, renderSweep } from "../render/text";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
interface ToolResult { content: Content[]; isError?: boolean }

const target = { description: 'What to act on: "role:name" (e.g. "button:Sign in"), a ref from an outline (e.g. "e0.57"), text on the page (e.g. "Draft 3"), or an object {"text": "..."} / {"role", "name", "nth", "near"}. Where there is no element to name (a canvas, a map, a chart), a point: {"x", "y"} in viewport pixels, or {"x", "y", "in": ref} measured from that element\'s top-left; read the numbers off a browser_look image, whose caption says where it sits.' };
const lane = { type: "string", description: 'Lane name. Each lane is an isolated browser (own cookies and history). Default "main". Use several for parallel work.' };
const expect = {
  type: "object",
  description: 'What must be true afterwards; the step fails, with what was actually there, if it is not. Keys: appears / disappears (text, or {"role","name"}), url {is|matches|changes}, field [target, value], state [target, "disabled"|"checked"|...], count [target, n], noErrors true, request {url, status}, within "5s".',
};
const steps = {
  type: "array",
  description: 'Steps, run in order until the first surprise. One verb per step: {"open": url} {"click": target} {"type": [target, text]} {"press": "Enter"} {"select": [target, option]} {"hover": target} {"drag": [from, to]} {"scroll": target | {"by": {x, y}, "in"?: target} | {"until": target, "in"?: target}} {"upload": [target, path...]} {"dialog": "accept"|"dismiss"} {"viewport": {w, h}} {"wait": expectation}. Any step may add "expect".',
  items: { type: "object" },
};

const TOOLS = [
  { name: "browser_open", description: "Open a URL in a lane and return what loaded plus an outline of the page (landmarks, headings, fields, actions with refs, and which actions are covered or disabled). Start here.",
    inputSchema: { type: "object", properties: { url: { type: "string" }, lane, own: { type: "boolean", description: "Open the lane as a tab in the person's own Chromium, with their logins, through the Argus extension. It only ever touches tabs it opened. Ask the person before acting on their accounts." }, desk: { type: "boolean", description: "Open the lane as a real, headful window on the desk (a monitor only agents use, watched from the Omarchy bar) instead of a headless browser. Only when the lane is first opened." }, viewport: { type: "object", description: "{w, h}; widths under 600 emulate a phone", properties: { w: { type: "integer" }, h: { type: "integer" } } } }, required: ["url"] } },
  { name: "browser_act", description: "Run a script of steps in one call, each verified; stops at the first step that fails and says why (covered, disabled, hidden, ambiguous, not-found with near matches, expectation-failed, timeout). Prefer this to single clicks when you know the next few steps.",
    inputSchema: { type: "object", properties: { steps, lane }, required: ["steps"] } },
  { name: "browser_click", description: "Click one element, or a point, with a real pointer. Returns what changed. If it cannot land (covered, disabled, hidden, offscreen) it does not click, and names the reason and the blocker. Confirm dialogs it opens are dismissed unless dialog is \"accept\".",
    inputSchema: { type: "object", properties: { target, lane, expect, dialog: { enum: ["accept", "dismiss"], description: "How to answer a confirm or prompt dialog the click opens. Default dismiss." } }, required: ["target"] } },
  { name: "browser_drag", description: "Drag from one element or point to another with the pointer held down: cards between columns, sliders, map pins, reordering. Works for pointer-driven and native HTML5 drag and drop. Returns what changed.",
    inputSchema: { type: "object", properties: { from: target, to: target, lane, expect }, required: ["from", "to"] } },
  { name: "browser_scroll", description: 'Scroll with the wheel. {"until": target} keeps scrolling until the target is on the page: long lists that only render the rows in view, feeds that load more at the bottom. "in" scrolls inside a container (a list, a panel) instead of the page. Or {"by": {"x", "y"}} pixels, or a target to bring into view.',
    inputSchema: { type: "object", properties: { until: target, in: target, by: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } } }, target, lane } } },
  { name: "browser_type", description: "Replace a field's text by typing into it. Verifies the field holds the text afterwards.",
    inputSchema: { type: "object", properties: { target, text: { type: "string" }, lane, expect }, required: ["target", "text"] } },
  { name: "browser_press", description: 'Press a key or chord: "Enter", "Tab", "Escape", "Control+a", ...',
    inputSchema: { type: "object", properties: { key: { type: "string" }, lane, expect }, required: ["key"] } },
  { name: "browser_select", description: "Choose an option in a select element by its visible text or value.",
    inputSchema: { type: "object", properties: { target, option: { type: "string" }, lane, expect }, required: ["target", "option"] } },
  { name: "browser_wait", description: 'Wait until something is true, instead of sleeping: e.g. {"appears": "Order confirmed", "within": "20s"}. Resolves the moment it holds; fails with a timeout otherwise.',
    inputSchema: { type: "object", properties: { until: expect, lane }, required: ["until"] } },
  { name: "browser_outline", description: "The page in a few hundred tokens: landmarks, headings, fields and actions with refs; covered, disabled and clipped actions are flagged.",
    inputSchema: { type: "object", properties: { lane, budget: { type: "integer", description: "Token budget, default 250" } } } },
  { name: "browser_find", description: "Find elements by target, including inside frames and shadow roots. Returns refs, positions and states, or near matches.",
    inputSchema: { type: "object", properties: { target, lane }, required: ["target"] } },
  { name: "browser_check", description: "What is wrong with the page: WCAG contrast with measured ratios, tap targets under 24px, unnamed controls, missing alt, heading order, duplicate ids, horizontal overflow, tiny text, console errors, exceptions, failed and slow requests. Includes frames and shadow roots. Pass viewports to audit the same page at several sizes at once and see what only fails on a phone.",
    inputSchema: { type: "object", properties: { lane, only: { type: "array", items: { enum: ["a11y", "layout", "runtime", "perf"] } }, viewports: { type: "array", description: '[{"w":390,"h":844},{"w":1280,"h":800}]', items: { type: "object", properties: { w: { type: "integer" }, h: { type: "integer" } } } } } } },
  { name: "browser_look", description: "See one element (covered or disabled ones too) as a cropped image, or the viewport if no target. Returns the image and its cost in image tokens.",
    inputSchema: { type: "object", properties: { target, lane } } },
  { name: "browser_screenshot", description: "A screenshot of the viewport (1280x800 costs 1,334 image tokens), or the full page. Prefer browser_look or text results when they answer the question.",
    inputSchema: { type: "object", properties: { lane, full: { type: "boolean" } } } },
  { name: "browser_run", description: "Run steps as a test in a fresh lane: console errors and failed requests fail it by default. Returns pass or fail, where, and why.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, steps }, required: ["name", "steps"] } },
  { name: "browser_sweep", description: "Run the same steps at several viewports and color schemes, in parallel lanes, and report which conditions fail and why.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, steps, viewports: { type: "array", items: { type: "object", properties: { w: { type: "integer" }, h: { type: "integer" } } } }, colorSchemes: { type: "array", items: { enum: ["light", "dark"] } } }, required: ["name", "steps"] } },
  { name: "browser_trace", description: "What was done in a lane, most recent first.",
    inputSchema: { type: "object", properties: { lane, limit: { type: "integer" } } } },
  { name: "browser_lanes", description: "List open lanes.", inputSchema: { type: "object", properties: {} } },
  { name: "browser_close", description: "Close a lane.", inputSchema: { type: "object", properties: { lane } } },
  { name: "omarchy_groups", description: "List every group of Omarchy system commands with how many each holds: the whole operating system in ~180 tokens. Then call omarchy_commands on a group.",
    inputSchema: { type: "object", properties: {} } },
  { name: "omarchy_commands", description: "List the commands in one Omarchy group, with a one-line summary each.",
    inputSchema: { type: "object", properties: { group: { type: "string" } }, required: ["group"] } },
  { name: "omarchy_help", description: "Full detail for one Omarchy command: summary, arguments, examples, and whether it is destructive.",
    inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "omarchy_run", description: "Run an Omarchy command and return its output. Destructive commands are refused unless confirm is true; always tell the user what you are about to run and why before setting it.",
    inputSchema: { type: "object", properties: { command: { type: "string" }, args: { type: "array", items: { type: "string" } }, confirm: { type: "boolean" } }, required: ["command"] } },
];

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

export class McpServer {
  private client: Client | null = null;
  private omarchy: Omarchy | null = null;
  /**
   * Lanes belong to the session that opened them. Two Claude Code sessions, or
   * two agents fanned out each with their own argus, both ask for "main": they
   * must not drive the same browser. The scope is the client process that
   * started this server, so lanes survive the server itself restarting.
   */
  private readonly scope = process.env.ARGUS_LANE_SCOPE || `s${process.ppid}`;

  constructor(private readonly options: { socketPath?: string } = {}) {}

  private label(name: string | undefined): string { return `${this.scope}:${name || "main"}`; }
  private nameOf(label: string): string | null { return label.startsWith(`${this.scope}:`) ? label.slice(this.scope.length + 1) : null; }

  private async daemon(): Promise<Client> {
    if (!this.client) this.client = await connect({ ...(this.options.socketPath ? { socketPath: this.options.socketPath } : {}), name: "argus-mcp" });
    return this.client;
  }

  /** The daemon lane id for a lane name, opening it if asked to. */
  private async laneId(name: string | undefined, open?: { url: string; viewport?: { w: number; h: number }; desk?: boolean; own?: boolean }): Promise<{ id: string; opened?: Record<string, unknown> } | null> {
    const label = this.label(name);
    const c = await this.daemon();
    const { lanes } = await c.call<{ lanes: Array<{ lane: string; label: string }> }>("lane.list");
    const existing = lanes.find((l) => l.label === label);
    if (existing) return { id: existing.lane };
    if (!open) return null;
    const opened = await c.call<Record<string, unknown>>("lane.open", { kind: open.own ? "own" : open.desk ? "desk" : "throwaway", url: open.url, label, ...(open.viewport ? { viewport: open.viewport } : {}) });
    return { id: opened.lane as string, opened };
  }

  private async act(args: Record<string, unknown>, steps: unknown[]): Promise<ToolResult> {
    const l = await this.laneId(args.lane as string | undefined);
    if (!l) return text(`No lane "${(args.lane as string) || "main"}". Call browser_open first.`, true);
    const r = await (await this.daemon()).call<ActResult>("act", { lane: l.id, steps });
    return text(renderAct(r, steps.length));
  }

  private image(path: string, caption: string): ToolResult {
    return { content: [{ type: "text", text: caption }, { type: "image", data: readFileSync(path).toString("base64"), mimeType: "image/png" }] };
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const withExpect = (step: Record<string, unknown>) => (args.expect ? { ...step, expect: args.expect } : step);
    switch (name) {
      case "browser_open": {
        const viewport = args.viewport as { w: number; h: number } | undefined;
        const found = await this.laneId(args.lane as string | undefined, { url: args.url as string, ...(viewport ? { viewport } : {}), ...(args.desk ? { desk: true } : {}), ...(args.own ? { own: true } : {}) });
        const c = await this.daemon();
        let head: string[];
        if (found!.opened) {
          head = [`lane ${(args.lane as string) || "main"} opened${args.own ? " in your browser" : args.desk ? " on the desk" : ""}`, ...renderObservation((found!.opened.observation ?? {}) as never)];
        } else {
          const steps: unknown[] = [];
          if (viewport) steps.push({ viewport });
          steps.push({ open: args.url });
          const r = await c.call<ActResult>("act", { lane: found!.id, steps });
          if (!r.ok) return text(renderAct(r, steps.length), true);
          head = [renderAct(r)];
        }
        const { outline } = await c.call<{ outline: string }>("scene.outline", { lane: found!.id });
        return text([...head, "", outline].join("\n"));
      }
      case "browser_act": return this.act(args, args.steps as unknown[]);
      case "browser_click": return this.act(args, [...(args.dialog ? [{ dialog: args.dialog }] : []), withExpect({ click: args.target })]);
      case "browser_drag": return this.act(args, [withExpect({ drag: [args.from, args.to] })]);
      case "browser_scroll": {
        const inside = args.in !== undefined ? { in: args.in } : {};
        if (args.until !== undefined) return this.act(args, [{ scroll: { until: args.until, ...inside } }]);
        if (args.by !== undefined) return this.act(args, [{ scroll: { by: args.by, ...inside } }]);
        if (args.target !== undefined) return this.act(args, [{ scroll: args.target }]);
        return text('Give "until", "by" or "target".', true);
      }
      case "browser_type": return this.act(args, [withExpect({ type: [args.target, args.text] })]);
      case "browser_press": return this.act(args, [withExpect({ press: args.key })]);
      case "browser_select": return this.act(args, [withExpect({ select: [args.target, args.option] })]);
      case "browser_wait": return this.act(args, [{ wait: args.until }]);

      case "browser_outline":
      case "browser_find":
      case "browser_check":
      case "browser_look":
      case "browser_screenshot":
      case "browser_trace": {
        const l = await this.laneId(args.lane as string | undefined);
        if (!l) return text(`No lane "${(args.lane as string) || "main"}". Call browser_open first.`, true);
        const c = await this.daemon();
        if (name === "browser_outline") return text((await c.call<{ outline: string }>("scene.outline", { lane: l.id, ...(args.budget ? { budget: args.budget } : {}) })).outline);
        if (name === "browser_find") return text(renderFind(await c.call("scene.find", { lane: l.id, target: args.target })));
        if (name === "browser_check") {
          const r = await c.call<{ across?: unknown[] }>("check", { lane: l.id, ...(args.only ? { only: args.only } : {}), ...(args.viewports ? { viewports: args.viewports } : {}) });
          return text(r.across ? renderCheckAcross(r as never) : renderCheck(r as never));
        }
        if (name === "browser_trace") {
          const { entries } = await c.call<{ entries: Array<{ id: string; method: string; ok: boolean; ms: number; at: string }> }>("trace.list", { lane: l.id, limit: (args.limit as number) ?? 20 });
          return text(entries.map((e) => `${e.at.slice(11, 19)} ${e.ok ? "✓" : "✗"} ${e.method} ${e.ms}ms ${e.id}`).join("\n") || "(nothing yet)");
        }
        // A tab the browser is not painting cannot be pictured; the page can
        // still be read, so the call answers with the page instead of nothing.
        type Shot = { image: string; w: number; h: number; tokens: number; origin?: { x: number; y: number } };
        const picture = async () => {
          const e = name === "browser_look"
            ? await c.call<Shot>("evidence.look", { lane: l.id, ...(args.target !== undefined ? { target: args.target } : {}) })
            : await c.call<Shot>("evidence.shot", { lane: l.id, ...(args.full ? { full: true } : {}) });
          const where = e.origin ? ` at (${e.origin.x}, ${e.origin.y}) in the viewport; image pixel (px, py) is viewport point (${e.origin.x}+px, ${e.origin.y}+py)` : "";
          return this.image(e.image, `${e.w}x${e.h}${where}, ${e.tokens} image tokens`);
        };
        try {
          return await picture();
        } catch (error) {
          const detail = error instanceof ArgusError ? error.message : error instanceof Error ? error.message : String(error);
          const { outline } = await c.call<{ outline: string }>("scene.outline", { lane: l.id });
          return text(`no picture: ${detail}\n\nthe page as text instead:\n${outline}`, true);
        }
      }

      case "browser_run": return text(renderRun(await (await this.daemon()).call("run", { name: args.name, steps: args.steps })));
      case "browser_sweep": {
        const across: Record<string, unknown> = {};
        if (args.viewports) across.viewports = args.viewports;
        if (args.colorSchemes) across.colorScheme = args.colorSchemes;
        if (!Object.keys(across).length) across.viewports = [{ w: 390, h: 844 }, { w: 1280, h: 800 }];
        return text(renderSweep(await (await this.daemon()).call("sweep", { name: args.name, steps: args.steps, across })));
      }
      case "browser_lanes": {
        const { lanes } = await (await this.daemon()).call<{ lanes: Array<{ label: string; url: string; title: string; busy: boolean }> }>("lane.list");
        const mine = lanes.map((l) => ({ ...l, name: this.nameOf(l.label ?? "") })).filter((l) => l.name !== null);
        const elsewhere = lanes.length - mine.length;
        const lines = mine.map((l) => `${l.name || "(unnamed)"}  ${l.title || l.url}${l.busy ? "  busy" : ""}`);
        if (elsewhere) lines.push(`(${elsewhere} more open in other sessions)`);
        return text(lines.join("\n") || "(no lanes)");
      }
      case "browser_close": {
        const l = await this.laneId(args.lane as string | undefined);
        if (!l) return text(`No lane "${(args.lane as string) || "main"}".`);
        await (await this.daemon()).call("lane.close", { lane: l.id });
        return text(`lane ${(args.lane as string) || "main"} closed`);
      }

      case "omarchy_groups": case "omarchy_commands": case "omarchy_help": case "omarchy_run": {
        this.omarchy ??= new Omarchy();
        if (!this.omarchy.available) return text("Omarchy is not installed on this machine.", true);
        if (name === "omarchy_groups") return text(this.omarchy.groups());
        if (name === "omarchy_commands") {
          const out = this.omarchy.group(args.group as string);
          return out ? text(out) : text(`No group '${args.group as string}'. Call omarchy_groups for the list.`, true);
        }
        if (name === "omarchy_help") {
          const out = this.omarchy.help(args.command as string);
          return out ? text(out) : text(`Unknown command '${args.command as string}'.`, true);
        }
        const r = this.omarchy.run(args.command as string, (args.args as string[]) ?? [], args.confirm === true);
        return text(r.text, !r.ok);
      }
      default: return text(`Unknown tool: ${name}`, true);
    }
  }

  async handle(message: { id?: number | string; method?: string; params?: Record<string, unknown> }): Promise<unknown | null> {
    const { id, method, params = {} } = message;
    if (id === undefined) return null; // notifications
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    switch (method) {
      case "initialize": {
        const asked = params.protocolVersion as string | undefined;
        const supported = ["2025-06-18", "2025-03-26", "2024-11-05"];
        return reply({
          protocolVersion: asked && supported.includes(asked) ? asked : supported[0],
          capabilities: { tools: {} },
          serverInfo: { name: "argus", version: "0.1.0" },
          instructions: "Argus drives isolated browsers and tells you the truth about each step. Start with browser_open (it returns an outline with refs). Batch steps with browser_act. When a step fails, read the reason and hint before retrying. Use browser_check for UI review and browser_sweep for responsive checks.",
        });
      }
      case "ping": return reply({});
      case "tools/list": return reply({ tools: TOOLS });
      case "tools/call": {
        try {
          return reply(await this.callTool(params.name as string, (params.arguments as Record<string, unknown>) ?? {}));
        } catch (error) {
          const detail = error instanceof ArgusError ? `${error.message} (${error.code})` : error instanceof Error ? error.message : String(error);
          return reply(text(detail, true));
        }
      }
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
  }

  /** Serve MCP over stdin/stdout, one JSON message per line. */
  async serveStdio(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    const pending: Promise<void>[] = [];
    for await (const chunk of Bun.stdin.stream()) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let message: { id?: number | string; method?: string; params?: Record<string, unknown> };
        try { message = JSON.parse(line); } catch { continue; }
        pending.push(this.handle(message).then((out) => { if (out) process.stdout.write(JSON.stringify(out) + "\n"); }));
      }
    }
    await Promise.all(pending);
    this.client?.close();
  }
}
