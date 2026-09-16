#!/usr/bin/env python3
# The accessibility tree of one native app, as an agent reads a page outline.
#
#   lib/atspi.py tree PID            role:name @x,y wxh [states], indented
#   lib/atspi.py json PID            the same, as JSON
#   lib/atspi.py find PID ROLE:NAME  the first match, as JSON (exact, then case-insensitive, then substring)
#
# Coordinates are window-relative. On a nested desk the app's window fills the
# desk's only output at 0,0, so they are also the pointer coordinates.

import json
import sys

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi  # noqa: E402

STATES = {
    Atspi.StateType.FOCUSED: "focused", Atspi.StateType.CHECKED: "checked", Atspi.StateType.SELECTED: "selected",
    Atspi.StateType.EXPANDED: "expanded", Atspi.StateType.SENSITIVE: None, Atspi.StateType.EDITABLE: "editable",
}
SKIP_ROLES = {"panel", "filler", "unknown"}


def app_for(pid: int):
    desktop = Atspi.get_desktop(0)
    for i in range(desktop.get_child_count()):
        a = desktop.get_child_at_index(i)
        if a is not None and a.get_process_id() == pid:
            return a
    return None


def nodes(root):
    out = []

    def walk(n, depth):
        if n is None or depth > 60:
            return
        comp = n.get_component_iface()
        e = comp.get_extents(Atspi.CoordType.WINDOW) if comp else None
        ss = n.get_state_set()
        states = [name for st, name in STATES.items() if name and ss.contains(st)]
        if not ss.contains(Atspi.StateType.SENSITIVE) and n.get_role_name() not in ("label", "frame", "application"):
            states.append("disabled")
        role = n.get_role_name()
        item = {"role": role, "name": n.get_name() or "", "depth": depth, "states": states}
        if e and e.width > 0:
            item.update({"x": e.x, "y": e.y, "w": e.width, "h": e.height})
        if n.get_text_iface() is not None and role in ("text", "entry", "password text"):
            item["value"] = Atspi.Text.get_text(n, 0, Atspi.Text.get_character_count(n))
        out.append(item)
        for i in range(n.get_child_count()):
            walk(n.get_child_at_index(i), depth + 1)

    walk(root, 0)
    return out


def find(items, target: str):
    role, _, name = target.partition(":")
    pool = [i for i in items if i["role"].replace(" ", "") == role.replace(" ", "") or i["role"] == role]
    for test in (lambda s: s == name, lambda s: s.lower() == name.lower(), lambda s: name.lower() in s.lower()):
        hits = [i for i in pool if test(i["name"])]
        if hits:
            return hits[0]
    return None


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__ or "usage: atspi.py tree|json|find PID [ROLE:NAME]", file=sys.stderr)
        return 2
    command, pid = sys.argv[1], int(sys.argv[2])
    app = app_for(pid)
    if app is None:
        print(f"no accessible app with pid {pid}", file=sys.stderr)
        return 1
    items = nodes(app)
    if command == "json":
        print(json.dumps(items))
    elif command == "find":
        hit = find(items, sys.argv[3])
        if not hit:
            print(f"no {sys.argv[3]}", file=sys.stderr)
            return 1
        print(json.dumps(hit))
    else:
        for i in items:
            if i["role"] in SKIP_ROLES and not i["name"]:
                continue
            box = f" @{i['x']},{i['y']} {i['w']}x{i['h']}" if "x" in i else ""
            value = f" = {i['value']!r}" if i.get("value") else ""
            states = f" [{', '.join(i['states'])}]" if i["states"] else ""
            print(f"{'  ' * min(i['depth'], 8)}{i['role']}:{i['name']}{value}{box}{states}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
