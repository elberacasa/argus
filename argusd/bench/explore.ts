// Print the outline an agent gets for each UI Testing Playground page.
import { Service } from "../src/rpc/service";
import { tmpdir } from "node:os";
const pages = process.argv.slice(2);
const service = new Service({ traceDir: `${tmpdir()}/argus-bench-trace` });
try {
  for (const p of pages) {
    const { lane } = await service.call("lane.open", { kind: "throwaway", url: `http://uitestingplayground.com/${p}` }) as { lane: string };
    const { outline, tokens } = await service.call("scene.outline", { lane, budget: 400 }) as { outline: string; tokens: number };
    console.log(`== ${p} (${tokens} tokens)\n${outline}\n`);
    await service.call("lane.close", { lane });
  }
} finally {
  await service.shutdown();
}
