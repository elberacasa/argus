// The protocol's methods, over lanes. Transport-free: the socket server feeds
// it parsed requests, and tests can call it directly.

import { act } from "../act/executor";
import { locate, publicElement } from "../act/locate";
import { Lanes } from "../lane/lanes";
import { ErrorCode, RpcError, type ActResult, type LaneKind, type Step, type Target, type Viewport } from "../protocol/types";
import { captureScene } from "../scene/snapshot";
import { outline } from "../scene/outline";

export const VERSION = "0.1.0";

export interface Notify { (method: string, params: Record<string, unknown>): void }

export class Service {
  readonly lanes: Lanes;
  private readonly listeners = new Set<Notify>();

  constructor(options: { executable?: string; headless?: boolean } = {}) {
    this.lanes = new Lanes(options, {
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

  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "hello":
        return {
          protocol: "0",
          server: { name: "argusd", version: VERSION },
          capabilities: { lanes: this.lanes.kinds, eyes: false, decider: "none", check: [] },
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
          const found = locate(scene, params.target as Target);
          if (found.ok) return { matches: [publicElement(found.element)], match: found.match };
          if (found.diagnosis.reason === "ambiguous")
            return { matches: (found.diagnosis.candidates ?? []).slice(0, (params.limit as number | undefined) ?? 8), match: "exact" };
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
      const result = await this.lanes.withLane(lane, (l) => this.traced(l.id, act(l, params.steps, { noErrorsByDefault: true })));
      const failedAt = result.steps.findIndex((s) => !s.ok);
      return {
        name: params.name,
        verdict: result.ok ? "pass" as const : "fail" as const,
        ...(result.ok ? {} : { failedAt: failedAt === -1 ? result.steps.length : failedAt }),
        steps: result.steps,
        ms: Math.round(performance.now() - t0),
        trace: `${lane}-${Date.now()}`,
      };
    } finally {
      if (own) await this.lanes.close(lane).catch(() => {});
    }
  }

  /** One script across conditions, in parallel lanes. */
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
