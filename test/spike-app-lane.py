#!/usr/bin/env python3
# Spike: can an agent see and operate a native app on a desktop nobody is
# looking at, without touching the person's focus or screen?
#
# Measures three things on the invisible desk (a Hyprland headless output):
#   eyes   grim captures the headless output directly
#   tree   AT-SPI reads the app's accessibility tree (roles, names, states)
#   hands  AT-SPI actions and editable text where the app exposes them; where it
#          does not (a GTK4 check box has no action), keys sent by Hyprland to
#          that one window -- no focus change, no pointer
# and asserts the person's active window and workspace never changed. Every
# effect is verified by reading the tree again, never assumed from a call.
#
# Requires `argus desk up`. Starts the fixture app itself and stops exactly
# that process afterwards.

import json
import os
import subprocess
import sys
import time

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.environ.get("ARGUS_SPIKE_OUT", "/tmp")


def hypr(*args: str):
    return json.loads(subprocess.run(["hyprctl", "-j", *args], capture_output=True, text=True, check=True).stdout)


def person_state():
    # The cursor is not compared: the person may be using the mouse. Nothing
    # here moves it; keys go to a window, not to the pointer.
    w = hypr("activewindow")
    return {"window": w.get("address") if isinstance(w, dict) else None, "workspace": hypr("activeworkspace")["id"]}


def send_key(address: str, key: str, mods: str = "") -> None:
    # hl.dsp.send_shortcut delivers a key to one window without focusing it. An
    # unknown window is an error, never a fallback to whatever has focus.
    lua = f'return hl.dispatch(hl.dsp.send_shortcut({{mods="{mods}", key="{key}", window="address:{address}"}}))'
    out = subprocess.run(["hyprctl", "eval", lua], capture_output=True, text=True).stdout.strip()
    if out not in ("ok", ""):
        raise RuntimeError(f"send_shortcut {key}: {out}")


def actions(node):
    a = node.get_action_iface()
    return [Atspi.Action.get_action_name(a, i) for i in range(Atspi.Action.get_n_actions(a))] if a else []


def ms(t0: float) -> int:
    return round((time.perf_counter() - t0) * 1000)


def walk(node, depth=0, out=None):
    out = [] if out is None else out
    if node is None or depth > 40:
        return out
    out.append((depth, node))
    for i in range(node.get_child_count()):
        walk(node.get_child_at_index(i), depth + 1, out)
    return out


def find(nodes, role, name=None):
    for _, n in nodes:
        if n.get_role_name() == role and (name is None or n.get_name() == name):
            return n
    return None


def main() -> int:
    desk = json.load(open(os.path.join(os.environ["XDG_RUNTIME_DIR"], "argus", "desk.json")))
    output = desk["output"]
    before = person_state()
    print(f"person before: {before}")

    t0 = time.perf_counter()
    app = subprocess.Popen([sys.executable, os.path.join(ROOT, "test", "fixture-app.py"), "argus-desk"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        window = None
        for _ in range(100):
            window = next((c for c in hypr("clients") if c["pid"] == app.pid), None)
            if window and window["mapped"]:
                break
            time.sleep(0.05)
        assert window, "fixture window never mapped"
        mon = next(m for m in hypr("monitors", "all") if m["id"] == window["monitor"])
        print(f"window mapped {ms(t0)}ms on monitor {mon['name']} workspace {window['workspace']['name']}")
        assert mon["name"] == output, f"window landed on {mon['name']}, not the desk {output}"

        # ---- tree
        t = time.perf_counter()
        desktop = Atspi.get_desktop(0)
        accessible = None
        for _ in range(100):
            for i in range(desktop.get_child_count()):
                a = desktop.get_child_at_index(i)
                if a is not None and a.get_process_id() == app.pid:
                    accessible = a
            if accessible:
                break
            time.sleep(0.05)
        assert accessible, "app never appeared on the accessibility bus"
        nodes = walk(accessible)
        print(f"tree: {len(nodes)} nodes in {ms(t)}ms")
        for depth, n in nodes:
            if n.get_role_name() in ("label", "button", "entry", "text", "check box", "heading", "list"):
                print(f"  {'  ' * min(depth, 6)}{n.get_role_name()}:{n.get_name()!r}")

        # ---- eyes: the compositor's frame. PNG compression dominates (about
        # 620ms at 1080p); the capture itself is about 13ms as PPM, so encode
        # crops, not whole frames.
        t = time.perf_counter()
        shot = os.path.join(OUT, "argus-app-lane-before.ppm")
        subprocess.run(["grim", "-t", "ppm", "-o", output, shot], check=True)
        print(f"eyes: captured {output} in {ms(t)}ms -> {shot}")

        # ---- hands
        entry = find(nodes, "text", "New item") or find(nodes, "entry", "New item")
        add = find(nodes, "button", "Add")
        urgent = find(nodes, "check box", "Urgent")
        assert entry and add and urgent, f"controls not found: entry={entry} add={add} urgent={urgent}"

        address = window["address"]
        t = time.perf_counter()
        editable = entry.get_editable_text_iface()
        assert editable, "entry has no editable text interface"
        editable.set_text_contents("Oat milk")
        print(f"hands: text set through EditableText in {ms(t)}ms")

        # The check box exposes no action, so it is reached with keys: Tab
        # from the entry, then Space. Verified below by its CHECKED state.
        print(f"  check box actions: {actions(urgent) or 'none'}; add button actions: {actions(add)}")
        t = time.perf_counter()
        send_key(address, "Tab")
        send_key(address, "Tab")
        send_key(address, "space")
        checked = False
        for _ in range(40):
            if urgent.get_state_set().contains(Atspi.StateType.CHECKED):
                checked = True
                break
            time.sleep(0.025)
        assert checked, "check box did not become checked"
        print(f"hands: check box checked with window-targeted keys in {ms(t)}ms (verified)")

        t = time.perf_counter()
        add.get_action_iface().do_action(actions(add).index("click"))
        print(f"hands: Add clicked through its AT-SPI action in {ms(t)}ms")

        # verify through the tree, not by trusting the calls
        status = None
        for _ in range(40):
            nodes = walk(accessible)
            labels = [n.get_name() for _, n in nodes if n.get_role_name() == "label"]
            if "! Oat milk" in labels and "1 item" in labels:
                status = labels
                break
            time.sleep(0.05)
        assert status, "effect not observed in the tree"
        print(f"verified: '! Oat milk' listed, status '1 item' ({ms(t)}ms incl. verify)")

        t = time.perf_counter()
        shot2 = os.path.join(OUT, "argus-app-lane-after.ppm")
        subprocess.run(["grim", "-t", "ppm", "-o", output, shot2], check=True)
        print(f"eyes: after capture {ms(t)}ms -> {shot2}")
    finally:
        os.killpg(app.pid, 15)
        app.wait(timeout=5)

    after = person_state()
    print(f"person after:  {after}")
    assert before == after, "the person's focus or workspace changed"
    print("person untouched: yes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
