// argusd: the Argus daemon, and a small client for talking to it.
//
//   argusd serve [--socket PATH] [--headful]   run the daemon
//   argusd call METHOD [JSON]                   one request, result as JSON
//   argusd scene URL...                         print the Scene of pages (diagnostic)
//   argusd mcp                                  MCP over stdio (starts the daemon if needed)
//   argusd pointer SOCKET WxH move|click X Y [right|middle]
//                                               a virtual pointer on one compositor (a nested desk)

import { realpathSync } from "node:fs";
import { Browser, Page } from "./cdp/pipe";
import { Client, ArgusError } from "./rpc/client";
import { defaultSocketPath, serve } from "./rpc/server";
import { Service, VERSION } from "./rpc/service";
import { captureScene } from "./scene/snapshot";
import { outline } from "./scene/outline";
import { VirtualPointer, type Button } from "./wayland/pointer";
import { McpServer } from "./mcp/server";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.shift();
  const socketPath = () => flag(args, "--socket") ?? process.env.ARGUS_SOCKET ?? defaultSocketPath();

  switch (command) {
    case "serve": {
      const headful = args.includes("--headful");
      const service = new Service({ headless: !headful });
      const server = await serve(service, {
        socketPath: socketPath(),
        validateResults: process.env.ARGUSD_VALIDATE_RESULTS === "1",
        log: (line) => { if (process.env.ARGUSD_LOG) console.error(line); },
      });
      console.error(`argusd ${VERSION} listening on ${server.socketPath}`);
      const stop = async () => {
        await server.stop();
        await service.shutdown();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return;
    }

    case "call": {
      const method = args.shift();
      if (!method) throw new Error("usage: argusd call METHOD [JSON]");
      const params = args[0] ? JSON.parse(args[0]) : {};
      const client = await Client.connect(socketPath(), { name: "argusd-call", version: VERSION });
      try {
        console.log(JSON.stringify(await client.call(method, params), null, 2));
      } finally {
        client.close();
      }
      return;
    }

    case "scene": {
      if (!args.length) throw new Error("usage: argusd scene URL...");
      const browser = await Browser.launch();
      try {
        for (const url of args) {
          const page = await Page.open(browser);
          await page.navigate(url);
          const t = performance.now();
          const scene = await captureScene(page);
          const { outline: text, tokens } = await outline(page, scene);
          console.log(`${text}\n(${Math.round(performance.now() - t)}ms, ${tokens} tokens, ${scene.elements.length} elements)\n`);
        }
      } finally {
        await browser.close();
      }
      return;
    }

    case "mcp": {
      const socket = flag(args, "--socket") ?? process.env.ARGUS_SOCKET;
      await new McpServer(socket ? { socketPath: socket } : {}).serveStdio();
      return;
    }

    case "pointer": {
      const [socket, size, action, xs, ys, button] = args;
      const [w, h] = (size ?? "").split("x").map(Number);
      const x = Number(xs), y = Number(ys);
      if (!socket || !w || !h || !["move", "click"].includes(action ?? "") || !Number.isFinite(x) || !Number.isFinite(y))
        throw new Error("usage: argusd pointer SOCKET WxH move|click X Y [right|middle]");
      if (x < 0 || y < 0 || x >= w || y >= h) throw new Error(`(${x}, ${y}) is outside the ${w}x${h} desk`);
      // Never the person's own compositor: its cursor is theirs. Only a nested
      // desk's socket is a valid target.
      const own = process.env.WAYLAND_DISPLAY;
      const runtime = process.env.XDG_RUNTIME_DIR ?? "";
      if (own && (socket === own || realpathSync(socket) === realpathSync(own.startsWith("/") ? own : `${runtime}/${own}`)))
        throw new Error(`refusing to drive ${own}: that is your own session's compositor, not a nested desk`);
      const pointer = await VirtualPointer.connect(socket, { w, h });
      try {
        if (action === "move") await pointer.move(x, y);
        else await pointer.click(x, y, (button as Button | undefined) ?? "left");
      } finally {
        pointer.close();
      }
      return;
    }

    default:
      console.error("usage: argusd serve|call|mcp|scene|pointer");
      process.exit(1);
  }
}

main().catch((error: unknown) => {
  if (error instanceof ArgusError) console.error(`argusd: ${error.message} (${error.code})`);
  else console.error(`argusd: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
