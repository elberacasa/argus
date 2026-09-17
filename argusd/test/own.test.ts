// Own lanes: tabs in a Chromium with the Argus extension, driven through the
// bridge. Runs only with ARGUS_TEST_OWN=1, against a throwaway browser with its
// own bridge socket -- never the person's real browser, which must be exactly
// as connected afterwards as before.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActResult } from "../src/protocol/types";

const enabled = process.env.ARGUS_TEST_OWN === "1";
const REPO = join(import.meta.dir, "../..");
const dir = mkdtempSync(join(tmpdir(), "argusd-own-test-"));
const throwawaySock = `${process.env.XDG_RUNTIME_DIR}/argus/throwaway/bridge.sock`;
const realSock = `${process.env.XDG_RUNTIME_DIR}/argus/bridge.sock`;

async function realConnected(): Promise<boolean> {
  if (!existsSync(realSock)) return false;
  const { Bridge } = await import("../src/lane/own");
  try { const b = await Bridge.connect(realSock); b.close(); return true; } catch { return false; }
}

describe.skipIf(!enabled)("own lanes", () => {
  let service: import("../src/rpc/service").Service;
  let pages: ReturnType<typeof Bun.serve>;
  let base = "";
  let realBefore = false;

  beforeAll(async () => {
    realBefore = await realConnected();
    const up = Bun.spawnSync([join(REPO, "test", "throwaway-browser.sh"), "start"], { stdout: "pipe", stderr: "pipe" });
    if (up.exitCode !== 0) throw new Error(`throwaway browser: ${up.stderr.toString()}`);
    process.env.ARGUS_BRIDGE_SOCK = throwawaySock;
    pages = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(req) {
        const { pathname } = new URL(req.url);
        if (pathname === "/api/receipt") return new Response("down", { status: 500 });
        return new Response(Bun.file(join(REPO, "test/fixture.html")), { headers: { "content-type": "text/html" } });
      },
    });
    base = `http://127.0.0.1:${pages.port}`;
    const { Service } = await import("../src/rpc/service");
    service = new Service({ traceDir: join(dir, "trace") });
  }, 60_000);

  afterAll(async () => {
    await service?.shutdown();
    delete process.env.ARGUS_BRIDGE_SOCK;
    Bun.spawnSync([join(REPO, "test", "throwaway-browser.sh"), "stop"]);
    pages?.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("hello advertises own lanes while a browser is bridged", async () => {
    const hello = await service.call("hello", { protocol: "0" }) as { capabilities: { lanes: string[] } };
    expect(hello.capabilities.lanes).toContain("own");
  });

  test("an own lane is a verified, truthful lane: diagnoses, deltas, failed requests", async () => {
    const { lane } = await service.call("lane.open", { kind: "own", url: `${base}/checkout` }) as { lane: string };
    const covered = await service.call("act", { lane, steps: [{ click: "button:Place order" }] }) as ActResult;
    expect(covered.steps[0]!.diagnosis?.reason).toBe("covered");
    expect(covered.steps[0]!.diagnosis?.blocker?.selector).toBe("div#scrim");
    const r = await service.call("act", { lane, steps: [
      { click: "button:Accept" },
      { type: ["textbox:Email address", "agent@example.com"], expect: { field: ["textbox:Email address", "agent@example.com"] } },
      { click: "button:Place order", expect: { appears: "Order placed", request: { url: "/api/receipt", status: 500 } } },
    ] }) as ActResult;
    expect(r.ok).toBe(true);
    expect(r.steps[2]!.observation.added).toContain("Order placed. Confirmation sent.");
    expect(r.steps[2]!.observation.network?.[0]).toMatchObject({ status: 500 });
    const check = await service.call("check", { lane, only: ["runtime"] }) as { findings: Array<{ rule: string }> };
    expect(check.findings.map((f) => f.rule)).toContain("console-error");
    const look = await service.call("evidence.look", { lane, target: "button:Place order" }) as { w: number; h: number; tokens: number };
    expect(look.w).toBeGreaterThan(50);
    const { lanes } = await service.call("lane.list", {}) as { lanes: Array<{ lane: string; kind: string; title: string }> };
    expect(lanes.find((l) => l.lane === lane)).toMatchObject({ kind: "own", title: "Argus fixture" });
    await service.call("lane.close", { lane });
  }, 90_000);

  test("the person's real bridge is untouched", async () => {
    expect(await realConnected()).toBe(realBefore);
  });
});
