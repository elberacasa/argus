// The interactions real apps ask for, on the Workbench app: dragging, points on
// a canvas, lists that render only what is in view, feeds that load as you
// scroll, rows of identical buttons, controls named differently from what they
// show, and confirm dialogs. Each was missing or costly in the first Workbench run.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { Service } from "../src/rpc/service";
import type { ActResult } from "../src/protocol/types";
import { MARKERS, orderTotal, startWorkbench, type Workbench } from "../bench/workbench/app";

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
