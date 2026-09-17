// How fast argusd is on real sites, and where the time goes.
//
//   bun bench/speed.ts [url...]
//
// For each site, in a fresh throwaway lane: the browser's own load time (a raw
// navigate to the load event, the floor no tool can beat), then argus's open,
// outline, a no-op step, check and a crop, each with its phases. Every number
// is wall time through the Service, as a client sees it minus the socket.

import { tmpdir } from "node:os";
import { Service } from "../src/rpc/service";
import { lastStepPhases } from "../src/act/executor";
import type { ActResult } from "../src/protocol/types";

const sites = process.argv.slice(2).length ? process.argv.slice(2) : [
  "https://example.com/",
  "https://news.ycombinator.com/",
  "https://en.wikipedia.org/wiki/Web_browser",
  "https://github.com/elberacasa/argus",
  "https://x.com/",
  "https://www.youtube.com/",
];

const service = new Service({ traceDir: `${tmpdir()}/argus-speed-trace` });
const ms = (t: number) => Math.round(performance.now() - t);
const rows: string[] = [];
console.log("| Site | Browser to DOMContentLoaded | argus open | of which settle | outline | no-op step | check | screenshot |");
console.log("|---|---:|---:|---:|---:|---:|---:|---:|");
try {
  // Warm the browser once so the first site does not pay for launching it.
  const warm = await service.call("lane.open", { kind: (process.env.KIND ?? "throwaway") as "throwaway" | "own" }) as { lane: string };
  await service.call("lane.close", { lane: warm.lane });

  const ROUNDS = Number(process.env.ROUNDS ?? 3);
  // KIND=own measures a tab in the person's own browser through the extension;
  // there is no separate "browser alone" load to compare, so that column is 0.
  const KIND = (process.env.KIND ?? "throwaway") as "throwaway" | "own";
  const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]!;
  for (const url of sites) {
    const m: Record<string, number[]> = { load: [], open: [], settle: [], outline: [], noop: [], check: [], shot: [] };
    let tokens = 0;
    // Interleaved rounds: the browser alone, then argus, so network swings hit both.
    for (let round = 0; round < ROUNDS; round++) {
      let t = performance.now();
      if (KIND === "throwaway") {
        const raw = await service.call("lane.open", { kind: "throwaway" }) as { lane: string };
        t = performance.now();
        await service.lanes.get(raw.lane).page.navigate(url, 30_000);
        m.load!.push(ms(t));
        await service.call("lane.close", { lane: raw.lane });
      } else m.load!.push(0);

      const { lane } = await service.call("lane.open", { kind: KIND }) as { lane: string };
      t = performance.now();
      const open = await service.call("act", { lane, steps: [{ open: url }] }) as ActResult;
      m.open!.push(ms(t));
      m.settle!.push(lastStepPhases.find(([n]) => n === "settle")?.[1] ?? 0);
      void open;
      t = performance.now(); tokens = (await service.call("scene.outline", { lane }) as { tokens: number }).tokens; m.outline!.push(ms(t));
      t = performance.now(); await service.call("act", { lane, steps: [{ press: "Shift" }] }); m.noop!.push(ms(t));
      t = performance.now(); await service.call("check", { lane }); m.check!.push(ms(t));
      t = performance.now(); await service.call("evidence.shot", { lane }); m.shot!.push(ms(t));
      await service.call("lane.close", { lane });
    }
    const f = (k: string) => `${median(m[k]!)}`;
    const line = `| ${url.replace(/^https:\/\//, "")} | ${f("load")} | ${f("open")} | ${f("settle")} | ${f("outline")} (${tokens} tok) | ${f("noop")} | ${f("check")} | ${f("shot")} |`;
    console.log(line);
    rows.push(line);
  }
} finally {
  await service.shutdown();
}
