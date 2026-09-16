// argus audit -- what is wrong with this page, measured in the browser.
//
// A coding agent that builds a UI gets told "done" and never learns the button
// it shipped is 18px tall or sits at 2.1:1 contrast. Every check here is one a
// human reviewer would raise, computed from real layout and real computed
// style, so the agent gets the review in the same round trip as the action.
return (() => {
  const LIMIT = 8;            // findings reported per rule
  const SCAN  = 3000;         // element ceiling, keeps a heavy SPA under ~120ms

  const els = [...document.querySelectorAll("body *")].slice(0, SCAN);
  // clientWidth, not innerWidth. On a phone, content wider than the screen makes
  // the browser zoom the whole page out, and innerWidth grows to match -- so an
  // overflow check against innerWidth measures the page against its own mistake
  // and passes. clientWidth stays the device width.
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  const findings = [];
  const add = (rule, severity, hint, items) =>
    items.length && findings.push({ rule, severity, hint, count: items.length, examples: items.slice(0, LIMIT) });

  // ---- helpers -------------------------------------------------------------
  const where = (el) => {
    const id = el.id ? "#" + el.id : "";
    const cls = typeof el.className === "string" && el.className.trim()
      ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
    return el.tagName.toLowerCase() + id + cls;
  };
  const label = (el) => (el.innerText || el.value || el.getAttribute("aria-label") || el.alt || "").replace(/\s+/g, " ").trim().slice(0, 40);
  const shown = (el, r) => r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";

  const parseColor = (c) => {
    const m = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
    return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
  };
  const luminance = ({ r, g, b }) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const over = (fg, bg) => ({            // composite a translucent colour onto its backdrop
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1,
  });
  // The painted background is whichever ancestor first supplies an opaque
  // colour; walking up is what the browser itself does when compositing.
  const backdrop = (el) => {
    let node = el, acc = null;
    while (node && node !== document.documentElement) {
      const c = parseColor(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0) { acc = acc ? over(acc, c) : c; if (acc.a >= 0.99) return acc; }
      node = node.parentElement;
    }
    const root = parseColor(getComputedStyle(document.documentElement).backgroundColor);
    const white = { r: 255, g: 255, b: 255, a: 1 };
    const base = root && root.a > 0 ? root : white;
    return acc ? over(acc, base) : base;
  };
  const ratio = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

  const INTERACTIVE = "a[href],button,input,select,textarea,[role=button],[role=link],[onclick],[tabindex]:not([tabindex='-1'])";
  const named = (el) =>
    (el.innerText || "").trim() || el.getAttribute("aria-label") || el.getAttribute("title") || el.alt ||
    (el.getAttribute("aria-labelledby") && document.getElementById(el.getAttribute("aria-labelledby"))?.innerText.trim()) ||
    (el.labels && el.labels.length && [...el.labels].some((l) => l.innerText.trim()));

  // ---- 1. contrast (WCAG 2.2 · 1.4.3) --------------------------------------
  {
    const bad = [];
    for (const el of els) {
      if (!el.childNodes.length || bad.length >= LIMIT * 3) continue;
      // Only elements that paint their own text; a wrapper inherits its child's finding.
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim().length > 1);
      if (!own) continue;
      const r = el.getBoundingClientRect();
      if (!shown(el, r)) continue;
      const cs = getComputedStyle(el);
      const fg = parseColor(cs.color);
      if (!fg || fg.a === 0) continue;
      const bg = backdrop(el);
      const contrast = ratio(fg.a < 1 ? over(fg, bg) : fg, bg);
      const size = parseFloat(cs.fontSize), bold = +cs.fontWeight >= 700;
      const large = size >= 24 || (size >= 18.66 && bold);     // WCAG "large text"
      const required = large ? 3 : 4.5;
      if (contrast < required)
        bad.push({ at: where(el), text: label(el), contrast: +contrast.toFixed(2), required, fontSize: Math.round(size) });
    }
    add("contrast", "error", "Text fails WCAG AA. Darken the text or lighten the background.", bad);
  }

  // ---- 2. tap targets (WCAG 2.2 · 2.5.8) -----------------------------------
  {
    const small = [];
    for (const el of document.querySelectorAll(INTERACTIVE)) {
      const r = el.getBoundingClientRect();
      if (!shown(el, r)) continue;
      // Inline links inside a paragraph are exempt; the rule targets controls.
      if (el.tagName === "A" && getComputedStyle(el).display.startsWith("inline") && el.closest("p,li")) continue;
      if (r.width < 24 || r.height < 24)
        small.push({ at: where(el), text: label(el), size: `${Math.round(r.width)}x${Math.round(r.height)}` });
      if (small.length >= LIMIT * 2) break;
    }
    add("tap-target", "warn", "Interactive target below 24x24 CSS px. Add padding or min-height.", small);
  }

  // ---- 3. horizontal overflow ----------------------------------------------
  {
    // Content inside a scroll or clip container is allowed to be wide -- that is
    // what overflow-x:auto is for. Only what escapes every such container counts.
    const escapes = (el) => {
      for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement)
        if (getComputedStyle(a).overflowX !== "visible") return false;
      return true;
    };
    const spilling = [];
    if (document.documentElement.scrollWidth > vw + 1) {
      for (const el of els) {
        const r = el.getBoundingClientRect();
        // Deliberately not shown(): a visually-hidden element is still laid out,
        // and a screen-reader-only table is exactly the kind that widens a page.
        if (!r.width || r.right <= vw + 1 || getComputedStyle(el).position === "fixed" || !escapes(el)) continue;
        spilling.push({ at: where(el), overflowPx: Math.round(r.right - vw), width: Math.round(r.width) });
      }
      // Report the narrowest offenders first: the outermost wrapper is always
      // "too wide" too, but the small element inside it is the one to fix.
      spilling.sort((a, b) => a.width - b.width);
    }
    add("overflow-x", "error", `Page scrolls sideways at ${vw}px wide. Add max-width:100% or let the row wrap.`, spilling.slice(0, LIMIT * 2));

  }

  // ---- 4. unnamed controls (WCAG 2.2 · 4.1.2) ------------------------------
  {
    const anon = [];
    for (const el of document.querySelectorAll(INTERACTIVE)) {
      const r = el.getBoundingClientRect();
      if (!shown(el, r) || named(el)) continue;
      if (el.type === "hidden") continue;
      anon.push({ at: where(el), size: `${Math.round(r.width)}x${Math.round(r.height)}` });
      if (anon.length >= LIMIT * 2) break;
    }
    add("unnamed-control", "error", "Control has no accessible name. A screenreader announces it as blank.", anon);
  }

  // ---- 5. images without alt ----------------------------------------------
  add("img-alt", "warn", "Image has no alt attribute. Use alt=\"\" if decorative.",
    [...document.images].filter((i) => !i.hasAttribute("alt") && shown(i, i.getBoundingClientRect()))
      .slice(0, LIMIT * 2).map((i) => ({ at: where(i), src: (i.currentSrc || i.src || "").split("/").pop().slice(0, 50) })));

  // ---- 6. heading order ----------------------------------------------------
  {
    const skips = [], hs = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].filter((h) => shown(h, h.getBoundingClientRect()));
    let prev = 0;
    for (const h of hs) {
      const lvl = +h.tagName[1];
      if (prev && lvl > prev + 1) skips.push({ at: where(h), text: label(h), jumped: `h${prev} to h${lvl}` });
      prev = lvl;
    }
    add("heading-order", "warn", "Heading level skipped. Outline order guides screenreader navigation.", skips);
  }

  // ---- 7. tiny text --------------------------------------------------------
  {
    const tiny = [], seen = new Set();
    for (const el of els) {
      if (!el.innerText || !el.innerText.trim() || tiny.length >= LIMIT) continue;
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size >= 12 || !shown(el, el.getBoundingClientRect())) continue;
      const at = where(el);
      const key = at + ":" + size;
      if (seen.has(key)) continue;
      seen.add(key);
      tiny.push({ at, text: label(el), fontSize: +size.toFixed(1) });
    }
    add("tiny-text", "warn", "Text under 12px is hard to read on any screen.", tiny);
  }

  // ---- 8. duplicate ids ----------------------------------------------------
  {
    const seen = new Map(), dupes = [];
    for (const el of document.querySelectorAll("[id]")) {
      const id = el.id;
      if (seen.has(id)) { if (!dupes.some((d) => d.id === id)) dupes.push({ id, at: where(el) }); }
      else seen.set(id, el);
    }
    add("duplicate-id", "error", "Duplicate id breaks label association and getElementById.", dupes.slice(0, LIMIT));
  }

  const score = findings.reduce((s, f) => s - (f.severity === "error" ? 12 : 4), 100);
  return {
    viewport: `${vw}x${vh}`,
    scanned: els.length,
    score: Math.max(0, score),
    errors: findings.filter((f) => f.severity === "error").length,
    warnings: findings.filter((f) => f.severity === "warn").length,
    findings,
  };
})();
