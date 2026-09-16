// The argus command line end to end: the real bin/argus, a daemon it starts by
// itself on a private socket, and a local page server.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "../..");
const dir = mkdtempSync(join(tmpdir(), "argus-cli-test-"));
const env = { ...process.env, ARGUS_SOCKET: join(dir, "run", "argus.sock"), XDG_STATE_HOME: join(dir, "state"), NO_COLOR: "1", ARGUS_LANE: "" };
let pages: ReturnType<typeof Bun.serve>;
let base = "";

// Asynchronous on purpose: the page server lives in this process and must keep
// answering while argus runs (a synchronous spawn starved it).
async function argus(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn([join(REPO, "bin", "argus"), ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}

beforeAll(() => {
  pages = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/checkout") return new Response(Bun.file(join(REPO, "test/fixture.html")), { headers: { "content-type": "text/html" } });
      if (pathname === "/api/receipt") return new Response("down", { status: 500 });
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${pages.port}`;
});

afterAll(async () => {
  const pidFile = `${env.ARGUS_SOCKET}.pid`;
  if (existsSync(pidFile)) {
    try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGTERM"); } catch { /* gone */ }
    for (let i = 0; i < 60 && existsSync(pidFile); i++) await Bun.sleep(100);
  }
  pages?.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

describe("argus", () => {
  test("help and unknown commands", async () => {
    expect((await argus("--help")).out).toContain("usage: argus");
    const bad = await argus("frobnicate");
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('unknown command "frobnicate"');
  });

  test("acting before opening a lane says how to start", async () => {
    const r = await argus("click", "button:x");
    expect(r.code).toBe(1);
    expect(r.err).toContain('no lane "main"');
  }, 30_000);

  test("open starts the daemon and prints an outline that flags the covered button", async () => {
    const r = await argus("open", `${base}/checkout`);
    expect(r.code).toBe(0);
    expect(r.out).toContain("lane main opened");
    expect(r.out).toMatch(/button:Place order e0\.\d+ \[covered by e0\.\d+ div#scrim\]/);
    expect((await argus("daemon", "status")).out).toContain("argusd running");
  }, 30_000);

  test("a covered click exits 3 and names the blocker", async () => {
    const r = await argus("click", "button:Place order");
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/^✗ click button:Place order e0\.\d+ · covered/);
    expect(r.out).toContain("blocker: generic:div#scrim");
  }, 30_000);

  test("--json prints the protocol result", async () => {
    const r = await argus("--json", "click", "button:Place order");
    const result = JSON.parse(r.out);
    expect(result.ok).toBe(false);
    expect(result.steps[0].diagnosis.reason).toBe("covered");
  }, 30_000);

  test("a script runs verified and reports what changed", async () => {
    const r = await argus("act", JSON.stringify([
      { click: "button:Accept" },
      { type: ["textbox:Email address", "agent@example.com"] },
      { click: "button:Place order", expect: { appears: "Order placed" } },
    ]));
    expect(r.code).toBe(0);
    expect(r.out).toContain('+ "Order placed. Confirmation sent."');
    expect(r.out).toMatch(/~ GET http:\/\/127\.0\.0\.1:\d+\/api\/receipt 500/);
  }, 30_000);

  test("--expect turns a single step into an assertion", async () => {
    const r = await argus("--expect", '{"appears":"Never going to appear","within":"300ms"}', "click", "button:Save");
    expect(r.code).toBe(3);
    expect(r.out).toContain("expectation-failed");
  }, 30_000);

  test("lanes are named, and each is its own browser", async () => {
    expect((await argus("--lane", "second", "open", `${base}/checkout`)).code).toBe(0);
    const lanes = (await argus("lanes")).out;
    expect(lanes).toMatch(/^main\s/m);
    expect(lanes).toMatch(/^second\s/m);
    // The consent banner was dismissed in "main" only.
    expect((await argus("--lane", "second", "click", "button:Place order")).code).toBe(3);
    expect((await argus("--lane", "second", "close")).out).toContain("lane second closed");
  }, 30_000);

  test("check, look and trace", async () => {
    expect((await argus("check", "a11y")).out).toMatch(/^score \d+\/100/);
    const look = (await argus("look", "button:Place order")).out;
    const [path] = look.split(/\s+/);
    expect(existsSync(path!)).toBe(true);
    expect(look).toMatch(/\d+x\d+  \d+ image tokens/);
    expect((await argus("trace", "-n", "3")).out).toMatch(/✓ check/);
  }, 30_000);

  test("desks, nests and the bar are handed to argus-legacy", async () => {
    const r = await argus("desk", "status");
    expect(r.out).toMatch(/desk (is down|up)/);
  }, 30_000);

  test("daemon stop stops exactly the daemon on this socket", async () => {
    const r = await argus("daemon", "stop");
    expect(r.code).toBe(0);
    expect(r.out).toContain("argusd stopped");
    expect(existsSync(`${env.ARGUS_SOCKET}.pid`)).toBe(false);
  }, 30_000);
});
