// Real tasks on real sites, step by step, and where each step's time goes.
//
//   bun bench/flows.ts            ROUNDS=3 KIND=throwaway|own
//
// Every flow ends in an expectation that only holds if the task happened, so
// a fast wrong answer shows up as a failure, not a good time.

import { tmpdir } from "node:os";
import { Service } from "../src/rpc/service";
import { lastStepPhases } from "../src/act/executor";
import type { ActResult, Step } from "../src/protocol/types";

const flows: Array<{ name: string; steps: Step[] }> = [
  {
    name: "Wikipedia search",
    steps: [
      { open: "https://en.wikipedia.org/wiki/Main_Page" },
      { type: [{ role: "searchbox" }, "Unix philosophy"] },
      { press: "Enter", expect: { url: { matches: "Unix_philosophy" } } },
    ],
  },
  {
    name: "Hacker News to new",
    steps: [
      { open: "https://news.ycombinator.com/" },
      { click: { role: "link", name: "new" }, expect: { url: { matches: "newest" } } },
    ],
  },
  {
    name: "GitHub repo to issues",
    steps: [
      { open: "https://github.com/elberacasa/argus" },
      { click: { role: "link", name: "Issues" }, expect: { url: { matches: "/issues" } } },
    ],
  },
  {
    name: "DuckDuckGo search",
    steps: [
      { open: "https://duckduckgo.com/" },
      { type: [{ role: "combobox" }, "omarchy"] },
      { press: "Enter", expect: { url: { matches: "q=omarchy" } } },
    ],
  },
];

const KIND = (process.env.KIND ?? "throwaway") as "throwaway" | "own";
const ROUNDS = Number(process.env.ROUNDS ?? 3);
const service = new Service({ traceDir: `${tmpdir()}/argus-flows-trace` });
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const verbOf = (s: Step) => Object.keys(s).find((k) => k !== "id" && k !== "expect")!;

try {
  const warm = await service.call("lane.open", { kind: KIND }) as { lane: string };
  await service.call("lane.close", { lane: warm.lane });
  for (const flow of flows) {
    const stepMs: number[][] = flow.steps.map(() => []);
    const phases: Array<Map<string, number[]>> = flow.steps.map(() => new Map());
    const failures: string[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      const { lane } = await service.call("lane.open", { kind: KIND }) as { lane: string };
      for (const [i, step] of flow.steps.entries()) {
        const t = performance.now();
        const r = await service.call("act", { lane, steps: [step] }) as ActResult;
        stepMs[i]!.push(Math.round(performance.now() - t));
        for (const [name, v] of lastStepPhases) (phases[i]!.get(name) ?? phases[i]!.set(name, []).get(name)!).push(v);
        if (!r.ok) { failures.push(`round ${round + 1} step ${i + 1}: ${r.steps[0]?.diagnosis?.reason} ${r.steps[0]?.diagnosis?.hint}`); break; }
      }
      await service.call("lane.close", { lane });
    }
    const total = stepMs.reduce((s, xs) => s + (xs.length ? median(xs) : 0), 0);
    console.log(`\n${flow.name}: ${total}ms (median steps summed), ${ROUNDS - new Set(failures.map((f) => f.split(" step")[0])).size}/${ROUNDS} passed`);
    for (const [i, step] of flow.steps.entries()) {
      if (!stepMs[i]!.length) continue;
      const detail = [...phases[i]!].map(([n, xs]) => `${n} ${median(xs)}`).join(" · ");
      console.log(`  ${verbOf(step).padEnd(6)} ${String(median(stepMs[i]!)).padStart(5)}ms  ${detail}`);
    }
    for (const f of failures) console.log(`  ✗ ${f}`);
  }
} finally {
  await service.shutdown();
}
