// What one call costs on each path: Argus's own browser over a pipe, and a tab
// in the person's Chromium over the extension and its native host.
//
//   bun bench/bridge.ts

import { tmpdir } from "node:os";
import { Service } from "../src/rpc/service";
import { captureScene } from "../src/scene/snapshot";

const service = new Service({ traceDir: `${tmpdir()}/argus-bridge-bench` });
const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const time = async (n: number, f: () => Promise<unknown>) => {
  const out: number[] = [];
  for (let i = 0; i < n; i++) { const t = performance.now(); await f(); out.push(performance.now() - t); }
  return med(out);
};

console.log("| path | one evaluate | one snapshot | outline | no-op step |");
console.log("|---|---:|---:|---:|---:|");
for (const kind of ["throwaway", "own"] as const) {
  const { lane } = await service.call("lane.open", { kind, url: "https://example.com/" }) as { lane: string };
  const ctx = service.lanes.get(lane);
  const evaluate = await time(20, () => ctx.page.send("Runtime.evaluate", { expression: "1", returnByValue: true }));
  const snapshot = await time(10, () => captureScene(ctx.page));
  const outline = await time(5, () => service.call("scene.outline", { lane }));
  const noop = await time(5, () => service.call("act", { lane, steps: [{ press: "Shift" }] }));
  console.log(`| ${kind} | ${evaluate.toFixed(1)} ms | ${snapshot.toFixed(1)} ms | ${outline.toFixed(0)} ms | ${noop.toFixed(0)} ms |`);
  await service.call("lane.close", { lane });
}
await service.shutdown();
