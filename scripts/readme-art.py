#!/usr/bin/env python3
"""Generate the README's figures from measured numbers.

    scripts/readme-art.py            writes docs/media/{stats,tokens,diagnosis,nest,architecture}.svg

Every figure is a dark tile in Argus colours, so it reads the same on GitHub's
light and dark themes. Numbers come from docs/performance.md and the benchmark
write-ups; change them there first, then here.
"""

import base64
from html import escape
from pathlib import Path

MEDIA = Path(__file__).resolve().parent.parent / "docs" / "media"

BG = "#101418"
EDGE = "rgba(255,255,255,0.09)"
INK = "#ecebe6"
MUTED = "#98a1a9"
FAINT = "#5d666e"
ACCENT = "#3ccbb8"
RED = "#ff7a7a"
AMBER = "#f0b35a"
GREEN = "#7ed6a0"
SANS = "ui-sans-serif, -apple-system, 'Segoe UI', Inter, Helvetica, Arial, sans-serif"
MONO = "ui-monospace, 'JetBrains Mono', SFMono-Regular, Menlo, Consolas, monospace"


def tile(width: int, height: int, body: str, title: str) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}" role="img">'
        f"<title>{escape(title)}</title>"
        f'<rect x="0.5" y="0.5" width="{width - 1}" height="{height - 1}" rx="18" fill="{BG}" stroke="{EDGE}"/>'
        f"{body}</svg>\n"
    )


def text(x, y, s, size=14, fill=INK, weight=400, family=SANS, anchor="start", extra=""):
    return (f'<text x="{x}" y="{y}" font-family="{family}" font-size="{size}" font-weight="{weight}" '
            f'fill="{fill}" text-anchor="{anchor}" {extra}>{escape(s)}</text>')


def stats() -> str:
    cards = [
        ("10/10", "0 false successes", "UI Testing Playground"),
        ("~105", "tokens per action", "vs 1,334 per screenshot"),
        ("3 ms", "to explain a blocked click", "names what is on top"),
        ("1–2 ms", "real click in a nest", "yours never moves"),
    ]
    w, h, pad, gap = 1000, 168, 20, 14
    cw = (w - pad * 2 - gap * 3) / 4
    body = ""
    for i, (value, label, note) in enumerate(cards):
        x = pad + i * (cw + gap)
        body += f'<rect x="{x:.1f}" y="{pad}" width="{cw:.1f}" height="{h - pad * 2}" rx="12" fill="rgba(255,255,255,0.03)" stroke="{EDGE}"/>'
        body += text(x + 18, pad + 56, value, 38, ACCENT if i == 0 else INK, 700)
        body += text(x + 18, pad + 86, label, 15, INK, 600)
        body += text(x + 18, pad + 110, note, 11.5, MUTED)
    return tile(w, h, body, "Argus in four measured numbers")


def tokens() -> str:
    rows = [
        ("Argus delta: what the click changed", 105, ACCENT),
        ("Re-reading the page as text", 1061, FAINT),
        ("Screenshot, 1280×800", 1334, FAINT),
        ("Screenshot, 1920×1080", 2691, FAINT),
        ("Re-reading raw HTML", 10451, FAINT),
    ]
    w, h = 1000, 330
    left, right, top, row_h = 300, 120, 92, 40
    span = w - left - right
    body = text(28, 46, "Tokens an agent reads to observe one click", 20, INK, 700)
    body += text(28, 70, "news.ycombinator.com · images exact, text at ~4 characters per token", 12.5, MUTED)
    for i, (label, value, color) in enumerate(rows):
        y = top + i * row_h
        bw = max(4, span * value / rows[-1][1])
        body += text(28, y + 21, label, 14, INK if i == 0 else MUTED, 600 if i == 0 else 400)
        body += f'<rect x="{left}" y="{y + 7}" width="{bw:.1f}" height="20" rx="4" fill="{color}"/>'
        body += text(left + bw + 10, y + 22, f"{value:,}", 14, INK if i == 0 else MUTED, 700 if i == 0 else 500)
    body += text(28, h - 22, "An Argus delta is causal: text that appeared or left, fields, failed requests, errors. A screenshot shows the result, not what the click did.", 12, FAINT)
    return tile(w, h, body, "Tokens to observe one click: Argus 105, screenshot 1,334, raw HTML 10,451")


def diagnosis() -> str:
    lines = [
        [("$ ", FAINT), ('argus click "button:Place order"', INK)],
        [("> click ", ACCENT), ("button:Place order", INK)],
        [("  ✗ covered  ", RED), ("button#pay", MUTED)],
        [("  covered by ", MUTED), ("div#scrim", INK), ("  z-index:9998 position:fixed", MUTED)],
        [("  Another element is painted over the target. Dismiss the overlay, then retry.", MUTED)],
        [],
        [("$ ", FAINT), ('argus click "button:Accept"', INK)],
        [("> click ", ACCENT), ("button:Accept", INK), ("                                   291ms", FAINT)],
        [("  − ", RED), ('"This site uses cookies."  "Accept"', MUTED)],
        [],
        [("$ ", FAINT), ('argus click "button:Place order"', INK)],
        [("> click ", ACCENT), ("button:Place order", INK), ("                              289ms", FAINT)],
        [("  + ", GREEN), ('"Order confirmed"  "Order placed. Confirmation sent."', INK)],
        [("  ~ ", AMBER), ("GET /api/receipt  ", MUTED), ("404", RED)],
    ]
    w, line_h, top = 1000, 24, 84
    h = top + len(lines) * line_h + 28
    body = "".join(f'<circle cx="{28 + i * 18}" cy="30" r="5.5" fill="{c}"/>' for i, c in enumerate(["#3a4148", "#3a4148", "#3a4148"]))
    body += text(w / 2, 35, "argus · checkout", 13, MUTED, 500, anchor="middle")
    body += f'<line x1="0" y1="54" x2="{w}" y2="54" stroke="{EDGE}"/>'
    for i, parts in enumerate(lines):
        if not parts:
            continue
        spans = "".join(f'<tspan fill="{c}">{escape(s)}</tspan>' for s, c in parts)
        body += f'<text x="30" y="{top + i * line_h}" font-family="{MONO}" font-size="15" xml:space="preserve">{spans}</text>'
    return tile(w, h, body, "A blocked click is reported as covered, with the element on top named, then recovered")


def nest() -> str:
    png = base64.b64encode((MEDIA / "nest-app.png").read_bytes()).decode()
    w, h = 1000, 470
    iw, ih = 600, 155
    body = text(28, 46, "A native app, driven with its own mouse", 20, INK, 700)
    body += text(28, 70, "GTK app inside a nest · real clicks and keys · every step verified in the accessibility tree", 12.5, MUTED)
    body += f'<rect x="28" y="96" width="{iw + 2}" height="{ih + 2}" rx="8" fill="#000" stroke="{EDGE}"/>'
    body += f'<image x="29" y="97" width="{iw}" height="{ih}" href="data:image/png;base64,{png}" preserveAspectRatio="xMidYMid slice"/>'
    body += text(28, 282, "WHAT THE AGENT DID", 11, FAINT, 700, extra='letter-spacing="1.5"')
    steps = [
        ("click-on", "checkbox:Urgent", "pointer at 32,231 → checked"),
        ("click-on", "text:New item", "pointer at 604,89 → focused"),
        ("type", '"Coffee beans"', "keys into the nest"),
        ("key", "Return", "tree shows 3 items ✓"),
    ]
    for i, (verb, target, result) in enumerate(steps):
        y = 312 + i * 30
        body += text(28, y, verb, 14, ACCENT, family=MONO)
        body += text(118, y, target, 14, INK, family=MONO)
        body += text(290, y, result, 14, MUTED, family=MONO)
    tree = [
        ("frame", "Argus fixture app", ""),
        ("  text", "New item = 'Eggs'", "focused"),
        ("  button", "Add", ""),
        ("  list item", "Oat milk", ""),
        ("  list item", "Sourdough", ""),
        ("  list item", "! Coffee beans", ""),
        ("  list item", "! Blueberries", ""),
        ("  check box", "Urgent", "checked"),
        ("  label", "4 items", ""),
    ]
    x0 = 660
    body += text(x0, 110, "WHAT THE AGENT READS", 11, FAINT, 700, extra='letter-spacing="1.5"')
    for i, (role, name, state) in enumerate(tree):
        y = 140 + i * 27
        st = f'<tspan fill="{GREEN}">  [{escape(state)}]</tspan>' if state else ""
        body += f'<text x="{x0}" y="{y}" font-family="{MONO}" font-size="13.5" xml:space="preserve"><tspan fill="{MUTED}">{escape(role)}:</tspan><tspan fill="{INK}">{escape(name)}</tspan>{st}</text>'
    body += f'<line x1="{x0 - 22}" y1="96" x2="{x0 - 22}" y2="{h - 28}" stroke="{EDGE}"/>'
    return tile(w, h, body, "A native GTK app driven inside a nested desktop, with its accessibility tree")


def architecture() -> str:
    w, h = 1000, 440

    def box(x, y, bw, bh, title, sub, strong=False):
        stroke = ACCENT if strong else EDGE
        fill = "rgba(60,203,184,0.07)" if strong else "rgba(255,255,255,0.03)"
        out = f'<rect x="{x}" y="{y}" width="{bw}" height="{bh}" rx="12" fill="{fill}" stroke="{stroke}" stroke-width="{1.5 if strong else 1}"/>'
        out += text(x + 16, y + 28, title, 15, INK, 700)
        for i, line in enumerate(sub):
            out += text(x + 16, y + 50 + i * 19, line, 12.5, MUTED)
        return out

    def arrow(x1, y1, x2, y2, label="", dashed=False):
        dash = ' stroke-dasharray="5 5"' if dashed else ""
        out = f'<path d="M{x1} {y1} C{(x1 + x2) / 2} {y1} {(x1 + x2) / 2} {y2} {x2} {y2}" fill="none" stroke="{FAINT}" stroke-width="1.5"{dash} marker-end="url(#head)"/>'
        if label:
            out += text((x1 + x2) / 2, (y1 + y2) / 2 - 8, label, 11.5, MUTED, anchor="middle")
        return out

    body = f'<defs><marker id="head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10z" fill="{FAINT}"/></marker></defs>'
    body += text(28, 44, "How Argus fits together", 20, INK, 700)
    agents = ["Claude Code", "opencode", "Codex", "any MCP client"]
    for i, a in enumerate(agents):
        y = 84 + i * 76
        body += f'<rect x="28" y="{y}" width="168" height="56" rx="10" fill="rgba(255,255,255,0.03)" stroke="{EDGE}"/>'
        body += text(112, y + 34, a, 14, INK, 600, anchor="middle")
        body += arrow(196, y + 28, 300, 238)
    body += text(250, 76, "MCP · CLI", 12, MUTED, 600, anchor="middle")
    body += box(304, 150, 290, 176, "argusd", ["Argus Protocol, private socket", "act · check · evidence", "run · sweep · trace", "verified steps, named failures"], strong=True)
    backends = [
        ("Browser lanes", ["isolated contexts, over a pipe"], False),
        ("Desk", ["invisible Hyprland monitor"], True),
        ("Nests", ["nested Hyprland, own mouse"], True),
        ("Your Chromium", ["only tabs Argus opened"], False),
    ]
    for i, (title, sub, live) in enumerate(backends):
        y = 72 + i * 86
        body += box(700, y, 272, 68, title, sub)
        if live:
            body += f'<rect x="878" y="{y + 12}" width="80" height="22" rx="11" fill="rgba(60,203,184,0.12)" stroke="rgba(60,203,184,0.45)"/>'
            body += text(918, y + 27, "live in bar", 11, ACCENT, 600, anchor="middle")
        body += arrow(594, 238, 698, y + 34)
    body += text(28, h - 26, "Desks and nests are watched live from the Omarchy bar, view-only; their work never reaches the person's screen, focus or cursor.", 12.5, MUTED)
    return tile(w, h, body, "Agents connect over MCP or the CLI to argusd, which drives browser lanes, desks, nests and your own Chromium")


if __name__ == "__main__":
    for name, make in {"stats": stats, "tokens": tokens, "diagnosis": diagnosis, "nest": nest, "architecture": architecture}.items():
        (MEDIA / f"{name}.svg").write_text(make())
        print(f"docs/media/{name}.svg")
