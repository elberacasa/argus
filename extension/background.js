// Argus bridge -- lets argus drive tabs it opens in this browser.
//
// The browser is the person's own: their logins, their tabs. So the bridge is
// built around one rule -- argus may only act on tabs it opened itself -- and
// every other design choice follows from making that rule hard to break:
//
//   - There is no remote-debugging port. Commands arrive over a native
//     messaging host, which Chromium launches only for this extension ID, and
//     which listens on a socket only the same user can open.
//   - Every command names a lane, never a tab id. A lane maps to a tab this
//     extension created; there is no way to address any other tab.
//   - Argus tabs sit in a group titled "Argus". Chromium itself shows the
//     "is debugging this browser" banner while attached; cancelling it detaches
//     the debugger, and the lane is forgotten rather than silently re-attached.

const HOST = "com.omarchy.argus";
const GROUP = { title: "Argus", color: "cyan" };
const PROTOCOL = "1.3";

let port = null;

// Browser events argus needs to observe what an action did, forwarded only for
// tabs this extension opened. Anything else the debugger reports stays here.
const FORWARDED = new Set([
  "Runtime.consoleAPICalled", "Runtime.exceptionThrown", "Runtime.executionContextCreated", "Runtime.executionContextsCleared",
  "Log.entryAdded", "Page.loadEventFired", "Page.frameStartedLoading", "Page.javascriptDialogOpening", "Page.lifecycleEvent",
  "Network.requestWillBeSent", "Network.responseReceived", "Network.loadingFinished", "Network.loadingFailed",
]);

function laneOf(tabId) {
  for (const [lane, id] of lanes) if (id === tabId) return lane;
  return null;
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!port || !FORWARDED.has(method)) return;
  const lane = laneOf(source.tabId);
  if (lane === null) return;
  port.postMessage({ event: { lane, method, params } });
});
const lanes = new Map();      // lane -> tabId, for tabs this extension created
const attached = new Set();   // tabIds with the debugger attached

// ---- lane bookkeeping, restored across service-worker restarts ----------------
// storage.session survives the worker being suspended but not a browser
// restart, which is right: a restarted browser has no argus tabs to own.
async function restore() {
  const { argusLanes = {} } = await chrome.storage.session.get("argusLanes");
  for (const [lane, tabId] of Object.entries(argusLanes)) {
    try { await chrome.tabs.get(tabId); lanes.set(lane, tabId); } catch { /* tab is gone */ }
  }
}
function persist() {
  return chrome.storage.session.set({ argusLanes: Object.fromEntries(lanes) });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
  for (const [lane, id] of lanes) if (id === tabId) lanes.delete(lane);
  persist();
});

// Cancelling Chromium's debugging banner lands here. That is the person saying
// stop, so the lane is released rather than re-attached on the next command.
chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
  attached.delete(tabId);
  const lane = laneOf(tabId);
  if (lane !== null) port?.postMessage({ event: { lane, method: "Argus.detached", params: { reason } } });
  if (reason === "canceled_by_user") {
    for (const [lane, id] of lanes) if (id === tabId) lanes.delete(lane);
    persist();
  }
});

// Returns true when this call attached a new debugger session. Scripts argus
// registers (the probe) belong to a debugger session, so a fresh attach -- after
// the service worker was suspended, say -- means they must be installed again.
async function ensureAttached(tabId) {
  if (attached.has(tabId)) return false;
  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL);
  } catch (e) {
    // Already attached by this extension from before a worker restart.
    if (!String(e.message || e).includes("Another debugger is already attached")) throw e;
    attached.add(tabId);
    return false;
  }
  attached.add(tabId);
  return true;
}

function tabOf(lane) {
  const tabId = lanes.get(String(lane));
  if (tabId === undefined) throw new Error(`no argus tab for lane ${lane} (open it first)`);
  return tabId;
}

async function settledTab(tabId, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === "complete") return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function groupIntoArgus(tabId) {
  const groups = await chrome.tabGroups.query({ title: GROUP.title });
  const tab = await chrome.tabs.get(tabId);
  const sameWindow = groups.find((g) => g.windowId === tab.windowId);
  const groupId = await chrome.tabs.group({ tabIds: [tabId], ...(sameWindow ? { groupId: sameWindow.id } : {}) });
  await chrome.tabGroups.update(groupId, GROUP);
}

// ---- operations argus can request ---------------------------------------------
const ops = {
  async hello() {
    return { version: chrome.runtime.getManifest().version, lanes: Object.fromEntries(lanes) };
  },

  // Open the lane's tab, or reuse it. Background tabs do not steal the
  // person's focus; the tab joins the Argus group so it is always identifiable.
  async lane_open({ lane }) {
    lane = String(lane);
    if (lanes.has(lane)) {
      const tabId = lanes.get(lane);
      try { await chrome.tabs.get(tabId); const fresh = await ensureAttached(tabId); return { tabId, reused: true, fresh }; }
      catch { lanes.delete(lane); }
    }
    const tab = await chrome.tabs.create({ url: "about:blank", active: false });
    // Defensive: let the initial blank document commit before attaching, so
    // nothing registered for the next page is racing it. (A first-load failure
    // that looked like this race turned out to be stale extension code cached
    // under an unchanged version; this wait was not shown to be required.)
    await settledTab(tab.id);
    await groupIntoArgus(tab.id);
    await ensureAttached(tab.id);
    lanes.set(lane, tab.id);
    await persist();
    return { tabId: tab.id, reused: false, fresh: true };
  },

  async lane_close({ lane }) {
    const tabId = tabOf(lane);
    if (attached.has(tabId)) await chrome.debugger.detach({ tabId }).catch(() => {});
    await chrome.tabs.remove(tabId);
    return { closed: true };
  },

  // Raw CDP, scoped to the lane's own tab and nothing else.
  async cdp({ lane, method, params }) {
    const tabId = tabOf(lane);
    await ensureAttached(tabId);
    return (await chrome.debugger.sendCommand({ tabId }, method, params || {})) ?? {};
  },

  async lanes() {
    const out = {};
    for (const [lane, tabId] of lanes) {
      try { const t = await chrome.tabs.get(tabId); out[lane] = { tabId, url: t.url, title: t.title }; } catch {}
    }
    return out;
  },
};

// ---- native messaging -----------------------------------------------------------
async function onRequest(msg) {
  const { id, op } = msg || {};
  try {
    if (!ops[op]) throw new Error(`unknown op: ${op}`);
    port?.postMessage({ id, ok: true, result: await ops[op](msg) });
  } catch (e) {
    port?.postMessage({ id, ok: false, error: String((e && e.message) || e) });
  }
}

function connect() {
  port = chrome.runtime.connectNative(HOST);
  port.onMessage.addListener(onRequest);
  port.onDisconnect.addListener(() => {
    port = null;
    // The host exits when the browser tells it to, or crashes; reconnect after
    // a pause rather than spinning.
    setTimeout(connect, 2000);
  });
}

restore().then(connect);
