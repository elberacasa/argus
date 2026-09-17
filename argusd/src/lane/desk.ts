// The desk, from the daemon's side: a Hyprland monitor only agents use.
//
// Bringing the desk up (the headless monitor, its workspace, the window rule
// that routes every argus-desk window there silently) is done by the desk
// commands, which are measured and tested; the daemon asks for it and then
// launches a headful Chromium whose windows carry the argus-desk class.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { argusRoot } from "../os/omarchy";

export const DESK_CLASS = "argus-desk";

/** Chromium flags for a desk browser: a real Wayland window the desk rule routes. */
export const DESK_BROWSER_ARGS = ["--ozone-platform=wayland", `--class=${DESK_CLASS}`, "--window-size=1280,800", "--no-default-browser-check"];

/** A desk is possible here: a Hyprland session and the desk commands. */
export function deskAvailable(): boolean {
  if (!process.env.HYPRLAND_INSTANCE_SIGNATURE || !process.env.WAYLAND_DISPLAY) return false;
  try {
    return existsSync(join(argusRoot(), "bin", "argus-legacy"));
  } catch {
    return false;
  }
}

/** Bring the desk up (idempotent). Rejects with the desk command's own message. */
export async function ensureDesk(): Promise<void> {
  const p = Bun.spawn([join(argusRoot(), "bin", "argus-legacy"), "desk", "up"], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error((err || out).trim() || "the desk could not be brought up");
}
