// A virtual pointer for one Wayland compositor, spoken on the wire directly.
//
// Pointer input is the part of computer use a shared desktop cannot give an
// agent: the compositor has one cursor, and moving it moves the person's. A
// desk that runs its own compositor (a nested Hyprland) has its own seat and
// its own cursor, and wlr-virtual-pointer-unstable-v1 drives that cursor with
// clicks the application cannot tell from a mouse. Connecting to the nested
// compositor's socket -- never the person's -- is what keeps this contained.
//
// No library: the Wayland wire format is small. Each message is a sender
// object id, then (size << 16 | opcode), then arguments; integers are
// little-endian 32-bit and strings are length-prefixed, NUL-terminated and
// padded to 4 bytes.

import type { Socket } from "bun";

const BTN = { left: 0x110, right: 0x111, middle: 0x112 } as const;
export type Button = keyof typeof BTN;

class Writer {
  private parts: number[] = [];
  u32(v: number): this { this.parts.push(v >>> 0); return this; }
  fixed(v: number): this { this.parts.push(Math.round(v * 256) | 0); return this; }
  string(s: string): this {
    const bytes = new TextEncoder().encode(s + "\0");
    this.u32(bytes.length);
    const padded = new Uint8Array(Math.ceil(bytes.length / 4) * 4);
    padded.set(bytes);
    const view = new DataView(padded.buffer);
    for (let i = 0; i < padded.length; i += 4) this.parts.push(view.getUint32(i, true));
    return this;
  }
  message(object: number, opcode: number): Uint8Array {
    const size = 8 + this.parts.length * 4;
    const buf = new ArrayBuffer(size);
    const view = new DataView(buf);
    view.setUint32(0, object, true);
    view.setUint32(4, (size << 16) | opcode, true);
    this.parts.forEach((p, i) => view.setUint32(8 + i * 4, p, true));
    return new Uint8Array(buf);
  }
}

export class VirtualPointer {
  private nextId = 2;
  private buffer = new Uint8Array(0);
  private readonly globals = new Map<string, { name: number; version: number }>();
  private readonly callbacks = new Map<number, () => void>();
  private pointerId = 0;
  private error: Error | null = null;
  private readonly start = performance.now();

  private constructor(private readonly socket: Socket<undefined>, private readonly extent: { w: number; h: number }) {}

  /**
   * Connect to a compositor by socket path and create a pointer whose absolute
   * coordinates span `extent` (the nested desk's output size).
   */
  static async connect(socketPath: string, extent: { w: number; h: number }): Promise<VirtualPointer> {
    let self: VirtualPointer | null = null;
    const socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data: (_s, chunk) => self?.receive(new Uint8Array(chunk)),
        close: () => { if (self) self.error ??= new Error("compositor closed the connection"); },
      },
    });
    self = new VirtualPointer(socket, extent);
    const registry = self.nextId++;
    self.send(1, 1, new Writer().u32(registry)); // wl_display.get_registry
    await self.roundtrip();
    const manager = self.globals.get("zwlr_virtual_pointer_manager_v1");
    if (!manager) throw new Error("this compositor offers no virtual pointer (zwlr_virtual_pointer_manager_v1)");
    const managerId = self.nextId++;
    const version = Math.min(manager.version, 2);
    self.send(registry, 0, new Writer().u32(manager.name).string("zwlr_virtual_pointer_manager_v1").u32(version).u32(managerId)); // wl_registry.bind
    self.pointerId = self.nextId++;
    self.send(managerId, 0, new Writer().u32(0).u32(self.pointerId)); // create_virtual_pointer(seat: default)
    await self.roundtrip();
    if (self.error) throw self.error;
    return self;
  }

  /** Move to viewport pixels on the nested desk. */
  async move(x: number, y: number): Promise<void> {
    this.send(this.pointerId, 1, new Writer().u32(this.time()).u32(Math.round(x)).u32(Math.round(y)).u32(this.extent.w).u32(this.extent.h));
    this.send(this.pointerId, 4, new Writer()); // frame
    await this.roundtrip();
  }

  async click(x: number, y: number, button: Button = "left"): Promise<void> {
    await this.move(x, y);
    this.send(this.pointerId, 2, new Writer().u32(this.time()).u32(BTN[button]).u32(1));
    this.send(this.pointerId, 4, new Writer());
    this.send(this.pointerId, 2, new Writer().u32(this.time()).u32(BTN[button]).u32(0));
    this.send(this.pointerId, 4, new Writer());
    await this.roundtrip();
  }

  async scroll(dy: number): Promise<void> {
    this.send(this.pointerId, 3, new Writer().u32(this.time()).u32(0).fixed(dy)); // axis: vertical
    this.send(this.pointerId, 4, new Writer());
    await this.roundtrip();
  }

  close(): void {
    if (this.pointerId) this.send(this.pointerId, 8, new Writer()); // destroy
    this.socket.end();
  }

  private time(): number {
    return Math.round(performance.now() - this.start);
  }

  private send(object: number, opcode: number, w: Writer): void {
    this.socket.write(w.message(object, opcode));
  }

  /** wl_display.sync: resolves once the compositor has processed everything sent so far. */
  private roundtrip(): Promise<void> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("compositor did not answer")), 2000);
      this.callbacks.set(id, () => { clearTimeout(timer); this.error ? reject(this.error) : resolve(); });
      this.send(1, 0, new Writer().u32(id));
    });
  }

  private receive(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    let offset = 0;
    const view = new DataView(merged.buffer);
    while (merged.length - offset >= 8) {
      const object = view.getUint32(offset, true);
      const header = view.getUint32(offset + 4, true);
      const size = header >>> 16, opcode = header & 0xffff;
      if (size < 8 || merged.length - offset < size) break;
      const args = new DataView(merged.buffer, offset + 8, size - 8);
      const readString = (at: number) => {
        const len = args.getUint32(at, true);
        const text = new TextDecoder().decode(new Uint8Array(merged.buffer, offset + 8 + at + 4, Math.max(0, len - 1)));
        return { text, next: at + 4 + Math.ceil(len / 4) * 4 };
      };
      if (object === 1 && opcode === 0) {
        // wl_display.error(object, code, message)
        const { text } = readString(8);
        this.error = new Error(`wayland error on object ${args.getUint32(0, true)} (code ${args.getUint32(4, true)}): ${text}`);
      } else if (object === 2 && opcode === 0) {
        // wl_registry.global(name, interface, version)
        const name = args.getUint32(0, true);
        const { text, next } = readString(4);
        this.globals.set(text, { name, version: args.getUint32(next, true) });
      } else if (this.callbacks.has(object) && opcode === 0) {
        const done = this.callbacks.get(object)!;
        this.callbacks.delete(object);
        done();
      }
      offset += size;
    }
    this.buffer = merged.slice(offset);
  }
}
