// One headless Claude Code session with one browser tool, as the benchmarks run it.

import { writeFileSync } from "node:fs";

export interface SessionResult {
  answer: string;
  claimed: "success" | "failure" | "none";
  tools: number;
  seconds: number;
  cost: number;
  input: number;
  output: number;
}

export const ENDING = `Do the task, check the outcome with the tools, then end your reply with exactly one final line: "RESULT: success" if the task's success condition was met, or "RESULT: failure" if it was not or you could not tell.`;

/**
 * Run `claude -p` asynchronously (a daemon or fixture server may live in the
 * caller's process and must keep answering), save the stream-json transcript,
 * and read the answer, the RESULT line, tool calls, time, tokens and cost.
 */
export async function runSession(o: { prompt: string; model: string; flags: string[]; cwd: string; transcript: string; timeoutMs?: number }): Promise<SessionResult> {
  const t0 = performance.now();
  const child = Bun.spawn(["claude", "-p", o.prompt, "--model", o.model, "--tools", "", ...o.flags,
    "--setting-sources", "", "--no-session-persistence", "--output-format", "stream-json", "--verbose"],
  { cwd: o.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const killer = setTimeout(() => child.kill(), o.timeoutMs ?? 600_000);
  const stdout = await new Response(child.stdout).text();
  await child.exited;
  clearTimeout(killer);
  const seconds = Math.round((performance.now() - t0) / 100) / 10;
  writeFileSync(o.transcript, stdout);
  type Event = { type: string; result?: string; usage?: Record<string, number>; total_cost_usd?: number; message?: { content?: Array<{ type: string }> } };
  const events = stdout.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) as Event; } catch { return null; } }).filter((e): e is Event => !!e);
  const final = events.findLast((e) => e.type === "result") ?? ({} as Event);
  const answer = final.result ?? "";
  const tools = events.filter((e) => e.type === "assistant").flatMap((e) => e.message?.content ?? []).filter((b) => b.type === "tool_use").length;
  const claimedMatch = /RESULT:\s*(success|failure)/i.exec(answer.split("\n").filter(Boolean).at(-1) ?? "");
  const u = final.usage ?? {};
  return {
    answer, claimed: (claimedMatch?.[1]?.toLowerCase() ?? "none") as SessionResult["claimed"], tools, seconds,
    cost: final.total_cost_usd ?? 0, output: u.output_tokens ?? 0,
    input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
  };
}
