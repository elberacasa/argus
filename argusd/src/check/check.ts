// check: what is wrong with this page, with standard rule ids.
//
// The prototype ran these rules as JavaScript inside the page, which could not
// see into frames or shadow roots. Here they run on the browser's own snapshot:
// computed style, layout and text for every document at once, so a control in
// a shadow root is reviewed like any other. Runtime findings come from what
// the lane's probe heard since it opened: console errors, uncaught exceptions,
// failed requests.
//
// Thresholds are the prototype's, which were chosen from WCAG 2.2: contrast
// 4.5:1 (3:1 for large text), targets 24x24 CSS px, text at least 12px.

import type { Protocol } from "devtools-protocol";
import type { Page } from "../cdp/pipe";
import type { Probe, Mark } from "../lane/probe";
import type { Scene } from "../scene/snapshot";

export type Category = "a11y" | "layout" | "runtime" | "perf";

export interface Finding {
  rule: string;
  category: Category;
  severity: "error" | "warn";
  hint: string;
  count: number;
  examples: Array<{ ref?: string; text?: string; detail?: unknown }>;
}

export interface CheckResult { score: number; findings: Finding[]; scanned: number; tokensEst: number }

/** Categories this implementation checks. In v0.1 `perf` has slow-request only; layout-shift and long-task need page observers. */
export const CATEGORIES: Category[] = ["a11y", "layout", "runtime", "perf"];

const STYLES = [
  "display", "visibility", "opacity", "color", "background-color", "font-size", "font-weight", "overflow-x", "position",
] as const;
const S = Object.fromEntries(STYLES.map((s, i) => [s, i])) as Record<(typeof STYLES)[number], number>;
const LIMIT = 8;
const INTERACTIVE_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"]);

interface RGBA { r: number; g: number; b: number; a: number }

function parseColor(c: string): RGBA | null {
  const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(c);
  return m ? { r: +m[1]!, g: +m[2]!, b: +m[3]!, a: m[4] === undefined ? 1 : +m[4] } : null;
}
const over = (fg: RGBA, bg: RGBA): RGBA => ({
  r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1,
});
const luminance = ({ r, g, b }: RGBA) => {
  const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrastOf = (a: RGBA, b: RGBA) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

export async function check(
  page: Page, probe: Probe, openMark: Mark, scene: Scene,
  options: { only?: Category[]; within?: number } = {},
): Promise<CheckResult> {
  const only = new Set(options.only ?? CATEGORIES);
  const findings: Finding[] = [];
  const add = (rule: string, category: Category, severity: Finding["severity"], hint: string, examples: Finding["examples"]) => {
    if (only.has(category) && examples.length) findings.push({ rule, category, severity, hint, count: examples.length, examples: examples.slice(0, LIMIT) });
  };

  const [snap, metrics] = await Promise.all([
    page.send("DOMSnapshot.captureSnapshot", { computedStyles: [...STYLES], includeDOMRects: true }),
    page.send("Page.getLayoutMetrics"),
  ]);
  // The device width, not the layout viewport: on a phone, content wider than
  // the screen makes the browser zoom out and the layout viewport grows to
  // match, so measuring against it compares the page with its own mistake
  // (measured: overflow.html at 390px reported no overflow). The document
  // element's clientWidth stays the device width.
  const widths = await page.send("Runtime.evaluate", {
    expression: "[document.documentElement.clientWidth, document.documentElement.scrollWidth]", returnByValue: true,
  }).then((r) => r.result.value as [number, number], () => null);
  const vw = widths?.[0] || Math.round(metrics.cssLayoutViewport.clientWidth);
  const contentWidth = Math.max(widths?.[1] ?? 0, Math.round(metrics.cssContentSize.width));
  const inScope = (backendNodeId: number) => options.within === undefined || scene.ancestors(backendNodeId).includes(options.within);
  const refOf = (d: number, backendNodeId: number) => `e${d}.${backendNodeId}`;

  let scanned = 0;
  const contrast: Finding["examples"] = [], tap: Finding["examples"] = [], unnamed: Finding["examples"] = [];
  const imgAlt: Finding["examples"] = [], tiny: Finding["examples"] = [], dupes: Finding["examples"] = [];
  const headings: Array<{ level: number; ref: string; text: string; y: number }> = [];
  const spilling: Array<{ ref: string; text: string; overflowPx: number; width: number }> = [];

  snap.documents.forEach((doc: Protocol.DOMSnapshot.DocumentSnapshot, d) => {
    const str = (i: number | undefined) => (i === undefined || i < 0 ? "" : snap.strings[i] ?? "");
    const nodes = doc.nodes;
    const parent = nodes.parentIndex ?? [];
    const names = nodes.nodeName ?? [];
    const types = nodes.nodeType ?? [];
    const values = nodes.nodeValue ?? [];
    const backend = nodes.backendNodeId ?? [];
    const layoutIdx = new Map(doc.layout.nodeIndex.map((n, i) => [n, i]));
    const style = (n: number, s: keyof typeof S) => {
      const i = layoutIdx.get(n);
      return i === undefined ? "" : str(doc.layout.styles[i]?.[S[s]]);
    };
    const box = (n: number) => {
      const i = layoutIdx.get(n);
      const b = i === undefined ? undefined : doc.layout.bounds[i];
      return b && b.length >= 4 ? { x: b[0]!, y: b[1]!, w: b[2]!, h: b[3]! } : null;
    };
    const attrs = (n: number) => {
      const flat = nodes.attributes?.[n] ?? [];
      const m = new Map<string, string>();
      for (let i = 0; i + 1 < flat.length; i += 2) m.set(str(flat[i]).toLowerCase(), str(flat[i + 1]));
      return m;
    };
    const children = new Map<number, number[]>();
    parent.forEach((p, n) => { if (p >= 0) { let l = children.get(p); if (!l) children.set(p, (l = [])); l.push(n); } });
    const textOf = (n: number, depth = 0): string =>
      depth > 12 ? "" : types[n] === 3 ? str(values[n]) : (children.get(n) ?? []).map((c) => textOf(c, depth + 1)).join(" ");
    const clean = (s: string) => s.replace(/\s+/g, " ").trim();
    const shown = (n: number) => {
      const b = box(n);
      return !!b && b.w > 0 && b.h > 0 && style(n, "visibility") !== "hidden" && style(n, "display") !== "none" && style(n, "opacity") !== "0";
    };
    const where = (n: number) => {
      const a = attrs(n);
      const cls = (a.get("class") ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
      return str(names[n]).toLowerCase() + (a.get("id") ? `#${a.get("id")}` : "") + cls.map((c) => `.${c}`).join("");
    };
    const backdrop = (n: number): RGBA => {
      let acc: RGBA | null = null;
      for (let p = n; p >= 0; p = parent[p] ?? -1) {
        const c = parseColor(style(p, "background-color"));
        if (c && c.a > 0) {
          acc = acc ? over(acc, c) : c;
          if (acc.a >= 0.99) return acc;
        }
      }
      const white = { r: 255, g: 255, b: 255, a: 1 };
      return acc ? over(acc, white) : white;
    };
    const labelledFor = new Set<string>();
    names.forEach((nm, n) => { if (str(nm) === "LABEL") { const f = attrs(n).get("for"); if (f) labelledFor.add(f); } });
    const insideLabel = (n: number) => { for (let p = parent[n] ?? -1, i = 0; p >= 0 && i < 6; p = parent[p] ?? -1, i++) if (str(names[p]) === "LABEL") return true; return false; };
    const ids = new Map<string, number>();

    names.forEach((nameIdx, n) => {
      if (types[n] !== 1) return;
      const id = backend[n] ?? -1;
      if (!inScope(id)) return;
      scanned++;
      const tag = str(nameIdx);
      const a = attrs(n);

      const idAttr = a.get("id");
      if (idAttr) {
        if (ids.has(idAttr) && !dupes.some((x) => (x.detail as { id: string }).id === idAttr)) dupes.push({ ref: refOf(d, id), detail: { id: idAttr } });
        else ids.set(idAttr, n);
      }
      if (!shown(n)) return;
      const b = box(n)!;

      // contrast: elements that paint their own text
      const ownText = (children.get(n) ?? []).some((c) => types[c] === 3 && clean(str(values[c])).length > 1);
      // WCAG 1.4.3 exempts inactive controls: a disabled button is meant to look faded.
      let inactive = false;
      for (let p = n, i = 0; p >= 0 && i < 8; p = parent[p] ?? -1, i++) {
        const pa = attrs(p);
        if (pa.has("disabled") || pa.get("aria-disabled") === "true") { inactive = true; break; }
      }
      if (ownText && !inactive && contrast.length < LIMIT * 3) {
        const fg = parseColor(style(n, "color"));
        if (fg && fg.a > 0) {
          const bg = backdrop(n);
          const ratio = contrastOf(fg.a < 1 ? over(fg, bg) : fg, bg);
          const size = parseFloat(style(n, "font-size")), bold = +style(n, "font-weight") >= 700;
          const required = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
          if (ratio < required) contrast.push({ ref: refOf(d, id), text: clean(textOf(n)).slice(0, 40), detail: { selector: where(n), contrast: +ratio.toFixed(2), required, fontSize: Math.round(size) } });
        }
      }
      if (ownText && tiny.length < LIMIT) {
        const size = parseFloat(style(n, "font-size"));
        if (size > 0 && size < 12) tiny.push({ ref: refOf(d, id), text: clean(textOf(n)).slice(0, 40), detail: { selector: where(n), fontSize: +size.toFixed(1) } });
      }

      const role = a.get("role");
      const interactive = (INTERACTIVE_TAGS.has(tag) && !(tag === "A" && !a.has("href")) && a.get("type") !== "hidden")
        || role === "button" || role === "link" || (a.has("tabindex") && a.get("tabindex") !== "-1");
      if (interactive) {
        const inlineLink = tag === "A" && style(n, "display").startsWith("inline");
        if (!inlineLink && (b.w < 24 || b.h < 24)) tap.push({ ref: refOf(d, id), text: clean(textOf(n)).slice(0, 40), detail: { selector: where(n), size: `${Math.round(b.w)}x${Math.round(b.h)}` } });
        const named = clean(textOf(n)) || a.get("aria-label") || a.get("aria-labelledby") || a.get("title") || a.get("alt")
          || (idAttr && labelledFor.has(idAttr)) || insideLabel(n) || (tag === "INPUT" && ["submit", "button", "reset"].includes(a.get("type") ?? "") && a.get("value"));
        if (!named) unnamed.push({ ref: refOf(d, id), detail: { selector: where(n), size: `${Math.round(b.w)}x${Math.round(b.h)}` } });
      }
      if (tag === "IMG" && !a.has("alt")) imgAlt.push({ ref: refOf(d, id), detail: { selector: where(n), src: (a.get("src") ?? "").split("/").pop()?.slice(0, 50) } });
      if (/^H[1-6]$/.test(tag)) headings.push({ level: Number(tag[1]), ref: refOf(d, id), text: clean(textOf(n)).slice(0, 40), y: b.y });

      // overflow-x: only the top document scrolls the page; content inside a
      // scroll or clip container is allowed to be wide.
      if (d === 0 && contentWidth > vw + 1 && b.x + b.w > vw + 1 && style(n, "position") !== "fixed") {
        let escapes = true;
        for (let p = parent[n] ?? -1; p >= 0; p = parent[p] ?? -1) {
          const t = str(names[p]);
          if (t === "BODY" || t === "HTML") break;
          if (style(p, "overflow-x") && style(p, "overflow-x") !== "visible") { escapes = false; break; }
        }
        if (escapes) spilling.push({ ref: refOf(d, id), text: where(n), overflowPx: Math.round(b.x + b.w - vw), width: Math.round(b.w) });
      }
    });
  });

  add("contrast", "a11y", "error", "Text fails WCAG AA contrast. Darken the text or lighten the background.", contrast);
  add("tap-target", "a11y", "warn", "Interactive target below 24x24 CSS px. Add padding or min-height.", tap);
  add("unnamed-control", "a11y", "error", "Control has no accessible name; a screen reader announces it as blank.", unnamed);
  add("img-alt", "a11y", "warn", 'Image has no alt attribute. Use alt="" if it is decorative.', imgAlt);
  const skips: Finding["examples"] = [];
  let prev = 0;
  for (const h of headings) {
    if (prev && h.level > prev + 1) skips.push({ ref: h.ref, text: h.text, detail: { jumped: `h${prev} to h${h.level}` } });
    prev = h.level;
  }
  add("heading-order", "a11y", "warn", "Heading level skipped. Outline order guides screen reader navigation.", skips);
  add("duplicate-id", "a11y", "error", "Duplicate id breaks label association and getElementById.", dupes);
  // Narrowest offenders first: the outer wrapper is always too wide as well,
  // but the small element inside it is the one to fix.
  spilling.sort((a, b) => a.width - b.width);
  add("overflow-x", "layout", "error", `Page scrolls sideways at ${vw}px wide. Add max-width:100% or let the row wrap.`,
    spilling.slice(0, LIMIT).map((s) => ({ ref: s.ref, text: s.text, detail: { overflowPx: s.overflowPx, width: s.width } })));
  add("tiny-text", "layout", "warn", "Text under 12px is hard to read on any screen.", tiny);

  const heard = probe.since(openMark, 50);
  add("console-error", "runtime", "error", "The page logged errors.", (heard.console ?? []).filter((c) => c.level === "error").map((c) => ({ text: c.text.slice(0, 160), ...(c.source ? { detail: { source: c.source } } : {}) })));
  add("exception", "runtime", "error", "Uncaught exceptions were thrown.", (heard.exceptions ?? []).map((e) => ({ text: e.message.slice(0, 160) })));
  add("failed-request", "runtime", "error", "Requests failed.", (heard.network ?? []).filter((r) => r.error || (r.status ?? 0) >= 400 || r.status === 0).map((r) => ({ text: `${r.method ?? "GET"} ${r.url}`.slice(0, 160), detail: { status: r.status, error: r.error } })));
  add("slow-request", "perf", "warn", "Requests took longer than a second.", (heard.network ?? []).filter((r) => !r.error && (r.status ?? 0) < 400 && (r.ms ?? 0) > 1000).map((r) => ({ text: r.url.slice(0, 160), detail: { ms: r.ms } })));

  const score = Math.max(0, findings.reduce((s, f) => s - (f.severity === "error" ? 12 : 4), 100));
  const result: CheckResult = { score, findings, scanned, tokensEst: 0 };
  result.tokensEst = Math.ceil(JSON.stringify(result).length / 4);
  return result;
}
