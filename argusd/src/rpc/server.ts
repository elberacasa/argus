// The Argus socket: JSON-RPC 2.0, one message per line, over a unix socket
// that only this user can open. No TCP, ever (constitution: no ports).

import { chmodSync, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { Socket } from "bun";
import { ErrorCode, RpcError } from "../protocol/types";
import { checkRequest, checkResult } from "../protocol/validate";
import type { Service } from "./service";

export function defaultSocketPath(): string {
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (!runtime) throw new Error("XDG_RUNTIME_DIR is not set; pass --socket");
  return `${runtime}/argus/argus.sock`;
}

interface Connection { buffer: string; negotiated: boolean; unsubscribe: (() => void) | null }

export interface ServerOptions {
  socketPath: string;
  /** Check every result against the schema too (tests, development). */
  validateResults?: boolean;
  log?: (line: string) => void;
}

export async function serve(service: Service, options: ServerOptions) {
  const { socketPath } = options;
  const log = options.log ?? (() => {});
  const dir = dirname(socketPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700);

  if (existsSync(socketPath)) {
    // A live daemon keeps its socket; a stale file from a crash is replaced.
    const alive = await Bun.connect({ unix: socketPath, socket: { data() {}, open(s) { s.end(); } } }).then(() => true, () => false);
    if (alive) throw new Error(`argusd is already running on ${socketPath}`);
    unlinkSync(socketPath);
  }

  const send = (socket: Socket<Connection>, message: unknown) => {
    socket.write(JSON.stringify(message) + "\n");
  };

  const handle = async (socket: Socket<Connection>, line: string) => {
    let message: { id?: string | number | null; method?: string; params?: Record<string, unknown> };
    try {
      message = JSON.parse(line);
    } catch {
      send(socket, { jsonrpc: "2.0", id: null, error: { code: ErrorCode.parse, message: "not valid JSON" } });
      return;
    }
    const id = message.id ?? null;
    const fail = (code: number, text: string, data?: unknown) =>
      send(socket, { jsonrpc: "2.0", id, error: { code, message: text, ...(data === undefined ? {} : { data }) } });

    if (typeof message !== "object" || message === null || typeof message.method !== "string") return fail(ErrorCode.invalidRequest, "not a JSON-RPC request");
    const method = message.method;
    const invalid = checkRequest(message);
    if (invalid) {
      const known = !/method must be equal to one of the allowed values/.test(invalid);
      return fail(known ? ErrorCode.invalidParams : ErrorCode.methodNotFound, known ? invalid : `unknown method ${method}`);
    }
    if (method !== "hello" && !socket.data.negotiated) return fail(ErrorCode.notNegotiated, "call hello first");

    const t0 = performance.now();
    try {
      if (method === "event.subscribe") {
        const params = message.params as { lanes?: string[] | "all"; kinds: string[] };
        socket.data.unsubscribe?.();
        socket.data.unsubscribe = service.subscribe((event, eventParams) => {
          const kind = event.slice("event.".length);
          const lane = eventParams.lane as string;
          if (!params.kinds.includes(kind)) return;
          if (Array.isArray(params.lanes) && !params.lanes.includes(lane)) return;
          send(socket, { jsonrpc: "2.0", method: event, params: eventParams });
        });
        return send(socket, { jsonrpc: "2.0", id, result: { subscribed: params.kinds } });
      }
      const result = await service.call(method, message.params ?? {});
      if (method === "hello") socket.data.negotiated = true;
      if (options.validateResults) {
        const bad = checkResult(method, result);
        if (bad) return fail(ErrorCode.internal, `argusd produced a result that breaks the protocol: ${bad}`, result);
      }
      send(socket, { jsonrpc: "2.0", id, result });
      log(`${method} ${Math.round(performance.now() - t0)}ms`);
    } catch (error) {
      if (error instanceof RpcError) return fail(error.code, error.message, error.data);
      log(`${method} failed: ${error instanceof Error ? error.stack : String(error)}`);
      fail(ErrorCode.internal, error instanceof Error ? error.message : String(error));
    }
  };

  const listener = Bun.listen<Connection>({
    unix: socketPath,
    socket: {
      open(socket) { socket.data = { buffer: "", negotiated: false, unsubscribe: null }; },
      data(socket, chunk) {
        socket.data.buffer += chunk.toString();
        let nl: number;
        while ((nl = socket.data.buffer.indexOf("\n")) !== -1) {
          const line = socket.data.buffer.slice(0, nl).trim();
          socket.data.buffer = socket.data.buffer.slice(nl + 1);
          if (line) void handle(socket, line);
        }
      },
      close(socket) { socket.data.unsubscribe?.(); },
      error(socket) { socket.data.unsubscribe?.(); },
    },
  });
  chmodSync(socketPath, 0o600);

  return {
    socketPath,
    async stop() {
      listener.stop(true);
      try { unlinkSync(socketPath); } catch { /* gone */ }
    },
  };
}
