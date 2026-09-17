// A minimal Argus client: what the CLI adapter, the MCP adapter and the tests
// use to speak to argusd. One connection, requests matched by id.

import type { Socket } from "bun";

export class ArgusError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
  }
}

export class Client {
  private nextId = 0;
  private buffer = "";
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Set<(method: string, params: Record<string, unknown>) => void>();

  /** What the daemon said about itself in hello. */
  server: { name: string; version: string; build?: string } | null = null;

  private constructor(private socket: Socket<undefined> | null) {}

  static async connect(socketPath: string, client = { name: "argus-client", version: "0.1.0" }): Promise<Client> {
    const c = new Client(null);
    c.socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data: (_s, chunk) => c.receive(chunk.toString()),
        close: () => c.failAll(new Error("argusd closed the connection")),
        error: (_s, error) => c.failAll(error),
      },
    });
    const hello = await c.call<{ server: { name: string; version: string; build?: string } }>("hello", { protocol: "0", client });
    c.server = hello.server;
    return c;
  }

  onEvent(listener: (method: string, params: Record<string, unknown>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.socket!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  close(): void {
    this.socket?.end();
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string; data?: unknown } };
      if (message.id === undefined && message.method) {
        for (const l of this.listeners) l(message.method, message.params ?? {});
        continue;
      }
      const pending = this.pending.get(message.id as number);
      if (!pending) continue;
      this.pending.delete(message.id as number);
      if (message.error) pending.reject(new ArgusError(message.error.code, message.error.message, message.error.data));
      else pending.resolve(message.result);
    }
  }

  private failAll(error: Error): void {
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }
}
