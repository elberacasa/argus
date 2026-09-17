// Own lanes: tabs in the person's own Chromium, reached through the Argus
// extension and its native messaging host.
//
// The extension only ever addresses tabs it opened, grouped under "Argus", and
// forwards the debugger events argus needs for those tabs alone. The host
// listens on a 0600 unix socket. There is no remote-debugging port anywhere:
// argusd is one more local client of that socket, speaking lines of JSON with
// request ids, and one subscription for events.

import type { Socket } from "bun";
import type { CdpPage } from "../cdp/page";
import type { EventName, EventParams, Method, Params, Result } from "../cdp/pipe";

export function bridgeSocketPath(): string {
  return process.env.ARGUS_BRIDGE_SOCK || `${process.env.XDG_RUNTIME_DIR ?? "/tmp"}/argus/bridge.sock`;
}

type Listener = (method: string, params: unknown) => void;

export class Bridge {
  private socket: Socket<undefined> | null = null;
  private buffer = "";
  private nextRid = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly lostHandlers = new Set<() => void>();
  connected = false;
  version = "";

  private constructor(readonly path: string) {}

  /** Connect, subscribe to events, and say hello. Rejects when no browser is bridged. */
  static async connect(path = bridgeSocketPath()): Promise<Bridge> {
    const b = new Bridge(path);
    b.socket = await Bun.connect({
      unix: path,
      socket: {
        data: (_s, chunk) => b.receive(chunk.toString()),
        close: () => b.lost(new Error("the bridge to your browser closed")),
        error: (_s, error) => b.lost(error),
      },
    });
    b.connected = true;
    b.socket.write(JSON.stringify({ op: "subscribe" }) + "\n");
    const hello = await b.request<{ version: string }>("hello", {}, 5_000);
    b.version = hello.version;
    return b;
  }

  onLost(handler: () => void): void { this.lostHandlers.add(handler); }

  request<T>(op: string, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    if (!this.connected || !this.socket) return Promise.reject(new Error("the bridge to your browser is not connected"));
    const rid = ++this.nextRid;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new Error(`${op}: your browser did not answer within ${timeoutMs}ms`));
      }, timeoutMs + 500);
      this.pending.set(rid, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.socket!.write(JSON.stringify({ ...args, op, rid, timeout: timeoutMs / 1000 }) + "\n");
    });
  }

  on(lane: string, listener: Listener): () => void {
    let set = this.listeners.get(lane);
    if (!set) this.listeners.set(lane, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  close(): void {
    this.connected = false;
    this.socket?.end();
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let message: { rid?: number; ok?: boolean; result?: unknown; error?: string; event?: { lane: string; method: string; params: unknown } };
      try { message = JSON.parse(line); } catch { continue; }
      if (message.event) {
        for (const l of this.listeners.get(String(message.event.lane)) ?? []) l(message.event.method, message.event.params);
        continue;
      }
      if (message.rid === undefined) continue;
      const p = this.pending.get(message.rid);
      if (!p) continue;
      this.pending.delete(message.rid);
      clearTimeout(p.timer);
      if (message.ok) p.resolve(message.result ?? {});
      else p.reject(new Error(message.error ?? "the extension reported an error"));
    }
  }

  private lost(error: Error): void {
    if (!this.connected) return;
    this.connected = false;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    for (const h of this.lostHandlers) h();
  }
}

/** A tab argus opened in the person's browser, driven through the bridge. */
export class OwnPage implements CdpPage {
  readonly contextId = undefined;
  private detached = false;

  private constructor(private readonly bridge: Bridge, readonly lane: string, readonly targetId: string) {
    bridge.on(lane, (method) => { if (method === "Argus.detached") this.detached = true; });
  }

  /** Open (or reuse) the extension's tab for this lane key and attach to it. */
  static async open(bridge: Bridge, lane: string): Promise<OwnPage> {
    await bridge.request("lane_open", { lane });
    const send = <M extends Method>(method: M, params?: Params<M>) => bridge.request<Result<M>>("cdp", { lane, method, params: params ?? {} });
    const { frameTree } = await send("Page.getFrameTree");
    const page = new OwnPage(bridge, lane, frameTree.frame.id);
    // An argus tab stays in the background so the person keeps theirs. A
    // headful Chromium drops input to a hidden tab (measured: a real click on
    // "Accept" changed nothing, visibilityState "hidden"); focus emulation makes
    // the page visible and focused to itself without bringing the tab forward,
    // and the same click lands.
    await Promise.all([page.send("Page.enable"), page.send("Runtime.enable"), page.send("Emulation.setFocusEmulationEnabled", { enabled: true })]);
    return page;
  }

  get alive(): boolean { return this.bridge.connected && !this.detached; }

  send<M extends Method>(method: M, params?: Params<M>): Promise<Result<M>> {
    // A capture of a tab the browser is not painting can stall; answer sooner.
    const timeout = method === "Page.captureScreenshot" ? 8_000 : 30_000;
    return this.bridge.request<Result<M>>("cdp", { lane: this.lane, method, params: params ?? {} }, timeout);
  }

  on<E extends EventName>(event: E, listener: (params: EventParams<E>) => void): () => void {
    return this.bridge.on(this.lane, (method, params) => { if (method === event) listener(params as EventParams<E>); });
  }

  async navigate(url: string, timeoutMs = 30_000): Promise<{ errorText?: string }> {
    let errorText: string | undefined;
    let loaderId: string | undefined;
    try {
      ({ errorText, loaderId } = await this.send("Page.navigate", { url }));
    } catch (error) {
      return { errorText: error instanceof Error ? error.message : String(error) };
    }
    if (errorText) return { errorText };
    // Ready when the new document is interactive (DOMContentLoaded), read from
    // the page itself: no dependence on which events this extension version
    // forwards. A same-document navigation has no loaderId and is ready at once.
    if (!loaderId) return {};
    const t0 = performance.now();
    while (performance.now() - t0 < timeoutMs) {
      try {
        const { result } = await this.send("Runtime.evaluate", { expression: "[document.readyState, location.href]", returnByValue: true });
        const [state, href] = result.value as [string, string];
        if ((state === "interactive" || state === "complete") && href !== "about:blank") return {};
      } catch { /* the old document is going away */ }
      await Bun.sleep(40);
    }
    return { errorText: `the page did not become ready within ${timeoutMs}ms` };
  }

  async info(): Promise<{ url: string; title: string }> {
    const lanes = await this.bridge.request<Record<string, { url: string; title: string }>>("lanes");
    return lanes[this.lane] ?? { url: "", title: "" };
  }

  async close(): Promise<void> {
    await this.bridge.request("lane_close", { lane: this.lane }).catch(() => {});
  }
}
