// The protocol's methods, over lanes. Transport-free: the socket server feeds
// it parsed requests, and tests can call it directly.

import { act, locateOn } from "../act/executor";
import { locate, publicElement } from "../act/locate";
import { Lanes } from "../lane/lanes";
import { ErrorCode, RpcError, type ActResult, type LaneKind, type Step, type Target, type Viewport } from "../protocol/types";
import { captureScene } from "../scene/snapshot";
import { outline } from "../scene/outline";
import { check, CATEGORIES, type Category } from "../check/check";
import { look, shot } from "../evidence/evidence";
import { Trace } from "../trace/trace";

export const VERSION = "0.1.0";

/**
 * Which code this process runs: the compiled binary's modification time, or
 * the newest source file's. A client computes the same and warns when a
 * daemon that is still running predates an update.
 */
export function buildId(): string {
  const { statSync, readdirSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  const self = process.argv[1] ?? "";
  if (!self.endsWith(".ts")) {
    try { return `bin-${Math.floor(statSync(process.execPath).mtimeMs)}`; } catch { return "bin-unknown"; }
  }
  const src = join(import.meta.dir, "..");
  let newest = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts")) newest = Math.max(newest, statSync(path).mtimeMs);
    }
  };
  walk(src);
  return `src-${Math.floor(newest)}`;
}

export interface Notify { (method: string, params: Record<string, unknown>): void }

export class Service {
  readonly lanes: Lanes;
  readonly trace: Trace;
  /** The code this daemon started with, fixed at startup so an update shows as a mismatch. */
  private readonly build = buildId();
  private readonly listeners = new Set<Notify>();

  constructor(options: { executable?: string; headless?: boolean; traceDir?: string } = {}) {
    this.trace = new Trace(options.traceDir);
    this.lanes = new Lanes({ ...(options.executable ? { executable: options.executable } : {}), ...(options.headless !== undefined ? { headless: options.headless } : {}) }, {
      lane: (e) => this.emit("event.lane", e),
    });
  }

  subscribe(notify: Notify): () => void {
    this.listeners.add(notify);
    return () => this.listeners.delete(notify);
  }

  private emit(method: string, params: Record<string, unknown>): void {
    for (const l of this.listeners) l(method, params);
  }

  /** Methods whose calls are written to the trace: everything that acts or judges. */
  private static readonly TRACED = new Set(["act", "run", "sweep", "check", "lane.open", "lane.close"]);

  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!Service.TRACED.has(method)) return this.dispatch(method, params);
    const t0 = performance.now();
    let result: unknown, ok = false;
    try {
      result = await this.dispatch(method, params);
      const r = result as { ok?: boolean; verdict?: string };
      ok = r?.ok ?? (r?.verdict ? r.verdict === "pass" : true);
      return result;
    } catch (error) {
      result = { error: error instanceof Error ? error.message : String(error) };
      throw error;
    } finally {
      const lane = (params.lane as string | undefined) ?? (result as { lane?: string } | undefined)?.lane ?? null;
      this.trace.record(method, lane, params, result, ok, Math.round(performance.now() - t0));
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "hello":
        return {
          protocol: "0",
          server: { name: "argusd", version: VERSION, build: this.build },
          capabilities: { lanes: await this.lanes.kinds(), eyes: true, decider: "none", check: CATEGORIES },
        };

      case "lane.open":
        return this.lanes.open(params as { kind: LaneKind; url?: string; viewport?: Viewport; label?: string });
      case "lane.close":
        return this.lanes.close(params.lane as string);
      case "lane.list":
        return this.lanes.list();

      case "scene.outline":
        return this.lanes.withLane(params.lane as string, async (lane) =>
          outline(lane.page, await captureScene(lane.page), (params.budget as number | undefined) ?? 250));

      case "scene.find":
        return this.lanes.withLane(params.lane as string, async (lane) => {
          const scene = await captureScene(lane.page);
          const found = await locateOn(lane.page, scene, params.target as Target);
          if (found.ok) return { matches: [publicElement(found.element)], match: found.match };
          if (found.diagnosis.reason === "ambiguous") {
            const limit = (params.limit as number | undefined) ?? 8;
            return { matches: (found.diagnosis.candidates ?? []).slice(0, limit), match: "exact", total: found.diagnosis.count ?? (found.diagnosis.candidates ?? []).length };
          }
          return { matches: [], match: "none", near: found.diagnosis.didYouMean ?? [], hint: found.diagnosis.hint };
        });

      case "act":
        return this.lanes.withLane(params.lane as string, (lane) =>
          this.traced(lane.id, act(lane, params.steps as Step[], params.stopOnSurprise === undefined ? {} : { stopOnSurprise: params.stopOnSurprise as boolean })));

      case "observe":
        return this.lanes.withLane(params.lane as string, async (lane) => {
          const { events: _events, ...observation } = lane.probe.since(lane.openMark);
          return observation;
        });

      case "check":
        if (Array.isArray(params.viewports)) return this.checkAcross(params as { lane: string; viewports: Viewport[]; only?: Category[] });
        return this.lanes.withLane(params.lane as string, async (lane) => {
          const scene = await captureScene(lane.page);
          let within: number | undefined;
          if (params.target !== undefined) {
            const found = locate(scene, params.target as Target);
            if (!found.ok) throw new RpcError(ErrorCode.invalidParams, found.diagnosis.hint, found.diagnosis);
            within = found.element.backendNodeId;
          }
          return check(lane.page, lane.probe, lane.openMark, scene, {
            ...(params.only ? { only: params.only as Category[] } : {}),
            ...(within !== undefined ? { within } : {}),
          });
        });

      case "evidence.shot":
        return this.lanes.withLane(params.lane as string, (lane) => shot(lane.page, lane.id, params.full === true));

      case "evidence.look":
        return this.lanes.withLane(params.lane as string, async (lane) => {
          const scene = await captureScene(lane.page);
          if (params.target === undefined) return look(lane.page, lane.id, scene, null);
          const found = locate(scene, params.target as Target);
          // A covered or ambiguous target is still worth seeing; only a missing one is an error.
          const element = found.ok ? found.element
            : found.diagnosis.reason === "ambiguous" ? scene.elements.find((e) => e.ref === found.diagnosis.candidates?.[0]?.ref) ?? null
            : null;
          if (!element) throw new RpcError(ErrorCode.invalidParams, found.ok ? "" : found.diagnosis.hint, found.ok ? undefined : found.diagnosis);
          return look(lane.page, lane.id, scene, element, (params.pad as number | undefined) ?? 16);
        });

      case "trace.list":
        return this.trace.list({ ...(params.lane ? { lane: params.lane as string } : {}), ...(params.limit ? { limit: params.limit as number } : {}) });

      case "trace.get": {
        const entry = this.trace.get(params.id as string);
        if (!entry) throw new RpcError(ErrorCode.invalidParams, `no trace entry ${params.id as string}`);
        return entry;
      }

      case "run":
        return this.run(params as { lane?: string; kind?: LaneKind; name: string; steps: Step[] });

      case "sweep":
        return this.sweep(params as { name: string; steps: Step[]; across: { viewports?: Viewport[]; colorScheme?: Array<"light" | "dark"> } });

      default:
        throw new RpcError(ErrorCode.methodNotFound, `${method} is part of the protocol but not implemented in argusd ${VERSION}`);
    }
  }

  private async traced(lane: string, result: Promise<ActResult>): Promise<ActResult> {
    const r = await result;
    for (const step of r.steps) this.emit("event.step", { lane, i: step.i, verb: step.verb, ok: step.ok, ...(step.diagnosis ? { reason: step.diagnosis.reason } : {}) });
    return r;
  }

  /** A script as a test: errors fail it, and the answer is a verdict. */
  private async run(params: { lane?: string; kind?: LaneKind; name: string; steps: Step[] }, setup?: (lane: string) => Promise<void>) {
    const t0 = performance.now();
    const own = params.lane === undefined;
    const lane = own ? (await this.lanes.open({ kind: params.kind ?? "throwaway" })).lane : params.lane!;
    try {
      if (setup) await setup(lane);
      const t0Act = performance.now();
      const result = await this.lanes.withLane(lane, (l) => this.traced(l.id, act(l, params.steps, { noErrorsByDefault: true })));
      const traceId = this.trace.record("run.steps", lane, { name: params.name, steps: params.steps }, result, result.ok, Math.round(performance.now() - t0Act));
      const failedAt = result.steps.findIndex((s) => !s.ok);
      return {
        name: params.name,
        verdict: result.ok ? "pass" as const : "fail" as const,
        ...(result.ok ? {} : { failedAt: failedAt === -1 ? result.steps.length : failedAt }),
        steps: result.steps,
        ms: Math.round(performance.now() - t0),
        trace: traceId,
      };
    } finally {
      if (own) await this.lanes.close(lane).catch(() => {});
    }
  }

  /** One script across conditions, in parallel lanes. */
  /**
   * The same audit at several sizes, in parallel lanes: what a responsive
   * review needs. A finding that only appears on a phone is the point, and it
   * is invisible when each size is looked at on its own.
   */
  private async checkAcross(params: { lane: string; viewports: Viewport[]; only?: Category[] }) {
    const url = await this.lanes.withLane(params.lane, async (lane) => (await captureScene(lane.page)).url);
    const across = await Promise.all(params.viewports.map(async (viewport) => {
      const opened = await this.lanes.open({ kind: "throwaway", viewport, url });
      try {
        const lane = this.lanes.get(opened.lane);
        const scene = await captureScene(lane.page);
        const r = await check(lane.page, lane.probe, lane.openMark, scene, { ...(params.only ? { only: params.only } : {}) });
        return { viewport, score: r.score, scanned: r.scanned, findings: r.findings };
      } finally {
        await this.lanes.close(opened.lane).catch(() => {});
      }
    }));
    return { across };
  }

  private async sweep(params: { name: string; steps: Step[]; across: { viewports?: Viewport[]; colorScheme?: Array<"light" | "dark"> } }) {
    const t0 = performance.now();
    const viewports = params.across.viewports ?? [{ w: 1280, h: 800 }];
    const schemes = params.across.colorScheme ?? [null];
    const conditions = viewports.flatMap((viewport) => schemes.map((colorScheme) => ({ viewport, colorScheme })));

    const results = await Promise.all(conditions.map(async (condition) => {
      const opened = await this.lanes.open({ kind: "throwaway", viewport: condition.viewport });
      try {
        const lane = this.lanes.get(opened.lane);
        if (condition.colorScheme)
          await lane.page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: condition.colorScheme }] });
        const r = await this.run({ lane: opened.lane, name: params.name, steps: params.steps });
        const failed = r.failedAt !== undefined ? r.steps[r.failedAt] : undefined;
        return {
          condition: { viewport: condition.viewport, ...(condition.colorScheme ? { colorScheme: condition.colorScheme } : {}) },
          verdict: r.verdict,
          ...(r.failedAt !== undefined ? { failedAt: r.failedAt } : {}),
          ...(failed?.diagnosis ? { diagnosis: failed.diagnosis } : {}),
        };
      } finally {
        await this.lanes.close(opened.lane).catch(() => {});
      }
    }));

    return {
      name: params.name,
      verdict: results.every((r) => r.verdict === "pass") ? "pass" : "fail",
      results,
      ms: Math.round(performance.now() - t0),
    };
  }

  async shutdown(): Promise<void> {
    await this.lanes.shutdown();
  }
}
