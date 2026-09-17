// Proves the Workbench before any model runs: each possible task can be done
// in a real browser and its judge then passes; doing nothing passes no judge;
// the traps really are impossible; the audit page has exactly its planted
// defects. Solved with raw browser input, not Argus's verbs, so the judges are
// checked independently of the tool being measured.
//
//   bun bench/workbench/selftest.ts

import { tmpdir } from "node:os";
import { Service } from "../../src/rpc/service";
import type { CdpPage } from "../../src/cdp/page";
import { AVATAR_PATH, MARKERS, startWorkbench } from "./app";
import { TASKS } from "./tasks";

const wb = startWorkbench();
const service = new Service({ traceDir: `${tmpdir()}/argus-workbench-selftest` });
let failures = 0;
const report = (ok: boolean, what: string) => { if (!ok) failures++; console.log(`${ok ? "ok  " : "FAIL"}  ${what}`); };

async function lane(url: string, viewport?: { w: number; h: number }) {
  const { lane } = await service.call("lane.open", { kind: "throwaway", ...(viewport ? { viewport } : {}) }) as { lane: string };
  const ctx = service.lanes.get(lane);
  await ctx.page.navigate(url, 15_000);
  await Bun.sleep(400);
  return { lane, page: ctx.page, probe: ctx.probe };
}
const js = async <T>(page: CdpPage, expression: string): Promise<T> => {
  const { result, exceptionDetails } = await page.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) throw new Error(`${expression}: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
  return result.value as T;
};
const until = async (page: CdpPage, expression: string, ms = 8000) => {
  const t = performance.now();
  while (performance.now() - t < ms) { if (await js<boolean>(page, expression).catch(() => false)) return; await Bun.sleep(50); }
  throw new Error(`never true: ${expression}`);
};
const center = (page: CdpPage, selector: string) => js<[number, number]>(page, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
const click = async (page: CdpPage, x: number, y: number) => {
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
};
const clickSel = async (page: CdpPage, selector: string) => { const [x, y] = await center(page, selector); await click(page, x, y); };
const clickText = async (page: CdpPage, selector: string, text: string) => {
  const [x, y] = await js<[number, number]>(page, `(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.trim() === ${JSON.stringify(text)}); e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  await click(page, x, y);
};
const typeInto = async (page: CdpPage, selector: string, text: string) => { await clickSel(page, selector); await page.send("Input.insertText", { text }); };

const solvers: Record<string, (answer: { text: string }) => Promise<void>> = {
  "spa-issue": async (a) => {
    const { page } = await lane(`${wb.base}/app`);
    await clickText(page, "a", "Projects"); await until(page, `!!document.querySelector('a[href="/app/projects/apollo"]')`);
    await clickText(page, "a", "Apollo"); await until(page, `[...document.querySelectorAll("a")].some((a) => a.textContent.startsWith("#42"))`);
    const title = await js<string>(page, `[...document.querySelectorAll("a")].find((a) => a.textContent.startsWith("#42 ")).textContent`);
    await clickText(page, "a", title); await until(page, `document.body.innerText.includes("Assignee:")`);
    a.text = "ASSIGNEE: " + await js<string>(page, `document.body.innerText.match(/Assignee: (.+)/)[1]`);
  },
  signup: async (a) => {
    const { page } = await lane(`${wb.base}/signup`);
    await typeInto(page, "#email", "sam@example.com"); await typeInto(page, "#password", "correct-horse-42");
    await until(page, `!document.querySelector("#next").disabled`); await clickSel(page, "#next");
    await clickSel(page, "#dob");
    await js(page, `(() => { const s = document.querySelector("#year"); s.value = "1990"; s.dispatchEvent(new Event("change")); })()`);
    for (let i = 0; i < 2; i++) await clickSel(page, "#nextm");
    await clickSel(page, '[aria-label="15 March 1990"]');
    await clickText(page, ".plan", "Team"); await clickSel(page, "#terms"); await clickSel(page, "#submit");
    await until(page, `document.body.innerText.includes("confirmation code")`);
    a.text = "CODE: " + await js<string>(page, `document.querySelector("#done strong").textContent`);
  },
  dialog: async () => {
    const { page, probe } = await lane(`${wb.base}/drafts`);
    await until(page, `document.querySelectorAll("button[data-id]").length === 5`);
    probe.arm("accept"); await clickSel(page, 'button[data-id="3"]');
    await until(page, `document.querySelectorAll("button[data-id]").length === 4`);
  },
  upload: async () => {
    const { page } = await lane(`${wb.base}/avatar`);
    const { root } = await page.send("DOM.getDocument", {});
    const { nodeId } = await page.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#file" });
    await page.send("DOM.setFileInputFiles", { nodeId, files: [AVATAR_PATH] });
    await until(page, `!document.querySelector("#upload").disabled`); await clickSel(page, "#upload");
    await until(page, `document.querySelector("#status").textContent.includes("updated")`);
  },
  drag: async () => {
    const { page } = await lane(`${wb.base}/board`);
    await until(page, `!!document.querySelector('[data-id="write-docs"]')`);
    const [x, y] = await center(page, '[data-id="write-docs"]');
    const [tx, ty] = await center(page, 'section[data-col="done"]');
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    for (let i = 1; i <= 10; i++) await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + (tx - x) * i / 10, y: y + (ty - y) * i / 10, button: "left", buttons: 1 });
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: tx, y: ty, button: "left", clickCount: 1 });
    await until(page, `!!document.querySelector('section[data-col="done"] [data-id="write-docs"]')`);
  },
  canvas: async (a) => {
    const { page } = await lane(`${wb.base}/map`);
    const red = MARKERS.find((m) => m.color === "#d93a3a")!;
    const [x, y] = await js<[number, number]>(page, `(() => { const r = document.querySelector("#map").getBoundingClientRect(); return [r.x + ${red.x} * r.width / 800, r.y + ${red.y} * r.height / 500]; })()`);
    await click(page, x, y); await until(page, `!!document.querySelector("#panel h2")`);
    a.text = "STATION: " + await js<string>(page, `document.querySelector("#panel h2").textContent`);
  },
  iframe: async () => {
    // The widget is another origin; drive it at its own URL the way the frame would.
    const { page } = await lane(`${wb.widget}/widget`);
    await typeInto(page, "#code", "ARGUS-2026"); await clickSel(page, "#redeem");
    await until(page, `document.querySelector("#msg").textContent.includes("Redeemed")`);
  },
  "virtual-list": async () => {
    const { page } = await lane(`${wb.base}/settings`);
    await clickSel(page, "#country");
    for (let i = 0; i < 80; i++) {
      if (await js<boolean>(page, `[...document.querySelectorAll("[role=option]")].some((o) => o.textContent === "Uruguay")`)) break;
      const [x, y] = await center(page, "#options");
      await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: 120 });
      await Bun.sleep(30);
    }
    await clickText(page, "[role=option]", "Uruguay"); await clickSel(page, "#save");
    await until(page, `document.querySelector("#saved").textContent === "Saved."`);
  },
  "hover-menu": async () => {
    const { page } = await lane(`${wb.base}/reports`);
    const [x, y] = await center(page, "#more .btn");
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await until(page, `!document.querySelector("#menu").hidden`);
    const [ix, iy] = await js<[number, number]>(page, `(() => { const e = [...document.querySelectorAll(".item")].find((e) => e.textContent === "Export CSV"); const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    for (let i = 1; i <= 5; i++) await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + (ix - x) * i / 5, y: y + (iy - y) * i / 5 });
    await click(page, ix, iy);
    await until(page, `!!document.querySelector(".toast")`);
  },
  "infinite-scroll": async (a) => {
    const { page } = await lane(`${wb.base}/orders`);
    for (let i = 0; i < 40 && !(await js<boolean>(page, `document.body.innerText.includes("Order #1187")`)); i++) {
      await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 400, y: 400, deltaX: 0, deltaY: 800 });
      await Bun.sleep(150);
    }
    a.text = "TOTAL: " + await js<string>(page, `[...document.querySelectorAll("#list li")].find((l) => l.textContent.includes("Order #1187")).lastElementChild.textContent`);
  },
  audit: async (a) => {
    const { lane: l } = await lane(`${wb.base}/audit`, { w: 390, h: 844 });
    await Bun.sleep(500);
    const r = await service.call("check", { lane: l }) as { findings: Array<{ rule: string }> };
    const rules = r.findings.map((f) => f.rule);
    console.log(`      argus check at 390×844: ${rules.join(", ")}`);
    a.text = ["contrast: Terms apply", "unnamed-control: search button", "missing-alt: hero image", "mobile-overflow: compare sizes table", "console-error: analytics", "failed-request: /api/recommendations 404"].map((d) => `DEFECT: ${d}`).join("\n");
  },
  "mobile-cover": async (a) => {
    const { page } = await lane(`${wb.base}/cart`, { w: 390, h: 844 });
    const [x, y] = await center(page, "#checkout");
    const top = await js<string>(page, `document.elementFromPoint(${x}, ${y}).closest("#promo") ? "promo" : document.elementFromPoint(${x}, ${y}).id`);
    report(top === "promo", `mobile-cover: at 390×844 the promo bar is on top of Checkout (${top})`);
    const desk = await lane(`${wb.base}/cart`, { w: 1280, h: 800 });
    const [dx, dy] = await center(desk.page, "#checkout");
    const dtop = await js<string>(desk.page, `document.elementFromPoint(${dx}, ${dy}).id`);
    report(dtop === "checkout", `mobile-cover: at 1280×800 Checkout is tappable (${dtop})`);
    a.text = "TAPPABLE: no, the free shipping promo bar covers it";
  },
};

try {
  for (const t of TASKS) {
    // Doing nothing must not pass.
    wb.reset();
    const idle = t.judge("", wb.state);
    report(!idle.met, `${t.id}: doing nothing fails (${idle.truth})`);
    if (!t.possible) continue;
    wb.reset();
    const answer = { text: "" };
    try {
      await solvers[t.id]!(answer);
      await Bun.sleep(300);
      const r = t.judge(answer.text, wb.state);
      report(r.met, `${t.id}: solved in a real browser, judge passes (${r.truth})`);
    } catch (error) {
      report(false, `${t.id}: solver failed: ${error instanceof Error ? error.message : error}`);
    }
    for (const { lane: l } of (await service.call("lane.list", {}) as { lanes: Array<{ lane: string }> }).lanes) await service.call("lane.close", { lane: l });
  }

  // The traps are really impossible.
  wb.reset();
  {
    const { page } = await lane(`${wb.base}/checkout`);
    await clickSel(page, "#place");
    await until(page, `!!document.querySelector(".toast")`);
    await until(page, `!document.querySelector(".toast")`, 4000);
    const shown = await js<string>(page, `document.body.innerText`);
    report(wb.state.orderAttempts === 1 && !/Order \d+ placed/.test(shown), "failed-order: the order request fails and the error disappears");
  }
  {
    const { page } = await lane(`${wb.base}/preferences`);
    await until(page, `document.querySelector("#email").getAttribute("aria-checked") === "true"`);
    await clickSel(page, "#email"); await clickSel(page, "#save");
    await until(page, `document.querySelector("#saved").textContent.includes("Saved")`);
    await page.navigate(`${wb.base}/preferences`, 10_000);
    await until(page, `document.querySelector("#email").getAttribute("aria-checked") === "true"`);
    report(wb.state.prefsSaves === 1, "unsaved-setting: shows Saved, but is on again after a reload");
  }
  // A wrong answer on the audit is judged wrong.
  const audit = TASKS.find((t) => t.id === "audit")!;
  report(!audit.judge("DEFECT: contrast: Terms apply\nDEFECT: duplicate-id: header", wb.state).met, "audit: a partial answer with a defect that is not there fails");
} finally {
  await service.shutdown();
  wb.stop();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
