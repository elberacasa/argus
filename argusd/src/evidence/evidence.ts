// Evidence: pixels on demand, always with their price.
//
// Images are written to files under $XDG_RUNTIME_DIR/argus/evidence and
// returned as paths, never inline: an agent that does not need to look pays
// nothing. Every capture reports its size in image tokens, from the published
// formula ceil(w/28) x ceil(h/28).
//
// A screenshot is taken only once the page's images have finished loading and
// its fonts are ready. The prototype captured GitHub's README with broken image
// icons that a real browser showed fine a moment later.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CdpPage as Page } from "../cdp/page";
import type { Scene, SceneElement } from "../scene/snapshot";

export interface Evidence { image: string; w: number; h: number; tokens: number; origin?: { x: number; y: number } }

export const imageTokens = (w: number, h: number) => Math.ceil(w / 28) * Math.ceil(h / 28);

function evidenceDir(): string {
  const dir = join(process.env.XDG_RUNTIME_DIR ?? "/tmp", "argus", "evidence");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Wait for in-viewport images to finish (loaded or failed) and fonts to be ready, up to a limit. */
export async function readyToLook(page: Page, timeoutMs = 3000): Promise<void> {
  await page.send("Runtime.evaluate", {
    expression: `Promise.race([
      Promise.all([
        document.fonts ? document.fonts.ready : null,
        ...[...document.images]
          .filter((i) => { const r = i.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && !i.complete; })
          .map((i) => new Promise((done) => { i.addEventListener("load", done, { once: true }); i.addEventListener("error", done, { once: true }); })),
      ]),
      new Promise((done) => setTimeout(done, ${timeoutMs})),
    ]).then(() => true)`,
    awaitPromise: true,
    returnByValue: true,
  }).catch(() => undefined);
}

async function capture(page: Page, lane: string, kind: string, clip?: { x: number; y: number; width: number; height: number }, full = false, origin?: { x: number; y: number }): Promise<Evidence> {
  await readyToLook(page);
  const { data } = await page.send("Page.captureScreenshot", {
    format: "png",
    ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
    ...(full ? { captureBeyondViewport: true } : {}),
  });
  const bytes = Buffer.from(data, "base64");
  // PNG header: width and height are big-endian at offsets 16 and 20.
  const w = bytes.readUInt32BE(16), h = bytes.readUInt32BE(20);
  const image = join(evidenceDir(), `${lane}-${kind}-${Date.now()}.png`);
  await Bun.write(image, bytes);
  return { image, w, h, tokens: imageTokens(w, h), ...(origin ? { origin } : {}) };
}

export async function shot(page: Page, lane: string, full = false): Promise<Evidence> {
  if (!full) {
    // Always clipped to the viewport: an unclipped capture of a tab the browser
    // is not painting (a background tab in the person's browser) can stall.
    const { cssVisualViewport: vv } = await page.send("Page.getLayoutMetrics");
    return capture(page, lane, "shot", { x: vv.pageX, y: vv.pageY, width: Math.round(vv.clientWidth), height: Math.round(vv.clientHeight) }, false, { x: 0, y: 0 });
  }
  const metrics = await page.send("Page.getLayoutMetrics");
  const { width, height } = metrics.cssContentSize;
  return capture(page, lane, "full", { x: 0, y: 0, width: Math.ceil(width), height: Math.min(Math.ceil(height), 16_000) }, true);
}

/** A crop around one element, including covered or disabled ones: those are the ones worth seeing. */
export async function look(page: Page, lane: string, scene: Scene, element: SceneElement | null, pad = 16): Promise<Evidence> {
  if (!element?.bounds) return shot(page, lane);
  const metrics = await page.send("Page.getLayoutMetrics");
  const { pageX, pageY } = metrics.cssVisualViewport;
  const b = element.bounds;
  // Scene bounds are viewport coordinates; a clip is in page coordinates.
  const x = Math.max(0, b.x - pad + pageX), y = Math.max(0, b.y - pad + pageY);
  const width = Math.min(b.w + pad * 2, scene.viewport.w + pageX - x), height = Math.min(b.h + pad * 2, scene.viewport.h + pageY - y);
  return capture(page, lane, "look", { x, y, width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) }, false, { x: Math.round(x - pageX), y: Math.round(y - pageY) });
}
