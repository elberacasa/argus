// argus upload -- find the file input an upload should go to.
//
// Unlike locate.js this deliberately ignores visibility. The usual real-world
// file input is display:none behind a styled label, so "only act on what a
// person could click" would make uploads impossible. Files are set directly on
// the input, which is what a picker would have done, without ever opening one.
//
// Matches by the names a person would use for the control: its label text
// (including a <label for> elsewhere in the page), aria-label, name, or id.
// Marks the chosen input with a one-time token so WebDriver can address it.
const [want, token] = arguments;
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();

const inputs = [...document.querySelectorAll("input[type=file]")];
if (!inputs.length) return { ok: false, reason: "no-file-input", hint: "This page has no <input type=file>. The upload may happen in an iframe or through drag and drop." };

const names = (el) => {
  const out = [];
  if (el.labels) for (const l of el.labels) out.push(l.innerText);
  if (el.id) document.querySelectorAll(`label[for="${CSS.escape(el.id)}"]`).forEach((l) => out.push(l.innerText));
  out.push(el.getAttribute("aria-label"), el.name, el.id);
  return [...new Set(out.map(norm).filter(Boolean))];
};
const at = (el) => "input" + (el.id ? "#" + el.id : el.name ? `[name=${el.name}]` : "");
const describe = (el, i) => ({ index: i, at: at(el), names: names(el), multiple: el.multiple, accept: el.accept || "*",
                               hidden: getComputedStyle(el).display === "none" });

let pick;
if (!want) {
  if (inputs.length > 1)
    return { ok: false, reason: "ambiguous", hint: "Several file inputs; name the one you mean.", candidates: inputs.map(describe) };
  pick = inputs[0];
} else {
  const w = norm(want);
  const exact = inputs.filter((el) => names(el).includes(w));
  const loose = exact.length ? exact : inputs.filter((el) => names(el).some((n) => n.includes(w)));
  if (!loose.length) return { ok: false, reason: "not-found", spec: want, candidates: inputs.map(describe) };
  if (loose.length > 1) return { ok: false, reason: "ambiguous", spec: want, candidates: loose.map(describe) };
  pick = loose[0];
}

document.querySelectorAll("[data-argus-upload]").forEach((el) => el.removeAttribute("data-argus-upload"));
pick.setAttribute("data-argus-upload", token);
return { ok: true, ...describe(pick, inputs.indexOf(pick)) };
