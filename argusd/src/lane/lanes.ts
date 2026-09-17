// Lanes: isolated places to work, and the browsers behind them.
//
// Lanes of one kind share one Chromium that argusd launched over a pipe, each in
// its own browser context -- separate cookies, storage and cache, and a
// fraction of the memory of a browser per lane. Throwaway lanes share a headless
// browser; desk lanes share a headful one whose windows land on the desk, one
// window per lane. If a browser dies, every lane in it is closed and reported
// lost, never silently re-created.

import { Browser, Page } from "../cdp/pipe";
import { act, setViewport, type LaneContext } from "../act/executor";
import { RpcError, ErrorCode, type LaneKind, type Viewport } from "../protocol/types";
import { Probe, type Mark } from "./probe";
import { DESK_BROWSER_ARGS, deskAvailable, ensureDesk } from "./desk";
import { Bridge, OwnPage } from "./own";
import type { CdpPage } from "../cdp/page";

export interface Lane extends LaneContext {
  page: CdpPage;
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

type BrowserKind = "throwaway" | "desk";

export class Lanes {
  private readonly browsers = new Map<BrowserKind, Browser>();
  private readonly launching = new Map<BrowserKind, Promise<Browser>>();
  /** Windows a headful browser opened by itself at launch, closed once a lane has a window of its own. */
  private readonly startupTargets = new Map<Browser, string[]>();
  private readonly lanes = new Map<string, Lane>();
  private next = 1;

  constructor(
    private readonly options: { executable?: string; headless?: boolean } = {},
    private readonly events: Partial<LaneEvents> = {},
  ) {}

  private bridge: Bridge | null = null;
  private bridging: Promise<Bridge> | null = null;

  /** Lane kinds this machine can serve right now. `own` only while a browser is bridged. */
  async kinds(): Promise<LaneKind[]> {
    const kinds: LaneKind[] = ["throwaway"];
    if (deskAvailable()) kinds.push("desk");
    try { await this.ensureBridge(); kinds.push("own"); } catch { /* no bridged browser */ }
    return kinds;
  }

  private async ensureBridge(): Promise<Bridge> {
    if (this.bridge?.connected) return this.bridge;
    if (!this.bridging) {
      this.bridging = Bridge.connect().then((bridge) => {
        this.bridge = bridge;
        bridge.onLost(() => {
          if (this.bridge !== bridge) return;
          this.bridge = null;
          for (const lane of [...this.lanes.values()]) {
            if (lane.kind !== "own") continue;
            this.lanes.delete(lane.id);
            this.events.lane?.({ lane: lane.id, change: "lost" });
          }
        });
        return bridge;
      }).finally(() => { this.bridging = null; });
    }
    return this.bridging;
  }

  private async ensureBrowser(kind: BrowserKind): Promise<Browser> {
    const existing = this.browsers.get(kind);
    if (existing?.alive) return existing;
    let pending = this.launching.get(kind);
    if (!pending) {
      pending = (async () => {
        if (kind === "desk") await ensureDesk();
        const browser = await Browser.launch({
          ...(this.options.executable ? { executable: this.options.executable } : {}),
          headless: kind === "desk" ? false : this.options.headless ?? true,
          ...(kind === "desk" ? { args: DESK_BROWSER_ARGS } : {}),
        });
        if (kind === "desk") {
          const { targetInfos } = await browser.send("Target.getTargets");
          this.startupTargets.set(browser, targetInfos.filter((t) => t.type === "page").map((t) => t.targetId));
        }
        this.browsers.set(kind, browser);
        browser.onExit(() => this.lost(kind, browser));
        return browser;
      })().finally(() => { this.launching.delete(kind); });
      this.launching.set(kind, pending);
    }
    return pending;
  }

  private lost(kind: BrowserKind, browser: Browser): void {
    if (this.browsers.get(kind) !== browser) return;
    this.browsers.delete(kind);
    for (const lane of [...this.lanes.values()]) {
      if (lane.kind !== kind) continue;
      this.lanes.delete(lane.id);
      this.events.lane?.({ lane: lane.id, change: "lost" });
    }
  }

  async open(params: { kind: LaneKind; url?: string; viewport?: Viewport; label?: string }) {
    if (params.kind === "desk" && !deskAvailable())
      throw new RpcError(ErrorCode.capabilityMissing, "desk lanes need a Hyprland session; this daemon has none");
    if (params.kind !== "throwaway" && params.kind !== "desk" && params.kind !== "own")
      throw new RpcError(ErrorCode.capabilityMissing, `lane kind "${params.kind}" is not available in argusd yet`);
    const id = `l${this.next++}`;
    let page: CdpPage;
    if (params.kind === "own") {
      let bridge: Bridge;
      try {
        bridge = await this.ensureBridge();
      } catch (error) {
        throw new RpcError(ErrorCode.capabilityMissing, `own lanes need your Chromium with the Argus extension (argus own install, then restart Chromium): ${error instanceof Error ? error.message : String(error)}`);
      }
      // A key of argusd's own, so it can never collide with a lane the legacy
      // command line opened in the same browser.
      page = await OwnPage.open(bridge, `argusd-${id}`);
    } else {
      let browser: Browser;
      try {
        browser = await this.ensureBrowser(params.kind);
      } catch (error) {
        throw new RpcError(ErrorCode.capabilityMissing, `could not start a ${params.kind} browser: ${error instanceof Error ? error.message : String(error)}`);
      }
      page = await Page.open(browser, { isolated: true, newWindow: params.kind === "desk" });
      if (params.kind === "desk") await this.closeStartupWindow(browser);
    }
    const desk = params.kind !== "throwaway";
    const probe = await Probe.attach(page);
    // A desk window or a tab in the person's browser is a real window: its size
    // is the viewport. Emulation is applied only when asked for.
    const viewport = params.viewport ?? DEFAULT_VIEWPORT;
    if (!desk || params.viewport) await setViewport(page, viewport);
    const lane: Lane = {
      id, kind: params.kind, page, probe,
      defaultViewport: desk && !params.viewport ? null : { w: viewport.w, h: viewport.h },
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

  /**
   * A headful Chromium opens a blank window of its own; once a lane has a
   * window, that one goes. Only the ids recorded at launch are closed: lanes
   * opening at the same moment are not yet registered, and a cleanup that
   * judged "not a lane" closed their windows (three parallel opens did).
   */
  private async closeStartupWindow(browser: Browser): Promise<void> {
    const ids = this.startupTargets.get(browser);
    if (!ids?.length) return;
    this.startupTargets.set(browser, []);
    for (const targetId of ids) await browser.send("Target.closeTarget", { targetId }).catch(() => {});
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
      if (!lane.page.alive) throw new RpcError(ErrorCode.browserLost, `the browser behind lane ${id} exited`);
      throw error;
    } finally {
      lane.busy = false;
    }
  }

  async close(id: string): Promise<{ closed: true }> {
    const lane = this.get(id);
    this.lanes.delete(id);
    const kind = lane.kind as BrowserKind;
    const last = kind === "desk" && ![...this.lanes.values()].some((l) => l.kind === "desk");
    if (lane.kind === "own") {
      await lane.page.close();
      this.events.lane?.({ lane: id, change: "closed" });
      return { closed: true };
    }
    if (last) {
      // A headful Chromium quits when its last window closes; end it on our
      // terms instead, so the next desk lane starts a fresh one cleanly.
      const browser = this.browsers.get(kind);
      this.browsers.delete(kind);
      await browser?.close();
    } else {
      await lane.page.close();
    }
    this.events.lane?.({ lane: id, change: "closed" });
    return { closed: true };
  }

  async list() {
    const lanes = [];
    for (const lane of this.lanes.values()) {
      let url = "", title = "";
      try {
        ({ url, title } = await lane.page.info());
      } catch { /* closing */ }
      lanes.push({ lane: lane.id, kind: lane.kind, url, title, label: lane.label ?? "", busy: lane.busy, opened: lane.opened });
    }
    return { lanes };
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.lanes.keys()]) await this.close(id).catch(() => {});
    this.bridge?.close();
    this.bridge = null;
    for (const [kind, browser] of [...this.browsers]) {
      this.browsers.delete(kind);
      await browser.close();
    }
  }
}
