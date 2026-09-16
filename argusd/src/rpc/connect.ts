// Reach argusd, starting it when nobody has.
//
// Clients (the MCP server, the CLI) must not need a daemon to be running
// already. If the socket answers, it is used. If not, argusd is started as its
// own session with its output in $XDG_STATE_HOME/argus/argusd.log, and the
// client waits for the socket to answer, up to a limit.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "./client";
import { defaultSocketPath } from "./server";

/** How to start the daemon: the compiled binary if this is one, otherwise bun on the source. */
function daemonCommand(): string[] {
  const self = process.argv[1] ?? "";
  if (self.endsWith(".ts")) return [process.execPath, self, "serve"];
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

  const stateDir = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "argus");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const log = openSync(join(stateDir, "argusd.log"), "a", 0o600);
  const [command, ...args] = daemonCommand();
  const child = spawn(command!, [...args, "--socket", socketPath], { detached: true, stdio: ["ignore", log, log] });
  child.unref();

  const deadline = performance.now() + 8000;
  let last: unknown;
  while (performance.now() < deadline) {
    await Bun.sleep(60);
    if (!existsSync(socketPath)) continue;
    try {
      return await Client.connect(socketPath, client);
    } catch (error) {
      last = error;
    }
  }
  throw new Error(`argusd did not start within 8s (see ${join(stateDir, "argusd.log")}; socket ${socketPath}, dir ${existsSync(dirname(socketPath))})${last ? `: ${String(last)}` : ""}`);
}
