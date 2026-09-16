// argusd end to end: a real daemon on a private socket, a real headless
// Chromium over a pipe, and a local page server. Every result is also checked
// against the protocol schema by the server (validateResults), so a response
// that breaks the standard fails here even if the assertion would pass.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, ArgusError } from "../src/rpc/client";
import { serve } from "../src/rpc/server";
import { Service } from "../src/rpc/service";
import type { ActResult, StepResult } from "../src/protocol/types";

const REPO = join(import.meta.dir, "../..");
const dir = mkdtempSync(join(tmpdir(), "argusd-test-"));
const socketPath = join(dir, "argus", "argus.sock");

let service: Service;
let server: Awaited<ReturnType<typeof serve>>;
let client: Client;
let pages: ReturnType<typeof Bun.serve>;
let base = "";

beforeAll(async () => {
  pages = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/checkout") return new Response(Bun.file(join(REPO, "test/fixture.html")), { headers: { "content-type": "text/html" } });
      if (pathname === "/reach") return new Response(Bun.file(join(import.meta.dir, "pages/reach.html")), { headers: { "content-type": "text/html" } });
      if (pathname === "/api/receipt") return new Response("down", { status: 500 });
      if (pathname === "/set-cookie") return new Response("<title>set</title>set", { headers: { "content-type": "text/html", "set-cookie": "who=lane-a; Path=/" } });
      if (pathname === "/echo-cookie") return new Response(`<title>echo</title><p>cookie:${req.headers.get("cookie") ?? "none"}</p>`, { headers: { "content-type": "text/html" } });
      if (pathname === "/quiet") return new Response("<title>Quiet</title><h1>Quiet page</h1><button>Nothing</button>", { headers: { "content-type": "text/html" } });
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${pages.port}`;
  service = new Service();
  server = await serve(service, { socketPath, validateResults: true });
  client = await Client.connect(socketPath);
}, 30_000);

afterAll(async () => {
  client?.close();
  await server?.stop();
  await service?.shutdown();
  pages?.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const openLane = async (url: string) => (await client.call<{ lane: string }>("lane.open", { kind: "throwaway", url })).lane;
const act = (lane: string, steps: unknown[]) => client.call<ActResult>("act", { lane, steps });
const expectError = async (p: Promise<unknown>, code: number) => {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(ArgusError); expect((e as ArgusError).code).toBe(code); return e as ArgusError; }
  throw new Error(`expected error ${code}`);
};

describe("the socket", () => {
  test("is private to this user", () => {
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "argus")).mode & 0o777).toBe(0o700);
  });

  test("refuses everything before hello", async () => {
    const reply = await new Promise<string>((resolve) => {
      let got = "";
      Bun.connect({
        unix: socketPath,
        socket: {
          open(s) { s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "lane.list", params: {} }) + "\n"); },
          data(s, chunk) { got += chunk.toString(); if (got.includes("\n")) { s.end(); resolve(got); } },
        },
      });
    });
    expect(JSON.parse(reply).error.code).toBe(-32002);
  });

  test("rejects unknown methods and invalid params before any code runs", async () => {
    await expectError(client.call("page.evaluate", { js: "1" }), -32601);
    await expectError(client.call("act", { lane: "l1", steps: [{ click: "button:A", press: "Enter" }] }), -32602);
  });

  test("a second daemon cannot take a live socket", async () => {
    await expect(serve(new Service(), { socketPath })).rejects.toThrow(/already running/);
  });
});

describe("lanes", () => {
  test("open, list, close; unknown lanes are an error, not a crash", async () => {
    const lane = await openLane(`${base}/quiet`);
    const { lanes } = await client.call<{ lanes: Array<{ lane: string; title: string }> }>("lane.list");
    expect(lanes.find((l) => l.lane === lane)?.title).toBe("Quiet");
    await client.call("lane.close", { lane });
    await expectError(client.call("act", { lane, steps: [{ press: "Tab" }] }), -32001);
  }, 30_000);

  test("lanes do not share cookies", async () => {
    const a = await openLane(`${base}/set-cookie`);
    await act(a, [{ open: `${base}/echo-cookie`, expect: { appears: "cookie:who=lane-a" } }]);
    const b = await openLane(`${base}/echo-cookie`);
    const r = await act(b, [{ wait: { appears: "cookie:none", within: "1s" } }]);
    expect(r.ok).toBe(true);
    await client.call("lane.close", { lane: a });
    await client.call("lane.close", { lane: b });
  }, 30_000);

  test("parallel work goes to separate lanes; one lane runs one script at a time", async () => {
    const lane = await openLane(`${base}/quiet`);
    const slow = act(lane, [{ wait: { appears: "never going to appear", within: "800ms" } }]);
    await expectError(act(lane, [{ press: "Tab" }]), -32006);
    await slow;
    await client.call("lane.close", { lane });
  }, 30_000);
});

describe("act on the checkout fixture", () => {
  let lane = "";
  beforeAll(async () => { lane = await openLane(`${base}/checkout`); }, 30_000);
  afterAll(async () => { await client.call("lane.close", { lane }); });

  test("the outline fits the budget and already says what is blocked", async () => {
    const { outline, tokens } = await client.call<{ outline: string; tokens: number }>("scene.outline", { lane });
    expect(tokens).toBeLessThanOrEqual(250);
    expect(outline).toContain("button:Place order");
    expect(outline).toMatch(/Place order e0\.\d+ \[covered by e0\.\d+ div#scrim\]/);
  }, 30_000);

  test("a covered click is not a success: it names the blocker and changes nothing", async () => {
    const r = await act(lane, [{ click: "button:Place order" }]);
    const s = r.steps[0]!;
    expect(r.ok).toBe(false);
    expect(s.diagnosis?.reason).toBe("covered");
    expect(s.diagnosis?.blocker?.selector).toBe("div#scrim");
    expect(s.observation.added).toBeUndefined();
  }, 30_000);

  test("a disabled control is diagnosed before anything is clicked", async () => {
    const r = await act(lane, [{ click: "button:Pay later" }]);
    expect(r.steps[0]!.diagnosis?.reason).toBe("disabled");
  }, 30_000);

  test("a typo gets did-you-mean, not just not-found", async () => {
    const r = await act(lane, [{ click: "button:Place ordr" }]);
    const d = r.steps[0]!.diagnosis!;
    expect(d.reason).toBe("not-found");
    expect(d.didYouMean?.map((e) => e.name)).toContain("Place order");
  }, 30_000);

  test("identical names are ambiguous; nth chooses", async () => {
    const r = await act(lane, [{ click: "button:Remove" }]);
    expect(r.steps[0]!.diagnosis?.reason).toBe("ambiguous");
    const candidates = r.steps[0]!.diagnosis!.candidates!;
    expect(candidates.length).toBe(2);
    const second = await client.call<{ matches: Array<{ ref: string }> }>("scene.find", { lane, target: { role: "button", name: "Remove", nth: 2 } });
    expect(second.matches.map((m) => m.ref)).toEqual([candidates[1]!.ref]);
  }, 30_000);

  test("a script recovers the way a person would, and every step is verified", async () => {
    const r = await act(lane, [
      { click: "button:Accept", expect: { disappears: "This site uses cookies." } },
      { type: ["textbox:Email address", "agent@omarchy.org"], expect: { field: ["textbox:Email address", "agent@omarchy.org"] } },
      { click: "button:Place order", expect: { appears: "Order placed", request: { url: "/api/receipt", status: 500 } } },
    ]);
    expect(r.steps.map((s) => [s.verb, s.ok])).toEqual([["click", true], ["type", true], ["click", true]]);
    const place = r.steps[2]!;
    expect(place.observation.added).toContain("Order placed. Confirmation sent.");
    expect(place.observation.removed).toContain("Order summary");
    expect(place.observation.network?.[0]).toMatchObject({ status: 500 });
    expect(r.steps[1]!.observation.fields?.[0]).toMatchObject({ to: "agent@omarchy.org" });
    expect(r.tokensEst).toBeLessThan(600);
  }, 30_000);

  test("exact names win over substrings, and a click with no effect says so", async () => {
    const r = await act(lane, [{ click: "button:Save" }]);
    const s = r.steps[0]!;
    expect(s.ok).toBe(true);
    expect(s.target?.name).toBe("Save");
    expect(s.match).toBe("exact");
    expect(s.observation.effect).toBe("none");
  }, 30_000);

  test("an expectation that does not hold fails the step with what was actually there", async () => {
    const r = await act(lane, [{ click: "button:Save", expect: { appears: "Saved!", within: "300ms" } }]);
    const s = r.steps[0]!;
    expect(s.ok).toBe(false);
    expect(s.diagnosis?.reason).toBe("expectation-failed");
    expect(s.diagnosis?.failed?.[0]?.condition).toBe('appears "Saved!"');
  }, 30_000);
});

describe("reach", () => {
  let lane = "";
  beforeAll(async () => { lane = await openLane(`${base}/reach`); }, 30_000);
  afterAll(async () => { await client.call("lane.close", { lane }); });

  test("clicks inside an open shadow root", async () => {
    const r = await act(lane, [{ click: "button:Shadow button", expect: { appears: "Clicked in shadow." } }]);
    expect(r.ok).toBe(true);
    expect(r.steps[0]!.target?.shadow).toBe("open");
  }, 30_000);

  test("clicks inside a frame", async () => {
    const r = await act(lane, [{ click: "button:Frame button", expect: { appears: "Clicked in frame." } }]);
    expect(r.ok).toBe(true);
    expect(r.steps[0]!.target?.frames?.length).toBe(2);
  }, 30_000);

  test("scrolls to an element below the fold before clicking it", async () => {
    const r = await act(lane, [{ click: "button:Far below", expect: { appears: "Clicked far below." } }]);
    expect(r.ok).toBe(true);
  }, 30_000);

  test("waits are expectations: resolves when the text appears, not after a fixed sleep", async () => {
    const r = await act(lane, [
      { click: "button:Load data" },
      { wait: { appears: "Data loaded after a delay.", within: "5s" } },
    ]);
    expect(r.ok).toBe(true);
    expect(r.steps[1]!.observation.ms).toBeLessThan(2500);
  }, 30_000);

  test("a wait that never holds is a timeout with how long it waited", async () => {
    const r = await act(lane, [{ wait: { appears: "Never.", within: "400ms" } }]);
    expect(r.steps[0]!.diagnosis?.reason).toBe("timeout");
    expect(r.steps[0]!.diagnosis?.waitedMs).toBeGreaterThanOrEqual(400);
  }, 30_000);

  test("plain text is a target", async () => {
    const r = await client.call<{ matches: Array<{ role: string }> }>("scene.find", { lane, target: { text: "Reach" } });
    expect(r.matches[0]?.role).toBe("heading");
  }, 30_000);

  test("selects an option and types into a field named by aria-label", async () => {
    const r = await act(lane, [
      { select: ["combobox:Plan", "Pro"] },
      { type: ["textbox:Full name", "Ada Lovelace"], expect: { field: ["textbox:Full name", "Ada Lovelace"] } },
      { press: "Enter" },
    ]);
    expect(r.steps.slice(0, 2).every((s: StepResult) => s.ok)).toBe(true);
  }, 30_000);
});

describe("testing", () => {
  test("run: console errors fail a test by default, and the verdict says where", async () => {
    const r = await client.call<{ verdict: string; failedAt: number; steps: StepResult[] }>("run", {
      name: "checkout loads cleanly",
      steps: [{ open: `${base}/checkout` }],
    });
    expect(r.verdict).toBe("fail");
    expect(r.failedAt).toBe(0);
    const failed = r.steps[0]!.diagnosis!.failed![0]!;
    expect(failed.condition).toBe("no errors");
    expect(JSON.stringify(failed.actual)).toContain("analytics: missing tracking id");
  }, 30_000);

  test("sweep: one script, several viewports, in parallel lanes", async () => {
    const r = await client.call<{ verdict: string; results: Array<{ verdict: string }> }>("sweep", {
      name: "quiet page",
      steps: [{ open: `${base}/quiet`, expect: { appears: "Quiet page" } }],
      across: { viewports: [{ w: 375, h: 812 }, { w: 1440, h: 900 }], colorScheme: ["light", "dark"] },
    });
    expect(r.verdict).toBe("pass");
    expect(r.results.length).toBe(4);
    const { lanes } = await client.call<{ lanes: unknown[] }>("lane.list");
    expect(lanes.length).toBe(0);
  }, 60_000);
});

describe("shutdown", () => {
  test("stops the browser and leaves no profile behind", async () => {
    const profiles = () => new Set(Array.from(new Bun.Glob("argusd-profile-*").scanSync({ cwd: tmpdir(), onlyFiles: false })));
    const before = profiles();
    const lane = await openLane(`${base}/quiet`);
    expect(lane).toMatch(/^l\d+$/);
    await service.shutdown();
    // This daemon's profile existed before the lane opened (the browser was
    // already up) and must be gone now; nothing else may have been left.
    expect([...profiles()].filter((p) => before.has(p))).toEqual([]);
  }, 30_000);
});
