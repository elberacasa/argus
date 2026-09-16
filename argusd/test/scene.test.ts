import { describe, expect, test } from "bun:test";
import { buildScene } from "../src/scene/snapshot";

const load = async (name: string) => buildScene(await Bun.file(`${import.meta.dir}/fixtures/${name}.snapshot.json`).json());

describe("scene from DOMSnapshot", () => {
  test("reaches into an open shadow root and says so", async () => {
    const scene = await load("uitap-shadowdom");
    const inGenerator = scene.elements.filter((e) => e.shadow === "open");
    expect(inGenerator.map((e) => e.role).sort()).toEqual(["button", "button", "textbox"]);
  });

  test("tells closed shadow roots apart from open ones", async () => {
    const scene = await load("uitap-shadowdom");
    expect(scene.elements.some((e) => e.shadow === "closed")).toBe(true);
    expect(scene.elements.filter((e) => e.shadow === null && e.role === "heading").length).toBeGreaterThan(0);
  });

  test("an icon button with no accessible name keeps an empty name instead of an invented one", async () => {
    const scene = await load("uitap-shadowdom");
    const buttons = scene.elements.filter((e) => e.shadow === "open" && e.role === "button");
    expect(buttons.every((b) => b.name === "")).toBe(true);
  });

  test("returns every nested frame's document in one pass", async () => {
    const scene = await load("uitap-frames");
    expect(scene.documents).toBe(3);
  });

  test("follows frame paths and places frame content in page coordinates", async () => {
    const scene = await load("uitap-frames");
    const outer = scene.elements.filter((e) => e.role === "button" && e.frames.join(">") === "0>1");
    const inner = scene.elements.filter((e) => e.role === "button" && e.frames.join(">") === "0>1>2");
    expect(outer.map((e) => e.name)).toEqual(["Edit", "Submit", "Click me", "Primary"]);
    expect(inner.map((e) => e.name)).toEqual(["Edit", "Submit", "Click me", "Primary"]);
    // The inner frame sits inside the outer one, so its buttons must be lower on the page.
    expect(inner[0]!.bounds!.y).toBeGreaterThan(outer[0]!.bounds!.y);
  });

  test("refs are unique within a scene", async () => {
    for (const name of ["uitap-shadowdom", "uitap-frames"]) {
      const scene = await load(name);
      expect(new Set(scene.elements.map((e) => e.ref)).size).toBe(scene.elements.length);
    }
  });
});
