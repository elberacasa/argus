// Desk lanes: real, headful windows on the desk monitor, never on the person's
// screen and never taking their focus. Runs only with ARGUS_TEST_DESK=1,
// because it creates a virtual monitor in the running Hyprland session.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service } from "../src/rpc/service";
import type { ActResult } from "../src/protocol/types";

const enabled = process.env.ARGUS_TEST_DESK === "1";
const REPO = join(import.meta.dir, "../..");
const dir = mkdtempSync(join(tmpdir(), "argusd-desk-test-"));
let service: Service;
let pages: ReturnType<typeof Bun.serve>;
let base = "";

const hypr = (...args: string[]) => JSON.parse(Bun.spawnSync(["hyprctl", "-j", ...args]).stdout.toString());
// Only windows that appeared during this test run: another daemon (the person's)
// may have desk windows of its own, and they are not this test's to count.
const foreign = new Set<string>();
const deskWindows = () => (hypr("clients") as Array<{ class: string; pid: number; workspace: { id: number }; size: [number, number]; address: string }>)
  .filter((c) => c.class === "argus-desk" && !foreign.has(c.address));

describe.skipIf(!enabled)("desk lanes", () => {
  let spy: ReturnType<typeof Bun.spawn> | null = null;
  const events: string[] = [];

  beforeAll(async () => {
    for (const w of deskWindows()) foreign.add(w.address);
    pages = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(Bun.file(join(REPO, "test/fixture.html")), { headers: { "content-type": "text/html" } }) });
    base = `http://127.0.0.1:${pages.port}`;
    service = new Service({ traceDir: join(dir, "trace") });
    // Listen, never dispatch: the only honest way to prove focus was not taken.
    const sock = `${process.env.XDG_RUNTIME_DIR}/hypr/${process.env.HYPRLAND_INSTANCE_SIGNATURE}/.socket2.sock`;
    spy = Bun.spawn(["socat", "-u", `UNIX-CONNECT:${sock}`, "-"], { stdout: "pipe" });
    (async () => { for await (const chunk of spy!.stdout as ReadableStream<Uint8Array>) events.push(...new TextDecoder().decode(chunk).split("\n")); })();
  }, 30_000);

  afterAll(async () => {
    spy?.kill();
    await service?.shutdown();
    pages?.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("hello advertises desk lanes in a Hyprland session", async () => {
    const hello = await service.call("hello", { protocol: "0" }) as { capabilities: { lanes: string[] } };
    expect(hello.capabilities.lanes).toContain("desk");
  });

  test("a desk lane is a real window on the desk, one per lane, and acts truthfully", async () => {
    const a = await service.call("lane.open", { kind: "desk", url: `${base}/`, label: "a" }) as { lane: string };
    const b = await service.call("lane.open", { kind: "desk", url: `${base}/`, label: "b" }) as { lane: string };
    await Bun.sleep(400);
    const windows = deskWindows();
    const pids = new Set(windows.map((w) => w.pid));
    expect(pids.size).toBe(1); // one browser...
    expect(windows.length).toBe(2); // ...a window per lane, and no leftover startup window
    for (const w of windows) {
      expect(w.workspace.id).toBe(91);
      expect(w.size).toEqual([1280, 800]);
    }
    const covered = await service.call("act", { lane: a.lane, steps: [{ click: "button:Place order" }] }) as ActResult;
    expect(covered.steps[0]!.diagnosis?.reason).toBe("covered");
    const placed = await service.call("act", { lane: b.lane, steps: [{ click: "button:Accept" }, { click: "button:Place order", expect: { appears: "Order placed" } }] }) as ActResult;
    expect(placed.ok).toBe(true);
    // Lanes are isolated: accepting cookies in b did not dismiss them in a.
    const stillCovered = await service.call("act", { lane: a.lane, steps: [{ click: "button:Place order" }] }) as ActResult;
    expect(stillCovered.steps[0]!.diagnosis?.reason).toBe("covered");
    await service.call("lane.close", { lane: a.lane });
    await Bun.sleep(300);
    expect(deskWindows().length).toBe(1);
    await service.call("lane.close", { lane: b.lane });
  }, 60_000);

  test("desk lanes opened at the same moment all survive", async () => {
    const opened = await Promise.all(["x", "y", "z"].map((label) => service.call("lane.open", { kind: "desk", url: `${base}/`, label }) as Promise<{ lane: string }>));
    await Bun.sleep(400);
    expect(deskWindows().length).toBe(3);
    const { lanes } = await service.call("lane.list", {}) as { lanes: Array<{ lane: string }> };
    for (const o of opened) expect(lanes.some((l) => l.lane === o.lane)).toBe(true);
    for (const o of opened) await service.call("lane.close", { lane: o.lane });
  }, 60_000);

  test("desk down closes the daemon's desk lanes before the monitor goes, so no window falls onto the person's screen", async () => {
    const { serve } = await import("../src/rpc/server");
    const socketPath = join(dir, "run", "argus.sock");
    const server = await serve(service, { socketPath });
    try {
      const lane = await service.call("lane.open", { kind: "desk", url: `${base}/`, label: "down" }) as { lane: string };
      await Bun.sleep(300);
      expect(deskWindows().length).toBe(1);
      const down = Bun.spawn([join(REPO, "bin", "argus"), "desk", "down"], { env: { ...process.env, ARGUS_SOCKET: socketPath }, stdout: "pipe", stderr: "pipe" });
      await down.exited;
      await Bun.sleep(300);
      expect(deskWindows()).toEqual([]);
      const { lanes } = await service.call("lane.list", {}) as { lanes: Array<{ lane: string }> };
      expect(lanes.some((l) => l.lane === lane.lane)).toBe(false);
    } finally {
      await server.stop();
    }
  }, 60_000);

  test("focus never arrived at the desk", async () => {
    await Bun.sleep(300);
    const stolen = events.filter((e) => /^(workspace|workspacev2)>>91/.test(e) || /^focusedmon(v2)?>>HEADLESS-/.test(e));
    expect(events.length).toBeGreaterThan(0);
    expect(stolen).toEqual([]);
  });
});
