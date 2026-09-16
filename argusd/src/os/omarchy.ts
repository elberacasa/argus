// The Omarchy command catalogue, served progressively.
//
// 367 visible commands would cost ~15k tokens as a flat tool list. Served as a
// group index, then a group, then one command's detail, the whole operating
// system costs an agent a couple of hundred tokens to discover. The catalogue
// is built by bin/argus-manifest from each command's `# omarchy:` metadata and
// cached until Omarchy updates. Destructive commands (lib/danger.txt) run only
// with explicit confirmation.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface OmarchyCommand { name: string; group: string; summary: string; args?: string; examples?: string[] }

const OMARCHY_BIN = process.env.OMARCHY_BIN ?? "/usr/share/omarchy/bin";

/** The Argus checkout: from the source tree, or from a compiled binary in argusd/dist. */
export function argusRoot(): string {
  if (process.env.ARGUS_ROOT) return process.env.ARGUS_ROOT;
  for (const candidate of [resolve(import.meta.dir, "../../.."), resolve(dirname(process.execPath), "../..")])
    if (existsSync(join(candidate, "bin", "argus-manifest"))) return candidate;
  throw new Error("cannot find the Argus checkout; set ARGUS_ROOT");
}

export class Omarchy {
  private commands: OmarchyCommand[] | null = null;
  private danger: Array<[string, string]> | null = null;

  constructor(private readonly root = argusRoot()) {}

  get available(): boolean { return existsSync(OMARCHY_BIN); }

  private load(): OmarchyCommand[] {
    if (this.commands) return this.commands;
    const cache = join(this.root, "run", "manifest.jsonl");
    const stale = !existsSync(cache) || statSync(cache).size === 0 || (existsSync(OMARCHY_BIN) && statSync(OMARCHY_BIN).mtimeMs > statSync(cache).mtimeMs);
    if (stale) {
      const built = spawnSync(join(this.root, "bin", "argus-manifest"), { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      if (built.status === 0 && built.stdout.trim()) {
        mkdirSync(dirname(cache), { recursive: true });
        writeFileSync(cache, built.stdout);
      }
    }
    this.commands = existsSync(cache)
      ? readFileSync(cache, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as OmarchyCommand)
      : [];
    return this.commands;
  }

  private dangerous(name: string): string | null {
    if (!this.danger) {
      this.danger = readFileSync(join(this.root, "lib", "danger.txt"), "utf8").split("\n")
        .map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
        .map((l) => { const [prefix, ...reason] = l.split(/\s+/); return [prefix!, reason.join(" ")] as [string, string]; });
    }
    return this.danger.find(([prefix]) => name.startsWith(prefix))?.[1] ?? null;
  }

  groups(): string {
    const counts = new Map<string, number>();
    for (const c of this.load()) counts.set(c.group, (counts.get(c.group) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]).map(([g, n]) => `${g} (${n})`).join("  ");
  }

  group(name: string): string | null {
    const found = this.load().filter((c) => c.group === name);
    return found.length ? found.map((c) => `${c.name}  -- ${c.summary}`).join("\n") : null;
  }

  help(name: string): string | null {
    const c = this.load().find((x) => x.name === name);
    if (!c) return null;
    const lines = [c.name, `  ${c.summary}`, c.args ? `  usage: ${c.name} ${c.args}` : "  takes no arguments"];
    if (c.examples?.length) lines.push("  examples:", ...c.examples.map((e) => `    ${e}`));
    const danger = this.dangerous(name);
    if (danger) lines.push(`  DESTRUCTIVE: ${danger}`, "  requires confirm:true");
    return lines.join("\n");
  }

  run(name: string, args: string[], confirm: boolean): { ok: boolean; text: string } {
    if (!this.load().some((c) => c.name === name)) return { ok: false, text: `Unknown or hidden command '${name}'.` };
    const danger = this.dangerous(name);
    if (danger && !confirm) return { ok: false, text: `'${name}' is destructive: ${danger}. Explain the change to the user, then retry with confirm:true.` };
    const r = spawnSync(join(OMARCHY_BIN, name), args, { encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    const text = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() || "(no output)";
    return r.status === 0 ? { ok: true, text } : { ok: false, text: `exit ${r.status ?? r.signal}\n${text}` };
  }
}
