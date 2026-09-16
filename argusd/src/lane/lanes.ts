// Lanes: isolated places to work, and the browsers behind them.
//
// Throwaway lanes share one headless Chromium that argusd launched over a pipe,
// each in its own browser context -- separate cookies, storage and cache, and
// a fraction of the memory of a browser per lane. If that browser dies, every
// lane in it is closed and reported lost, never silently re-created.

import { Browser, Page } from "../cdp/pipe";
import { act, setViewport, type LaneContext } from "../act/executor";
import { RpcError, ErrorCode, type LaneKind, type Viewport } from "../protocol/types";
import { Probe, type Mark } from "./probe";

export interface Lane extends LaneContext {
  id: string;
  kind: LaneKind;
  label?: string;
  opened: string;
  busy: boolean;
  openMark: Mark;
}

export interface LaneEvents {
  lane(event: { lane: string; change: "opened" | "closed" | "lost" }): void;
}

const DEFAULT_VIEWPORT = { w: 1280, h: 800 };

export class Lanes {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private readonly lanes = new Map<string, Lane>();
  private next = 1;

  constructor(
    private readonly options: { executable?: string; headless?: boolean } = {},
    private readonly events: Partial<LaneEvents> = {},
  ) {}

  get kinds(): LaneKind[] { return ["throwaway"]; }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.alive) return this.browser;
    if (!this.launching) {
      this.launching = Browser.launch({
        ...(this.options.executable ? { executable: this.options.executable } : {}),
        headless: this.options.headless ?? true,
      }).then((browser) => {
        this.browser = browser;
        browser.onExit(() => this.lost(browser));
        return browser;
      }).finally(() => { this.launching = null; });
    }
    return this.launching;
  }

  private lost(browser: Browser): void {
    if (this.browser !== browser) return;
    this.browser = null;
    for (const lane of [...this.lanes.values()]) {
      this.lanes.delete(lane.id);
      this.events.lane?.({ lane: lane.id, change: "lost" });
    }
  }

  async open(params: { kind: LaneKind; url?: string; viewport?: Viewport; label?: string }) {
    if (params.kind !== "throwaway")
      throw new RpcError(ErrorCode.capabilityMissing, `lane kind "${params.kind}" is not available in argusd yet; use throwaway`);
    const browser = await this.ensureBrowser();
    const page = await Page.open(browser, { isolated: true });
    const probe = await Probe.attach(page);
    const viewport = params.viewport ?? DEFAULT_VIEWPORT;
    await setViewport(page, viewport);
    const id = `l${this.next++}`;
    const lane: Lane = {
      id, kind: params.kind, page, probe,
      defaultViewport: { w: viewport.w, h: viewport.h },
      opened: new Date().toISOString(), busy: false,
      openMark: await probe.mark(),
      ...(params.label ? { label: params.label } : {}),
    };
    this.lanes.set(id, lane);
    this.events.lane?.({ lane: id, change: "opened" });

    const result: { lane: string; kind: LaneKind; url: string; observation?: unknown } = { lane: id, kind: params.kind, url: "about:blank" };
    if (params.url) {
      const opened = await this.withLane(id, (l) => act(l, [{ open: params.url! }]));
      const step = opened.steps[0]!;
      result.url = step.observation.url?.to ?? params.url;
      result.observation = step.observation;
      if (!step.ok) {
        await this.close(id);
        throw new RpcError(ErrorCode.internal, step.diagnosis?.hint ?? `could not open ${params.url}`, step.diagnosis);
      }
    }
    return result;
  }

  get(id: string): Lane {
    const lane = this.lanes.get(id);
    if (!lane) throw new RpcError(ErrorCode.unknownLane, `no lane ${id}`);
    return lane;
  }

  /** Run work on a lane exclusively: lanes are serial, parallelism is more lanes. */
  async withLane<T>(id: string, work: (lane: Lane) => Promise<T>): Promise<T> {
    const lane = this.get(id);
    if (lane.busy) throw new RpcError(ErrorCode.busy, `lane ${id} is running another script`);
    lane.busy = true;
    try {
      return await work(lane);
    } catch (error) {
      if (!this.browser?.alive) throw new RpcError(ErrorCode.browserLost, `the browser behind lane ${id} exited`);
      throw error;
    } finally {
      lane.busy = false;
    }
  }

  async close(id: string): Promise<{ closed: true }> {
    const lane = this.get(id);
    this.lanes.delete(id);
    await lane.page.close();
    this.events.lane?.({ lane: id, change: "closed" });
    return { closed: true };
  }

  async list() {
    const lanes = [];
    for (const lane of this.lanes.values()) {
      let url = "", title = "";
      try {
        const info = await lane.page.browser.send("Target.getTargetInfo", { targetId: lane.page.targetId });
        url = info.targetInfo.url;
        title = info.targetInfo.title;
      } catch { /* closing */ }
      lanes.push({ lane: lane.id, kind: lane.kind, url, title, label: lane.label ?? "", busy: lane.busy, opened: lane.opened });
    }
    return { lanes };
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.lanes.keys()]) await this.close(id).catch(() => {});
    await this.browser?.close();
    this.browser = null;
  }
}
