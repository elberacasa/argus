// What happens on a page, heard from the browser rather than from wrappers
// injected into it: console, exceptions, network and dialogs arrive as CDP
// events, so nothing a page does before or after our script runs is missed.
//
// The one thing CDP has no event for is "the DOM changed". A MutationObserver
// in an isolated world counts mutations: invisible to the page's own scripts,
// installed before any of them run, and read only to tell quiet from busy.

import type { CdpPage as Page } from "../cdp/page";
import type { Observation } from "../protocol/types";

const MUTATION_WORLD = "argus";
const MUTATION_SCRIPT = `(() => {
  let n = 0;
  new MutationObserver((r) => { n += r.length; })
    .observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  Object.defineProperty(globalThis, "__argusMutations", { get: () => n });
})()`;

type Answer = "accept" | "dismiss";
interface Entry<T> { seq: number; at: number; value: T }
interface Request { method: string; url: string; started: number; status?: number }

export interface Mark {
  seq: number;
  mutations: number;
  at: number;
}

export class Probe {
  private seq = 0;
  private readonly console: Entry<NonNullable<Observation["console"]>[number]>[] = [];
  private readonly exceptions: Entry<NonNullable<Observation["exceptions"]>[number]>[] = [];
  private readonly network: Entry<NonNullable<Observation["network"]>[number] & { ok: boolean }>[] = [];
  private readonly dialogs: Entry<NonNullable<Observation["dialogs"]>[number]>[] = [];
  private readonly inflight = new Map<string, Request>();
  private worldContext: number | null = null;
  private armed: { answer: Answer; text?: string } | null = null;
  /** Last time anything at all happened on the page, for settle detection. */
  lastActivity = performance.now();
  /** Navigations started, for effect detection. */
  navigations = 0;

  private constructor(private readonly page: Page) {}

  static async attach(page: Page): Promise<Probe> {
    const probe = new Probe(page);
    probe.listen();
    await Promise.all([
      page.send("Network.enable"),
      page.send("Log.enable"),
      page.send("Page.addScriptToEvaluateOnNewDocument", { source: MUTATION_SCRIPT, worldName: MUTATION_WORLD }),
      page.send("Page.setLifecycleEventsEnabled", { enabled: true }),
    ]);
    return probe;
  }

  /** Answer the next dialog this way instead of dismissing it. One-shot. */
  arm(answer: Answer, text?: string): void {
    this.armed = text === undefined ? { answer } : { answer, text };
  }

  get busyRequests(): number { return this.inflight.size; }

  async mark(): Promise<Mark> {
    return { seq: this.seq, mutations: await this.mutations(), at: performance.now() };
  }

  async mutations(): Promise<number> {
    if (this.worldContext === null) return 0;
    try {
      const { result } = await this.page.send("Runtime.evaluate", {
        expression: "globalThis.__argusMutations | 0",
        contextId: this.worldContext,
        returnByValue: true,
      });
      return typeof result.value === "number" ? result.value : 0;
    } catch {
      return 0;
    }
  }

  /** Everything recorded after a mark, in the protocol's observation shape. */
  since(mark: Mark, limit = 12): Pick<Observation, "console" | "exceptions" | "network" | "dialogs"> & { events: number } {
    const after = <T>(list: Entry<T>[]) => list.filter((e) => e.seq > mark.seq).map((e) => e.value);
    const out: Pick<Observation, "console" | "exceptions" | "network" | "dialogs"> & { events: number } = { events: this.seq - mark.seq };
    const consoleItems = after(this.console);
    if (consoleItems.length) out.console = consoleItems.slice(-limit);
    const exceptions = after(this.exceptions);
    if (exceptions.length) out.exceptions = exceptions.slice(-limit);
    // Only failed or slow requests: forty successful asset loads bury the one 500.
    const network = after(this.network).filter((r) => !r.ok || (r.ms ?? 0) > 1000).map(({ ok: _ok, ...r }) => r);
    if (network.length) out.network = network.slice(-limit);
    const dialogs = after(this.dialogs);
    if (dialogs.length) out.dialogs = dialogs.slice(-limit);
    return out;
  }

  /** Every request that finished after a mark, including successful ones. */
  requestsSince(mark: Mark): Array<{ method?: string; url: string; status?: number }> {
    return this.network.filter((e) => e.seq > mark.seq).map((e) => e.value);
  }

  private push<T>(list: Entry<T>[], value: T): void {
    list.push({ seq: ++this.seq, at: performance.now(), value });
    if (list.length > 500) list.splice(0, list.length - 500);
    this.lastActivity = performance.now();
  }

  private listen(): void {
    const page = this.page;

    page.on("Runtime.executionContextCreated", ({ context }) => {
      const aux = context.auxData as { frameId?: string; isDefault?: boolean } | undefined;
      if (context.name === MUTATION_WORLD && aux?.frameId === page.targetId) this.worldContext = context.id;
    });
    page.on("Runtime.executionContextsCleared", () => { this.worldContext = null; });

    page.on("Runtime.consoleAPICalled", ({ type, args, stackTrace }) => {
      if (type !== "error" && type !== "warning" && type !== "assert") return;
      const text = args.map((a) => (a.value !== undefined ? String(a.value) : a.description ?? a.type)).join(" ");
      const frame = stackTrace?.callFrames[0];
      this.push(this.console, {
        level: type === "warning" ? "warning" : "error",
        text: text.slice(0, 500),
        ...(frame ? { source: `${frame.url}:${frame.lineNumber + 1}` } : {}),
      });
    });
    page.on("Log.entryAdded", ({ entry }) => {
      if (entry.level !== "error" && entry.level !== "warning") return;
      // Failed resource loads arrive here as well as from the network domain.
      if (entry.source === "network") return;
      this.push(this.console, { level: entry.level, text: entry.text.slice(0, 500), ...(entry.url ? { source: entry.url } : {}) });
    });
    page.on("Runtime.exceptionThrown", ({ exceptionDetails: d }) => {
      const message = d.exception?.description?.split("\n")[0] ?? d.text;
      this.push(this.exceptions, { message: message.slice(0, 500), ...(d.exception?.description ? { stack: d.exception.description.slice(0, 2000) } : {}) });
    });

    page.on("Network.requestWillBeSent", ({ requestId, request }) => {
      this.inflight.set(requestId, { method: request.method, url: request.url, started: performance.now() });
      this.lastActivity = performance.now();
    });
    page.on("Network.responseReceived", ({ requestId, response }) => {
      const r = this.inflight.get(requestId);
      if (r) r.status = response.status;
    });
    page.on("Network.loadingFinished", ({ requestId }) => {
      const r = this.inflight.get(requestId);
      if (!r) return;
      this.inflight.delete(requestId);
      const status = r.status ?? 0;
      this.push(this.network, { method: r.method, url: r.url, status, ms: Math.round(performance.now() - r.started), ok: status > 0 && status < 400 });
    });
    page.on("Network.loadingFailed", ({ requestId, errorText, canceled }) => {
      const r = this.inflight.get(requestId);
      if (!r) return;
      this.inflight.delete(requestId);
      if (canceled) return;
      this.push(this.network, { method: r.method, url: r.url, ...(r.status ? { status: r.status } : {}), ms: Math.round(performance.now() - r.started), error: errorText, ok: false });
    });

    page.on("Page.frameStartedLoading", ({ frameId }) => {
      if (frameId === page.targetId) this.navigations++;
      this.lastActivity = performance.now();
    });

    page.on("Page.javascriptDialogOpening", ({ type, message }) => {
      const armed = this.armed;
      this.armed = null;
      const answer: Answer = armed?.answer ?? "dismiss";
      page.send("Page.handleJavaScriptDialog", {
        accept: answer === "accept",
        ...(armed?.text !== undefined ? { promptText: armed.text } : {}),
      }).catch(() => {});
      this.push(this.dialogs, { type: type as "alert" | "confirm" | "prompt" | "beforeunload", message: message.slice(0, 500), answered: answer });
    });
  }
}
