#!/usr/bin/env python3
"""Find `local` statements that read a name they declare.

    local k=$1 file=/pool/session-$k

bash expands every right-hand side before it creates any of the locals, so `$k`
here is *not* the `k` being declared. It is whatever `k` is visible through
dynamic scope -- the caller's, if it has one. That works by accident when the
caller happens to hold the same value and fails silently when it does not. In
argus it produced a score bar that rendered full in one context and empty in
another, and a pool slot lookup that only worked because its caller was also
named `k`.

Exit status is the number of offending statements.
"""

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
ASSIGN = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)=")


def split_words(text):
    """Split a `local` argument list on top-level whitespace, honouring quotes
    and $( ) / ${ } / $(( )) nesting well enough for real scripts."""
    words, cur, depth, quote = [], [], 0, None
    i = 0
    while i < len(text):
        c = text[i]
        if quote:
            cur.append(c)
            if c == "\\" and quote == '"' and i + 1 < len(text):
                cur.append(text[i + 1]); i += 1
            elif c == quote:
                quote = None
        elif c in "\"'":
            quote = c; cur.append(c)
        elif c in "({":
            depth += 1; cur.append(c)
        elif c in ")}":
            depth -= 1; cur.append(c)
        elif c.isspace() and depth == 0:
            if cur: words.append("".join(cur)); cur = []
        else:
            cur.append(c)
        i += 1
    if cur:
        words.append("".join(cur))
    return words


def references(value, name):
    # $name, ${name...}, or a bare name inside $(( arithmetic )).
    if re.search(r"\$\{?%s(?![A-Za-z0-9_])" % re.escape(name), value):
        return True
    for arith in re.findall(r"\$\(\((.*?)\)\)", value):
        if re.search(r"(?<![A-Za-z0-9_$])%s(?![A-Za-z0-9_])" % re.escape(name), arith):
            return True
    return False


STATEMENT = re.compile(r"(?:^|[;{(]|&&|\|\|)\s*(?:local|declare|typeset)\s+(?:-[a-zA-Z]+\s+)*")


def statement_body(text):
    """The argument list of one statement: up to the first `;`, `}` or `#`
    that is not inside quotes or $( ) nesting. One-liner functions put several
    statements on a line, and a lint that only reads line starts misses them."""
    depth, quote = 0, None
    for i, c in enumerate(text):
        if quote:
            if c == quote:
                quote = None
        elif c in "\"'":
            quote = c
        elif c in "(":
            depth += 1
        elif c == ")":
            depth -= 1
        elif c == "{" and i > 0 and text[i - 1] == "$":
            depth += 1
        elif c == "}" and depth > 0:
            depth -= 1
        elif depth == 0 and (c in ";}" or (c == "#" and (i == 0 or text[i - 1].isspace()))):
            return text[:i]
    return text


def scan(path):
    problems = []
    for lineno, line in enumerate(path.read_text().splitlines(), 1):
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        for m in STATEMENT.finditer(stripped):
            body = statement_body(stripped[m.end():])
            declared = []
            for word in split_words(body):
                a = ASSIGN.match(word)
                if a:
                    value = word[a.end():]
                    for earlier in declared:
                        if references(value, earlier):
                            problems.append((lineno, earlier, stripped))
                    declared.append(a.group(1))
                elif (bare := re.match(r"[A-Za-z_][A-Za-z0-9_]*", word)):
                    declared.append(bare.group(0))
    return problems


def main():
    files = [p for p in ROOT.rglob("*") if p.is_file() and ".git" not in p.parts
             and (p.suffix == ".sh" or (p.parent.name == "bin" and p.read_bytes()[:11] == b"#!/bin/bash"))]
    total = 0
    for f in sorted(files):
        for lineno, name, text in scan(f):
            total += 1
            print(f"{f.relative_to(ROOT)}:{lineno}: `{name}` read in the statement that declares it")
            print(f"    {text}")
    return total


if __name__ == "__main__":
    sys.exit(main())
