// UI Testing Playground through argusd, with ground truth.
//
//   bun bench/uitap.ts [challenge...]      all ten by default
//
// uitestingplayground.com is a third-party site built to break automation;
// each page states its trap and what success means. Every challenge here is
// played the way an agent would play it through the Argus Protocol (reading
// outlines and diagnoses, never page internals), and then judged by the
// harness reading the page itself. The two are compared: when Argus reports a
// step as done and the page shows it did not happen, that is a false success,
// the failure this benchmark exists to count.
//
// Cost is what the agent reads: every protocol result, at ~4 characters per
// token. The harness's own ground-truth queries are not counted.

import { tmpdir } from "node:os";
import { Service } from "../src/rpc/service";
import type { ActResult } from "../src/protocol/types";

const BASE = "http://uitestingplayground.com";

interface Outcome { passed: boolean; falseSuccess: boolean; said: string; truth: string }
interface Run { challenge: string; outcome: Outcome; calls: number; tokens: number; ms: number }

class Agent {
  calls = 0;
  chars = 0;
  constructor(private readonly service: Service) {}

  async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    this.calls++;
    const result = await this.service.call(method, params);
    this.chars += JSON.stringify(result).length;
    return result as T;
  }

  act(lane: string, steps: unknown[]) { return this.call<ActResult>("act", { lane, steps }); }
  async open(path: string) { return (await this.call<{ lane: string }>("lane.open", { kind: "throwaway", url: `${BASE}/${path}` })).lane; }
  outline(lane: string) { return this.call<{ outline: string }>("scene.outline", { lane, budget: 400 }); }
}

/** Ground truth, read by the harness from the page itself; not shown to the agent and not counted. */
async function truth<T>(service: Service, lane: string, expression: string): Promise<T> {
  const { result } = await service.lanes.get(lane).page.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return result.value as T;
}

const refOf = (outline: string, pattern: RegExp) => pattern.exec(outline)?.[1];
const said = (r: ActResult, i = r.steps.length - 1) => {
  const s = r.steps[i];
  return !s ? "no step" : s.ok ? `ok${s.observation.effect ? " (no effect)" : ""}` : s.diagnosis!.reason;
};

type Challenge = (a: Agent, s: Service) => Promise<Outcome>;

const challenges: Record<string, Challenge> = {
  // A second click on the green button must not land: after the first, a blue
  // button covers it, and the page complains if green is hit again.
  async hiddenlayers(a, s) {
    const lane = await a.open("hiddenlayers");
    const { outline } = await a.outline(lane);
    const green = refOf(outline, /button:Button (e[\d.]+)/)!;
    const first = await a.act(lane, [{ click: green }]);
    const second = await a.act(lane, [{ click: green }]);
    const warned = await truth<boolean>(s, lane, `!!document.querySelector("p.bg-warning")`);
    const blocked = !second.steps[0]!.ok;
    return {
      passed: first.ok && blocked && !warned,
      falseSuccess: second.steps[0]!.ok && warned,
      said: `1st ${said(first)}, 2nd ${said(second)}`,
      truth: warned ? "green hit twice" : "second click did not land",
    };
  },

  // Type into a field partly covered by another element inside a scroll box.
  async overlapped(a, s) {
    const lane = await a.open("overlapped");
    let r = await a.act(lane, [{ type: ["textbox:Name", "Argus"], expect: { field: ["textbox:Name", "Argus"] } }]);
    let note = said(r);
    if (!r.ok && /Scroll it clear/.test(r.steps[0]!.diagnosis?.hint ?? "")) {
      // What the diagnosis tells an agent to do.
      r = await a.act(lane, [{ scroll: "textbox:Name" }, { type: ["textbox:Name", "Argus"], expect: { field: ["textbox:Name", "Argus"] } }]);
      note += ` → ${said(r)}`;
    }
    const value = await truth<string>(s, lane, `document.querySelector("#name").value`);
    return { passed: r.ok && value === "Argus", falseSuccess: r.ok && value !== "Argus", said: note, truth: `name = ${JSON.stringify(value)}` };
  },

  // After Hide, say which of seven buttons can no longer be clicked, and why.
  async visibility(a, s) {
    const lane = await a.open("visibility");
    await a.act(lane, [{ click: "button:Hide" }]);
    const names = ["Removed", "Zero Width", "Overlapped", "Opacity 0", "Visibility Hidden", "Display None", "Offscreen"];
    const reasons: string[] = [];
    let wrongOk = 0;
    for (const name of names) {
      const r = await a.act(lane, [{ click: `button:${name}` }]);
      const step = r.steps[0]!;
      reasons.push(step.ok ? "ok" : step.diagnosis!.reason);
      if (step.ok) wrongOk++;
    }
    const hidden = await truth<number>(s, lane, `["removedButton","zeroWidthButton","overlappedButton","transparentButton","invisibleButton","notdisplayedButton","offscreenButton"].length`);
    return {
      passed: wrongOk === 0,
      falseSuccess: wrongOk > 0,
      said: names.map((n, i) => `${n}: ${reasons[i]}`).join(", "),
      truth: `all ${hidden} unusable after Hide`,
    };
  },

  // A button that ignores synthetic DOM clicks; only a real one turns it green.
  async click(a, s) {
    const lane = await a.open("click");
    const r = await a.act(lane, [{ click: "button:Button That Ignores DOM Click Event" }]);
    const green = await truth<boolean>(s, lane, `document.querySelector("#badButton").classList.contains("btn-success")`);
    return { passed: r.ok && green, falseSuccess: r.ok && !green, said: said(r), truth: green ? "turned green" : "did not react" };
  },

  // Type a name and press the button; its label must become the typed text.
  async textinput(a, s) {
    const lane = await a.open("textinput");
    const r = await a.act(lane, [
      { type: ["textbox:Set New Button Name", "Argus"] },
      { click: { role: "button", name: "Button That Should Change it's Name Based on Input Value" }, expect: { appears: { role: "button", name: "Argus" } } },
    ]);
    const text = await truth<string>(s, lane, `document.querySelector("#updatingButton").textContent`);
    return { passed: r.ok && text === "Argus", falseSuccess: r.ok && text !== "Argus", said: said(r), truth: `button reads ${JSON.stringify(text)}` };
  },

  // A label appears about 15 s after the click; wait for it, then click it.
  async clientdelay(a, s) {
    const lane = await a.open("clientdelay");
    await truth(s, lane, `window.__labelClicks = 0; document.addEventListener("click", (e) => { if (e.target.classList && e.target.classList.contains("bg-success")) window.__labelClicks++ }, true); true`);
    const r = await a.act(lane, [
      { click: "button:Button Triggering Client Side Logic" },
      { wait: { appears: "Data calculated on the client side.", within: "25s" } },
      { click: { text: "Data calculated on the client side." } },
    ]);
    const clicks = await truth<number>(s, lane, `window.__labelClicks`);
    return { passed: r.ok && clicks === 1, falseSuccess: r.ok && clicks !== 1, said: r.steps.map((_, i) => said(r, i)).join(" → "), truth: `label clicked ${clicks}×` };
  },

  // A button whose name contains a non-breaking space.
  async nbsp(a, s) {
    const lane = await a.open("nbsp");
    await truth(s, lane, `window.__clicks = 0; document.addEventListener("click", (e) => { if (e.target.tagName === "BUTTON") window.__clicks++ }, true); true`);
    const r = await a.act(lane, [{ click: "button:My Button" }]);
    const clicks = await truth<number>(s, lane, `window.__clicks`);
    return { passed: r.ok && clicks === 1, falseSuccess: r.ok && clicks !== 1, said: said(r), truth: `button clicked ${clicks}×` };
  },

  // A button hidden inside a scrolled container.
  async scrollbars(a, s) {
    const lane = await a.open("scrollbars");
    await truth(s, lane, `window.__clicks = 0; document.querySelector("#hidingButton").addEventListener("click", () => window.__clicks++); true`);
    const r = await a.act(lane, [{ click: "button:Hiding Button" }]);
    const clicks = await truth<number>(s, lane, `window.__clicks`);
    return { passed: r.ok && clicks === 1, falseSuccess: r.ok && clicks !== 1, said: said(r), truth: `button clicked ${clicks}×` };
  },

  // Generate a GUID with a button inside a shadow root.
  async shadowdom(a, s) {
    const lane = await a.open("shadowdom");
    const { outline } = await a.outline(lane);
    const generate = refOf(outline, /button#buttonGenerate\S* (e[\d.]+)/)!;
    const r = await a.act(lane, [{ click: generate }]);
    const reported = r.steps[0]!.observation.fields?.[0]?.to ?? "";
    const value = await truth<string>(s, lane, `document.querySelector("guid-generator").shadowRoot.querySelector("#editField").value`);
    const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
    return {
      passed: r.ok && guid && reported === value,
      falseSuccess: r.ok && !guid,
      said: `${said(r)}, field reported ${reported ? JSON.stringify(reported) : "nothing"}`,
      truth: guid ? `GUID ${value}` : `field ${JSON.stringify(value)}`,
    };
  },

  // Click a button inside the inner of two nested frames.
  async frames(a, s) {
    const lane = await a.open("frames");
    const r = await a.act(lane, [{ click: { role: "button", name: "Edit", nth: 2 }, expect: { appears: "Button pressed: Edit" } }]);
    const inner = await truth<string>(s, lane, `(() => { const outer = document.querySelector("iframe").contentDocument; const inner = outer.querySelector("iframe").contentDocument; return inner.querySelector("#result").textContent; })()`);
    const outer = await truth<string>(s, lane, `document.querySelector("iframe").contentDocument.querySelector("#result").textContent`);
    return {
      passed: r.ok && inner === "Button pressed: Edit" && outer === "",
      falseSuccess: r.ok && inner !== "Button pressed: Edit",
      said: `${said(r)} on ${r.steps[0]!.target?.ref ?? "?"}`,
      truth: `inner ${JSON.stringify(inner)}, outer ${JSON.stringify(outer)}`,
    };
  },
};

const chosen = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(challenges);
const service = new Service({ traceDir: `${tmpdir()}/argus-bench-trace` });
const runs: Run[] = [];
try {
  for (const name of chosen) {
    const agent = new Agent(service);
    const t0 = performance.now();
    let outcome: Outcome;
    try {
      outcome = await challenges[name]!(agent, service);
    } catch (error) {
      outcome = { passed: false, falseSuccess: false, said: `harness error: ${error instanceof Error ? error.message : error}`, truth: "-" };
    }
    runs.push({ challenge: name, outcome, calls: agent.calls, tokens: Math.ceil(agent.chars / 4), ms: Math.round(performance.now() - t0) });
    for (const { lane } of (await service.call("lane.list", {}) as { lanes: Array<{ lane: string }> }).lanes) await service.call("lane.close", { lane });
    const r = runs.at(-1)!;
    console.error(`${r.outcome.passed ? "pass" : "FAIL"}  ${name.padEnd(13)} ${String(r.calls).padStart(2)} calls  ~${String(r.tokens).padStart(5)} tokens  ${String(r.ms).padStart(6)} ms  ${r.outcome.falseSuccess ? "FALSE SUCCESS  " : ""}${r.outcome.said} | truth: ${r.outcome.truth}`);
  }
} finally {
  await service.shutdown();
}

const passed = runs.filter((r) => r.outcome.passed).length;
const false_ = runs.filter((r) => r.outcome.falseSuccess).length;
console.log(`\n| Challenge | Result | Argus reported | Ground truth | Calls | Tokens (~) |`);
console.log(`|---|---|---|---|---:|---:|`);
for (const r of runs)
  console.log(`| ${r.challenge} | ${r.outcome.passed ? "pass" : "**fail**"}${r.outcome.falseSuccess ? " · **false success**" : ""} | ${r.outcome.said} | ${r.outcome.truth} | ${r.calls} | ${r.tokens.toLocaleString()} |`);
console.log(`\n**${passed}/${runs.length} passed, ${false_} false successes**, ${runs.reduce((n, r) => n + r.calls, 0)} calls, ~${runs.reduce((n, r) => n + r.tokens, 0).toLocaleString()} tokens.`);
process.exit(passed === runs.length && false_ === 0 ? 0 : 1);
