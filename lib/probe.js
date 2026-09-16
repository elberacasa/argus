// argus probe -- installed before any page script via
// Page.addScriptToEvaluateOnNewDocument, so it survives navigation and catches
// errors thrown during initial parse.
//
// The probe records continuously but reports only on demand. An agent asks
// "what changed since my last mark?" and pays for the answer, not for the page.
(() => {
  if (window.__argus) return;

  const MAX = 200;                    // ring-buffer ceiling per channel
  const ring = () => ({ items: [], push(v) { this.items.push(v); if (this.items.length > MAX) this.items.shift(); } });

  const state = {
    console: ring(),
    network: ring(),
    dialogs: ring(),
    nextAnswer: null,                 // one-shot answer for the next confirm/prompt
    shifts: 0,                        // cumulative layout shift, unbuffered
    longTasks: 0,
    mutations: 0,
    lastMutation: 0,
    inflight: 0,
    navigatedAt: performance.now(),
    marks: new Map(),
  };

  // ---- console + uncaught errors -------------------------------------------
  // Wrapping rather than relying on CDP's Runtime.consoleAPICalled keeps the
  // capture inside the page, so it works the same through any transport.
  for (const level of ["error", "warn"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      state.console.push({ level, text: args.map(fmt).join(" ").slice(0, 400), t: now() });
      original(...args);
    };
  }
  addEventListener("error", (e) => {
    // Resource load failures surface here with no message; they matter for UX.
    const where = e.filename ? ` (${short(e.filename)}:${e.lineno})` : "";
    state.console.push({
      level: "error",
      text: e.message ? e.message + where : `failed to load ${short(e.target?.src || e.target?.href || "resource")}`,
      t: now(),
    });
  }, true);
  addEventListener("unhandledrejection", (e) => {
    state.console.push({ level: "error", text: "unhandled rejection: " + fmt(e.reason).slice(0, 400), t: now() });
  });

  function fmt(v) {
    if (v instanceof Error) return v.message;
    if (typeof v === "object" && v !== null) { try { return JSON.stringify(v); } catch { return String(v); } }
    return String(v);
  }
  const short = (u) => { try { const p = new URL(u, location.href); return p.pathname + p.search; } catch { return String(u).slice(0, 80); } };
  const now = () => Math.round(performance.now());

  // ---- modal dialogs -------------------------------------------------------
  // A native dialog is poison for an agent. alert/confirm/prompt block the page
  // and make chromedriver dismiss them on the next command, so a "Delete?" gets
  // a silent "no" and the agent sees a button that does nothing. A file picker
  // opens a portal window -- on a desk lane, on the user's own screen.
  //
  // So none of them ever reach the browser. Each is recorded and answered here.
  // The default answer is the safe one (dismiss, as before -- but now reported),
  // and accepting takes an explicit one-shot `argus dialog accept` first, so an
  // agent can never confirm something destructive by accident.
  const answer = (type, message, fallback) => {
    const a = state.nextAnswer;
    state.nextAnswer = null;
    const accepted = !!(a && a.accept);
    state.dialogs.push({ type, message: String(message ?? "").slice(0, 200), answer: accepted ? "accepted" : "dismissed", t: now() });
    return { accepted, text: a && a.text !== undefined ? a.text : fallback };
  };
  // An alert asks nothing, so it must not consume a one-shot answer meant for
  // a confirm that follows it -- or "accept" would land on the alert and the
  // destructive confirm behind it would be dismissed.
  window.alert = (message) => {
    state.dialogs.push({ type: "alert", message: String(message ?? "").slice(0, 200), answer: "shown", t: now() });
  };
  window.confirm = (message) => answer("confirm", message).accepted;
  window.prompt = (message, def) => {
    const r = answer("prompt", message, def ?? "");
    return r.accepted ? String(r.text) : null;
  };
  window.print = () => { state.dialogs.push({ type: "print", message: "print dialog suppressed", answer: "suppressed", t: now() }); };

  const describeInput = (el) => {
    const id = el.id ? "#" + el.id : el.name ? "[name=" + el.name + "]" : "";
    return "input" + id;
  };
  const chooser = (el, via) => state.dialogs.push({
    type: "file-chooser", at: describeInput(el), via,
    multiple: !!el.multiple, accept: el.accept || "*",
    message: "file picker suppressed; set files with: argus upload", answer: "suppressed", t: now(),
  });
  // Capture phase on window sees the click first -- including the synthetic
  // click a <label for> forwards to a hidden input -- and cancelling it stops
  // the input's activation behaviour, which is what opens the picker.
  addEventListener("click", (e) => {
    const el = e.target;
    if (el instanceof HTMLInputElement && el.type === "file") { e.preventDefault(); chooser(el, "click"); }
  }, true);
  const nativeShowPicker = HTMLInputElement.prototype.showPicker;
  if (nativeShowPicker) {
    HTMLInputElement.prototype.showPicker = function () {
      if (this.type === "file") return chooser(this, "showPicker");
      return nativeShowPicker.call(this);
    };
  }
  for (const api of ["showOpenFilePicker", "showSaveFilePicker", "showDirectoryPicker"]) {
    if (window[api]) window[api] = () => {
      state.dialogs.push({ type: "file-chooser", at: api, via: api, message: "file system picker suppressed", answer: "suppressed", t: now() });
      return Promise.reject(new DOMException("The user aborted a request.", "AbortError"));
    };
  }
  // Downloads are recorded as intent here; the CLI confirms the file landed.
  addEventListener("click", (e) => {
    const a = e.target instanceof Element && e.target.closest("a[download]");
    if (a) state.dialogs.push({ type: "download", message: a.getAttribute("download") || short(a.href), answer: "started", t: now() });
  }, true);

  // ---- network -------------------------------------------------------------
  // fetch and XHR are wrapped for status codes (PerformanceObserver cannot see
  // them); the observer catches everything else the page pulls in.
  const record = (method, url, status, started, error) => {
    state.network.push({
      method, url: short(url), status, ms: Math.round(performance.now() - started),
      ...(error ? { error } : {}),
    });
  };

  const nativeFetch = window.fetch;
  window.fetch = async function (...args) {
    const started = performance.now();
    const url = args[0]?.url ?? String(args[0]);
    const method = (args[1]?.method ?? args[0]?.method ?? "GET").toUpperCase();
    state.inflight++;
    try {
      const res = await nativeFetch.apply(this, args);
      record(method, url, res.status, started);
      return res;
    } catch (err) {
      record(method, url, 0, started, err.message);
      throw err;
    } finally { state.inflight--; }
  };

  const openXHR = XMLHttpRequest.prototype.open;
  const sendXHR = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__argus = { method: String(method).toUpperCase(), url };
    return openXHR.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    const meta = this.__argus;
    if (meta) {
      const started = performance.now();
      state.inflight++;
      this.addEventListener("loadend", () => {
        state.inflight--;
        record(meta.method, meta.url, this.status, started, this.status === 0 ? "network error" : undefined);
      }, { once: true });
    }
    return sendXHR.apply(this, args);
  };

  observe("resource", (entries) => {
    for (const e of entries) {
      if (e.initiatorType === "fetch" || e.initiatorType === "xmlhttprequest") continue; // already wrapped
      // responseStatus is 0 for opaque cross-origin reads, which is not a failure.
      state.network.push({ method: "GET", url: short(e.name), status: e.responseStatus ?? null, ms: Math.round(e.duration), kind: e.initiatorType });
    }
  });

  // ---- layout stability + responsiveness -----------------------------------
  observe("layout-shift", (entries) => {
    for (const e of entries) if (!e.hadRecentInput) state.shifts += e.value;
  });
  observe("longtask", (entries) => { state.longTasks += entries.length; });

  function observe(type, cb) {
    try { new PerformanceObserver((l) => cb(l.getEntries())).observe({ type, buffered: true }); } catch {}
  }

  // ---- DOM quiescence ------------------------------------------------------
  state.lastMutation = performance.now();
  // `document` is observable at document-start; `document.documentElement` is
  // still null there, which is what silently killed the whole probe.
  new MutationObserver((records) => {
    state.mutations += records.length;
    state.lastMutation = performance.now();
  }).observe(document, { childList: true, subtree: true, attributes: true, characterData: true });

  // ---- visible text fingerprint -------------------------------------------
  // The diff is over *visible* text only. A hidden menu's contents are not a
  // change the user or the agent can perceive, and including them makes every
  // delta noisy on framework-heavy pages.
  function visibleText() {
    const counts = new Map();
    const root = document.body || document.documentElement;
    if (!root) return counts;            // document-start: nothing has parsed yet
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.nodeValue.replace(/\s+/g, " ").trim();
      if (text.length < 2) continue;
      const el = n.parentElement;
      if (!el || el.closest("script,style,noscript,template")) continue;
      // offsetParent is null for display:none and for position:fixed; the rect
      // check covers the fixed case without a full getComputedStyle per node.
      if (!el.offsetParent) { const r = el.getBoundingClientRect(); if (!r.width && !r.height) continue; }
      counts.set(text, (counts.get(text) || 0) + 1);
    }
    return counts;
  }

  // Keyed by a stable-ish path so the diff survives re-renders that preserve
  // structure, which is the common case for controlled inputs.
  function fieldState() {
    const out = new Map();
    for (const el of document.querySelectorAll("input,textarea,select")) {
      if (el.type === "password") continue;                   // never record secrets
      const key = el.id ? "#" + el.id : el.name ? "[name=" + el.name + "]" : el.tagName.toLowerCase() + ":" + [...document.querySelectorAll(el.tagName)].indexOf(el);
      out.set(key,
        el.type === "checkbox" || el.type === "radio" ? String(el.checked)
        : el.type === "file" ? [...(el.files || [])].map((f) => f.name + " (" + f.size + "B)").join(", ")
        : String(el.value ?? ""));
    }
    return out;
  }

  function diffFields(before, after) {
    const changed = [];
    for (const [k, v] of after) {
      const was = before.get(k);
      if (was !== undefined && was !== v)
        changed.push({ at: k, from: clip(was), to: clip(v) });
    }
    return changed;
  }
  const clip = (v) => (v.length > 48 ? v.slice(0, 48) + "..." : v);

  // Where keyboard focus is, described the way a person would name it. Keyboard
  // navigation is invisible to a text diff, and it is half of accessibility.
  function focusName() {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return null;
    // Controls are named by what they say; a focused landmark or container (a
    // skip-link target, a dialog) by what it is, not by all the text inside it.
    const control = el.matches("a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[contenteditable]");
    const role = el.getAttribute("role") || ({ A: "link", BUTTON: "button", INPUT: "textbox", SELECT: "combobox", TEXTAREA: "textbox", SUMMARY: "button" }[el.tagName]) || el.tagName.toLowerCase();
    const label = el.getAttribute("aria-label") || (control ? (el.innerText || el.value || el.getAttribute("title") || "") : (el.id ? "#" + el.id : ""));
    const name = label.replace(/\s+/g, " ").trim().slice(0, 50);
    const r = el.getBoundingClientRect();
    return { name: role + (name ? (name.startsWith("#") ? name : ":" + name) : ""), onscreen: r.bottom > 0 && r.top < innerHeight && r.width > 0 && r.height > 0 };
  }

  function diffText(before, after) {
    const added = [], removed = [];
    for (const [t, n] of after) { const d = n - (before.get(t) || 0); if (d > 0) added.push(t); }
    for (const [t, n] of before) { const d = n - (after.get(t) || 0); if (d > 0) removed.push(t); }
    return { added, removed };
  }

  // ---- public surface ------------------------------------------------------
  window.__argus = {
    // Snapshot the world so a later delta() can describe what an action did.
    mark(name = "default") {
      state.marks.set(name, {
        text: visibleText(),
        fields: fieldState(),
        focus: focusName(),
        url: location.href,
        title: document.title,
        console: state.console.items.length,
        network: state.network.items.length,
        dialogs: state.dialogs.items.length,
        shifts: state.shifts,
        longTasks: state.longTasks,
        mutations: state.mutations,
        t: performance.now(),
      });
      return true;
    },

    delta(name = "default", limit = 12) {
      let from = state.marks.get(name), navigated = false;
      if (!from && name !== "nav") { from = state.marks.get("nav"); navigated = true; }
      if (!from) return { error: "no mark named " + name };
      const text = diffText(from.text, visibleText());
      const out = {
        ms: Math.round(performance.now() - from.t),
        mutations: state.mutations - from.mutations,
      };
      if (navigated) out.navigated = true;
      if (location.href !== from.url) out.url = { from: from.url, to: location.href };
      if (document.title !== from.title) out.title = { from: from.title, to: document.title };
      const focusNow = focusName();
      if ((focusNow && focusNow.name) !== (from.focus && from.focus.name))
        out.focus = { from: from.focus && from.focus.name, to: focusNow && focusNow.name, ...(focusNow && !focusNow.onscreen ? { offscreen: true } : {}) };
      const fields = diffFields(from.fields || new Map(), fieldState());
      if (fields.length) out.fields = fields.slice(0, limit);
      if (text.added.length) out.added = text.added.slice(0, limit);
      if (text.removed.length) out.removed = text.removed.slice(0, limit);
      if (text.added.length > limit) out.addedMore = text.added.length - limit;
      if (text.removed.length > limit) out.removedMore = text.removed.length - limit;

      const dialogs = state.dialogs.items.slice(from.dialogs ?? 0);
      if (dialogs.length) out.dialogs = dialogs.slice(-limit);

      const console_ = state.console.items.slice(from.console);
      if (console_.length) out.console = console_.slice(-limit);
      // Only surface requests that failed or were slow. A delta listing 40
      // successful asset loads buries the one 500 that explains the bug.
      const net = state.network.items.slice(from.network)
        .filter((r) => (r.status !== null && (r.status === 0 || r.status >= 400)) || r.ms > 1000 || r.error);
      if (net.length) out.network = net.slice(-limit);

      const shift = state.shifts - from.shifts;
      if (shift > 0.01) out.layoutShift = +shift.toFixed(3);
      const long = state.longTasks - from.longTasks;
      if (long) out.longTasks = long;
      return out;
    },

    // Resolves once the network and the DOM have both been quiet for `quiet` ms.
    // Replaces sleeping an arbitrary duration and reports what it actually waited for.
    settled({ quiet = 250, timeout = 10000 } = {}) {
      const started = performance.now();
      return new Promise((resolve) => {
        (function poll() {
          const idleFor = performance.now() - state.lastMutation;
          const waited = performance.now() - started;
          if (state.inflight === 0 && idleFor >= quiet && document.readyState !== "loading") {
            return resolve({ ms: Math.round(waited), reason: "network-idle+dom-quiet" });
          }
          if (waited > timeout) {
            return resolve({ ms: Math.round(waited), reason: "timeout", inflight: state.inflight, domIdleMs: Math.round(idleFor) });
          }
          setTimeout(poll, 50);
        })();
      });
    },

    // Answer the next confirm/prompt. One-shot, so it can never leak into a
    // later, unrelated dialog.
    answerNext(accept, text) { state.nextAnswer = { accept: !!accept, text }; return true; },

    stats: () => ({ inflight: state.inflight, mutations: state.mutations, shifts: +state.shifts.toFixed(3), longTasks: state.longTasks }),
  };

  // Installed at document-start, so this baseline is the empty document: the
  // first delta after a load therefore describes the page that rendered.
  window.__argus.mark("nav");
  window.__argus.mark();
})();
