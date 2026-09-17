#!/usr/bin/env python3
"""Publish a head-to-head run as evidence: logs, images, a chart and panels.

    scripts/h2h-evidence.py <results dir> <name>

<results dir> is what `argusd/bench/h2h.ts` wrote (rows.json and one stream-json
transcript per session). This writes:

    docs/benchmarks/<name>/README.md          results and how to read the logs
    docs/benchmarks/<name>/rows.json          the harness's judged rows
    docs/benchmarks/<name>/runs/*.md          every call, what came back, the images
    docs/benchmarks/<name>/runs/img/*         the images each model was shown
    docs/media/h2h.svg                        time per challenge, both rounds
    docs/media/h2h-<challenge>.png            two sessions side by side (needs rsvg-convert)

Everything shown is taken from the transcripts. Logs drop session metadata
(settings, local paths) and system reminders a tool appends for the model;
long results are truncated and say so.
"""

import base64
import json
import re
import sys
from html import escape
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = Path(sys.argv[1])
NAME = sys.argv[2]
OUT = ROOT / "docs" / "benchmarks" / NAME
MEDIA = ROOT / "docs" / "media"

TOOLS = {"argus": "Argus", "chrome": "Claude in Chrome"}
CHALLENGES = {
    "hiddenlayers": "Hidden Layers", "overlapped": "Overlapped", "visibility": "Visibility", "click": "Click",
    "textinput": "Text Input", "clientdelay": "Client Side Delay", "nbsp": "Non-Breaking Space",
    "scrollbars": "Scrollbars", "shadowdom": "Shadow DOM", "frames": "Frames",
}

# Figures use the README's dark tile; series colours passed the dataviz
# palette validator against this surface (lightness band, CVD, contrast).
BG, EDGE, INK, MUTED, FAINT = "#101418", "rgba(255,255,255,0.09)", "#ecebe6", "#98a1a9", "#5d666e"
GRID = "rgba(255,255,255,0.07)"
SERIES = {"argus": "#199e70", "chrome": "#d95926"}
RED = "#ff7a7a"
SANS = "ui-sans-serif, -apple-system, 'Segoe UI', Inter, Helvetica, Arial, sans-serif"
MONO = "ui-monospace, 'JetBrains Mono', SFMono-Regular, Menlo, Consolas, monospace"


def clean(text: str) -> str:
    text = re.sub(r"<system-reminder>.*?</system-reminder>", "", text, flags=re.S)
    text = re.sub(r"\n*Tab Context:\n(?:- .*\n?|  .*\n?)*", "\n", text)
    text = text.replace(str(Path.home()), "~")
    return text.strip()


def load(tool: str, challenge: str, round_: int):
    """One session as a list of calls: name, input, text results, images; plus the final answer."""
    calls, answer, by_id = [], "", {}
    for line in (SRC / f"{tool}-{challenge}-{round_}.jsonl").read_text().splitlines():
        e = json.loads(line)
        if e.get("type") == "assistant":
            for b in e["message"]["content"]:
                if b["type"] == "tool_use":
                    call = {"name": b["name"].split("__")[-1], "input": b["input"], "texts": [], "images": []}
                    by_id[b["id"]] = call
                    calls.append(call)
        elif e.get("type") == "user" and isinstance(e["message"]["content"], list):
            for b in e["message"]["content"]:
                if b.get("type") != "tool_result" or b.get("tool_use_id") not in by_id:
                    continue
                call = by_id[b["tool_use_id"]]
                parts = b["content"] if isinstance(b["content"], list) else [{"type": "text", "text": str(b["content"])}]
                for p in parts:
                    if p["type"] == "text":
                        t = clean(p["text"])
                        if t:
                            call["texts"].append(t)
                    elif p["type"] == "image":
                        call["images"].append((p["source"]["media_type"], p["source"]["data"]))
        elif e.get("type") == "result":
            answer = clean(e.get("result") or "")
    return calls, answer


def describe(name: str, inp: dict) -> str:
    """A call as one short line, from its input."""
    def one(n, i):
        if n == "computer":
            a = i.get("action", "")
            if "coordinate" in i:
                return f"{a} ({i['coordinate'][0]}, {i['coordinate'][1]})"
            if a == "wait":
                return f"wait {i.get('duration', '')} s"
            if a == "type":
                return f"type {json.dumps(i.get('text', ''))}"
            return a + (f" ×{i['scale']}" if "scale" in i else "")
        if n == "navigate":
            return "navigate " + re.sub(r"^https?://[^/]+", "", i.get("url", ""))
        if n == "find":
            return f"find {json.dumps(i.get('query', ''))}"
        if n == "javascript_tool":
            return "javascript " + json.dumps(i.get("text", ""))[:60]
        if n == "tabs_context_mcp":
            return "tabs_context"
        if n == "browser_open":
            return "open " + re.sub(r"^https?://[^/]+", "", i.get("url", ""))
        if n == "browser_act":
            return "act " + json.dumps(i.get("steps", []))
        rest = json.dumps(i)
        return f"{n.removeprefix('browser_')} {rest}" if rest != "{}" else n.removeprefix("browser_")
    if name == "browser_batch":
        return " → ".join(one(a["name"], a["input"]) for a in inp.get("actions", []))
    return one(name, inp)


def shorten(s: str, n: int) -> str:
    return s if len(s) <= n else s[: n - 1] + "…"


# ---- logs ---------------------------------------------------------------------

def write_logs(rows):
    img_dir = OUT / "runs" / "img"
    img_dir.mkdir(parents=True, exist_ok=True)
    for r in rows:
        tool, ch, rd = r["tool"], r["name"], r["round"]
        calls, answer = load(tool, ch, rd)
        stem = f"{tool}-{ch}-{rd}"
        md = [f"# {TOOLS[tool]} · {CHALLENGES[ch]} · round {rd}", "",
              f"**Goal met (read from the page): {'yes' if r['met'] else 'no'}** ({r['truth']}) · claimed {r['claimed']}"
              f"{' · FALSE SUCCESS' if r['falseSuccess'] else ''} · {r['tools']} tool calls · {r['seconds']} s · ${r['cost']:.3f}", ""]
        k = 0
        for i, c in enumerate(calls, 1):
            md += [f"## {i}. `{c['name']}`", "", "```json", json.dumps(c["input"], indent=2), "```", ""]
            for t in c["texts"]:
                md += ["```", shorten(t, 2000) + ("\n[truncated]" if len(t) > 2000 else ""), "```", ""]
            for mime, data in c["images"]:
                k += 1
                ext = "png" if mime.endswith("png") else "jpg"
                (img_dir / f"{stem}-{k}.{ext}").write_bytes(base64.b64decode(data))
                md += [f"![image {k} returned to the model](img/{stem}-{k}.{ext})", ""]
        md += ["## Final answer", "", "```", answer, "```", ""]
        (OUT / "runs" / f"{stem}.md").write_text("\n".join(md))


# ---- chart --------------------------------------------------------------------

def text(x, y, s, size=13, fill=INK, weight=400, family=SANS, anchor="start"):
    return f'<text x="{x}" y="{y}" font-family="{family}" font-size="{size}" font-weight="{weight}" fill="{fill}" text-anchor="{anchor}">{escape(s)}</text>'


def mark(tool, x, y):
    c = SERIES[tool]
    if tool == "argus":
        return f'<circle cx="{x:.1f}" cy="{y}" r="5" fill="{c}" stroke="{BG}" stroke-width="2"/>'
    return f'<rect x="{x - 4.6:.1f}" y="{y - 4.6}" width="9.2" height="9.2" fill="{c}" stroke="{BG}" stroke-width="2" transform="rotate(45 {x:.1f} {y})"/>'


def chart(rows):
    w, left, right, top = 1000, 190, 40, 150
    row_h = 34
    names = list(CHALLENGES)
    h = top + row_h * len(names) + 60
    xmax = 140
    sx = lambda s: left + (w - left - right) * min(s, xmax) / xmax
    body = [text(28, 44, "Same model, same tasks, same judge", 22, INK, 700),
            text(28, 68, "Claude Opus 5 on UI Testing Playground, two rounds, 20 sessions per tool. Every goal was checked on the page.", 13, MUTED)]
    # totals
    tot = {t: {k: sum(r[k] for r in rows if r["tool"] == t) for k in ("seconds", "cost", "input", "output", "tools")} for t in TOOLS}
    met = {t: sum(r["met"] for r in rows if r["tool"] == t) for t in TOOLS}
    false = {t: sum(r["falseSuccess"] for r in rows if r["tool"] == t) for t in TOOLS}
    cols = [("Goals met", lambda t: f"{met[t]}/20"), ("False successes", lambda t: str(false[t])),
            ("Total time", lambda t: f"{tot[t]['seconds']:.0f} s"), ("Tokens", lambda t: f"{(tot[t]['input'] + tot[t]['output']) / 1000:,.0f}k"),
            ("Cost", lambda t: f"${tot[t]['cost']:.2f}")]
    for i, (label, f) in enumerate(cols):
        x = 190 + i * 160
        body.append(text(x, 96, label, 11.5, MUTED))
        for j, t in enumerate(TOOLS):
            body.append(text(x, 116 + j * 18, f(t), 14, INK, 700 if t == "argus" else 400))
    for j, t in enumerate(TOOLS):
        y = 111 + j * 18
        body.append(mark(t, 38, y))
        body.append(text(52, y + 5, TOPLABEL[t], 13, INK))
    # axis
    base = top + row_h * len(names)
    for s in (0, 30, 60, 90, 120):
        x = sx(s)
        body.append(f'<line x1="{x:.1f}" y1="{top - 6}" x2="{x:.1f}" y2="{base}" stroke="{GRID}" stroke-width="1"/>')
        body.append(text(x, base + 20, f"{s} s", 11.5, MUTED, anchor="middle"))
    body.append(text(w - right, base + 42, "seconds per session, including starting it; one mark per round", 11.5, MUTED, anchor="end"))
    for i, ch in enumerate(names):
        y = top + i * row_h + row_h / 2
        body.append(text(left - 16, y + 4.5, CHALLENGES[ch], 13, INK, anchor="end"))
        for t, dy in (("argus", -6), ("chrome", 6)):
            secs = sorted(r["seconds"] for r in rows if r["tool"] == t and r["name"] == ch)
            if len(secs) > 1:
                body.append(f'<line x1="{sx(secs[0]):.1f}" y1="{y + dy}" x2="{sx(secs[-1]):.1f}" y2="{y + dy}" stroke="{SERIES[t]}" stroke-width="2" stroke-opacity="0.5"/>')
            for s in secs:
                body.append(mark(t, sx(s), y + dy))
        # label the one outlier
        worst = max((r for r in rows if r["name"] == ch), key=lambda r: r["seconds"])
        if worst["seconds"] > 100:
            body.append(text(sx(worst["seconds"]), y - 9, f"{worst['seconds']:.0f} s: two screenshots timed out at 30 s each", 11.5, MUTED, anchor="end"))
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img">'
           f"<title>Argus and Claude in Chrome, same model: both 20/20 with no false successes; time per session by challenge</title>"
           f'<rect x="0.5" y="0.5" width="{w - 1}" height="{h - 1}" rx="18" fill="{BG}" stroke="{EDGE}"/>' + "".join(body) + "</svg>\n")
    (MEDIA / "h2h.svg").write_text(svg)


TOPLABEL = {"argus": "Argus", "chrome": "Claude in Chrome"}


# ---- panels -------------------------------------------------------------------

def image_size(mime, data):
    raw = base64.b64decode(data)
    if mime.endswith("png"):
        return int.from_bytes(raw[16:20], "big"), int.from_bytes(raw[20:24], "big")
    i = 2
    while i < len(raw):
        marker, length = raw[i + 1], int.from_bytes(raw[i + 2:i + 4], "big")
        if marker in (0xC0, 0xC2):
            return int.from_bytes(raw[i + 7:i + 9], "big"), int.from_bytes(raw[i + 5:i + 7], "big")
        i += 2 + length
    return 400, 300


def column(tool, ch, rd, row, x, width):
    calls, _ = load(tool, ch, rd)
    out, y = [], 0
    out.append(mark(tool, x + 6, y + 14))
    out.append(text(x + 20, y + 19, TOOLS[tool], 15, INK, 700))
    out.append(text(x + width, y + 19, f"{row['tools']} calls · {row['seconds']} s · ${row['cost']:.3f} · goal {'met' if row['met'] else 'NOT met'}", 12, MUTED, anchor="end"))
    y += 38
    chars = int(width / 7.4)
    for i, c in enumerate(calls, 1):
        out.append(text(x, y + 12, f"{i:>2}", 12, FAINT, family=MONO))
        out.append(text(x + 22, y + 12, shorten(describe(c["name"], c["input"]), chars - 4), 12, INK, 600, MONO))
        y += 18
        lines = []
        for t in c["texts"]:
            for ln in t.splitlines():
                if ln.strip():
                    lines.append(ln.rstrip())
        shown = lines[:6]
        for ln in shown:
            fill = RED if re.search(r"timed out|failed|✗|Error", ln) else MUTED
            out.append(text(x + 22, y + 11, shorten(ln, chars - 4), 11.5, fill, family=MONO))
            y += 16
        if len(lines) > len(shown):
            out.append(text(x + 22, y + 11, f"… {len(lines) - len(shown)} more lines", 11.5, FAINT, family=MONO))
            y += 16
        if c["images"]:
            ix = x + 22
            for mime, data in c["images"]:
                iw, ih = image_size(mime, data)
                th = 110 if iw > 200 else ih
                tw = iw * th / ih
                if ix + tw > x + width:
                    break
                out.append(f'<image x="{ix:.1f}" y="{y + 4}" width="{tw:.1f}" height="{th}" href="data:{mime};base64,{data}"/>')
                out.append(f'<rect x="{ix:.1f}" y="{y + 4}" width="{tw:.1f}" height="{th}" fill="none" stroke="{EDGE}"/>')
                out.append(text(ix, y + th + 18, f"{iw}×{ih} image", 10.5, FAINT))
                ix += tw + 12
            y += th + 28
        y += 8
    return out, y


def panel(ch, rd, headline):
    rows = json.loads((SRC / "rows.json").read_text())
    w, pad, gap = 1200, 28, 36
    colw = (w - pad * 2 - gap) / 2
    body = [text(pad, 42, f"{CHALLENGES[ch]}, round {rd}: {headline}", 19, INK, 700),
            text(pad, 64, "Every call each session made, the start of what came back and the images the model was shown, from the transcripts. Full logs in docs/benchmarks.", 12.5, MUTED)]
    heights = []
    for k, tool in enumerate(TOOLS):
        row = next(r for r in rows if r["tool"] == tool and r["name"] == ch and r["round"] == rd)
        parts, hgt = column(tool, ch, rd, row, pad + k * (colw + gap), colw)
        body.append(f'<g transform="translate(0 86)">{"".join(parts)}</g>')
        heights.append(hgt)
    h = 86 + max(heights) + 20
    body.insert(0, f'<line x1="{w / 2}" y1="86" x2="{w / 2}" y2="{h - 20}" stroke="{EDGE}"/>')
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img">'
           f"<title>{escape(CHALLENGES[ch])}: Argus and Claude in Chrome sessions side by side</title>"
           f'<rect x="0.5" y="0.5" width="{w - 1}" height="{h - 1:.0f}" rx="18" fill="{BG}" stroke="{EDGE}"/>' + "".join(body) + "</svg>\n")
    # As PNG: GitHub serves SVGs with a policy that blocks the embedded images.
    import subprocess
    subprocess.run(["rsvg-convert", "--zoom", "2", "-o", str(MEDIA / f"h2h-{ch}.png")], input=svg.encode(), check=True)


def write_index(rows):
    total = lambda t, k: sum(r[k] for r in rows if r["tool"] == t)
    md = [f"# Head to head, {NAME.removeprefix('h2h-')}", "",
          "Argus and Claude in Chrome, driven by the same model (Claude Opus 5) through `claude -p`, on",
          "[UI Testing Playground](http://uitestingplayground.com). Produced by `argusd/bench/h2h.ts --rounds 2`;",
          "the write-up is in [benchmark-uitap.md](../../benchmark-uitap.md).", "",
          "Goals are judged from the page itself: both tools opened the pages through a local proxy that injected a",
          "reporter, which sent real clicks and page state to the harness. Neither tool graded itself.", "",
          "| | Goals met | False successes | Tool calls | Time | Input + output tokens | Cost |",
          "|---|---:|---:|---:|---:|---:|---:|"]
    for t in TOOLS:
        md.append(f"| {TOOLS[t]} | {sum(r['met'] for r in rows if r['tool'] == t)}/{sum(1 for r in rows if r['tool'] == t)} | "
                  f"{sum(r['falseSuccess'] for r in rows if r['tool'] == t)} | {total(t, 'tools')} | {total(t, 'seconds'):.0f} s | "
                  f"{total(t, 'input'):,} + {total(t, 'output'):,} | ${total(t, 'cost'):.2f} |")
    md += ["", "## Every session", "", "Each log has every call the model made, what the tool returned, the images the model",
           "was shown, and its final answer. Removed: session metadata (settings, local paths) and system reminders a tool",
           "appends for the model. Results longer than 2,000 characters are truncated and marked.", "",
           "| Challenge | Round | Argus | Claude in Chrome |", "|---|---:|---|---|"]
    for rd in sorted({r["round"] for r in rows}):
        for ch in CHALLENGES:
            cells = []
            for t in TOOLS:
                r = next((x for x in rows if x["tool"] == t and x["name"] == ch and x["round"] == rd), None)
                cells.append(f"[{'met' if r['met'] else 'NOT met'} · {r['tools']} calls · {r['seconds']} s](runs/{t}-{ch}-{rd}.md) ({r['truth']})" if r else "-")
            md.append(f"| {CHALLENGES[ch]} | {rd} | {cells[0]} | {cells[1]} |")
    (OUT / "README.md").write_text("\n".join(md) + "\n")


if __name__ == "__main__":
    rows = json.loads((SRC / "rows.json").read_text())
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "rows.json").write_text(json.dumps(rows, indent=2) + "\n")
    write_logs(rows)
    write_index(rows)
    chart(rows)
    panel("clientdelay", 2, "waiting for a slow page")
    panel("hiddenlayers", 1, "knowing whether a click landed")
    print(f"wrote {OUT.relative_to(ROOT)}, docs/media/h2h.svg and the h2h-*.png panels")
