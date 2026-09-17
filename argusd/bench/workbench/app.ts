// Workbench: a small web app built to look like the things agents are asked to
// drive, with the traps real apps have. The harness hosts it, so every judge
// reads the server's own record of what happened, whichever tool drove it.
//
// Two origins: the app, and a second port that serves the gift-card widget
// the app embeds as a cross-origin frame.

import { createHash } from "node:crypto";
import { join } from "node:path";

const ASSETS = join(import.meta.dir, "assets");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- ground truth -------------------------------------------------------------

export interface State {
  issueViews: string[];
  signup: Record<string, unknown> | null;
  signupCode: string | null;
  drafts: number[];
  avatarSha: string | null;
  board: Record<string, string>;
  stationViews: string[];
  redeemed: string[];
  country: string | null;
  exports: number;
  archives: number;
  orderAttempts: number;
  prefsSaves: number;
}

export const fresh = (): State => ({
  issueViews: [], signup: null, signupCode: null, drafts: [1, 2, 3, 4, 5], avatarSha: null,
  board: { "write-docs": "todo", "fix-login": "doing", "ship-v2": "todo", "update-deps": "done" },
  stationViews: [], redeemed: [], country: null, exports: 0, archives: 0, orderAttempts: 0, prefsSaves: 0,
});

export const MARKERS = [
  { id: "st-1", name: "Harbor Gate", color: "#2f6fdd", x: 160, y: 120 },
  { id: "st-2", name: "Willow Bend", color: "#2e9e4f", x: 610, y: 90 },
  { id: "st-3", name: "Kestrel Point", color: "#d93a3a", x: 470, y: 330 },
  { id: "st-4", name: "Amber Flats", color: "#e38b1c", x: 240, y: 390 },
  { id: "st-5", name: "Violet Ridge", color: "#8a4fd8", x: 700, y: 410 },
];

export const orderTotal = (n: number) => `$${(((n * 7919) % 50000) / 100 + 12).toFixed(2)}`;
export const AVATAR_SHA = createHash("sha256").update(await Bun.file(join(ASSETS, "avatar.png")).bytes()).digest("hex");
export const AVATAR_PATH = join(ASSETS, "avatar.png");

const COUNTRIES = "Afghanistan,Albania,Algeria,Andorra,Angola,Antigua and Barbuda,Argentina,Armenia,Australia,Austria,Azerbaijan,Bahamas,Bahrain,Bangladesh,Barbados,Belarus,Belgium,Belize,Benin,Bhutan,Bolivia,Bosnia and Herzegovina,Botswana,Brazil,Brunei,Bulgaria,Burkina Faso,Burundi,Cabo Verde,Cambodia,Cameroon,Canada,Central African Republic,Chad,Chile,China,Colombia,Comoros,Congo,Costa Rica,Croatia,Cuba,Cyprus,Czechia,Denmark,Djibouti,Dominica,Dominican Republic,Ecuador,Egypt,El Salvador,Equatorial Guinea,Eritrea,Estonia,Eswatini,Ethiopia,Fiji,Finland,France,Gabon,Gambia,Georgia,Germany,Ghana,Greece,Grenada,Guatemala,Guinea,Guinea-Bissau,Guyana,Haiti,Honduras,Hungary,Iceland,India,Indonesia,Iran,Iraq,Ireland,Israel,Italy,Jamaica,Japan,Jordan,Kazakhstan,Kenya,Kiribati,Kuwait,Kyrgyzstan,Laos,Latvia,Lebanon,Lesotho,Liberia,Libya,Liechtenstein,Lithuania,Luxembourg,Madagascar,Malawi,Malaysia,Maldives,Mali,Malta,Marshall Islands,Mauritania,Mauritius,Mexico,Micronesia,Moldova,Monaco,Mongolia,Montenegro,Morocco,Mozambique,Myanmar,Namibia,Nauru,Nepal,Netherlands,New Zealand,Nicaragua,Niger,Nigeria,North Korea,North Macedonia,Norway,Oman,Pakistan,Palau,Panama,Papua New Guinea,Paraguay,Peru,Philippines,Poland,Portugal,Qatar,Romania,Russia,Rwanda,Saint Kitts and Nevis,Saint Lucia,Saint Vincent and the Grenadines,Samoa,San Marino,Sao Tome and Principe,Saudi Arabia,Senegal,Serbia,Seychelles,Sierra Leone,Singapore,Slovakia,Slovenia,Solomon Islands,Somalia,South Africa,South Korea,South Sudan,Spain,Sri Lanka,Sudan,Suriname,Sweden,Switzerland,Syria,Taiwan,Tajikistan,Tanzania,Thailand,Timor-Leste,Togo,Tonga,Trinidad and Tobago,Tunisia,Turkey,Turkmenistan,Tuvalu,Uganda,Ukraine,United Arab Emirates,United Kingdom,United States,Uruguay,Uzbekistan,Vanuatu,Vatican City,Venezuela,Vietnam,Yemen,Zambia,Zimbabwe".split(",");

// ---- pages --------------------------------------------------------------------

const CSS = `
*{box-sizing:border-box} body{margin:0;font:15px/1.5 system-ui,sans-serif;color:#1d2330;background:#f6f7f9}
header{background:#1d2330;color:#fff;padding:12px 24px;font-weight:600}
main{max-width:880px;margin:24px auto;padding:0 20px}
.card{background:#fff;border:1px solid #e3e6eb;border-radius:10px;padding:20px;margin:0 0 16px}
button,.btn{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid #c9ced6;background:#fff;cursor:pointer}
button.primary{background:#2457d6;border-color:#2457d6;color:#fff} button:disabled{opacity:.5;cursor:not-allowed}
input,select{font:inherit;padding:8px 10px;border:1px solid #c9ced6;border-radius:8px}
label{display:block;margin:12px 0 4px;font-weight:500} .error{color:#b42318;font-size:13px;min-height:20px}
a{color:#2457d6} ul.plain{list-style:none;padding:0;margin:0} ul.plain li{padding:10px 0;border-bottom:1px solid #eef0f3}
.toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%);background:#1d2330;color:#fff;padding:10px 16px;border-radius:8px}
`;

const page = (title: string, body: string, script = "", head = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${CSS}</style>${head}</head>
<body><header>Workbench</header><main>${body}</main>${script ? `<script>${script}</script>` : ""}</body></html>`;

// T1: a client-side app. Routes render from fetched data; the issues view loads its code first.
const SPA = page("Workbench", `<div id="root">Loading…</div>`, `
const root = document.getElementById("root");
const go = (path) => { history.pushState({}, "", path); render(); };
document.addEventListener("click", (e) => { const a = e.target.closest("a[data-route]"); if (a) { e.preventDefault(); go(a.getAttribute("href")); } });
addEventListener("popstate", render);
const load = (src) => new Promise((r) => { const s = document.createElement("script"); s.src = src; s.onload = r; document.head.append(s); });
async function render() {
  const p = location.pathname;
  let m;
  if (p === "/app" || p === "/app/") {
    root.innerHTML = '<div class="card"><h1>Home</h1><p>Welcome back.</p><nav><a data-route href="/app/projects">Projects</a> · <a data-route href="/app/activity">Activity</a></nav></div>';
  } else if (p === "/app/activity") {
    root.innerHTML = '<div class="card"><h1>Activity</h1><p>Nothing new today.</p><a data-route href="/app">Home</a></div>';
  } else if (p === "/app/projects") {
    root.innerHTML = '<div class="card">Loading projects…</div>';
    const list = await (await fetch("/api/projects")).json();
    root.innerHTML = '<div class="card"><h1>Projects</h1><ul class="plain">' + list.map((x) => '<li><a data-route href="/app/projects/' + x.slug + '">' + x.name + '</a> <small>' + x.open + ' open issues</small></li>').join("") + '</ul></div>';
  } else if ((m = p.match(/^\\/app\\/projects\\/(\\w+)$/))) {
    root.innerHTML = '<div class="card">Loading issues…</div>';
    if (!window.IssueList) await load("/static/issues.js");
    const issues = await (await fetch("/api/projects/" + m[1] + "/issues")).json();
    root.innerHTML = IssueList(m[1], issues);
  } else if ((m = p.match(/^\\/app\\/projects\\/(\\w+)\\/issues\\/(\\d+)$/))) {
    root.innerHTML = '<div class="card">Loading issue…</div>';
    const x = await (await fetch("/api/projects/" + m[1] + "/issues/" + m[2])).json();
    root.innerHTML = '<div class="card"><p><a data-route href="/app/projects/' + m[1] + '">← ' + x.project + '</a></p><h1>#' + x.number + ' ' + x.title + '</h1><p>Reporter: ' + x.reporter + '</p><p>Assignee: ' + x.assignee + '</p><p>' + x.body + '</p></div>';
  } else root.innerHTML = '<div class="card">Not found</div>';
}
render();`);

const ISSUES_JS = `window.IssueList = (slug, issues) => '<div class="card"><p><a data-route href="/app/projects">← Projects</a></p><h1>' + (slug === "apollo" ? "Apollo" : "Hermes") + ' issues</h1><ul class="plain">' + issues.map((i) => '<li><a data-route href="/app/projects/' + slug + '/issues/' + i.number + '">#' + i.number + ' ' + i.title + '</a></li>').join("") + '</ul></div>';`;

const ISSUE_TITLES = ["Crash when exporting large files", "Login fails on Safari", "Dark mode colors are off", "Search ignores accents", "Slow dashboard on first load", "Typo in onboarding email", "Avatar upload rotates photos", "Keyboard trap in modal", "Timezone shown as UTC", "Broken link in footer", "CSV import drops last row", "Notifications arrive twice"];
const issuesFor = (slug: string) => ISSUE_TITLES.map((t, i) => ({ number: 37 + i, title: slug === "apollo" ? t : [...ISSUE_TITLES].reverse()[i] }));
const PEOPLE = ["Dana Whitfield", "Ian Brooks", "Priya Natarajan", "Tomás Ferreira", "Mara Ortiz", "Kenji Sato"];
const issue = (slug: string, n: number) => ({
  project: slug === "apollo" ? "Apollo" : "Hermes", number: n,
  title: issuesFor(slug).find((i) => i.number === n)?.title ?? "Unknown",
  reporter: slug === "apollo" && n === 42 ? "Dana Whitfield" : PEOPLE[(n * 5) % PEOPLE.length],
  assignee: slug === "apollo" && n === 42 ? "Mara Ortiz" : slug === "hermes" && n === 42 ? "Ian Brooks" : PEOPLE[(n * 7) % PEOPLE.length],
  body: "Steps to reproduce are in the linked report.",
});

// T2: a two-step signup with validation, a custom date picker, plan choice and terms.
const SIGNUP = page("Create account", `
<div class="card" id="step1"><h1>Create your account</h1>
  <label for="email">Email</label><input id="email" type="email" autocomplete="off" style="width:100%"><div class="error" id="email-error"></div>
  <label for="password">Password</label><input id="password" type="password" style="width:100%"><div class="error" id="password-error"></div>
  <small>At least 12 characters, including a number.</small><p><button class="primary" id="next" disabled>Next</button></p></div>
<div class="card" id="step2" hidden><h1>A few details</h1>
  <label>Date of birth</label>
  <div style="position:relative"><button type="button" id="dob">Select date</button>
    <div id="picker" hidden style="position:absolute;z-index:2;background:#fff;border:1px solid #c9ced6;border-radius:10px;padding:12px;top:44px;width:300px">
      <div style="display:flex;gap:8px;align-items:center;justify-content:space-between">
        <button type="button" id="prev" aria-label="Previous month">‹</button><strong id="month-label"></strong>
        <select id="year" aria-label="Year"></select><button type="button" id="nextm" aria-label="Next month">›</button></div>
      <div id="grid" style="display:grid;grid-template-columns:repeat(7,1fr);gap:4px;margin-top:10px"></div></div></div>
  <label>Plan</label>
  <div role="radiogroup" aria-label="Plan" style="display:flex;gap:8px">${["Starter", "Team", "Enterprise"].map((p) => `<div role="radio" aria-checked="false" tabindex="0" class="plan card" style="margin:0;padding:10px 14px;cursor:pointer" data-plan="${p}">${p}</div>`).join("")}</div>
  <p><label style="display:flex;gap:8px;align-items:center;font-weight:400"><span style="position:relative;display:inline-block;width:20px;height:20px;border:2px solid #2457d6;border-radius:5px"><input type="checkbox" id="terms" style="position:absolute;inset:0;opacity:0;margin:0"><span id="tick" hidden style="position:absolute;inset:2px;background:#2457d6;border-radius:2px"></span></span>I accept the terms of service</label></p>
  <div class="error" id="submit-error"></div><button class="primary" id="submit">Create account</button></div>
<div class="card" id="done" hidden></div>`, `
const $ = (id) => document.getElementById(id);
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
let view = { y: 2000, m: 0 }, dob = null, plan = null;
function validate() {
  const e = $("email").value, p = $("password").value;
  $("email-error").textContent = e && !/^[^@\\s]+@[^@\\s]+\\.[a-z]{2,}$/i.test(e) ? "Enter a valid email address." : "";
  $("password-error").textContent = p && !(p.length >= 12 && /\\d/.test(p)) ? "Password must be at least 12 characters and include a number." : "";
  $("next").disabled = !(e && p && !$("email-error").textContent && !$("password-error").textContent);
}
$("email").addEventListener("input", validate); $("password").addEventListener("input", validate);
$("next").onclick = () => { $("step1").hidden = true; $("step2").hidden = false; };
for (let y = 2026; y >= 1920; y--) $("year").add(new Option(y, y));
function draw() {
  $("month-label").textContent = MONTHS[view.m]; $("year").value = view.y;
  const days = new Date(view.y, view.m + 1, 0).getDate(), first = new Date(view.y, view.m, 1).getDay();
  $("grid").innerHTML = "<span></span>".repeat(first) + Array.from({ length: days }, (_, i) => '<button type="button" class="day" aria-label="' + (i + 1) + " " + MONTHS[view.m] + " " + view.y + '">' + (i + 1) + "</button>").join("");
}
$("dob").onclick = () => { $("picker").hidden = !$("picker").hidden; draw(); };
$("prev").onclick = () => { view.m--; if (view.m < 0) { view.m = 11; view.y--; } draw(); };
$("nextm").onclick = () => { view.m++; if (view.m > 11) { view.m = 0; view.y++; } draw(); };
$("year").onchange = () => { view.y = +$("year").value; draw(); };
$("grid").onclick = (e) => { const b = e.target.closest(".day"); if (!b) return; dob = { d: +b.textContent, m: view.m + 1, y: view.y }; $("dob").textContent = b.getAttribute("aria-label"); $("picker").hidden = true; };
document.querySelectorAll(".plan").forEach((el) => el.onclick = () => { plan = el.dataset.plan; document.querySelectorAll(".plan").forEach((o) => { o.setAttribute("aria-checked", String(o === el)); o.style.borderColor = o === el ? "#2457d6" : ""; }); });
$("terms").onchange = () => { $("tick").hidden = !$("terms").checked; };
$("submit").onclick = async () => {
  if (!dob || !plan || !$("terms").checked) { $("submit-error").textContent = "Choose a date of birth and a plan, and accept the terms."; return; }
  const r = await fetch("/api/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: $("email").value, password: $("password").value, dob, plan, terms: true }) });
  const { code } = await r.json();
  $("step2").hidden = true; $("done").hidden = false; $("done").innerHTML = "<h1>Welcome!</h1><p>Your confirmation code is <strong>" + code + "</strong>.</p>";
};`);

// T3: delete with a native confirm dialog.
const DRAFTS = page("Drafts", `<div class="card"><h1>Drafts</h1><ul class="plain" id="list"></ul></div>`, `
const list = document.getElementById("list");
async function load() {
  const drafts = await (await fetch("/api/drafts")).json();
  list.innerHTML = drafts.map((d) => '<li style="display:flex;justify-content:space-between;align-items:center"><span>Draft ' + d + '</span><button data-id="' + d + '">Delete</button></li>').join("") || "<li>No drafts.</li>";
}
list.onclick = async (e) => {
  const b = e.target.closest("button[data-id]"); if (!b) return;
  if (!confirm('Delete "Draft ' + b.dataset.id + '"? This cannot be undone.')) return;
  await fetch("/api/drafts/" + b.dataset.id, { method: "DELETE" }); load();
};
load();`);

// T4: a styled file picker.
const AVATAR = page("Profile picture", `<div class="card"><h1>Profile picture</h1>
<p><img id="preview" alt="Current profile picture" width="96" height="96" style="border-radius:50%;background:#dfe3ea"></p>
<label class="btn" style="display:inline-block;font-weight:400">Choose image<input id="file" type="file" accept="image/png" style="position:absolute;width:1px;height:1px;opacity:0"></label>
<button class="primary" id="upload" disabled>Upload</button><p id="status"></p></div>`, `
const f = document.getElementById("file"), up = document.getElementById("upload");
f.onchange = () => { const file = f.files[0]; if (!file) return; document.getElementById("preview").src = URL.createObjectURL(file); up.disabled = false; };
up.onclick = async () => { up.disabled = true; const r = await fetch("/api/avatar", { method: "POST", body: f.files[0] }); document.getElementById("status").textContent = r.ok ? "Profile picture updated." : "Upload failed."; };`);

// T5: a board where cards move only by dragging with a pointer.
const BOARD = page("Board", `<div class="card"><h1>Sprint board</h1><div id="cols" style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px"></div></div>`, `
const COLS = { todo: "To do", doing: "In progress", done: "Done" }, NAMES = { "write-docs": "Write docs", "fix-login": "Fix login", "ship-v2": "Ship v2", "update-deps": "Update dependencies" };
const cols = document.getElementById("cols");
async function load() {
  const board = await (await fetch("/api/board")).json();
  cols.innerHTML = Object.entries(COLS).map(([k, t]) => '<section data-col="' + k + '" style="background:#eef1f5;border-radius:8px;padding:10px;min-height:260px"><h2 style="font-size:14px;margin:0 0 8px">' + t + '</h2>' + Object.entries(board).filter(([, c]) => c === k).map(([id]) => '<div class="task" data-id="' + id + '" style="background:#fff;border:1px solid #d5dae1;border-radius:6px;padding:10px;margin-bottom:8px;cursor:grab;touch-action:none;user-select:none">' + NAMES[id] + '</div>').join("") + '</section>').join("");
}
let drag = null;
cols.addEventListener("pointerdown", (e) => { const t = e.target.closest(".task"); if (!t) return; drag = { t, x: e.clientX, y: e.clientY, moving: false }; t.setPointerCapture(e.pointerId); });
cols.addEventListener("pointermove", (e) => {
  if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!drag.moving && Math.hypot(dx, dy) > 6) { drag.moving = true; drag.t.style.position = "relative"; drag.t.style.zIndex = 5; drag.t.style.boxShadow = "0 6px 18px rgba(0,0,0,.18)"; }
  if (drag.moving) drag.t.style.transform = "translate(" + dx + "px," + dy + "px)";
});
cols.addEventListener("pointerup", async (e) => {
  if (!drag) return; const d = drag; drag = null; if (!d.moving) return;
  d.t.style.visibility = "hidden"; const under = document.elementFromPoint(e.clientX, e.clientY); d.t.style.visibility = "";
  const col = under && under.closest("section[data-col]");
  if (col) await fetch("/api/board", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: d.t.dataset.id, column: col.dataset.col }) });
  load();
});
load();`);

// T6: a map drawn on a canvas; markers exist only as pixels.
const MAP = page("Stations", `<div class="card"><h1>Stations</h1><p>Select a marker to see the station.</p>
<div style="display:flex;gap:16px;align-items:flex-start"><canvas id="map" width="800" height="500" style="width:560px;height:350px;border-radius:8px"></canvas>
<aside id="panel" class="card" style="margin:0;flex:1">No station selected.</aside></div></div>`, `
const c = document.getElementById("map"), g = c.getContext("2d");
const M = ${JSON.stringify(MARKERS.map(({ id, color, x, y }) => ({ id, color, x, y })))};
g.fillStyle = "#e8eef3"; g.fillRect(0, 0, 800, 500); g.strokeStyle = "#cfd8e0";
for (let i = 0; i < 800; i += 40) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 500); g.stroke(); }
for (let j = 0; j < 500; j += 40) { g.beginPath(); g.moveTo(0, j); g.lineTo(800, j); g.stroke(); }
g.strokeStyle = "#9fb3c8"; g.lineWidth = 10; g.beginPath(); g.moveTo(0, 260); g.bezierCurveTo(250, 180, 520, 420, 800, 300); g.stroke();
for (const m of M) { g.beginPath(); g.arc(m.x, m.y, 16, 0, 7); g.fillStyle = m.color; g.fill(); g.lineWidth = 4; g.strokeStyle = "#fff"; g.stroke(); }
c.onclick = async (e) => {
  const r = c.getBoundingClientRect(), x = (e.clientX - r.left) * 800 / r.width, y = (e.clientY - r.top) * 500 / r.height;
  const hit = M.find((m) => Math.hypot(m.x - x, m.y - y) <= 20); if (!hit) return;
  const s = await (await fetch("/api/stations/" + hit.id)).json();
  document.getElementById("panel").innerHTML = "<h2>" + s.name + "</h2><p>Bikes available: " + s.bikes + "</p>";
};`);

// T7: a gift card widget from another origin, in a frame.
const REDEEM = (widget: string) => page("Redeem a gift card", `<div class="card"><h1>Redeem a gift card</h1><p>Enter your code in the secure form below.</p>
<iframe src="${widget}/widget" title="Gift card" style="width:100%;height:190px;border:1px solid #e3e6eb;border-radius:8px"></iframe></div>`);
const WIDGET = `<!doctype html><html><head><meta charset="utf-8"><style>${CSS} body{background:#fff;padding:16px}</style></head><body>
<label for="code">Gift code</label><input id="code" autocomplete="off"> <button class="primary" id="redeem">Redeem</button><p id="msg"></p>
<script>document.getElementById("redeem").onclick = async () => { const r = await fetch("/redeem", { method: "POST", body: document.getElementById("code").value }); document.getElementById("msg").textContent = r.ok ? "Redeemed: $25 credit added." : "That code is not valid."; };</script></body></html>`;

// T8: a custom country picker whose long list only renders the rows in view.
const SETTINGS = page("Settings", `<div class="card"><h1>Settings</h1>
<label id="country-label">Country</label>
<div style="position:relative;width:320px"><button type="button" id="country" role="combobox" aria-labelledby="country-label" aria-expanded="false" aria-controls="options" style="width:100%;text-align:left">Choose a country</button>
<div id="pop" hidden style="position:absolute;z-index:2;top:44px;width:100%;background:#fff;border:1px solid #c9ced6;border-radius:8px">
<div id="options" role="listbox" style="height:240px;overflow-y:auto;position:relative"><div id="spacer"></div></div></div></div>
<p><button class="primary" id="save">Save</button> <span id="saved"></span></p></div>`, `
const ALL = ${JSON.stringify(COUNTRIES)}, ROW = 32;
const box = document.getElementById("options"), spacer = document.getElementById("spacer"), btn = document.getElementById("country");
let chosen = null;
spacer.style.height = ALL.length * ROW + "px";
function paint() {
  const first = Math.max(0, Math.floor(box.scrollTop / ROW) - 2), last = Math.min(ALL.length, first + Math.ceil(240 / ROW) + 4);
  box.querySelectorAll("[role=option]").forEach((o) => o.remove());
  for (let i = first; i < last; i++) { const o = document.createElement("div"); o.setAttribute("role", "option"); o.textContent = ALL[i]; o.style.cssText = "position:absolute;left:0;right:0;height:" + ROW + "px;padding:6px 10px;cursor:pointer;top:" + i * ROW + "px"; o.onclick = () => { chosen = ALL[i]; btn.textContent = chosen; document.getElementById("pop").hidden = true; btn.setAttribute("aria-expanded", "false"); }; box.append(o); }
}
box.onscroll = paint;
btn.onclick = () => { const p = document.getElementById("pop"); p.hidden = !p.hidden; btn.setAttribute("aria-expanded", String(!p.hidden)); paint(); };
document.getElementById("save").onclick = async () => { const r = await fetch("/api/settings", { method: "PUT", body: JSON.stringify({ country: chosen }) }); document.getElementById("saved").textContent = r.ok ? "Saved." : ""; };`);

// T9: an overflow menu that opens on hover only.
const REPORTS = page("Reports", `<div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><h1>Q3 reports</h1>
<div id="more" style="position:relative"><span class="btn" style="display:inline-block">More ▾</span>
<div id="menu" hidden style="position:absolute;right:0;top:40px;background:#fff;border:1px solid #c9ced6;border-radius:8px;min-width:160px;z-index:3">
${["Print", "Export CSV", "Archive"].map((x) => `<div class="item" style="padding:8px 12px;cursor:pointer">${x}</div>`).join("")}</div></div></div>
<table style="width:100%;border-collapse:collapse"><tr><th align="left">Region</th><th align="right">Revenue</th></tr>
${[["North", "$412,300"], ["South", "$298,110"], ["East", "$351,870"], ["West", "$377,450"]].map(([r, v]) => `<tr><td>${r}</td><td align="right">${v}</td></tr>`).join("")}</table></div>`, `
const more = document.getElementById("more"), menu = document.getElementById("menu"); let t;
more.onmouseenter = () => { clearTimeout(t); menu.hidden = false; };
more.onmouseleave = () => { t = setTimeout(() => { menu.hidden = true; }, 200); };
menu.onclick = async (e) => {
  const item = e.target.closest(".item"); if (!item) return; menu.hidden = true;
  const path = { "Export CSV": "/api/export.csv", "Archive": "/api/archive", "Print": "/api/print" }[item.textContent];
  await fetch(path, { method: "POST" });
  const n = document.createElement("div"); n.className = "toast"; n.textContent = item.textContent + " started."; document.body.append(n); setTimeout(() => n.remove(), 2500);
};`);

// T10: orders that load in pages as you scroll.
const ORDERS = page("Orders", `<div class="card"><h1>Orders</h1><ul class="plain" id="list"></ul><p id="sentinel">Loading more…</p></div>`, `
let next = 1250, busy = false;
const list = document.getElementById("list");
async function more() {
  if (busy || next < 1001) return; busy = true;
  const rows = await (await fetch("/api/orders?from=" + next)).json(); next -= rows.length;
  list.insertAdjacentHTML("beforeend", rows.map((o) => '<li style="display:flex;justify-content:space-between"><span>Order #' + o.n + '</span><span>' + o.total + '</span></li>').join(""));
  busy = false;
  const s = document.getElementById("sentinel").getBoundingClientRect(); if (s.top < innerHeight) more();
}
new IntersectionObserver((e) => { if (e[0].isIntersecting) more(); }).observe(document.getElementById("sentinel"));`);

// T11: checkout whose order request fails, with an error that disappears.
const CHECKOUT = page("Checkout", `<div class="card"><h1>Checkout</h1><ul class="plain"><li>Trail Pack 30L — $89.00</li><li>Water bottle — $18.00</li><li><strong>Total: $107.00</strong></li></ul>
<p><button class="primary" id="place">Place order</button></p><div id="result"></div></div>`, `
const b = document.getElementById("place");
b.onclick = async () => {
  b.disabled = true; b.textContent = "Placing order…";
  const r = await fetch("/api/orders", { method: "POST" });
  b.disabled = false; b.textContent = "Place order";
  if (r.ok) { const { number } = await r.json(); document.getElementById("result").textContent = "Order " + number + " placed."; return; }
  const n = document.createElement("div"); n.className = "toast"; n.textContent = "Something went wrong. Please try again."; document.body.append(n); setTimeout(() => n.remove(), 1500);
};`);

// T12: a preference that says it saved but does not persist.
const PREFS = page("Notifications", `<div class="card"><h1>Notifications</h1>
<div style="display:flex;align-items:center;gap:12px"><span id="email-label">Email notifications</span>
<button type="button" role="switch" id="email" aria-labelledby="email-label" aria-checked="true" style="width:52px;height:30px;border-radius:15px;padding:0;position:relative"><span id="knob" style="position:absolute;top:3px;width:22px;height:22px;border-radius:50%;background:#2457d6"></span></button></div>
<p><button class="primary" id="save">Save</button> <span id="saved"></span></p></div>`, `
const s = document.getElementById("email"), knob = document.getElementById("knob");
const show = (on) => { s.setAttribute("aria-checked", String(on)); knob.style.left = on ? "27px" : "3px"; knob.style.background = on ? "#2457d6" : "#9aa3af"; };
fetch("/api/preferences").then((r) => r.json()).then((p) => show(p.email));
s.onclick = () => show(s.getAttribute("aria-checked") !== "true");
document.getElementById("save").onclick = async () => { const r = await fetch("/api/preferences", { method: "PUT", body: JSON.stringify({ email: s.getAttribute("aria-checked") === "true" }) }); document.getElementById("saved").textContent = r.ok ? "Saved ✓" : "Could not save."; };`);

// T13: a landing page with six planted defects and none of the other kinds.
const AUDIT = page("Northwind Trail Pack", `
<section class="card"><h1>Northwind Trail Pack</h1>
<img src="/static/hero.png" width="600" height="240" style="max-width:100%;height:auto;border-radius:8px">
<p>A 30-litre pack for long days on the trail. Weatherproof, light, and built to last.</p>
<div style="display:flex;gap:8px;align-items:center"><input id="q" placeholder="Search gear" aria-label="Search gear">
<button id="search-btn" style="width:40px;height:40px;padding:8px"><svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="8" cy="8" r="6" stroke="#1d2330" stroke-width="2" fill="none"/><path d="M13 13l5 5" stroke="#1d2330" stroke-width="2"/></svg></button></div>
<p style="color:#b9bdc4;font-size:14px">Terms apply to free returns.</p></section>
<section class="card"><h2>Compare sizes</h2><div><table style="min-width:640px;border-collapse:collapse"><tr><th align="left">Size</th><th>Volume</th><th>Weight</th><th>Torso</th><th>Price</th></tr>
<tr><td>Small</td><td>26 L</td><td>1.1 kg</td><td>38–45 cm</td><td>$84</td></tr><tr><td>Medium</td><td>30 L</td><td>1.2 kg</td><td>43–50 cm</td><td>$89</td></tr></table></div></section>
<section class="card"><h2>Recommended for you</h2><div id="recs">Loading…</div></section>`, `
console.error("Analytics failed to initialise: missing site key");
fetch("/api/recommendations").then((r) => { document.getElementById("recs").textContent = r.ok ? "…" : "No recommendations right now."; });`);

// T14: a cart whose checkout button a promo bar covers, on phones only.
const CART = page("Cart", `<div class="card"><h1>Your cart</h1><ul class="plain"><li>Trail Pack 30L — $89.00</li></ul><p><strong>Subtotal: $89.00</strong></p></div>
<div id="checkout-row"><button class="primary" id="checkout" style="width:100%;padding:14px">Checkout</button></div>
<div id="promo">Free shipping on orders over $100 — <a href="#">Shop more</a></div>`, "", `<style>
#promo{background:#fff4d6;border-top:1px solid #f0d58a;padding:14px 20px;text-align:center}
@media (max-width:600px){ html,body{height:100%;overflow:hidden} #checkout-row{position:fixed;left:16px;right:16px;bottom:24px} #promo{position:fixed;left:0;right:0;bottom:0;height:88px;z-index:4} }
</style>`);

// ---- server -------------------------------------------------------------------

export interface Workbench { base: string; widget: string; state: State; reset(): void; stop(): void }

export function startWorkbench(): Workbench {
  let state = fresh();
  const html = (s: string) => new Response(s, { headers: { "content-type": "text/html; charset=utf-8" } });
  const json = (v: unknown, status = 200) => Response.json(v, { status });

  const widgetServer = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/widget") return html(WIDGET);
      if (url.pathname === "/redeem" && req.method === "POST") {
        const code = (await req.text()).trim();
        state.redeemed.push(code);
        return code === "ARGUS-2026" ? new Response("ok") : new Response("invalid", { status: 422 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const widget = `http://127.0.0.1:${widgetServer.port}`;

  const app = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const url = new URL(req.url), p = url.pathname, m = req.method;
      if (p === "/app" || p.startsWith("/app/")) return html(SPA);
      if (p === "/static/issues.js") { await sleep(900); return new Response(ISSUES_JS, { headers: { "content-type": "text/javascript" } }); }
      if (p === "/static/hero.png") return new Response(Bun.file(join(ASSETS, "hero.png")));
      if (p === "/api/projects") { await sleep(400); return json([{ slug: "apollo", name: "Apollo", open: 12 }, { slug: "hermes", name: "Hermes", open: 12 }]); }
      let r;
      if ((r = p.match(/^\/api\/projects\/(apollo|hermes)\/issues$/))) { await sleep(300); return json(issuesFor(r[1]!)); }
      if ((r = p.match(/^\/api\/projects\/(apollo|hermes)\/issues\/(\d+)$/))) { await sleep(500); state.issueViews.push(`${r[1]}/${r[2]}`); return json(issue(r[1]!, Number(r[2]))); }

      if (p === "/signup") return html(SIGNUP);
      if (p === "/api/signup" && m === "POST") { await sleep(400); state.signup = await req.json(); state.signupCode = `WB-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; return json({ code: state.signupCode }); }

      if (p === "/drafts") return html(DRAFTS);
      if (p === "/api/drafts") return json(state.drafts);
      if ((r = p.match(/^\/api\/drafts\/(\d+)$/)) && m === "DELETE") { state.drafts = state.drafts.filter((d) => d !== Number(r![1])); return json({ ok: true }); }

      if (p === "/avatar") return html(AVATAR);
      if (p === "/api/avatar" && m === "POST") { state.avatarSha = createHash("sha256").update(new Uint8Array(await req.arrayBuffer())).digest("hex"); return json({ ok: true }); }

      if (p === "/board") return html(BOARD);
      if (p === "/api/board" && m === "GET") return json(state.board);
      if (p === "/api/board" && m === "PATCH") { const { id, column } = await req.json() as { id: string; column: string }; if (id in state.board) state.board[id] = column; return json(state.board); }

      if (p === "/map") return html(MAP);
      if ((r = p.match(/^\/api\/stations\/(st-\d)$/))) { const s = MARKERS.find((x) => x.id === r![1]); if (!s) return json({}, 404); state.stationViews.push(s.id); return json({ name: s.name, bikes: (s.x + s.y) % 17 }); }

      if (p === "/redeem") return html(REDEEM(widget));

      if (p === "/settings") return html(SETTINGS);
      if (p === "/api/settings" && m === "PUT") { state.country = (await req.json() as { country: string | null }).country; return json({ ok: true }); }

      if (p === "/reports") return html(REPORTS);
      if (p === "/api/export.csv" && m === "POST") { state.exports++; return new Response("region,revenue\n"); }
      if (p === "/api/archive" && m === "POST") { state.archives++; return json({ ok: true }); }
      if (p === "/api/print" && m === "POST") return json({ ok: true });

      if (p === "/orders") return html(ORDERS);
      if (p === "/api/orders" && m === "GET") { await sleep(300); const from = Number(url.searchParams.get("from") ?? 1250); return json(Array.from({ length: 20 }, (_, i) => from - i).filter((n) => n > 1000).map((n) => ({ n, total: orderTotal(n) }))); }

      if (p === "/checkout") return html(CHECKOUT);
      if (p === "/api/orders" && m === "POST") { await sleep(600); state.orderAttempts++; return json({ error: "payment service unavailable" }, 500); }

      if (p === "/preferences") return html(PREFS);
      if (p === "/api/preferences" && m === "GET") return json({ email: true });
      if (p === "/api/preferences" && m === "PUT") { state.prefsSaves++; return json({ saved: true }); }

      if (p === "/audit") return html(AUDIT);
      if (p === "/api/recommendations") return json({ error: "not found" }, 404);

      if (p === "/cart") return html(CART);
      if (p === "/favicon.ico") return new Response(null, { status: 204 });
      return new Response("not found", { status: 404 });
    },
  });

  return {
    base: `http://127.0.0.1:${app.port}`, widget,
    get state() { return state; },
    reset() { state = fresh(); },
    stop() { app.stop(true); widgetServer.stop(true); },
  };
}
