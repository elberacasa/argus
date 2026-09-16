// argus locate -- find an element by role and accessible name, the way a person
// describes it ("the Sign in button"), and when it cannot be acted on, say why.
//
// Coordinates break on every redesign and every viewport. Roles and names are
// what the model already reasons in, and they are what a screenreader exposes,
// so an element that cannot be located here is usually an element a human using
// assistive tech also cannot find -- the lookup doubles as an audit.
//
// Returns either { ok:true, x, y, ... } for the caller to dispatch real input
// at, or { ok:false, reason, ... } with a diagnosis the agent can act on.
const [spec, wantIndex] = arguments;               // "button:Sign in" | "Sign in"
  const sep = spec.indexOf(":");
  const role = sep > 0 ? spec.slice(0, sep).trim().toLowerCase() : "";
  const want = (sep > 0 ? spec.slice(sep + 1) : spec).trim().toLowerCase();

  const ROLES = {
    button:   "button,[role=button],input[type=button],input[type=submit],input[type=reset],summary",
    link:     "a[href],[role=link]",
    textbox:  "input:not([type]),input[type=text],input[type=email],input[type=password],input[type=search],input[type=tel],input[type=url],input[type=number],textarea,[role=textbox],[contenteditable='']:not([contenteditable=false]),[contenteditable=true]",
    checkbox: "input[type=checkbox],[role=checkbox],[role=switch]",
    radio:    "input[type=radio],[role=radio]",
    combobox: "select,[role=combobox],[role=listbox]",
    tab:      "[role=tab]",
    menuitem: "[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio]",
    heading:  "h1,h2,h3,h4,h5,h6,[role=heading]",
    image:    "img,[role=img]",
    option:   "option,[role=option]",
    // A label is clickable: it forwards the click to its control. Styled upload
    // buttons are almost always a <label for> in front of a hidden file input.
    label:    "label",
  };
  const ANY = Object.values(ROLES).join(",");

  // A pragmatic accessible-name computation: the sources that actually carry
  // the name on real pages, in the precedence the spec gives them.
  const accName = (el) => {
    const byId = el.getAttribute("aria-labelledby");
    if (byId) {
      const t = byId.split(/\s+/).map((i) => document.getElementById(i)?.innerText || "").join(" ").trim();
      if (t) return t;
    }
    const aria = el.getAttribute("aria-label");
    if (aria?.trim()) return aria.trim();
    if (el.labels?.length) { const t = [...el.labels].map((l) => l.innerText).join(" ").trim(); if (t) return t; }
    const text = (el.innerText || "").trim();
    if (text) return text;
    return (el.value || el.getAttribute("placeholder") || el.getAttribute("title") || el.alt || "").trim();
  };

  const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const describe = (el) => {
    const id = el.id ? "#" + el.id : "";
    const cls = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/)[0] : "";
    return el.tagName.toLowerCase() + id + cls;
  };

  const pool = [...document.querySelectorAll(role && ROLES[role] ? ROLES[role] : ANY)];
  if (role && !ROLES[role])
    return { ok: false, reason: "unknown-role", role, known: Object.keys(ROLES) };

  // Exact name wins over prefix wins over substring, so "Save" never picks
  // "Save and close" while an exact "Save and close" is still reachable.
  const scored = [];
  for (const el of pool) {
    const name = norm(accName(el));
    if (!name) continue;
    const rank = name === want ? 0 : name.startsWith(want) ? 1 : name.includes(want) ? 2 : -1;
    if (rank >= 0) scored.push({ el, name, rank });
  }
  if (!scored.length) {
    // Offer the nearest things that do exist: far cheaper than a screenshot and
    // usually enough for the agent to correct itself on the next call.
    const TAG_ROLE = { a: "link", button: "button", input: "textbox", textarea: "textbox", select: "combobox", img: "image", summary: "button" };
    const roleOf = (el) => el.getAttribute("role")
      || (el.tagName === "INPUT" ? ({ checkbox: "checkbox", radio: "radio", submit: "button", button: "button", reset: "button" }[el.type] || "textbox") : null)
      || TAG_ROLE[el.tagName.toLowerCase()] || el.tagName.toLowerCase();
    const near = pool.map((el) => ({ n: norm(accName(el)), r: roleOf(el) }))
      .filter((c) => c.n).slice(0, 200)
      .filter((c) => want.split(/\s+/).some((w) => w.length > 2 && c.n.includes(w)))
      .slice(0, 6).map((c) => `${c.r}:${c.n.slice(0, 40)}`);
    return { ok: false, reason: "not-found", spec, ...(near.length ? { didYouMean: near } : {}) };
  }

  scored.sort((a, b) => a.rank - b.rank);
  const best = scored.filter((s) => s.rank === scored[0].rank);
  if (best.length > 1 && wantIndex === undefined)
    return {
      ok: false, reason: "ambiguous", spec, matches: best.length,
      candidates: best.slice(0, 6).map((s, i) => ({ index: i, at: describe(s.el), name: s.name.slice(0, 50) })),
      hint: "Re-issue with an index, or use the exact accessible name.",
    };

  const el = best[wantIndex ?? 0]?.el;
  if (!el) return { ok: false, reason: "index-out-of-range", available: best.length };

  // ---- why can this element not be acted on? -------------------------------
  const cs = getComputedStyle(el);
  const at = describe(el), name = norm(accName(el));
  const boxOf = () => { const b = el.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; };

  if (el.disabled || el.getAttribute("aria-disabled") === "true")
    return { ok: false, reason: "disabled", at, name, box: boxOf(), hint: "The control is disabled; something upstream must enable it first." };
  if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0")
    return { ok: false, reason: "hidden", at, name, css: `display:${cs.display} visibility:${cs.visibility} opacity:${cs.opacity}` };

  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0)
    return { ok: false, reason: "zero-size", at, name, hint: "The element occupies no space; its parent may be collapsed." };

  if (cs.pointerEvents === "none")
    return { ok: false, reason: "pointer-events-none", at, name, box: boxOf(), hint: "The element cannot receive the click; an ancestor or the element itself sets pointer-events:none." };

  const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
  if (x < 0 || y < 0 || x > innerWidth || y > innerHeight)
    return { ok: false, reason: "offscreen", at, name, rect: { x, y }, viewport: `${innerWidth}x${innerHeight}` };

  // Hit-test the centre. If something else answers, that thing is what a real
  // click would hit -- this is the check that turns "the click did nothing"
  // into "a cookie banner is on top of it".
  const hit = document.elementFromPoint(x, y);
  if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
    const blocker = getComputedStyle(hit);
    return {
      ok: false, reason: "covered", at, name, box: boxOf(),
      coveredBy: describe(hit),
      blockerZIndex: blocker.zIndex, blockerPosition: blocker.position,
      hint: "Another element is painted over the target. Dismiss the overlay, or scroll it out of the way, then retry.",
    };
  }

  const frame = el.ownerDocument !== document ? "iframe" : null;
  return { ok: true, x, y, at, name, rect: { w: Math.round(r.width), h: Math.round(r.height) }, box: boxOf(), ...(frame ? { frame } : {}) };
