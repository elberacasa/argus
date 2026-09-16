#!/usr/bin/env python3
# A native GTK4 app for testing app lanes: a to-do list with an entry, an Add
# button, a checkbox and a status label. Its application id is chosen by the
# caller so the compositor can route it (argus-desk goes to the invisible desk).
#
#   test/fixture-app.py [app-id]

import sys

import gi

gi.require_version("Gtk", "4.0")
from gi.repository import Gtk  # noqa: E402

APP_ID = sys.argv[1] if len(sys.argv) > 1 else "argus-desk"


def build(app: Gtk.Application) -> None:
    win = Gtk.ApplicationWindow(application=app, title="Argus fixture app")
    win.set_default_size(640, 420)
    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12, margin_top=24, margin_bottom=24, margin_start=24, margin_end=24)

    heading = Gtk.Label(label="Groceries", xalign=0)
    heading.add_css_class("title-1")
    box.append(heading)

    row = Gtk.Box(spacing=8)
    entry = Gtk.Entry(placeholder_text="New item", hexpand=True)
    entry.update_property([Gtk.AccessibleProperty.LABEL], ["New item"])
    add = Gtk.Button(label="Add")
    row.append(entry)
    row.append(add)
    box.append(row)

    items = Gtk.ListBox()
    box.append(items)

    urgent = Gtk.CheckButton(label="Urgent")
    box.append(urgent)

    status = Gtk.Label(label="0 items", xalign=0)
    box.append(status)

    def on_add(*_: object) -> None:
        text = entry.get_text().strip()
        if not text:
            status.set_label("Nothing to add")
            return
        items.append(Gtk.Label(label=("! " if urgent.get_active() else "") + text, xalign=0))
        entry.set_text("")
        count = sum(1 for _ in items)
        status.set_label(f"{count} item{'s' if count != 1 else ''}")

    add.connect("clicked", on_add)
    entry.connect("activate", on_add)
    win.set_child(box)
    win.present()


app = Gtk.Application(application_id=None)
# GTK derives the Wayland app id from the program name when there is no
# application id; set it explicitly so window rules can match it.
from gi.repository import GLib  # noqa: E402

GLib.set_prgname(APP_ID)
app.connect("activate", build)
app.run([sys.argv[0]])
