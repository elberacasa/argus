// Reach argusd, starting it when nobody has.
//
// Clients (the MCP server, the CLI) must not need a daemon to be running
// already. If the socket answers, it is used. If not, argusd is started as its
// own session with its output in $XDG_STATE_HOME/argus/argusd.log, and the
// client waits for the socket to answer, up to a limit.

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "./client";
import { defaultSocketPath } from "./server";

/**
 * How to start the daemon: this binary with `serve` when it is the compiled
 * argusd, otherwise bun on argusd's own entry point. Never the running script:
 * a benchmark importing connect() started copies of itself, each of which
 * started another.
 */
function daemonCommand(): string[] {
  const main = join(import.meta.dir, "..", "main.ts");
  if (existsSync(main)) return [process.execPath, main, "serve"];
  return [process.execPath, "serve"];
}

export async function connect(options: { socketPath?: string; name?: string; start?: boolean } = {}): Promise<Client> {
  const socketPath = options.socketPath ?? process.env.ARGUS_SOCKET ?? defaultSocketPath();
  const client = { name: options.name ?? "argus-client", version: "0.1.0" };
  try {
    return await Client.connect(socketPath, client);
  } catch (error) {
    if (options.start === false) throw error;
  }

  // Only one client starts the daemon. Several started at once (three
  // commands in parallel did) each launched their own, and lanes opened in one
  // were missing from the others. The rest wait for the socket.
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  const startLock = `${socketPath}.starting`;
  let starter = false;
  try {
    if (existsSync(startLock) && Date.now() - statSync(startLock).mtimeMs > 15_000) unlinkSync(startLock);
    closeSync(openSync(startLock, "wx", 0o600));
    starter = true;
  } catch { /* someone else is starting it */ }

  if (starter) {
    const stateDir = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "argus");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const log = openSync(join(stateDir, "argusd.log"), "a", 0o600);
    const [command, ...args] = daemonCommand();
    const child = spawn(command!, [...args, "--socket", socketPath], { detached: true, stdio: ["ignore", log, log] });
    child.unref();
  }

  const deadline = performance.now() + 10_000;
  let last: unknown;
  try {
    while (performance.now() < deadline) {
      await Bun.sleep(60);
      if (!existsSync(socketPath)) continue;
      try {
        return await Client.connect(socketPath, client);
      } catch (error) {
        last = error;
      }
    }
  } finally {
    if (starter) try { unlinkSync(startLock); } catch { /* gone */ }
  }
  throw new Error(`argusd did not start within 10s (see $XDG_STATE_HOME/argus/argusd.log; socket ${socketPath})${last ? `: ${String(last)}` : ""}`);
}
