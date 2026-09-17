// Turning what an agent names into one element, or saying precisely why not.
//
// Names match exact, then case-insensitive, then substring, and the level is
// reported. Several matches at the best level are ambiguous -- never a guess --
// unless `nth` or `near` chooses. Nothing found returns the closest names that
// do exist, because "not found" alone sends an agent back to re-read the page.

import type { Diagnosis, Element, Target, TargetObject } from "../protocol/types";
import type { Scene, SceneElement } from "../scene/snapshot";

export type Match = "exact" | "ci" | "substring" | "ref";

export type Located =
  | { ok: true; element: SceneElement; match: Match }
  | { ok: false; diagnosis: Diagnosis };

const REF = /^e\d+\.(\d+)$/;

/** What an agent sees of an element: no internal fields. */
export function publicElement(e: SceneElement, extra: Partial<Element> = {}): Element {
  return {
    ref: e.ref,
    role: e.role,
    name: e.name,
    bounds: e.bounds,
    ...(e.frames.length > 1 ? { frames: e.frames } : {}),
    ...(e.shadow ? { shadow: e.shadow } : {}),
    ...(e.state.length ? { state: e.state } : {}),
    selector: e.selector,
    ...extra,
  };
}

export function label(e: { role: string; name: string; selector?: string }): string {
  return e.name ? `${e.role} "${e.name}"` : `${e.role} ${e.selector ?? ""}`.trim();
}

export function describeTarget(target: Target): string {
  if (typeof target === "string") return target;
  if (target.x !== undefined) return `point (${target.x}, ${target.y})${target.in !== undefined ? ` in ${describeTarget(target.in)}` : ""}`;
  if (target.text) return `text "${target.text}"`;
  return [target.role, target.name !== undefined ? `"${target.name}"` : ""].filter(Boolean).join(" ") || "element";
}

export function parseTarget(target: Target): TargetObject & { ref?: number } {
  if (typeof target !== "string") return target;
  const ref = REF.exec(target);
  if (ref) return { ref: Number(ref[1]) };
  const colon = target.indexOf(":");
  if (colon === -1) return { role: target };
  return { role: target.slice(0, colon), name: target.slice(colon + 1) };
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const lower = (s: string) => norm(s).toLowerCase();

const center = (e: { bounds: { x: number; y: number; w: number; h: number } | null }) =>
  e.bounds ? { x: e.bounds.x + e.bounds.w / 2, y: e.bounds.y + e.bounds.h / 2 } : null;

/** ARIA roles and the implicit ones argus assigns; a bare word that is not one of these is text. */
const ROLES = new Set(["alert", "alertdialog", "application", "article", "banner", "button", "cell", "checkbox", "columnheader", "combobox", "complementary", "contentinfo", "definition", "dialog", "directory", "document", "feed", "figure", "file", "form", "generic", "grid", "gridcell", "group", "heading", "image", "img", "label", "link", "list", "listbox", "listitem", "log", "main", "marquee", "math", "menu", "menubar", "menuitem", "menuitemcheckbox", "menuitemradio", "meter", "navigation", "none", "note", "option", "presentation", "progressbar", "radio", "radiogroup", "region", "row", "rowgroup", "rowheader", "scrollbar", "search", "searchbox", "separator", "slider", "spinbutton", "status", "switch", "tab", "table", "tablist", "tabpanel", "term", "textbox", "timer", "toolbar", "tooltip", "tree", "treegrid", "treeitem"]);

export function locate(scene: Scene, target: Target): Located {
  let t = parseTarget(target);

  if (t.x !== undefined || t.y !== undefined)
    return { ok: false, diagnosis: { reason: "not-found", hint: "A point ({x, y}) is a place, not an element: only click, hover and drag take one.", didYouMean: [] } };

  // "Draft 3" is text, not a role nobody has: a bare word that is not a role
  // names what the page says.
  if (t.role !== undefined && t.name === undefined && !ROLES.has(t.role.toLowerCase()) && !scene.elements.some((e) => e.role.toLowerCase() === t.role!.toLowerCase()))   {
    const { role, ...rest } = t;
    t = { ...rest, text: role };
  }

  if (t.ref !== undefined) {
    const element = scene.elements.find((e) => e.backendNodeId === t.ref) ?? scene.describe(t.ref);
    if (element) return { ok: true, element, match: "ref" };
    return { ok: false, diagnosis: { reason: "detached", hint: `${target} is no longer in the page; find the element again.` } };
  }

  // Plain text: any visible block of text, owned by the element that holds it.
  if (t.text !== undefined) {
    const want = t.text;
    const levels: Array<[Match, (s: string) => boolean]> = [
      ["exact", (s) => norm(s) === norm(want)],
      ["ci", (s) => lower(s) === lower(want)],
      ["substring", (s) => lower(s).includes(lower(want))],
    ];
    for (const [match, test] of levels) {
      const hits = scene.texts.filter((b) => test(b.text));
      if (!hits.length) continue;
      const elements = hits
        .map((b) => scene.describe(b.backendNodeId))
        .filter((e): e is SceneElement => !!e);
      return choose(scene, elements, match, t, target);
    }
    return {
      ok: false,
      diagnosis: {
        reason: "not-found",
        hint: `No text "${want}" on the page.`,
        didYouMean: nearestTexts(scene, want),
      },
    };
  }

  const role = t.role?.toLowerCase();
  const pool = scene.elements.filter((e) => !role || e.role.toLowerCase() === role);
  if (t.name === undefined) {
    if (pool.length) return choose(scene, pool, "exact", t, target);
  } else {
    const want = t.name;
    const levels: Array<[Match, (s: string) => boolean]> = [
      ["exact", (s) => norm(s) === norm(want)],
      ["ci", (s) => lower(s) === lower(want)],
      ["substring", (s) => want !== "" && lower(s).includes(lower(want))],
    ];
    for (const [match, test] of levels) {
      const hits = pool.filter((e) => test(e.name));
      if (hits.length) return choose(scene, hits, match, t, target);
    }
    // What it shows, when its name is something else: "button:›" is the
    // button named "Next month" that reads ›.
    for (const [match, test] of levels) {
      const hits = pool.filter((e) => e.content !== undefined && test(e.content));
      if (hits.length) return choose(scene, hits, match, t, target);
    }
  }

  return {
    ok: false,
    diagnosis: {
      reason: "not-found",
      hint: `No ${describeTarget(target)} on the page.`,
      didYouMean: nearestElements(scene, t.role, t.name ?? ""),
    },
  };
}

function choose(scene: Scene, found: SceneElement[], match: Match, t: TargetObject, target: Target): Located {
  // A visible match beats a hidden one with the same name; a hidden-only
  // match is still returned, so the caller can diagnose it as hidden.
  const visible = found.filter((e) => e.visible);
  let pool = visible.length ? visible : found;

  if (t.near !== undefined) {
    const anchor = locate(scene, t.near);
    if (!anchor.ok) return anchor;
    // Nearest in the page's structure first -- the Delete button in Draft 3's
    // row shares a closer container with "Draft 3" than the next row's does --
    // then on screen.
    const a = center(anchor.element);
    const up = scene.ancestors(anchor.element.backendNodeId);
    const depth = new Map(up.map((id, i) => [id, up.length - i]));
    const shared = (e: SceneElement) => { for (const id of scene.ancestors(e.backendNodeId)) { const d = depth.get(id); if (d !== undefined) return d; } return 0; };
    pool = [...pool].sort((x, y) => shared(y) - shared(x) || (a ? dist(center(x), a) - dist(center(y), a) : 0));
    if (t.nth === undefined) return { ok: true, element: pool[0]!, match };
  }
  if (t.nth !== undefined) {
    const chosen = pool[t.nth - 1];
    if (chosen) return { ok: true, element: chosen, match };
    return {
      ok: false,
      diagnosis: { reason: "not-found", hint: `Only ${pool.length} ${describeTarget(target)}; nth ${t.nth} does not exist.`, didYouMean: pool.slice(0, 5).map((e) => publicElement(e)) },
    };
  }
  if (pool.length === 1) return { ok: true, element: pool[0]!, match };
  return {
    ok: false,
    diagnosis: {
      reason: "ambiguous",
      hint: `${pool.length} elements match ${describeTarget(target)}${match === "exact" ? "" : ` (${match} match)`}; pass one of their refs, nth, or near.`,
      candidates: pool.slice(0, 8).map((e) => publicElement(e)),
    },
  };
}

function dist(p: { x: number; y: number } | null, q: { x: number; y: number }): number {
  return p ? Math.hypot(p.x - q.x, p.y - q.y) : Number.POSITIVE_INFINITY;
}

/** Word-overlap and edit-distance similarity, 0..1. */
export function similarity(a: string, b: string): number {
  const x = lower(a), y = lower(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.8;
  const wx = new Set(x.split(" ")), wy = new Set(y.split(" "));
  const shared = [...wx].filter((w) => wy.has(w)).length;
  const words = shared / Math.max(wx.size, wy.size);
  const edit = 1 - levenshtein(x, y) / Math.max(x.length, y.length);
  return Math.max(words, edit);
}

function levenshtein(a: string, b: string): number {
  if (a.length > 64 || b.length > 64) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

function nearestElements(scene: Scene, role: string | undefined, name: string): Element[] {
  const scored = scene.elements
    .filter((e) => e.visible && (e.name || e.role === role))
    .map((e) => ({
      e,
      score: (role && e.role.toLowerCase() === role.toLowerCase() ? 0.35 : 0) + (name ? similarity(e.name, name) * 0.65 : 0.3),
    }))
    .filter((s) => s.score >= 0.4)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, 3).map((s) => publicElement(s.e));
}

function nearestTexts(scene: Scene, text: string): Element[] {
  return scene.texts
    .map((b) => ({ b, score: similarity(b.text.slice(0, 120), text) }))
    .filter((s) => s.score >= 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((s) => scene.describe(s.b.backendNodeId))
    .filter((e): e is SceneElement => !!e)
    .map((e) => publicElement(e));
}
