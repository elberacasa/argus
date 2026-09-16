// Protocol results as compact text: what an agent or a person reads.
//
// JSON is the protocol; text is the interface. The same act result is about a
// third of the tokens as text, and reads top to bottom as what happened: the
// step, whether it held, what changed, and when it failed, why and what to do.

import type { ActResult, Diagnosis, Element, Observation, StepResult } from "../protocol/types";

const q = (s: string) => `"${s.length > 140 ? `${s.slice(0, 137)}...` : s}"`;
const who = (e: Element) => `${e.role}:${e.name || e.selector || ""} ${e.ref}`.trim();

export function renderTarget(step: StepResult): string {
  return step.target ? ` ${who(step.target)}${step.match && step.match !== "exact" && step.match !== "ref" ? ` (${step.match} match)` : ""}` : "";
}

export function renderObservation(o: Observation, indent = "  "): string[] {
  const out: string[] = [];
  if (o.url) out.push(`${indent}→ ${o.url.to}`);
  if (o.title) out.push(`${indent}title ${q(o.title.to)}`);
  for (const t of o.added ?? []) out.push(`${indent}+ ${q(t)}`);
  if (o.addedMore) out.push(`${indent}+ … ${o.addedMore} more`);
  for (const t of o.removed ?? []) out.push(`${indent}− ${q(t)}`);
  if (o.removedMore) out.push(`${indent}− … ${o.removedMore} more`);
  for (const f of o.fields ?? []) out.push(`${indent}= ${f.target}: ${f.from !== undefined ? `${q(f.from)} → ` : ""}${q(f.to)}`);
  for (const d of o.dialogs ?? []) out.push(`${indent}◇ ${d.type} ${q(d.message)} (${d.answered})`);
  for (const c of o.console ?? []) out.push(`${indent}! console ${c.level}: ${c.text}`);
  for (const e of o.exceptions ?? []) out.push(`${indent}! exception: ${e.message}`);
  for (const r of o.network ?? []) out.push(`${indent}~ ${r.method ?? "GET"} ${r.url} ${r.error ?? r.status ?? ""}${r.ms !== undefined ? ` ${r.ms}ms` : ""}`);
  if (o.effect === "none") out.push(`${indent}(nothing changed on the page)`);
  return out;
}

export function renderDiagnosis(d: Diagnosis, indent = "  "): string[] {
  const out = [`${indent}${d.hint}`];
  if (d.blocker) out.push(`${indent}blocker: ${who(d.blocker)}`);
  if (d.candidates?.length) out.push(`${indent}candidates: ${d.candidates.map(who).join(" · ")}`);
  if (d.didYouMean?.length) out.push(`${indent}did you mean: ${d.didYouMean.map(who).join(" · ")}`);
  for (const f of d.failed ?? []) out.push(`${indent}expected ${f.condition}; actual: ${f.actual === null ? "absent" : JSON.stringify(f.actual)}`);
  if (d.detail) out.push(`${indent}detail: ${d.detail}`);
  return out;
}

export function renderStep(step: StepResult): string {
  const mark = step.ok ? "✓" : "✗";
  const head = `${mark} ${step.verb}${renderTarget(step)}${step.ok ? "" : ` · ${step.diagnosis?.reason}`}  ${step.observation.ms ?? 0}ms`;
  return [head, ...(step.ok ? [] : renderDiagnosis(step.diagnosis!)), ...renderObservation(step.observation)].join("\n");
}

export function renderAct(r: ActResult, planned?: number): string {
  const lines = r.steps.map(renderStep);
  if (planned !== undefined && r.steps.length < planned) lines.push(`(stopped: ${planned - r.steps.length} step(s) not run)`);
  return lines.join("\n");
}

export function renderRun(r: { name: string; verdict: string; failedAt?: number; steps: StepResult[]; ms: number; trace: string }): string {
  return [`${r.verdict === "pass" ? "PASS" : "FAIL"} ${r.name}  ${r.ms}ms  trace ${r.trace}`, ...r.steps.map((s) => renderStep(s).replace(/^/gm, "  "))].join("\n");
}

export function renderSweep(r: { name: string; verdict: string; ms: number; results: Array<{ condition: { viewport?: { w: number; h: number }; colorScheme?: string }; verdict: string; failedAt?: number; diagnosis?: Diagnosis }> }): string {
  const lines = [`${r.verdict === "pass" ? "PASS" : "FAIL"} ${r.name}  ${r.results.length} conditions  ${r.ms}ms`];
  for (const c of r.results) {
    const where = [c.condition.viewport ? `${c.condition.viewport.w}x${c.condition.viewport.h}` : "", c.condition.colorScheme ?? ""].filter(Boolean).join(" ");
    lines.push(`  ${c.verdict === "pass" ? "✓" : "✗"} ${where}${c.failedAt !== undefined ? `  step ${c.failedAt}` : ""}${c.diagnosis ? `: ${c.diagnosis.reason}, ${c.diagnosis.hint}` : ""}`);
  }
  return lines.join("\n");
}

export function renderCheck(r: { score: number; scanned: number; findings: Array<{ rule: string; severity: string; hint: string; count: number; examples: Array<{ ref?: string; text?: string; detail?: unknown }> }> }): string {
  const lines = [`score ${r.score}/100 · ${r.findings.length} finding(s) · ${r.scanned} elements`];
  for (const f of r.findings) {
    lines.push(`${f.severity === "error" ? "✗" : "!"} ${f.rule} ×${f.count}  ${f.hint}`);
    for (const e of f.examples.slice(0, 3)) {
      const detail = e.detail && typeof e.detail === "object"
        ? Object.entries(e.detail as Record<string, unknown>).filter(([, v]) => v !== undefined).map(([k, v]) => `${k} ${v}`).join(", ")
        : "";
      lines.push(`    ${[e.ref, e.text ? q(e.text) : "", detail].filter(Boolean).join("  ")}`);
    }
  }
  return lines.join("\n");
}

export function renderFind(r: { matches: Element[]; match: string; near?: Element[]; hint?: string }): string {
  if (!r.matches.length) return [r.hint ?? "no match", ...(r.near?.length ? [`did you mean: ${r.near.map(who).join(" · ")}`] : [])].join("\n");
  return r.matches.map((e) => `${who(e)}${e.bounds ? ` @${e.bounds.x},${e.bounds.y} ${e.bounds.w}x${e.bounds.h}` : ""}${e.state?.length ? ` [${e.state.join(", ")}]` : ""}`).join("\n");
}
