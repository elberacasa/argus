// A typed Chrome DevTools Protocol client over Chromium's debugging pipe.
//
// --remote-debugging-pipe speaks CDP on file descriptors 3 (commands in) and 4
// (messages out), each message a JSON object terminated by NUL. There is no TCP
// port: only the process holding the other end of the pipe can talk to the
// browser. Measured on this machine: first answer in 125ms, zero ports opened.
//
// Method names, parameters and results are typed from Chromium's own protocol
// definition (the devtools-protocol package), so a misspelled method or a wrong
// parameter is a compile error, not a runtime surprise.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping";
import type { CdpPage } from "./page";

type Commands = ProtocolMapping.Commands;
type Events = ProtocolMapping.Events;
export type Method = keyof Commands;
export type Params<M extends Method> = Commands[M]["paramsType"][0];
export type Result<M extends Method> = Commands[M]["returnType"];
export type EventName = keyof Events;
export type EventParams<E extends EventName> = Events[E][0];

export class CdpError extends Error {
  constructor(readonly method: string, readonly code: number, message: string) {
    super(`${method}: ${message} (${code})`);
  }
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type Listener = (params: unknown, sessionId: string | undefined) => void;

export interface LaunchOptions {
  executable?: string;
  headless?: boolean;
  args?: string[];
  /** Per-command timeout. No call may hang forever (constitution: no silent stalls). */
  timeoutMs?: number;
}

/** Browser processes (group leaders) running on exactly this profile directory. */
function browsersOnProfile(dir: string): number[] {
  const pids: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const args = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
      if (!args.includes(`--user-data-dir=${dir}`) || args.some((a) => a.startsWith("--type="))) continue;
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) === Number(entry)) pids.push(Number(entry)); // pgrp == pid
    } catch { /* exited */ }
  }
  return pids;
}

/** The browser binary itself, not a launcher that adds the person's flags (Arch's /usr/bin/chromium reads chromium-flags.conf). */
function defaultExecutable(): string {
  for (const candidate of ["/usr/lib/chromium/chromium"]) if (existsSync(candidate)) return candidate;
  return "chromium";
}

/** Written into every profile argusd creates: the pid of the daemon that owns it. */
const OWNER_FILE = "argusd.owner";

export class Browser {
  /**
   * Remove profiles whose owning daemon is gone. A daemon that exits normally
   * removes its own; one that is killed cannot, and its browser has already
   * exited with the pipe. Only directories carrying an owner file are touched.
   */
  static sweepAbandonedProfiles(): void {
    for (const name of readdirSync(tmpdir())) {
      if (!name.startsWith("argusd-profile-")) continue;
      const dir = join(tmpdir(), name);
      const ownerFile = join(dir, OWNER_FILE);
      if (!existsSync(ownerFile)) continue;
      const owner = Number(readFileSync(ownerFile, "utf8"));
      if (!Number.isInteger(owner) || owner <= 0) continue;
      let alive = true;
      try { process.kill(owner, 0); } catch { alive = false; }
      if (alive) continue;
      // A headless browser exits with its pipe; a headful one keeps running and
      // keeps its window. Stop exactly the browser on this profile: a process
      // whose command line names this profile and that leads its own group.
      for (const pid of browsersOnProfile(dir)) {
        try { process.kill(-pid, "SIGTERM"); } catch { /* gone */ }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private nextId = 0;
  private buffer = "";
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private closed = false;

  private constructor(
    private readonly proc: ChildProcess,
    private readonly toBrowser: Writable,
    fromBrowser: Readable,
    private readonly profileDir: string,
    private readonly timeoutMs: number,
  ) {
    // A browser that exits (a headful one does when its last window closes)
    // breaks the pipe; the write error is the first sign, and must not escape.
    toBrowser.on("error", (error) => this.fail(error instanceof Error ? error : new Error(String(error))));
    fromBrowser.setEncoding("utf8");
    fromBrowser.on("data", (chunk: string) => this.receive(chunk));
    proc.on("exit", () => this.fail(new Error("browser exited")));
  }

  /** Launch a browser argus owns: a fresh profile, its own process group. */
  static async launch(options: LaunchOptions = {}): Promise<Browser> {
    Browser.sweepAbandonedProfiles();
    const profileDir = mkdtempSync(join(tmpdir(), "argusd-profile-"));
    writeFileSync(join(profileDir, OWNER_FILE), `${process.pid}\n`);
    const args = [
      "--remote-debugging-pipe",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      ...(options.headless === false ? [] : ["--headless=new"]),
      ...(options.args ?? []),
      "about:blank",
    ];
    const proc = spawn(options.executable ?? defaultExecutable(), args, {
      // fd 3: we write, the browser reads. fd 4: the browser writes, we read.
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
      // Its own process group, so argusd can stop exactly this browser and
      // nothing else -- never by name (constitution: never touch what argus did
      // not create).
      detached: true,
    });
    const toBrowser = proc.stdio[3] as Writable | null;
    const fromBrowser = proc.stdio[4] as Readable | null;
    if (!toBrowser || !fromBrowser) throw new Error("could not open the debugging pipe");
    const browser = new Browser(proc, toBrowser, fromBrowser, profileDir, options.timeoutMs ?? 30_000);
    await browser.send("Browser.getVersion");
    return browser;
  }

  send<M extends Method>(method: M, params?: Params<M>, sessionId?: string): Promise<Result<M>> {
    if (this.closed) return Promise.reject(new Error(`${method}: browser is closed`));
    const id = ++this.nextId;
    const message = JSON.stringify({ id, method, params: params ?? {}, ...(sessionId ? { sessionId } : {}) });
    return new Promise<Result<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(method, -1, `no answer within ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      this.toBrowser.write(message + "\0");
    });
  }

  on<E extends EventName>(event: E, listener: (params: EventParams<E>, sessionId: string | undefined) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener as Listener);
    return () => set.delete(listener as Listener);
  }

  /** Resolve with the first matching event, or reject after a timeout. */
  waitFor<E extends EventName>(
    event: E,
    predicate: (params: EventParams<E>, sessionId: string | undefined) => boolean = () => true,
    timeoutMs = this.timeoutMs,
  ): Promise<EventParams<E>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`${event}: not seen within ${timeoutMs}ms`)); }, timeoutMs);
      const off = this.on(event, (params, sessionId) => {
        if (!predicate(params, sessionId)) return;
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }

  /** Alive means the process is still running and its pipe still writable, not just "not closed by us". */
  get alive(): boolean {
    return !this.closed && this.proc.exitCode === null && this.proc.signalCode === null && !this.toBrowser.destroyed;
  }

  /** Called once when the browser goes away for any reason. */
  onExit(listener: () => void): void { this.proc.once("exit", listener); }

  async close(): Promise<void> {
    if (this.closed) return;
    const exited = new Promise<void>((resolve) => {
      if (this.proc.exitCode !== null || this.proc.signalCode !== null) resolve();
      else this.proc.once("exit", () => resolve());
    });
    try { await this.send("Browser.close"); } catch { /* already going */ }
    this.fail(new Error("browser closed"));
    // Give it a moment to exit on its own, then stop the whole process group:
    // renderers and helpers go with the browser.
    const gone = await Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 3000))]);
    if (!gone && this.proc.pid) {
      try { process.kill(-this.proc.pid, "SIGTERM"); } catch { /* gone */ }
      await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
    }
    // Only after it exited: Chromium writes into its profile until the end, so
    // deleting earlier left the directory behind, recreated (measured).
    rmSync(this.profileDir, { recursive: true, force: true });
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let end: number;
    while ((end = this.buffer.indexOf("\0")) !== -1) {
      const raw = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (!raw) continue;
      let message: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string }; sessionId?: string };
      try { message = JSON.parse(raw); } catch { continue; }
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new CdpError(pending.method, message.error.code, message.error.message));
        else pending.resolve(message.result ?? {});
      } else if (message.method) {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params, message.sessionId);
      }
    }
  }

  private fail(error: Error): void {
    this.closed = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

/** A page target, reached through a flattened session on the same pipe. */
export class Page implements CdpPage {
  private constructor(
    readonly browser: Browser,
    readonly targetId: string,
    readonly sessionId: string,
    readonly contextId: string | undefined,
  ) {}

  /**
   * Open a page. With `isolated`, the page gets its own browser context: no
   * cookies, storage or cache shared with any other lane in the same browser.
   */
  static async open(browser: Browser, options: { isolated?: boolean; newWindow?: boolean } = {}): Promise<Page> {
    const contextId = options.isolated
      ? (await browser.send("Target.createBrowserContext", { disposeOnDetach: true })).browserContextId
      : undefined;
    const { targetId } = await browser.send("Target.createTarget", {
      url: "about:blank",
      ...(contextId ? { browserContextId: contextId } : {}),
      ...(options.newWindow ? { newWindow: true } : {}),
    });
    const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(browser, targetId, sessionId, contextId);
    await Promise.all([page.send("Page.enable"), page.send("Runtime.enable")]);
    return page;
  }

  send<M extends Method>(method: M, params?: Params<M>): Promise<Result<M>> {
    return this.browser.send(method, params, this.sessionId);
  }

  get alive(): boolean { return this.browser.alive; }

  async info(): Promise<{ url: string; title: string }> {
    const { targetInfo } = await this.browser.send("Target.getTargetInfo", { targetId: this.targetId });
    return { url: targetInfo.url, title: targetInfo.title };
  }

  /** Events from this page's session only. */
  on<E extends EventName>(event: E, listener: (params: EventParams<E>) => void): () => void {
    return this.browser.on(event, (params, sessionId) => {
      if (sessionId === this.sessionId) listener(params);
    });
  }

  async navigate(url: string, timeoutMs = 30_000): Promise<{ errorText?: string }> {
    // The document is ready to act on at DOMContentLoaded; "load" waits for every
    // image and subresource (measured: 11.7 s on a Wikipedia article). Settling
    // afterwards covers what the page does next.
    const loaded = this.browser.waitFor("Page.domContentEventFired", (_, sessionId) => sessionId === this.sessionId, timeoutMs);
    // Handled from the start: if the navigate command itself stalls, the load
    // wait times out first, and an unobserved rejection would end the daemon.
    const settled = loaded.then(() => null, (error: unknown) => error as Error);
    let errorText: string | undefined;
    try {
      ({ errorText } = await this.send("Page.navigate", { url }));
    } catch (error) {
      return { errorText: error instanceof Error ? error.message : String(error) };
    }
    if (errorText) return { errorText };
    const failure = await settled;
    if (failure) return { errorText: `the page did not finish loading within ${timeoutMs}ms` };
    return {};
  }

  async close(): Promise<void> {
    try { await this.browser.send("Target.closeTarget", { targetId: this.targetId }); } catch { /* gone */ }
    if (this.contextId) {
      try { await this.browser.send("Target.disposeBrowserContext", { browserContextId: this.contextId }); } catch { /* gone */ }
    }
  }
}
