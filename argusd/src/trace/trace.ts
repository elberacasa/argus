// Trace: everything argusd did, as one JSON line per call.
//
// Kept under $XDG_STATE_HOME/argus/trace, one file per day, so a session can be
// read back, audited or replayed after the fact. Secrets are never resolved in
// argusd before approval, so a trace holds a secret's name, never its value.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TraceEntry {
  id: string;
  at: string;
  lane: string | null;
  method: string;
  ok: boolean;
  ms: number;
  params: unknown;
  result: unknown;
}

export class Trace {
  private seq = 0;
  readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "argus", "trace");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  record(method: string, lane: string | null, params: unknown, result: unknown, ok: boolean, ms: number): string {
    const now = new Date();
    const id = `t${now.getTime().toString(36)}${(++this.seq).toString(36)}`;
    const entry: TraceEntry = { id, at: now.toISOString(), lane, method, ok, ms, params, result };
    appendFileSync(join(this.dir, `${now.toISOString().slice(0, 10)}.jsonl`), JSON.stringify(entry) + "\n", { mode: 0o600 });
    return id;
  }

  private files(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((f) => f.endsWith(".jsonl")).sort().reverse().map((f) => join(this.dir, f));
  }

  list(options: { lane?: string; limit?: number } = {}) {
    const limit = options.limit ?? 50;
    const entries: Array<{ id: string; lane: string | null; method: string; ok: boolean; ms: number; at: string }> = [];
    for (const file of this.files()) {
      const lines = readFileSync(file, "utf8").trimEnd().split("\n").reverse();
      for (const line of lines) {
        if (!line) continue;
        const e = JSON.parse(line) as TraceEntry;
        if (options.lane && e.lane !== options.lane) continue;
        entries.push({ id: e.id, lane: e.lane, method: e.method, ok: e.ok, ms: e.ms, at: e.at });
        if (entries.length >= limit) return { entries };
      }
    }
    return { entries };
  }

  get(id: string): TraceEntry | null {
    for (const file of this.files()) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (line.includes(`"id":"${id}"`)) return JSON.parse(line) as TraceEntry;
      }
    }
    return null;
  }
}
