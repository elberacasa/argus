#!/usr/bin/env python3
"""Publish a Workbench run: every session's log, the images, and the figures.

    scripts/workbench-evidence.py <name> <results dir>[:label] ...

Each results dir is what `argusd/bench/workbench/run.ts` wrote (rows.json and
one stream-json transcript per session). Several can be given; a label renames
that directory's tools (e.g. "argus=argus before the fixes"). This writes:

    docs/benchmarks/<name>/README.md       results and how to read the logs
    docs/benchmarks/<name>/rows.json       the judged rows, all runs together
    docs/benchmarks/<name>/runs/*.md       every call, what came back, the images
    docs/media/workbench.svg               correct, calls and time per tool

Everything shown comes from the transcripts. Session metadata (settings, local
paths) and the reminders a tool appends for the model are removed; long results
are truncated and marked.
"""

import base64
import json
import re
import sys
from html import escape
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NAME = sys.argv[1]
SOURCES = []
for arg in sys.argv[2:]:
    path, _, label = arg.partition(":")
    SOURCES.append((Path(path), dict(p.split("=", 1) for p in label.split(",")) if label else {}))
OUT = ROOT / "docs" / "benchmarks" / NAME
MEDIA = ROOT / "docs" / "media"

TITLES = {
    "spa-issue": "App navigation", "signup": "Multi-step form", "dialog": "Confirm dialog", "upload": "File upload",
    "drag": "Drag and drop", "canvas": "Canvas map", "iframe": "Cross-origin frame", "virtual-list": "Long custom list",
    "hover-menu": "Hover menu", "infinite-scroll": "Infinite scroll", "failed-order": "Trap: order fails quietly",
    "unsaved-setting": "Trap: setting does not persist", "audit": "Find the defects", "mobile-cover": "Covered on phones",
}
BG, EDGE, INK, MUTED, FAINT = "#101418", "rgba(255,255,255,0.09)", "#ecebe6", "#98a1a9", "#5d666e"
GRID = "rgba(255,255,255,0.07)"
# The dataviz validator passed these three against this surface (lightness
# band, chroma, CVD separation, contrast).
SERIES = {"argus": "#199e70", "argus-own": "#3987e5", "chrome": "#d95926"}
SANS = "ui-sans-serif, -apple-system, 'Segoe UI', Inter, Helvetica, Arial, sans-serif"
MONO = "ui-monospace, 'JetBrains Mono', SFMono-Regular, Menlo, Consolas, monospace"
LABELS = {"argus": "Argus (its own browser)", "argus-own": "Argus (your Chromium)", "chrome": "Claude in Chrome"}


def clean(t: str) -> str:
    t = re.sub(r"<system-reminder>.*?</system-reminder>", "", t, flags=re.S)
    t = re.sub(r"\n*Tab Context:\n(?:- .*\n?|  .*\n?)*", "\n", t)
    return t.replace(str(Path.home()), "~").strip()


def load(src: Path, tool: str, task: str, rd: int):
    calls, answer, by_id = [], "", {}
    for line in (src / f"{tool}-{task}-{rd}.jsonl").read_text().splitlines():
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
                    if p["type"] == "text" and clean(p["text"]):
                        call["texts"].append(clean(p["text"]))
                    elif p["type"] == "image":
                        call["images"].append((p["source"]["media_type"], p["source"]["data"]))
        elif e.get("type") == "result":
            answer = clean(e.get("result") or "")
    return calls, answer


def collect():
    rows = []
    for src, labels in SOURCES:
        for r in json.loads((src / "rows.json").read_text()):
            r = {**r, "source": str(src), "label": labels.get(r["tool"], LABELS.get(r["tool"], r["tool"])), "key": labels.get(r["tool"], r["tool"])}
            rows.append(r)
    return rows


def write_logs(rows):
    img = OUT / "runs" / "img"
    img.mkdir(parents=True, exist_ok=True)
    for r in rows:
        calls, answer = load(Path(r["source"]), r["tool"], r["task"], r["round"])
        stem = f"{r['key'].replace(' ', '-')}-{r['task']}-{r['round']}"
        outcome = "correct" if r["correct"] else "WRONG"
        md = [f"# {r['label']} · {TITLES.get(r['task'], r['task'])} · round {r['round']}", "",
              f"**{outcome}** · goal met (read from the server): {'yes' if r['met'] else 'no'} ({r['truth']}) · claimed {r['claimed']}"
              f"{' · FALSE SUCCESS' if r['falseSuccess'] else ''}{'' if r['possible'] else ' · this task cannot succeed; reporting failure is the correct outcome'}"
              f" · {r['tools']} tool calls · {r['seconds']} s · ${r['cost']:.3f}", ""]
        k = 0
        for i, c in enumerate(calls, 1):
            md += [f"## {i}. `{c['name']}`", "", "```json", json.dumps(c["input"], indent=2), "```", ""]
            for t in c["texts"]:
                md += ["```", (t[:2000] + "\n[truncated]") if len(t) > 2000 else t, "```", ""]
            for mime, data in c["images"]:
                k += 1
                ext = "png" if mime.endswith("png") else "jpg"
                (img / f"{stem}-{k}.{ext}").write_bytes(base64.b64decode(data))
                md += [f"![image {k} shown to the model](img/{stem}-{k}.{ext})", ""]
        md += ["## Final answer", "", "```", answer, "```", ""]
        (OUT / "runs" / f"{stem}.md").write_text("\n".join(md))


def text(x, y, s, size=13, fill=INK, weight=400, family=SANS, anchor="start"):
    return f'<text x="{x}" y="{y}" font-family="{family}" font-size="{size}" font-weight="{weight}" fill="{fill}" text-anchor="{anchor}">{escape(s)}</text>'


def chart(rows, keys):
    w, left, right, top, row_h = 1000, 230, 40, 170, 30
    tasks = [t for t in TITLES if any(r["task"] == t for r in rows)]
    h = top + row_h * len(tasks) + 64
    xmax = max(r["seconds"] for r in rows if r["key"] in keys)
    sx = lambda s: left + (w - left - right) * min(s, xmax) / xmax
    body = [text(28, 44, "The same tasks, the same model, three ways to drive a browser", 21, INK, 700),
            text(28, 68, "Claude Opus 5 on the Workbench app. Every goal is judged from the server's own record of what happened.", 12.5, MUTED)]
    cols = [("Correct", lambda rs: f"{sum(r['correct'] for r in rs)}/{len(rs)}"),
            ("False successes", lambda rs: str(sum(r["falseSuccess"] for r in rs))),
            ("Tool calls", lambda rs: str(sum(r["tools"] for r in rs))),
            ("Time", lambda rs: f"{sum(r['seconds'] for r in rs):.0f} s"),
            ("Cost", lambda rs: f"${sum(r['cost'] for r in rs):.2f}")]
    for i, (head, f) in enumerate(cols):
        x = 300 + i * 140
        body.append(text(x, 96, head, 11.5, MUTED))
        for j, k in enumerate(keys):
            body.append(text(x, 116 + j * 18, f([r for r in rows if r["key"] == k]), 13.5, INK, 700 if j == 0 else 400))
    for j, k in enumerate(keys):
        y = 111 + j * 18
        body.append(f'<circle cx="38" cy="{y}" r="5" fill="{SERIES.get(k, FAINT)}"/>')
        body.append(text(52, y + 5, next(r["label"] for r in rows if r["key"] == k), 12.5, INK))
    base = top + row_h * len(tasks)
    for s in range(0, int(xmax) + 1, 60):
        body.append(f'<line x1="{sx(s):.1f}" y1="{top - 8}" x2="{sx(s):.1f}" y2="{base}" stroke="{GRID}"/>')
        body.append(text(sx(s), base + 20, f"{s} s", 11.5, MUTED, anchor="middle"))
    body.append(text(w - right, base + 42, "seconds per session; a cross is a task the tool got wrong", 11.5, MUTED, anchor="end"))
    for i, t in enumerate(tasks):
        y = top + i * row_h + row_h / 2
        body.append(text(left - 16, y + 4.5, TITLES[t], 12.5, INK, anchor="end"))
        for j, k in enumerate(keys):
            r = next((x for x in rows if x["key"] == k and x["task"] == t), None)
            if not r:
                continue
            x, c = sx(r["seconds"]), SERIES.get(k, FAINT)
            dy = (j - (len(keys) - 1) / 2) * 7
            if r["correct"]:
                body.append(f'<circle cx="{x:.1f}" cy="{y + dy}" r="4.5" fill="{c}" stroke="{BG}" stroke-width="1.5"/>')
            else:
                body.append(f'<path d="M{x - 5:.1f} {y + dy - 5}l10 10M{x + 5:.1f} {y + dy - 5}l-10 10" stroke="{c}" stroke-width="2.5" fill="none"/>')
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img">'
           f"<title>Workbench: Argus and Claude in Chrome on fourteen realistic tasks</title>"
           f'<rect x="0.5" y="0.5" width="{w - 1}" height="{h - 1}" rx="18" fill="{BG}" stroke="{EDGE}"/>' + "".join(body) + "</svg>\n")
    (MEDIA / "workbench.svg").write_text(svg)


def write_index(rows, keys):
    md = [f"# Workbench, {NAME.split('-', 1)[1] if '-' in NAME else NAME}", "",
          "Fourteen realistic tasks (`docs/benchmark-workbench.md`), the same model (Claude Opus 5) through three",
          "browser tools, judged from the server's own record of what happened.", "",
          "| | " + " | ".join(next(r["label"] for r in rows if r["key"] == k) for k in keys) + " |",
          "|---|" + "---|" * len(keys)]
    metrics = [("Correct", lambda rs: f"{sum(r['correct'] for r in rs)}/{len(rs)}"),
               ("False successes", lambda rs: str(sum(r["falseSuccess"] for r in rs))),
               ("Tool calls", lambda rs: str(sum(r["tools"] for r in rs))),
               ("Time", lambda rs: f"{sum(r['seconds'] for r in rs):.0f} s"),
               ("Tokens", lambda rs: f"{sum(r['input'] + r['output'] for r in rs) / 1000:,.0f}k"),
               ("Cost", lambda rs: f"${sum(r['cost'] for r in rs):.2f}")]
    for label, f in metrics:
        md.append(f"| {label} | " + " | ".join(f([r for r in rows if r["key"] == k]) for k in keys) + " |")
    md += ["", "## Every session", "",
           "Each log has every call the model made, what the tool returned, the images it was shown, and its final",
           "answer. Removed: session metadata (settings, local paths) and the reminders a tool appends for the model.",
           "Results over 2,000 characters are truncated and marked.", "",
           "| Task | " + " | ".join(next(r["label"] for r in rows if r["key"] == k) for k in keys) + " |",
           "|---|" + "---|" * len(keys)]
    for t in TITLES:
        if not any(r["task"] == t for r in rows):
            continue
        cells = []
        for k in keys:
            r = next((x for x in rows if x["key"] == k and x["task"] == t), None)
            if not r:
                cells.append("-")
                continue
            stem = f"{r['key'].replace(' ', '-')}-{r['task']}-{r['round']}"
            cells.append(f"[{'correct' if r['correct'] else '**wrong**'} · {r['tools']} calls · {r['seconds']} s](runs/{stem}.md) ({r['truth']})")
        md.append(f"| {TITLES[t]} | " + " | ".join(cells) + " |")
    (OUT / "README.md").write_text("\n".join(md) + "\n")


if __name__ == "__main__":
    rows = collect()
    order = list(SERIES)
    keys = sorted(dict.fromkeys(r["key"] for r in rows), key=lambda k: order.index(k) if k in order else len(order))
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "rows.json").write_text(json.dumps(rows, indent=2) + "\n")
    write_logs(rows)
    write_index(rows, keys)
    chart([r for r in rows if r["key"] in keys], keys)
    print(f"wrote {OUT.relative_to(ROOT)} and docs/media/workbench.svg")
