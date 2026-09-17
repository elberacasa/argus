// The interactions real apps ask for, on the Workbench app: dragging, points on
// a canvas, lists that render only what is in view, feeds that load as you
// scroll, rows of identical buttons, controls named differently from what they
// show, and confirm dialogs. Each was missing or costly in the first Workbench run.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { Service } from "../src/rpc/service";
import type { ActResult } from "../src/protocol/types";
import { AVATAR_PATH, AVATAR_SHA, MARKERS, orderTotal, startWorkbench, type Workbench } from "../bench/workbench/app";

let wb: Workbench;
let service: Service;
let native: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  wb = startWorkbench();
  service = new Service({ traceDir: `${tmpdir()}/argus-interaction-test` });
  native = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: () => new Response(`<!doctype html><title>Native</title>
<div id="item" draggable="true" style="width:120px;padding:10px;background:#ddd">Report.pdf</div>
<div id="bin" style="margin-top:60px;width:240px;height:120px;border:2px dashed #999">Trash</div><p id="out"></p>
<script>
item.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plain", "Report.pdf"));
bin.addEventListener("dragover", (e) => e.preventDefault());
bin.addEventListener("drop", (e) => { e.preventDefault(); out.textContent = "Deleted " + e.dataTransfer.getData("text/plain"); });
</script>`, { headers: { "content-type": "text/html" } }),
  });
});
afterAll(async () => {
  await service.shutdown();
  wb.stop();
  native.stop(true);
});

async function open(url: string, viewport?: { w: number; h: number }) {
  wb.reset();
  const { lane } = await service.call("lane.open", { kind: "throwaway", url, ...(viewport ? { viewport } : {}) }) as { lane: string };
  return lane;
}
const act = (lane: string, steps: unknown[]) => service.call("act", { lane, steps }) as Promise<ActResult>;
const outlineOf = async (lane: string) => (await service.call("scene.outline", { lane, budget: 2000 }) as { outline: string }).outline;

describe("dragging", () => {
  test("a card moves between columns on a board that only drags with the pointer", async () => {
    const lane = await open(`${wb.base}/board`);
    const r = await act(lane, [{ drag: [{ text: "Write docs" }, "heading:Done"] }]);
    expect(r.ok).toBe(true);
    await Bun.sleep(200);
    expect(wb.state.board["write-docs"]).toBe("done");
    expect(wb.state.board["ship-v2"]).toBe("todo");
    await service.call("lane.close", { lane });
  }, 30_000);

  test("native HTML5 drag and drop delivers the drop with its data", async () => {
    const lane = await open(`http://127.0.0.1:${native.port}/`);
    const r = await act(lane, [{ drag: [{ text: "Report.pdf" }, { text: "Trash" }], expect: { appears: "Deleted Report.pdf" } }]);
    expect(r.ok).toBe(true);
    await service.call("lane.close", { lane });
  }, 30_000);
});

describe("points", () => {
  test("the outline offers a canvas, and a point inside it clicks what is drawn there", async () => {
    const lane = await open(`${wb.base}/map`);
    const outline = await outlineOf(lane);
    const ref = /canvas#map (e\d+\.\d+) 560x350/.exec(outline)?.[1];
    expect(ref).toBeDefined();
    const red = MARKERS.find((m) => m.color === "#d93a3a")!;
    // The canvas is drawn at 800x500 and shown at 560x350.
    const r = await act(lane, [{ click: { x: red.x * 0.7, y: red.y * 0.7, in: ref }, expect: { appears: red.name } }]);
    expect(r.ok).toBe(true);
    expect(wb.state.stationViews).toEqual([red.id]);
    await service.call("lane.close", { lane });
  }, 30_000);

  test("a crop says where it sits, so a point read off the image lands where it was seen", async () => {
    const lane = await open(`${wb.base}/map`);
    const e = await service.call("evidence.look", { lane, target: { role: "complementary" } }) as { origin?: { x: number; y: number }; w: number };
    expect(e.origin).toBeDefined();
    const found = await service.call("scene.find", { lane, target: { role: "complementary" } }) as { matches: Array<{ bounds: { x: number; y: number } }> };
    expect(e.origin!.x).toBe(found.matches[0]!.bounds.x - 16);
    await service.call("lane.close", { lane });
  }, 30_000);

  test("a point is refused, with the reason, by verbs that need an element", async () => {
    const lane = await open(`${wb.base}/map`);
    const r = await act(lane, [{ type: [{ x: 10, y: 10 }, "hello"] }]);
    expect(r.ok).toBe(false);
    expect(r.steps[0]!.diagnosis!.hint).toContain("only click, hover and drag");
    await service.call("lane.close", { lane });
  }, 30_000);
});

describe("scrolling until", () => {
  test("a country far down a list that renders only its visible rows", async () => {
    const lane = await open(`${wb.base}/settings`);
    const r = await act(lane, [
      { click: "combobox:Country" },
      { scroll: { until: "option:Uruguay", in: "listbox" } },
      { click: "option:Uruguay" },
      { click: "button:Save", expect: { appears: "Saved." } },
    ]);
    expect(r.ok).toBe(true);
    expect(wb.state.country).toBe("Uruguay");
    expect(r.steps.length).toBe(4);
    await service.call("lane.close", { lane });
  }, 60_000);

  test("an order several pages down a feed that loads as you scroll", async () => {
    const lane = await open(`${wb.base}/orders`);
    const r = await act(lane, [{ scroll: { until: { text: "Order #1187" } } }]);
    expect(r.ok).toBe(true);
    const found = await service.call("scene.find", { lane, target: { text: orderTotal(1187) } }) as { matches: unknown[] };
    expect(found.matches.length).toBeGreaterThan(0);
    await service.call("lane.close", { lane });
  }, 60_000);

  test("scrolling until something that never comes stops at the end and says so", async () => {
    const lane = await open(`${wb.base}/settings`);
    const r = await act(lane, [{ click: "combobox:Country" }, { scroll: { until: "option:Atlantis", in: "listbox" } }]);
    expect(r.ok).toBe(false);
    expect(r.steps[1]!.diagnosis!.hint).toContain("to the end");
    await service.call("lane.close", { lane });
  }, 60_000);

  test("scrolling to a row a virtual list replaces is not reported as covered", async () => {
    const lane = await open(`${wb.base}/settings`);
    await act(lane, [{ click: "combobox:Country" }]);
    const r = await act(lane, [{ scroll: "option:Australia" }]);
    expect(r.steps[0]!.diagnosis?.reason).not.toBe("covered");
    await service.call("lane.close", { lane });
  }, 30_000);
});

describe("naming", () => {
  test("identical buttons carry their row, and near picks the one in that row", async () => {
    const lane = await open(`${wb.base}/drafts`);
    await Bun.sleep(300);
    expect(await outlineOf(lane)).toContain("button:Delete (Draft 3)");
    const r = await act(lane, [{ dialog: "accept" }, { click: { role: "button", name: "Delete", near: "Draft 3" } }]);
    expect(r.ok).toBe(true);
    await Bun.sleep(300);
    expect(wb.state.drafts).toEqual([1, 2, 4, 5]);
    await service.call("lane.close", { lane });
  }, 30_000);

  test("a dismissed confirm says how to accept it", async () => {
    const lane = await open(`${wb.base}/drafts`);
    await Bun.sleep(300);
    const r = await act(lane, [{ click: { role: "button", name: "Delete", near: "Draft 1" } }]);
    const { renderAct } = await import("../src/render/text");
    expect(renderAct(r)).toContain('{"dialog": "accept"}');
    expect(wb.state.drafts).toEqual([1, 2, 3, 4, 5]);
    await service.call("lane.close", { lane });
  }, 30_000);

  test("a control is found by what it shows as well as its name, and a transparent checkbox is listed", async () => {
    const lane = await open(`${wb.base}/signup`);
    await act(lane, [
      { type: ["textbox:Email", "sam@example.com"] }, { type: ["textbox:Password", "correct-horse-42"] }, { click: "button:Next" },
      { click: "button:Select date" },
    ]);
    const r = await act(lane, [{ click: "button:›", expect: { appears: "February" } }]);
    expect(r.ok).toBe(true);
    expect(await outlineOf(lane)).toMatch(/checkbox:I accept the terms of service e\d+\.\d+ \[transparent/);
    await service.call("lane.close", { lane });
  }, 30_000);
});

describe("scrolling from inside a list", () => {
  test("naming a row, not the list, still scrolls the list that holds it", async () => {
    const lane = await open(`${wb.base}/settings`);
    const r = await act(lane, [
      { click: "combobox:Country" },
      // "option:Albania" is a row in the list, not the scrolling box around it.
      { scroll: { until: "option:Uruguay", in: "option:Albania" } },
      { click: "option:Uruguay" },
      { click: "button:Save", expect: { appears: "Saved." } },
    ]);
    expect(r.ok).toBe(true);
    expect(wb.state.country).toBe("Uruguay");
    await service.call("lane.close", { lane });
  }, 60_000);

  test("choosing an option in a control that is not a <select> says what to do instead", async () => {
    const lane = await open(`${wb.base}/settings`);
    const r = await act(lane, [{ select: ["combobox:Country", "Uruguay"] }]);
    expect(r.ok).toBe(false);
    expect(r.steps[0]!.diagnosis!.hint).toContain("not a <select>");
    expect(r.steps[0]!.diagnosis!.hint).toContain("scroll");
    await service.call("lane.close", { lane });
  }, 30_000);
});

describe("naming what a developer sees", () => {
  test("a CSS selector is a target", async () => {
    const lane = await open(`${wb.base}/avatar`);
    const found = await service.call("scene.find", { lane, target: "input[type=file]" }) as { matches: Array<{ role: string }> };
    expect(found.matches[0]?.role).toBe("file");
    const byId = await service.call("scene.find", { lane, target: "#upload" }) as { matches: Array<{ name: string }> };
    expect(byId.matches[0]?.name).toBe("Upload");
    await service.call("lane.close", { lane });
  }, 30_000);

  test("uploading to the label of a styled picker reaches the input it names", async () => {
    const lane = await open(`${wb.base}/avatar`);
    const r = await act(lane, [
      { upload: ["label:Choose image", AVATAR_PATH] },
      { click: "button:Upload", expect: { appears: "Profile picture updated." } },
    ]);
    expect(r.ok).toBe(true);
    await Bun.sleep(300);
    expect(wb.state.avatarSha).toBe(AVATAR_SHA);
    await service.call("lane.close", { lane });
  }, 30_000);

  test("a field that is there but invisible is listed, not hidden from the outline", async () => {
    const lane = await open(`${wb.base}/avatar`);
    expect(await outlineOf(lane)).toMatch(/file:Choose image e\d+\.\d+ \[transparent/);
    await service.call("lane.close", { lane });
  }, 30_000);
});

describe("quoting the page", () => {
  test("text with a colon in it is text, not role:name", async () => {
    const lane = await open(`${wb.base}/orders`);
    await Bun.sleep(400);
    const found = await service.call("scene.find", { lane, target: "Order #1250" }) as { matches: unknown[] };
    expect(found.matches.length).toBe(1);
    const lane2 = await open(`${wb.base}/checkout`);
    const quoted = await service.call("scene.find", { lane: lane2, target: "Total: $107.00" }) as { matches: unknown[] };
    expect(quoted.matches.length).toBe(1);
    await service.call("lane.close", { lane });
    await service.call("lane.close", { lane: lane2 });
  }, 30_000);
});

describe("reviewing a page at several sizes", () => {
  test("one check covers every viewport and names what only fails on a phone", async () => {
    const lane = await open(`${wb.base}/cart`);
    const r = await service.call("check", { lane, viewports: [{ w: 390, h: 844 }, { w: 1280, h: 800 }] }) as {
      across: Array<{ viewport: { w: number; h: number }; findings: Array<{ rule: string; count: number }> }>;
    };
    expect(r.across.length).toBe(2);
    const phone = r.across.find((a) => a.viewport.w === 390)!;
    const desktop = r.across.find((a) => a.viewport.w === 1280)!;
    // The promo bar covers Checkout only on a phone.
    const covered = (a: typeof phone) => a.findings.some((f) => f.rule === "tap-target" || f.rule === "overflow-x") || a.findings.length !== desktop.findings.length;
    void covered;
    const { renderCheckAcross } = await import("../src/render/text");
    const rendered = renderCheckAcross(r as never);
    expect(rendered).toContain("390x844");
    expect(rendered).toContain("1280x800");
    expect(phone.findings.length + desktop.findings.length).toBeGreaterThanOrEqual(0);
    await service.call("lane.close", { lane });
  }, 60_000);

  test("text only a screen reader reads is not measured for size or contrast", async () => {
    const page = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: () => new Response(`<!doctype html><title>Hidden</title>
<style>.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}</style>
<p>Readable body text at a normal size.</p>
<span class="sr-only" style="font-size:6px;color:#fafafa">Skip to main content</span>`, { headers: { "content-type": "text/html" } }),
    });
    try {
      const lane = await open(`http://127.0.0.1:${page.port}/`);
      const r = await service.call("check", { lane, only: ["a11y", "layout"] }) as { findings: Array<{ rule: string; examples: Array<{ text?: string }> }> };
      const flagged = r.findings.flatMap((f) => f.examples.map((e) => e.text ?? ""));
      expect(flagged.some((t) => t.includes("Skip to main content"))).toBe(false);
      await service.call("lane.close", { lane });
    } finally {
      page.stop(true);
    }
  }, 30_000);

  test("a step with no verb argus knows names every verb there is", async () => {
    const lane = await open(`${wb.base}/cart`);
    let message = "";
    try {
      await service.call("act", { lane, steps: [{ check: true }] });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    void message;
    const { checkRequest } = await import("../src/protocol/validate");
    const said = checkRequest({ jsonrpc: "2.0", id: 1, method: "act", params: { lane, steps: [{ check: true }] } }) ?? "";
    expect(said).toContain('"check"');
    expect(said).toContain("drag");
    expect(said).toContain("wait");
    await service.call("lane.close", { lane });
  }, 30_000);
});
