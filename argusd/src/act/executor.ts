// The executor: steps in, verified observations out.
//
// Deterministic code, no model. Each step is resolved against a fresh Scene,
// checked for reachability the way a person's click would be (a hit test at
// the point it will click), performed with real input events, allowed to
// settle, and then held to its expectation. The script stops at the first
// surprise and says why. A step that reports ok has an effect or an
// expectation that held; "nothing happened" is reported, not dressed up.

import type { Page } from "../cdp/pipe";
import type { Probe, Mark } from "../lane/probe";
import type {
  ActResult, Diagnosis, Element, ElementStateName, Expectation, FailedCondition, Observation, Step, StepResult, Target, Verb,
} from "../protocol/types";
import { captureScene, hitTest, type Scene, type SceneElement } from "../scene/snapshot";
import { describeTarget, label, locate, publicElement, type Match } from "./locate";

export interface LaneContext {
  page: Page;
  probe: Probe;
  defaultViewport: { w: number; h: number };
}

const QUIET_MS = 150;
const SETTLE_MAX_MS = 3000;
const NAV_MAX_MS = 15_000;
const LIST_LIMIT = 12;

const VERBS: Verb[] = ["open", "click", "hover", "type", "press", "select", "upload", "scroll", "dialog", "viewport", "wait"];

export function verbOf(step: Step): Verb {
  const verb = VERBS.find((v) => v in step);
  if (!verb) throw new Error("step has no verb");
  return verb;
}

export function parseDuration(s: string | undefined, fallback: number): number {
  if (!s) return fallback;
  const m = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(s);
  if (!m) return fallback;
  return Math.min(120_000, Number(m[1]) * (m[2] === "s" ? 1000 : 1));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function act(
  lane: LaneContext,
  steps: Step[],
  options: { stopOnSurprise?: boolean; noErrorsByDefault?: boolean } = {},
): Promise<ActResult> {
  const t0 = performance.now();
  const results: StepResult[] = [];
  const stop = options.stopOnSurprise ?? true;
  for (let i = 0; i < steps.length; i++) {
    const result = await runStep(lane, steps[i]!, i, options.noErrorsByDefault ?? false);
    results.push(result);
    if (!result.ok && stop) break;
  }
  const out: ActResult = {
    ok: results.length === steps.length && results.every((r) => r.ok),
    steps: results,
    ms: Math.round(performance.now() - t0),
    tokensEst: 0,
  };
  out.tokensEst = Math.ceil(JSON.stringify(out).length / 4);
  return out;
}

interface Performed {
  ok: boolean;
  target?: SceneElement;
  match?: Match;
  diagnosis?: Diagnosis;
  fields?: Observation["fields"];
  /** Some verbs change nothing visible by design; they are not held to "effect". */
  expectsEffect: boolean;
}

async function runStep(lane: LaneContext, step: Step, i: number, noErrorsByDefault: boolean): Promise<StepResult> {
  const t0 = performance.now();
  const verb = verbOf(step);
  const before = await captureScene(lane.page);
  const mark = await lane.probe.mark();
  const navigationsBefore = lane.probe.navigations;

  let performed: Performed;
  try {
    performed = await perform(lane, step, verb, before);
  } catch (error) {
    performed = { ok: false, expectsEffect: false, diagnosis: { reason: "probe-error", hint: "The browser refused the step.", detail: error instanceof Error ? error.message : String(error) } };
  }

  const observation: Observation = {};
  let diagnosis = performed.diagnosis;
  let ok = performed.ok;

  if (ok) {
    const settled = await settle(lane, mark, navigationsBefore !== lane.probe.navigations || verb === "open");
    observation.settled = settled;

    const expectation: Expectation | undefined = verb === "wait"
      ? (step as { wait: Expectation }).wait
      : step.expect ?? (noErrorsByDefault ? { noErrors: true } : undefined);
    const withNoErrors = expectation && noErrorsByDefault && expectation.noErrors === undefined
      ? { ...expectation, noErrors: true } : expectation;

    if (withNoErrors) {
      const within = parseDuration(withNoErrors.within, verb === "wait" ? 5000 : 5000);
      const held = await holds(lane, withNoErrors, mark, before, within);
      observation.expect = held.held ? { held: true } : { held: false, failed: held.failed };
      if (!held.held) {
        ok = false;
        diagnosis = verb === "wait"
          ? { reason: "timeout", hint: `Still not true after ${within}ms: ${held.failed.map((f) => f.condition).join("; ")}.`, waitedMs: held.waitedMs }
          : { reason: "expectation-failed", hint: failureHint(held.failed), failed: held.failed };
      }
    }
  }

  const after = await captureScene(lane.page);
  Object.assign(observation, describeChange(before, after, lane.probe.since(mark, LIST_LIMIT)));
  // A verb's own report (e.g. the files set by upload) wins over the scene diff.
  if (performed.fields?.length) observation.fields = performed.fields;
  observation.ms = Math.round(performance.now() - t0);

  if (ok && performed.expectsEffect && !step.expect) {
    const mutations = (await lane.probe.mutations()) - mark.mutations;
    const events = lane.probe.since(mark).events;
    const changed = mutations > 0 || events > 0 || navigationsBefore !== lane.probe.navigations
      || observation.url || observation.added || observation.removed || observation.fields;
    if (!changed) observation.effect = "none";
  }

  const result: StepResult = { i, verb, ok, observation };
  if (step.id) result.id = step.id;
  if (performed.target) result.target = publicElement(performed.target);
  if (performed.match) result.match = performed.match;
  if (!ok) result.diagnosis = diagnosis ?? { reason: "probe-error", hint: "The step failed without a reason.", detail: "missing diagnosis" };
  return result;
}

// ---- performing ---------------------------------------------------------------

async function perform(lane: LaneContext, step: Step, verb: Verb, scene: Scene): Promise<Performed> {
  const { page } = lane;
  switch (verb) {
    case "open": {
      const url = (step as { open: string }).open;
      const { errorText } = await page.navigate(url, NAV_MAX_MS);
      if (errorText) return { ok: false, expectsEffect: false, diagnosis: { reason: "navigation-failed", hint: `Could not load ${url}: ${errorText}.`, errorText } };
      return { ok: true, expectsEffect: false };
    }

    case "click":
    case "hover": {
      const target = (step as { click?: Target; hover?: Target })[verb]!;
      const reached = await reach(lane, scene, target, verb === "click");
      if (!reached.ok) return { ...reached, expectsEffect: false };
      const { x, y } = reached.point;
      await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      if (verb === "click") {
        await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      }
      return { ok: true, target: reached.element, match: reached.match, expectsEffect: verb === "click" };
    }

    case "type": {
      const [target, text] = (step as { type: [Target, string | { secret: string }] }).type;
      if (typeof text !== "string")
        return { ok: false, expectsEffect: false, diagnosis: { reason: "forbidden", hint: `Secret "${text.secret}" needs the person's approval, and approvals are not built yet. Nothing was typed.` } };
      const reached = await reach(lane, scene, target, true);
      if (!reached.ok) return { ...reached, expectsEffect: false };
      const node = reached.element.backendNodeId;
      const from = await fieldValue(page, node);
      await page.send("DOM.focus", { backendNodeId: node });
      await callOn(page, node, `function () {
        if ("value" in this) {
          const proto = Object.getPrototypeOf(this);
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          setter ? setter.call(this, "") : (this.value = "");
          this.dispatchEvent(new Event("input", { bubbles: true }));
        } else if (this.isContentEditable) { this.textContent = ""; }
      }`);
      await page.send("Input.insertText", { text });
      const to = await fieldValue(page, node);
      const fields: Observation["fields"] = from === to ? [] : [{ target: label(reached.element), ...(from ? { from } : {}), to: to ?? "" }];
      if (to !== text && !(to ?? "").includes(text)) {
        return {
          ok: false, target: reached.element, match: reached.match, fields, expectsEffect: false,
          diagnosis: {
            reason: "expectation-failed",
            hint: `Typed into ${label(reached.element)} but it holds "${to ?? ""}".` + (reached.centreCoveredBy !== undefined
              ? ` Its centre is covered by ${reached.centreCoveredBy ? label(reached.centreCoveredBy) : "another element"}; pages often reject input they cannot see. Scroll it clear ({"scroll": target}) and type again.`
              : ""),
            failed: [{ condition: `field holds "${text}"`, actual: to }],
          },
        };
      }
      return { ok: true, target: reached.element, match: reached.match, fields, expectsEffect: false };
    }

    case "press": {
      await pressChord(page, (step as { press: string }).press);
      return { ok: true, expectsEffect: true };
    }

    case "select": {
      const [target, option] = (step as { select: [Target, string] }).select;
      const reached = await reach(lane, scene, target, true);
      if (!reached.ok) return { ...reached, expectsEffect: false };
      const chosen = await callOn(page, reached.element.backendNodeId, `function (want) {
        if (!(this instanceof HTMLSelectElement)) return { error: "not a select element" };
        const norm = (s) => s.replace(/\\s+/g, " ").trim().toLowerCase();
        const option = [...this.options].find((o) => norm(o.text) === norm(want) || o.value === want);
        if (!option) return { error: "no option", options: [...this.options].map((o) => o.text).slice(0, 12) };
        this.value = option.value;
        this.dispatchEvent(new Event("input", { bubbles: true }));
        this.dispatchEvent(new Event("change", { bubbles: true }));
        return { value: option.text };
      }`, [option]) as { error?: string; options?: string[]; value?: string };
      if (chosen?.error)
        return {
          ok: false, target: reached.element, match: reached.match, expectsEffect: false,
          diagnosis: { reason: "not-found", hint: `${label(reached.element)} has no option "${option}"${chosen.options ? `; it has: ${chosen.options.join(", ")}` : ""}.`, didYouMean: [] },
        };
      return { ok: true, target: reached.element, match: reached.match, expectsEffect: false, fields: [{ target: label(reached.element), to: chosen?.value ?? option }] };
    }

    case "upload": {
      const [target, ...files] = (step as { upload: [Target, ...string[]] }).upload;
      const found = locate(scene, target);
      if (!found.ok) return { ok: false, expectsEffect: false, diagnosis: found.diagnosis };
      await page.send("DOM.setFileInputFiles", { files, backendNodeId: found.element.backendNodeId });
      const count = await callOn(page, found.element.backendNodeId, "function () { return this.files ? this.files.length : -1 }");
      if (count !== files.length)
        return {
          ok: false, target: found.element, match: found.match, expectsEffect: false,
          diagnosis: { reason: "expectation-failed", hint: `${label(found.element)} holds ${count} file(s), not ${files.length}.`, failed: [{ condition: `${files.length} file(s) set`, actual: count }] },
        };
      return { ok: true, target: found.element, match: found.match, expectsEffect: false, fields: [{ target: label(found.element), to: files.map((f) => f.split("/").pop()).join(", ") }] };
    }

    case "scroll": {
      const value = (step as { scroll: Target | { by: { x: number; y: number } } }).scroll;
      if (typeof value === "object" && "by" in value) {
        const vp = scene.viewport;
        await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: vp.w / 2, y: vp.h / 2, deltaX: value.by.x, deltaY: value.by.y });
        return { ok: true, expectsEffect: false };
      }
      const found = locate(scene, value as Target);
      if (!found.ok) return { ok: false, expectsEffect: false, diagnosis: found.diagnosis };
      // Scroll until the element's centre is visible and uncovered, not merely
      // "in view": try the least movement first, then each alignment.
      const node = found.element.backendNodeId;
      let lastCover: SceneElement | null = null;
      for (const block of [null, "center", "start", "end"]) {
        if (block === null) await page.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: node });
        else await callOn(page, node, "function (block) { this.scrollIntoView({ block, inline: 'nearest' }) }", [block]);
        const now = await captureScene(page);
        const e = now.elements.find((x) => x.backendNodeId === node);
        if (!e?.bounds) break;
        const cx = Math.round(e.bounds.x + e.bounds.w / 2), cy = Math.round(e.bounds.y + e.bounds.h / 2);
        if (cx < 0 || cy < 0 || cx >= now.viewport.w || cy >= now.viewport.h) continue;
        const backendNodeId = await hitTest(page, now, cx, cy);
        if (backendNodeId === null) continue;
        if (backendNodeId === node || now.ancestors(backendNodeId).includes(node)) return { ok: true, target: e, match: found.match, expectsEffect: false };
        lastCover = coveringElement(now, backendNodeId);
      }
      return {
        ok: false, target: found.element, match: found.match, expectsEffect: false,
        diagnosis: {
          reason: "covered",
          hint: `Scrolled ${label(found.element)} every way, and its centre stays covered${lastCover ? ` by ${label(lastCover)}` : ""}.`,
          blocker: lastCover ? publicElement(lastCover) : { ref: found.element.ref, role: "generic", name: "" },
        },
      };
    }

    case "dialog": {
      const value = (step as { dialog: "accept" | "dismiss" | { accept: string } }).dialog;
      if (typeof value === "string") lane.probe.arm(value);
      else lane.probe.arm("accept", value.accept);
      return { ok: true, expectsEffect: false };
    }

    case "viewport": {
      const value = (step as { viewport: { w: number; h: number; mobile?: boolean; scale?: number } | "reset" }).viewport;
      const vp = value === "reset" ? { ...lane.defaultViewport } : value;
      await setViewport(page, vp);
      return { ok: true, expectsEffect: false };
    }

    case "wait":
      return { ok: true, expectsEffect: false };
  }
}

export async function setViewport(page: Page, vp: { w: number; h: number; mobile?: boolean; scale?: number }): Promise<void> {
  const mobile = vp.mobile ?? vp.w < 600;
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: vp.w, height: vp.h, deviceScaleFactor: vp.scale ?? (mobile ? 2 : 1), mobile,
  });
  await page.send("Emulation.setTouchEmulationEnabled", { enabled: mobile });
}

// ---- reachability ------------------------------------------------------------

type Reached =
  | { ok: true; element: SceneElement; match: Match; point: { x: number; y: number }; centreCoveredBy?: SceneElement | null }
  | { ok: false; diagnosis: Diagnosis; target?: SceneElement; match?: Match };

/**
 * Where a person's click would land, and whether it would land on the element.
 * Offscreen elements are scrolled to first, as a person would.
 */
export async function reach(lane: LaneContext, scene: Scene, target: Target, needsEnabled: boolean): Promise<Reached> {
  const found = locate(scene, target);
  if (!found.ok) return found;
  let element = found.element;

  if (needsEnabled && element.state.includes("disabled"))
    return { ok: false, target: element, match: found.match, diagnosis: { reason: "disabled", hint: `${label(element)} is disabled; something on the page has to enable it first.` } };
  if (!element.visible) {
    if (element.hiddenBy === "zero-size")
      return { ok: false, target: element, match: found.match, diagnosis: { reason: "zero-size", hint: `${label(element)} takes up no space on the page.` } };
    return { ok: false, target: element, match: found.match, diagnosis: { reason: "hidden", hint: `${label(element)} is on the page but hidden (${element.hiddenBy}).`, why: element.hiddenBy === "display" || element.hiddenBy === "visibility" || element.hiddenBy === "opacity" ? element.hiddenBy : "display" } };
  }

  const inView = (e: SceneElement) => {
    const b = e.bounds!;
    return b.x + b.w > 0 && b.y + b.h > 0 && b.x < scene.viewport.w && b.y < scene.viewport.h;
  };
  if (!inView(element)) {
    await lane.page.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: element.backendNodeId });
    const again = await captureScene(lane.page);
    const moved = again.elements.find((e) => e.backendNodeId === element.backendNodeId);
    if (!moved || !moved.bounds || !(moved.bounds.x + moved.bounds.w > 0 && moved.bounds.y + moved.bounds.h > 0 && moved.bounds.x < again.viewport.w && moved.bounds.y < again.viewport.h))
      return { ok: false, target: element, match: found.match, diagnosis: { reason: "offscreen", hint: `${label(element)} is outside the viewport and scrolling did not bring it in.`, scrollable: false } };
    element = moved;
    scene = again;
  }

  // Hit-test where the click will land. A hit on one of the element's own
  // ancestors means the element is clipped by a scroll container at that point
  // (the ancestor paints there, the element does not): scroll it into view and
  // test again, as a person would. Anything else on top is a real cover.
  for (let attempt = 0; ; attempt++) {
    const b = element.bounds!;
    const vx0 = Math.max(0, b.x), vy0 = Math.max(0, b.y);
    const vx1 = Math.min(scene.viewport.w, b.x + b.w), vy1 = Math.min(scene.viewport.h, b.y + b.h);
    // The centre first; if something covers it, the parts of the element a
    // person can still see. A partly covered field is clickable where it shows.
    const fractions: Array<[number, number]> = [[0.5, 0.5], [0.2, 0.5], [0.8, 0.5], [0.5, 0.25], [0.5, 0.75], [0.2, 0.25], [0.8, 0.25], [0.2, 0.75], [0.8, 0.75]];
    const points = fractions.map(([fx, fy]) => ({ x: Math.round(vx0 + (vx1 - vx0) * fx), y: Math.round(vy0 + (vy1 - vy0) * fy) }));
    const point = points[0]!;

    const hit = await hitTest(lane.page, scene, point.x, point.y);
    // Some documents answer nothing for a point (e.g. mid-navigation): click anyway, and let verification judge.
    if (hit === null) return { ok: true, element, match: found.match, point };
    const lands = (id: number) => id === element.backendNodeId || scene.ancestors(id).includes(element.backendNodeId);
    if (lands(hit)) return { ok: true, element, match: found.match, point };

    if (!scene.ancestors(element.backendNodeId).includes(hit)) {
      for (const p of points.slice(1)) {
        const other = await hitTest(lane.page, scene, p.x, p.y);
        if (other !== null && lands(other)) return { ok: true, element, match: found.match, point: p, centreCoveredBy: coveringElement(scene, hit) };
      }
    }

    // Clipped: a scroll container between the element and the page hides the
    // point. The hit may be an ancestor, or whatever the overflowing element
    // happens to lie over; the layout is asked, not guessed from the hit.
    const clipped = scene.ancestors(element.backendNodeId).includes(hit)
      || await callOn(lane.page, element.backendNodeId, `function () {
        const r = this.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
        for (let a = this.parentElement; a && a !== document.body; a = a.parentElement) {
          const s = getComputedStyle(a);
          if (s.overflowX === "visible" && s.overflowY === "visible") continue;
          const c = a.getBoundingClientRect();
          if (x < c.left || x > c.right || y < c.top || y > c.bottom) return true;
        }
        return false;
      }`).then((v) => v === true, () => false);
    if (clipped && attempt === 0) {
      await lane.page.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: element.backendNodeId });
      scene = await captureScene(lane.page);
      const moved = scene.elements.find((e) => e.backendNodeId === element.backendNodeId);
      if (!moved?.bounds) break;
      element = moved;
      continue;
    }
    if (clipped)
      return { ok: false, target: element, match: found.match, diagnosis: { reason: "offscreen", hint: `${label(element)} is clipped by a scroll container and scrolling did not reveal it.`, scrollable: true } };

    const blocker = coveringElement(scene, hit);
    const blockerPublic: Element = blocker ? publicElement(blocker) : { ref: `e0.${hit}`, role: "generic", name: "" };
    return {
      ok: false,
      target: element,
      match: found.match,
      diagnosis: {
        reason: "covered",
        hint: `${label(element)} is covered by ${blocker ? label(blocker) : "another element"} at (${point.x}, ${point.y}); dismiss or close it first.`,
        blocker: blockerPublic,
      },
    };
  }
  return { ok: false, target: element, match: found.match, diagnosis: { reason: "detached", hint: `${label(element)} went away while scrolling to it.` } };
}

/** The most meaningful element at a hit point: a named ancestor if the hit itself is anonymous. */
function coveringElement(scene: Scene, hit: number): SceneElement | null {
  const own = scene.describe(hit);
  if (own && (own.name || own.role !== "generic" || own.selector.includes("#"))) return own;
  for (const id of scene.ancestors(hit).slice(1, 6)) {
    const up = scene.describe(id);
    if (up && (up.role === "dialog" || up.role === "alertdialog" || up.selector.includes("#"))) return up;
  }
  return own;
}

// ---- settle and expectations -------------------------------------------------

async function settle(lane: LaneContext, mark: Mark, navigated: boolean): Promise<{ quietMs: number; waitedMs: number } | "timeout"> {
  const t0 = performance.now();
  const max = navigated ? NAV_MAX_MS : SETTLE_MAX_MS;
  if (navigated) {
    // A click that navigates: wait for the new document before judging quiet.
    while (performance.now() - t0 < max) {
      try {
        const { result } = await lane.page.send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
        if (result.value === "complete") break;
      } catch { /* context swapping */ }
      await sleep(25);
    }
  }
  let mutations = await lane.probe.mutations();
  let quietSince = performance.now();
  while (performance.now() - t0 < max) {
    await sleep(25);
    const now = await lane.probe.mutations();
    if (now !== mutations || lane.probe.busyRequests > 0 || lane.probe.lastActivity > quietSince) {
      mutations = now;
      quietSince = performance.now();
      continue;
    }
    if (performance.now() - quietSince >= QUIET_MS) return { quietMs: QUIET_MS, waitedMs: Math.round(performance.now() - t0) };
  }
  void mark;
  return "timeout";
}

async function holds(
  lane: LaneContext, expectation: Expectation, mark: Mark, before: Scene, within: number,
): Promise<{ held: true; waitedMs: number } | { held: false; failed: FailedCondition[]; waitedMs: number }> {
  const t0 = performance.now();
  let failed: FailedCondition[] = [];
  for (;;) {
    const scene = await captureScene(lane.page);
    failed = await check(lane, expectation, mark, before, scene);
    const waitedMs = Math.round(performance.now() - t0);
    if (!failed.length) return { held: true, waitedMs };
    if (waitedMs >= within) return { held: false, failed, waitedMs };
    await sleep(50);
  }
}

async function check(lane: LaneContext, x: Expectation, mark: Mark, before: Scene, scene: Scene): Promise<FailedCondition[]> {
  const failed: FailedCondition[] = [];
  const textPresent = (want: string) => {
    const w = want.replace(/\s+/g, " ").trim().toLowerCase();
    return scene.texts.some((b) => b.text.toLowerCase().includes(w)) || scene.elements.some((e) => e.visible && e.name.toLowerCase().includes(w));
  };
  const elementPresent = (t: Target) => {
    const found = locate(scene, t);
    return found.ok ? found.element.visible : found.diagnosis.reason === "ambiguous";
  };

  if (x.appears !== undefined) {
    const present = typeof x.appears === "string" ? textPresent(x.appears) : elementPresent(x.appears);
    if (!present) failed.push({ condition: `appears ${typeof x.appears === "string" ? `"${x.appears}"` : describeTarget(x.appears)}`, actual: null });
  }
  if (x.disappears !== undefined) {
    const present = typeof x.disappears === "string" ? textPresent(x.disappears) : elementPresent(x.disappears);
    if (present) failed.push({ condition: `disappears ${typeof x.disappears === "string" ? `"${x.disappears}"` : describeTarget(x.disappears)}`, actual: "still present" });
  }
  if (x.url) {
    const url = scene.url;
    if (x.url.is !== undefined && url !== x.url.is) failed.push({ condition: `url is ${x.url.is}`, actual: url });
    if (x.url.matches !== undefined && !new RegExp(x.url.matches).test(url)) failed.push({ condition: `url matches ${x.url.matches}`, actual: url });
    if (x.url.changes && url === before.url) failed.push({ condition: "url changes", actual: url });
  }
  if (x.field) {
    const [t, want] = x.field;
    const found = locate(scene, t);
    const value = found.ok ? await fieldValue(lane.page, found.element.backendNodeId) : null;
    if (value !== want) failed.push({ condition: `${describeTarget(t)} holds "${want}"`, actual: value });
  }
  if (x.state) {
    const [t, want] = x.state;
    const found = locate(scene, t);
    const actual = found.ok ? statesOf(found.element) : null;
    if (!actual || !actual.includes(want)) failed.push({ condition: `${describeTarget(t)} is ${want}`, actual });
  }
  if (x.count) {
    const [t, want] = x.count;
    const found = locate(scene, t);
    const n = found.ok ? 1 : found.diagnosis.reason === "ambiguous" ? countMatches(scene, t) : 0;
    const okCount = typeof want === "number" ? n === want : (want.gte === undefined || n >= want.gte) && (want.lte === undefined || n <= want.lte);
    if (!okCount) failed.push({ condition: `count of ${describeTarget(t)} ${JSON.stringify(want)}`, actual: n });
  }
  if (x.noErrors) {
    const seen = lane.probe.since(mark);
    const errors = [
      ...(seen.console ?? []).filter((c) => c.level === "error").map((c) => `console: ${c.text}`),
      ...(seen.exceptions ?? []).map((e) => `exception: ${e.message}`),
      ...(seen.network ?? []).filter((r) => r.error || (r.status ?? 0) >= 400 || r.status === 0).map((r) => `request: ${r.url} ${r.status ?? r.error}`),
    ];
    if (errors.length) failed.push({ condition: "no errors", actual: errors.slice(0, 5) });
  }
  if (x.request) {
    const want = x.request;
    const hit = lane.probe.requestsSince(mark).some((r) => r.url.includes(want.url)
      && (want.method === undefined || r.method === want.method) && (want.status === undefined || r.status === want.status));
    if (!hit) failed.push({ condition: `request ${want.method ?? ""} ${want.url}${want.status ? ` -> ${want.status}` : ""}`.replace("  ", " "), actual: null });
  }
  return failed;
}

function countMatches(scene: Scene, t: Target): number {
  const found = locate(scene, t);
  if (found.ok) return 1;
  // Ambiguous: count every candidate, not just the first few reported.
  const role = typeof t === "string" ? t.split(":")[0]!.toLowerCase() : t.role?.toLowerCase();
  const name = typeof t === "string" ? (t.includes(":") ? t.slice(t.indexOf(":") + 1) : undefined) : t.name;
  return scene.elements.filter((e) => e.visible && (!role || e.role.toLowerCase() === role)
    && (name === undefined || e.name.toLowerCase().includes(name.toLowerCase()))).length;
}

function statesOf(e: SceneElement): ElementStateName[] {
  const s = new Set<ElementStateName>(e.state as ElementStateName[]);
  s.add(e.state.includes("disabled") ? "disabled" : "enabled");
  if (!e.state.includes("checked")) s.add("unchecked");
  s.add(e.visible ? "visible" : "hidden");
  return [...s];
}

function failureHint(failed: FailedCondition[]): string {
  const first = failed[0]!;
  const actual = first.actual === null ? "" : `; actual: ${typeof first.actual === "string" ? first.actual : JSON.stringify(first.actual)}`;
  return `Expected ${first.condition}${actual}.` + (failed.length > 1 ? ` ${failed.length - 1} more condition(s) failed.` : "");
}

// ---- what changed ------------------------------------------------------------

function describeChange(before: Scene, after: Scene, events: ReturnType<Probe["since"]>): Observation {
  const out: Observation = {};
  if (before.url !== after.url) out.url = { from: before.url, to: after.url };
  if (before.title !== after.title) out.title = { from: before.title, to: after.title };

  const count = (s: Scene) => {
    const m = new Map<string, number>();
    for (const b of s.texts) m.set(b.text, (m.get(b.text) ?? 0) + 1);
    return m;
  };
  const a = count(before), b = count(after);
  const added: string[] = [], removed: string[] = [];
  for (const [text, n] of b) for (let k = a.get(text) ?? 0; k < n; k++) added.push(text);
  for (const [text, n] of a) for (let k = b.get(text) ?? 0; k < n; k++) removed.push(text);
  if (added.length) { out.added = added.slice(0, LIST_LIMIT).map(clip); if (added.length > LIST_LIMIT) out.addedMore = added.length - LIST_LIMIT; }
  if (removed.length) { out.removed = removed.slice(0, LIST_LIMIT).map(clip); if (removed.length > LIST_LIMIT) out.removedMore = removed.length - LIST_LIMIT; }

  // Fields that changed by any means: typed, or filled by the page itself.
  const was = new Map(before.fields.map((f) => [f.backendNodeId, f.value]));
  const fields = after.fields
    .filter((f) => was.has(f.backendNodeId) && was.get(f.backendNodeId) !== f.value)
    .map((f) => ({ target: f.label, ...(was.get(f.backendNodeId) ? { from: clip(was.get(f.backendNodeId)!) } : {}), to: clip(f.value) }));
  if (fields.length) out.fields = fields.slice(0, LIST_LIMIT);

  const { events: _events, ...rest } = events;
  return Object.assign(out, rest);
}

const clip = (s: string) => (s.length > 280 ? `${s.slice(0, 277)}...` : s);

// ---- page helpers ------------------------------------------------------------

async function callOn(page: Page, backendNodeId: number, fn: string, args: unknown[] = []): Promise<unknown> {
  const { object } = await page.send("DOM.resolveNode", { backendNodeId });
  if (!object.objectId) return undefined;
  try {
    const { result, exceptionDetails } = await page.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: fn,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  } finally {
    page.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
  }
}

async function fieldValue(page: Page, backendNodeId: number): Promise<string | null> {
  const v = await callOn(page, backendNodeId, `function () { return "value" in this ? String(this.value) : this.isContentEditable ? this.textContent : null }`);
  return typeof v === "string" ? v : null;
}

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" }, Tab: { code: "Tab", keyCode: 9 }, Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 }, Delete: { code: "Delete", keyCode: 46 }, Space: { code: "Space", keyCode: 32, text: " " },
  ArrowUp: { code: "ArrowUp", keyCode: 38 }, ArrowDown: { code: "ArrowDown", keyCode: 40 }, ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 }, Home: { code: "Home", keyCode: 36 }, End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 }, PageDown: { code: "PageDown", keyCode: 34 },
};
const MODIFIERS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

async function pressChord(page: Page, chord: string): Promise<void> {
  const parts = chord.split("+");
  const key = parts.pop()!;
  const modifiers = parts.reduce((m, p) => m | (MODIFIERS[p] ?? 0), 0);
  const known = KEYS[key === " " ? "Space" : key];
  const single = key.length === 1;
  const spec = known ?? {
    code: single ? (/[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : /\d/.test(key) ? `Digit${key}` : "") : key,
    keyCode: single ? key.toUpperCase().charCodeAt(0) : 0,
    ...(single ? { text: key } : {}),
  };
  const text = modifiers & (MODIFIERS.Control! | MODIFIERS.Meta! | MODIFIERS.Alt!) ? undefined : spec.text;
  for (const p of parts) {
    await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: p, code: `${p}Left`, modifiers, windowsVirtualKeyCode: { Alt: 18, Control: 17, Meta: 91, Shift: 16 }[p] ?? 0 });
  }
  await page.send("Input.dispatchKeyEvent", {
    type: text ? "keyDown" : "rawKeyDown", key: key === "Space" ? " " : key, code: spec.code, modifiers,
    windowsVirtualKeyCode: spec.keyCode, ...(text ? { text, unmodifiedText: text } : {}),
  });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: key === "Space" ? " " : key, code: spec.code, modifiers, windowsVirtualKeyCode: spec.keyCode });
  for (const p of parts.reverse()) {
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: p, code: `${p}Left`, modifiers: 0, windowsVirtualKeyCode: { Alt: 18, Control: 17, Meta: 91, Shift: 16 }[p] ?? 0 });
  }
}
