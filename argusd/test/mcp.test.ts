// The MCP server end to end: a real MCP client conversation over stdio,
// against a daemon the server starts by itself.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

const REPO = join(import.meta.dir, "../..");
const dir = mkdtempSync(join(tmpdir(), "argus-mcp-test-"));
const socket = join(dir, "run", "argus.sock");
let mcp: Subprocess<"pipe", "pipe", "pipe">;
let pages: ReturnType<typeof Bun.serve>;
let nextId = 0;
let buffer = "";
const waiting = new Map<number, (v: any) => void>();

async function pump() {
  const decoder = new TextDecoder();
  for await (const chunk of mcp.stdout) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const msg = JSON.parse(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
  }
}

function rpc(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = ++nextId;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
const tool = async (name: string, args: Record<string, unknown> = {}) => (await rpc("tools/call", { name, arguments: args })).result;
const textOf = (r: any) => r.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");

beforeAll(async () => {
  pages = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/checkout") return new Response(Bun.file(join(REPO, "test/fixture.html")), { headers: { "content-type": "text/html" } });
      if (pathname === "/api/receipt") return new Response("down", { status: 500 });
      return new Response("not found", { status: 404 });
    },
  });
  mcp = Bun.spawn(["bun", join(import.meta.dir, "../src/main.ts"), "mcp"], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, ARGUS_SOCKET: socket, XDG_STATE_HOME: join(dir, "state") },
  });
  void pump();
}, 30_000);

afterAll(async () => {
  mcp?.stdin.end();
  mcp?.kill();
  // Stop exactly the daemon the server started, by the pid it recorded.
  const pidFile = `${socket}.pid`;
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8"));
    try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
    for (let i = 0; i < 50 && existsSync(pidFile); i++) await Bun.sleep(100);
  }
  pages?.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

describe("argusd mcp", () => {
  test("initializes and lists the tools agents use", async () => {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect(init.result.serverInfo.name).toBe("argus");
    const { result } = await rpc("tools/list");
    const names = result.tools.map((t: any) => t.name);
    for (const n of ["browser_open", "browser_act", "browser_click", "browser_check", "browser_look", "browser_sweep", "omarchy_groups", "omarchy_run"]) expect(names).toContain(n);
  });

  test("browser_open starts the daemon by itself and returns an outline that flags the covered button", async () => {
    const r = await tool("browser_open", { url: `http://127.0.0.1:${pages.port}/checkout` });
    expect(r.isError).toBeUndefined();
    const t = textOf(r);
    expect(t).toContain("lane main opened");
    expect(t).toMatch(/button:Place order e0\.\d+ \[covered by e0\.\d+ div#scrim\]/);
    expect(existsSync(`${socket}.pid`)).toBe(true);
  }, 30_000);

  test("a covered click comes back as a reason, not as a success", async () => {
    const t = textOf(await tool("browser_click", { target: "button:Place order" }));
    expect(t).toMatch(/^✗ click button:Place order e0\.\d+ · covered/);
    expect(t).toContain("blocker: generic:div#scrim");
  }, 30_000);

  test("browser_act runs a verified script and reports what changed", async () => {
    const t = textOf(await tool("browser_act", { steps: [
      { click: "button:Accept" },
      { type: ["textbox:Email address", "agent@example.com"] },
      { click: "button:Place order", expect: { appears: "Order placed" } },
    ] }));
    expect(t).toContain('+ "Order placed. Confirmation sent."');
    expect(t).toContain('= textbox:Email address: "agent@example.com"');
    expect(t).toMatch(/~ GET http:\/\/127\.0\.0\.1:\d+\/api\/receipt 500/);
    expect(t).not.toContain("✗");
  }, 30_000);

  test("browser_look returns the pixels, not a path", async () => {
    const r = await tool("browser_look", { target: "button:Place order" });
    const image = r.content.find((c: any) => c.type === "image");
    expect(image.mimeType).toBe("image/png");
    expect(Buffer.from(image.data, "base64").subarray(1, 4).toString()).toBe("PNG");
    expect(textOf(r)).toMatch(/\d+x\d+, \d+ image tokens/);
  }, 30_000);

  test("browser_check reviews the page", async () => {
    const t = textOf(await tool("browser_check", { only: ["a11y"] }));
    expect(t).toMatch(/^score \d+\/100/);
    expect(t).toContain("contrast");
  }, 30_000);

  test("tools on a lane that does not exist say how to start", async () => {
    const r = await tool("browser_click", { target: "button:x", lane: "nope" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("Call browser_open first");
  }, 30_000);

  test("destructive Omarchy commands are refused without confirmation", async () => {
    if (!existsSync("/usr/share/omarchy/bin")) return;
    const groups = textOf(await tool("omarchy_groups"));
    expect(groups).toMatch(/\w+ \(\d+\)/);
    const r = await tool("omarchy_run", { command: "omarchy-system-reset" });
    if (textOf(r).startsWith("Unknown")) return; // not in this machine's catalogue
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("destructive");
  }, 30_000);
});
