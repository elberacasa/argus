// The Scene: what an agent can see, built from the browser's own snapshot.
//
// The bash prototype located elements with JavaScript injected into the page.
// That cannot see inside shadow roots or frames, and failed exactly there on a
// neutral benchmark (UI Testing Playground: Shadow DOM, Frames). One call to
// DOMSnapshot.captureSnapshot returns every document -- main page and nested
// frames -- with shadow-root content included, layout for each node, and
// Chromium's own judgement of what is clickable. The Scene is built from that.
//
// Coordinates are viewport CSS pixels, what Input.dispatchMouseEvent takes.
// DOM.getNodeForLocation does not take viewport pixels: it takes document
// coordinates, so a hit test on a scrolled page must add the scroll offset
// (measured on Chromium 152: at scrollY 38, (10,125) named the row 38px above
// the one under the pointer). Always hit-test through hitTest().

import type { Protocol } from "devtools-protocol";
import type { CdpPage as Page } from "../cdp/page";

export interface Rect { x: number; y: number; w: number; h: number }

export type ElementState =
  | "disabled" | "checked" | "expanded" | "collapsed" | "selected" | "required" | "invalid" | "readonly";

export interface SceneElement {
  /** e<document>.<backendNodeId>: stable while the node lives. */
  ref: string;
  role: string;
  name: string;
  bounds: Rect | null;
  /** Index path of documents from the top, e.g. [0, 1, 2]. */
  frames: number[];
  /** "open" or "closed" when the element lives inside a shadow tree. */
  shadow: "open" | "closed" | null;
  state: ElementState[];
  clickable: boolean;
  visible: boolean;
  /** Why it is not visible, when it is not. */
  hiddenBy?: "display" | "visibility" | "opacity" | "zero-size";
  /** tag#id.class, for people reading a diagnosis. */
  selector: string;
  backendNodeId: number;
}

/** A form field's current value, as the browser holds it (not the value attribute). */
export interface FieldValue { backendNodeId: number; label: string; value: string }

/** A block of visible text: every text node under one element, joined. */
export interface TextBlock { text: string; backendNodeId: number; bounds: Rect | null }

export interface Scene {
  url: string;
  title: string;
  documents: number;
  viewport: { w: number; h: number };
  /** Page scroll at capture, in CSS pixels. */
  scroll: { x: number; y: number };
  elements: SceneElement[];
  texts: TextBlock[];
  fields: FieldValue[];
  /** Backend node ids from a node up to the top document, crossing frames and shadow roots. */
  ancestors(backendNodeId: number): number[];
  /** The element for a backend node: its own entry, or a described generic one. */
  describe(backendNodeId: number): SceneElement | null;
}

const STYLES = ["display", "visibility", "opacity"] as const;

const IMPLICIT_ROLE: Record<string, string> = {
  BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox", SUMMARY: "button", DIALOG: "dialog",
  LABEL: "label", IMG: "image", H1: "heading", H2: "heading", H3: "heading", H4: "heading",
  H5: "heading", H6: "heading", OPTION: "option", NAV: "navigation", MAIN: "main", FORM: "form",
  HEADER: "banner", FOOTER: "contentinfo", ASIDE: "complementary", IFRAME: "iframe",
};
const INPUT_ROLE: Record<string, string> = {
  checkbox: "checkbox", radio: "radio", submit: "button", button: "button",
  reset: "button", file: "file", range: "slider", search: "searchbox",
};
// Roles whose accessible name comes from their content (WAI-ARIA "name from
// content"). A landmark, dialog or div is named only by aria-label or a title:
// naming a <main> after all of its text would be noise, not a name.
const NAME_FROM_CONTENT = new Set([
  "button", "link", "heading", "option", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "treeitem",
  "cell", "gridcell", "columnheader", "rowheader", "checkbox", "radio", "switch", "tooltip", "label", "summary",
]);
const BLOCK_SKIP = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "HEAD", "TITLE"]);

export async function captureScene(page: Page): Promise<Scene> {
  const [snap, metrics] = await Promise.all([
    page.send("DOMSnapshot.captureSnapshot", { computedStyles: [...STYLES], includeDOMRects: true }),
    page.send("Page.getLayoutMetrics"),
  ]);
  const vv = metrics.cssVisualViewport;
  return buildScene(snap, { w: Math.round(vv.clientWidth), h: Math.round(vv.clientHeight) }, { x: vv.pageX, y: vv.pageY });
}

/** The node a real pointer at viewport (x, y) would hit, or null when nothing answers. */
export async function hitTest(page: Page, scene: Scene, x: number, y: number): Promise<number | null> {
  try {
    const { backendNodeId } = await page.send("DOM.getNodeForLocation", {
      x: Math.round(x + scene.scroll.x), y: Math.round(y + scene.scroll.y), includeUserAgentShadowDOM: false, ignorePointerEventsNone: true,
    });
    return backendNodeId;
  } catch {
    return null;
  }
}

export function buildScene(
  snap: Protocol.DOMSnapshot.CaptureSnapshotResponse,
  viewport: { w: number; h: number } = { w: 0, h: 0 },
  scroll: { x: number; y: number } = { x: 0, y: 0 },
): Scene {
  const { strings, documents } = snap;
  const str = (i: number | undefined) => (i === undefined || i < 0 ? "" : strings[i] ?? "");

  // Which iframe node leads into each document, to follow frame paths and
  // coordinate offsets from the top down.
  const parentOfDocument = new Map<number, { doc: number; node: number }>();
  documents.forEach((doc, d) => {
    const cdi = doc.nodes.contentDocumentIndex;
    cdi?.index.forEach((node, k) => {
      const child = cdi.value[k];
      if (child !== undefined) parentOfDocument.set(child, { doc: d, node });
    });
  });

  const rawBounds = new Map<number, Map<number, Rect>>();
  const boundsIn = (d: number): Map<number, Rect> => {
    let cached = rawBounds.get(d);
    if (cached) return cached;
    cached = new Map();
    const layout = documents[d]!.layout;
    layout.nodeIndex.forEach((node, i) => {
      const b = layout.bounds[i];
      if (b && b.length >= 4) cached!.set(node, { x: b[0]!, y: b[1]!, w: b[2]!, h: b[3]! });
    });
    rawBounds.set(d, cached);
    return cached;
  };

  // Layout bounds are in each document's own coordinates. The viewport origin
  // of a document is its iframe's viewport position minus its own scroll.
  const originCache = new Map<number, { x: number; y: number; path: number[] }>();
  const origin = (d: number): { x: number; y: number; path: number[] } => {
    const hit = originCache.get(d);
    if (hit) return hit;
    const doc = documents[d]!;
    const sx = doc.scrollOffsetX ?? 0, sy = doc.scrollOffsetY ?? 0;
    const parent = parentOfDocument.get(d);
    let result: { x: number; y: number; path: number[] };
    if (!parent) result = { x: -sx, y: -sy, path: [d] };
    else {
      const up = origin(parent.doc);
      const frame = boundsIn(parent.doc).get(parent.node);
      result = { x: up.x + (frame?.x ?? 0) - sx, y: up.y + (frame?.y ?? 0) - sy, path: [...up.path, d] };
    }
    originCache.set(d, result);
    return result;
  };

  const elements: SceneElement[] = [];
  const texts: TextBlock[] = [];
  const fields: FieldValue[] = [];
  const byBackend = new Map<number, { doc: number; node: number }>();
  const parentsOf: number[][] = [];
  const describers: Array<(node: number) => SceneElement> = [];

  documents.forEach((doc, d) => {
    const nodes = doc.nodes;
    const parent = nodes.parentIndex ?? [];
    parentsOf[d] = parent;
    const names = nodes.nodeName ?? [];
    const types = nodes.nodeType ?? [];
    const values = nodes.nodeValue ?? [];
    const backend = nodes.backendNodeId ?? [];
    const clickable = new Set(nodes.isClickable?.index ?? []);
    const checked = new Set(nodes.inputChecked?.index ?? []);
    const selected = new Set(nodes.optionSelected?.index ?? []);
    // shadowRootType marks every node *inside* a shadow tree (value: open or
    // closed), not the shadow root node; the parent chain skips the root and
    // goes straight to the host. Read the membership directly.
    const shadowOf = new Map((nodes.shadowRootType?.index ?? []).map((node, k) => [node, str(nodes.shadowRootType!.value[k])]));
    const inputValue = new Map((nodes.inputValue?.index ?? []).map((n, k) => [n, str(nodes.inputValue!.value[k])]));
    const layoutIdx = new Map(doc.layout.nodeIndex.map((n, i) => [n, i]));
    const { x: ox, y: oy, path } = origin(d);
    const bounds = boundsIn(d);
    backend.forEach((id, n) => byBackend.set(id, { doc: d, node: n }));

    const children = new Map<number, number[]>();
    parent.forEach((p, n) => {
      if (p < 0) return;
      let list = children.get(p);
      if (!list) children.set(p, (list = []));
      list.push(n);
    });
    const attrCache = new Map<number, Map<string, string>>();
    const attrs = (n: number): Map<string, string> => {
      let m = attrCache.get(n);
      if (m) return m;
      m = new Map();
      const flat = nodes.attributes?.[n] ?? [];
      for (let i = 0; i + 1 < flat.length; i += 2) m.set(str(flat[i]).toLowerCase(), str(flat[i + 1]));
      attrCache.set(n, m);
      return m;
    };
    const textOf = (n: number, depth = 0): string => {
      if (depth > 12) return "";
      if (types[n] === 3) return str(values[n]);
      if (BLOCK_SKIP.has(str(names[n]))) return "";
      return (children.get(n) ?? []).map((c) => textOf(c, depth + 1)).join(" ");
    };
    const style = (n: number, which: (typeof STYLES)[number]): string => {
      const i = layoutIdx.get(n);
      if (i === undefined) return "";
      return str(doc.layout.styles[i]?.[STYLES.indexOf(which)]);
    };
    const clean = (s: string) => s.replace(/\s+/g, " ").trim();
    const place = (b: Rect | undefined): Rect | null =>
      b ? { x: Math.round(b.x + ox), y: Math.round(b.y + oy), w: Math.round(b.w), h: Math.round(b.h) } : null;

    // <label for=id> and wrapping labels name their controls.
    const labelFor = new Map<string, string>();
    names.forEach((nameIdx, n) => {
      if (types[n] === 1 && str(nameIdx) === "LABEL") {
        const target = attrs(n).get("for");
        if (target) labelFor.set(target, clean(textOf(n)));
      }
    });
    const wrappingLabel = (n: number): string => {
      for (let p = parent[n] ?? -1, i = 0; p >= 0 && i < 6; p = parent[p] ?? -1, i++)
        if (str(names[p]) === "LABEL") return clean(textOf(p));
      return "";
    };

    const roleOf = (n: number, tag: string, a: Map<string, string>): string => {
      const explicit = a.get("role")?.split(/\s+/)[0];
      if (explicit) return explicit;
      if (tag === "A" && a.has("href")) return "link";
      if (tag === "INPUT") return INPUT_ROLE[a.get("type") ?? "text"] ?? "textbox";
      if (a.get("contenteditable") === "true" || a.get("contenteditable") === "") return "textbox";
      return IMPLICIT_ROLE[tag] ?? "generic";
    };

    const selectorOf = (tag: string, a: Map<string, string>): string => {
      const id = a.get("id");
      const cls = (a.get("class") ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
      return tag.toLowerCase() + (id ? `#${id}` : "") + cls.map((c) => `.${c}`).join("");
    };

    const make = (n: number): SceneElement => {
      const tag = str(names[n]);
      const a = attrs(n);
      const role = roleOf(n, tag, a);
      const isField = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      const id = a.get("id");
      const name = clean(
        a.get("aria-label")
        || (id && labelFor.get(id))
        || (isField ? wrappingLabel(n) : "")
        || (isField || !NAME_FROM_CONTENT.has(role) ? "" : textOf(n))
        || a.get("placeholder") || a.get("title") || a.get("alt")
        || (isField && ["submit", "button", "reset"].includes(a.get("type") ?? "") ? inputValue.get(n) ?? "" : "")
        || "",
      ).slice(0, 80);

      const raw = bounds.get(n);
      let hiddenBy: SceneElement["hiddenBy"];
      if (!raw) hiddenBy = "display";
      else if (style(n, "display") === "none") hiddenBy = "display";
      else if (style(n, "visibility") === "hidden") hiddenBy = "visibility";
      else if (style(n, "opacity") === "0") hiddenBy = "opacity";
      else if (raw.w === 0 || raw.h === 0) hiddenBy = "zero-size";

      const state: ElementState[] = [];
      if (a.has("disabled") || a.get("aria-disabled") === "true") state.push("disabled");
      if (checked.has(n) || a.get("aria-checked") === "true") state.push("checked");
      if (a.get("aria-expanded") === "true") state.push("expanded");
      if (a.get("aria-expanded") === "false") state.push("collapsed");
      if (selected.has(n) || a.get("aria-selected") === "true") state.push("selected");
      if (a.has("required") || a.get("aria-required") === "true") state.push("required");
      if (a.get("aria-invalid") === "true") state.push("invalid");
      if (a.has("readonly") || a.get("aria-readonly") === "true") state.push("readonly");

      const shadow = shadowOf.get(n);
      return {
        ref: `e${d}.${backend[n]}`,
        role,
        name,
        bounds: place(raw),
        frames: path,
        shadow: shadow === "open" ? "open" : shadow === "closed" ? "closed" : null,
        state,
        clickable: clickable.has(n),
        visible: hiddenBy === undefined,
        ...(hiddenBy ? { hiddenBy } : {}),
        selector: selectorOf(tag, a),
        backendNodeId: backend[n] ?? -1,
      };
    };
    describers[d] = make;

    names.forEach((nameIdx, n) => {
      if (types[n] !== 1) return;
      const tag = str(nameIdx);
      const a = attrs(n);
      const isLink = tag === "A" && a.has("href");
      const isInput = tag === "INPUT" && a.get("type") !== "hidden";
      const interesting = clickable.has(n) || isLink || isInput || tag in IMPLICIT_ROLE || a.has("role")
        || (a.has("tabindex") && a.get("tabindex") !== "-1") || a.has("contenteditable");
      if (!interesting) return;
      const element = make(n);
      elements.push(element);
      const type = a.get("type") ?? "text";
      if ((tag === "INPUT" && !["submit", "button", "reset", "image", "file", "hidden"].includes(type)) || tag === "TEXTAREA") {
        const value = ["checkbox", "radio"].includes(type) ? (checked.has(n) ? "checked" : "unchecked") : inputValue.get(n) ?? "";
        fields.push({ backendNodeId: element.backendNodeId, label: `${element.role}:${element.name || element.selector}`, value });
      }
    });

    // Visible text, grouped by the element that holds it, so a paragraph
    // arrives whole rather than as fragments of inline markup.
    const blockText = new Map<number, string[]>();
    names.forEach((_, n) => {
      if (types[n] !== 3 || !layoutIdx.has(n)) return;
      const text = clean(str(values[n]));
      if (!text) return;
      let owner = parent[n] ?? -1;
      // Climb out of inline wrappers (b, span, a...) to the nearest block-ish parent.
      for (let i = 0; i < 4 && owner >= 0; i++) {
        const disp = style(owner, "display");
        if (disp && disp !== "inline") break;
        const up = parent[owner] ?? -1;
        if (up < 0) break;
        owner = up;
      }
      if (owner < 0 || BLOCK_SKIP.has(str(names[owner]))) return;
      if (style(owner, "visibility") === "hidden" || style(owner, "opacity") === "0") return;
      let list = blockText.get(owner);
      if (!list) blockText.set(owner, (list = []));
      list.push(text);
    });
    for (const [owner, parts] of blockText)
      texts.push({ text: parts.join(" "), backendNodeId: backend[owner] ?? -1, bounds: place(bounds.get(owner)) });
  });

  const ancestors = (backendNodeId: number): number[] => {
    const out: number[] = [];
    let at = byBackend.get(backendNodeId);
    for (let guard = 0; at && guard < 4096; guard++) {
      const backends = documents[at.doc]!.nodes.backendNodeId ?? [];
      out.push(backends[at.node] ?? -1);
      const p = parentsOf[at.doc]![at.node] ?? -1;
      if (p >= 0) at = { doc: at.doc, node: p };
      else {
        const frame = parentOfDocument.get(at.doc);
        at = frame ? { doc: frame.doc, node: frame.node } : undefined;
      }
    }
    return out;
  };

  const describe = (backendNodeId: number): SceneElement | null => {
    const own = elements.find((e) => e.backendNodeId === backendNodeId);
    if (own) return own;
    const at = byBackend.get(backendNodeId);
    if (!at) return null;
    // Text nodes and other non-elements are described by their element.
    const types = documents[at.doc]!.nodes.nodeType ?? [];
    let node = at.node;
    while (node >= 0 && types[node] !== 1) node = parentsOf[at.doc]![node] ?? -1;
    return node >= 0 ? describers[at.doc]!(node) : null;
  };

  const top = documents[0];
  return {
    url: str(top?.documentURL),
    title: str(top?.title),
    documents: documents.length,
    viewport,
    scroll,
    elements,
    texts,
    fields,
    ancestors,
    describe,
  };
}
