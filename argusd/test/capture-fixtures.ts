// Record real DOMSnapshot responses so the Scene builder is tested offline,
// against what Chromium actually returns rather than a hand-written guess.
import { Browser, Page } from "../src/cdp/pipe";
const pages = { shadowdom: "http://uitestingplayground.com/shadowdom", frames: "http://uitestingplayground.com/frames" };
const b = await Browser.launch();
try {
  for (const [name, url] of Object.entries(pages)) {
    const p = await Page.open(b);
    await p.navigate(url);
    const snap = await p.send("DOMSnapshot.captureSnapshot", { computedStyles: ["display", "visibility", "opacity"], includeDOMRects: true });
    await Bun.write(`${import.meta.dir}/fixtures/uitap-${name}.snapshot.json`, JSON.stringify(snap));
    console.log(`recorded ${name}: ${snap.documents.length} document(s)`);
  }
} finally { await b.close(); }
