// The outline: a page in a couple of hundred tokens.
//
// Landmarks and headings give the shape, fields and actions give what can be
// done, and every line carries a ref so the agent can act without reading
// more. What does not fit the budget is counted, never silently dropped.
// Actions are hit-tested, so a covered button says so in the outline itself.

import type { Page } from "../cdp/pipe";
import { hitTest, type Scene, type SceneElement } from "./snapshot";

const LANDMARKS = new Set(["main", "navigation", "banner", "contentinfo", "complementary", "form", "dialog", "alertdialog", "search", "region"]);
const FIELDS = new Set(["textbox", "searchbox", "combobox", "checkbox", "radio", "slider", "file", "spinbutton", "switch"]);
const ACTIONS = new Set(["button", "link", "menuitem", "tab", "option"]);

export async function outline(page: Page, scene: Scene, budget = 250): Promise<{ outline: string; tokens: number }> {
  const visible = scene.elements.filter((e) => e.visible);
  const inView = (e: SceneElement) => !!e.bounds && e.bounds.y < scene.viewport.h && e.bounds.y + e.bounds.h > 0;

  const coveredBy = new Map<number, SceneElement | null>();
  const clipped = new Set<number>();
  const actions = visible.filter((e) => ACTIONS.has(e.role) || FIELDS.has(e.role));
  // Hit-test what is on screen, up to a limit: about a millisecond each.
  for (const e of actions.filter(inView).slice(0, 24)) {
    const b = e.bounds!;
    const x = Math.round(Math.max(0, b.x) + Math.min(b.w, scene.viewport.w - Math.max(0, b.x)) / 2);
    const y = Math.round(Math.max(0, b.y) + Math.min(b.h, scene.viewport.h - Math.max(0, b.y)) / 2);
    {
      const backendNodeId = await hitTest(page, scene, x, y);
      if (backendNodeId === null) continue;
      if (backendNodeId === e.backendNodeId || scene.ancestors(backendNodeId).includes(e.backendNodeId)) continue;
      // An ancestor painting at the element's centre means it is clipped by a
      // scroll container, not covered by something else.
      if (scene.ancestors(e.backendNodeId).includes(backendNodeId)) clipped.add(e.backendNodeId);
      else coveredBy.set(e.backendNodeId, scene.describe(backendNodeId));
    }
  }

  const tag = (e: SceneElement) => {
    const notes: string[] = [];
    if (e.state.includes("disabled")) notes.push("disabled");
    if (e.state.includes("checked")) notes.push("checked");
    if (e.state.includes("required")) notes.push("required");
    if (!inView(e)) notes.push("below");
    if (clipped.has(e.backendNodeId)) notes.push("scrolled out of its container");
    const blocker = coveredBy.get(e.backendNodeId);
    if (coveredBy.has(e.backendNodeId)) notes.push(`covered by ${blocker ? blocker.ref + " " + (blocker.name || blocker.selector) : "another element"}`);
    return notes.length ? ` [${notes.join(", ")}]` : "";
  };
  const line = (e: SceneElement, indent = "  ") => `${indent}${e.role}:${e.name || e.selector} ${e.ref}${tag(e)}`;

  const lines: string[] = [];
  lines.push(`${scene.title || scene.url} (${scene.viewport.w}x${scene.viewport.h}${scene.documents > 1 ? `, ${scene.documents} documents` : ""})`);
  const sections: Array<[string, SceneElement[]]> = [
    ["landmarks", visible.filter((e) => LANDMARKS.has(e.role))],
    ["headings", visible.filter((e) => e.role === "heading")],
    ["fields", visible.filter((e) => FIELDS.has(e.role))],
    ["actions", visible.filter((e) => ACTIONS.has(e.role))
      // Blocked and in-view actions first: they are what the agent needs next.
      .sort((a, b) => Number(coveredBy.has(b.backendNodeId)) - Number(coveredBy.has(a.backendNodeId)) || Number(inView(b)) - Number(inView(a)))],
  ];

  const tokensOf = (s: string) => Math.ceil(s.length / 4);
  let used = tokensOf(lines[0]!);
  for (const [name, items] of sections) {
    if (!items.length) continue;
    const header = `${name}:`;
    if (used + tokensOf(header) > budget) { lines.push(`… ${items.length} ${name} (scene.find)`); continue; }
    lines.push(header);
    used += tokensOf(header);
    let shown = 0;
    for (const e of items) {
      const l = name === "headings" ? `  ${e.name} ${e.ref}`
        : name === "landmarks" ? `  ${e.role}${e.name ? ` "${e.name}"` : ""} ${e.ref}`
        : line(e);
      if (used + tokensOf(l) > budget - 8) break;
      lines.push(l);
      used += tokensOf(l);
      shown++;
    }
    if (shown < items.length) {
      const more = `  … ${items.length - shown} more ${name} (scene.find)`;
      lines.push(more);
      used += tokensOf(more);
    }
  }
  const text = lines.join("\n");
  return { outline: text, tokens: tokensOf(text) };
}
