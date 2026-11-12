#!/usr/bin/env python3
"""Writes corpus/upstream.json: the patterns of fancy-regex 0.19.2's own tests and their texts.

    python gen_corpus.py <fancy-regex-0.19.2 source directory>

A pattern is any raw string literal, or a string literal that is the first argument of a call whose second argument is a string literal
(`assert_is_match(r"..", "..")`, `assert_find`, `assert_captures`, ...), or the argument of `Regex::new(`,
`RegexBuilder::new(`, `regex(`, or the value of `let pattern`/`let re`/`let regex`. Its texts are the second arguments
it was called with in the same file; a few generic texts are added by the test. Nothing is judged here: a literal that
is no pattern compiles (or fails) the same in both engines and is compared as such.
"""
import json
import re
import sys
from pathlib import Path

def lit(first_group):
    """A string literal: three groups from `first_group` (a raw literal's hashes and body, a normal one's body)."""
    return rf'(?:r(#*)"(.*?)"\{first_group}|"((?:\\.|[^"\\])*)")'


RAW_ANY = re.compile(r'\br(#*)"(.*?)"\1', re.S)
PAIR = re.compile(rf'\b[A-Za-z_:]+\(\s*{lit(1)}\s*,\s*{lit(4)}', re.S)
SINGLE = re.compile(rf'(?:Regex::new|RegexBuilder::new|regex|ascii_bytes_regex)\(\s*{lit(1)}\s*[,)]', re.S)
LET = re.compile(rf'let\s+(?:pattern|re|regex|p)\s*=\s*{lit(1)}\s*;', re.S)

ESCAPES = {'n': '\n', 'r': '\r', 't': '\t', '0': '\0', '\\': '\\', '"': '"', "'": "'"}


def unescape(text):
    out, i = [], 0
    while i < len(text):
        c = text[i]
        if c != '\\':
            out.append(c)
            i += 1
            continue
        n = text[i + 1]
        if n in ESCAPES:
            out.append(ESCAPES[n])
            i += 2
        elif n == 'x':
            out.append(chr(int(text[i + 2:i + 4], 16)))
            i += 4
        elif n == 'u':
            end = text.index('}', i)
            out.append(chr(int(text[i + 3:end], 16)))
            i = end + 1
        elif n == '\n':
            i += 2
            while i < len(text) and text[i] in ' \t\r\n':
                i += 1
        else:
            raise ValueError(text[i:i + 8])
    return ''.join(out)


def literal(groups, at):
    """The value of the literal whose three groups start at `at`."""
    if groups[at + 1] is not None:
        return groups[at + 1]
    return unescape(groups[at + 2])


def main(root):
    found = {}
    files = sorted(Path(root, 'tests').glob('*.rs')) + sorted(Path(root, 'src').glob('*.rs'))
    for path in files:
        source = path.read_text(encoding='utf-8')
        texts = {}
        patterns = []
        for m in PAIR.finditer(source):
            try:
                pattern, text = literal(m.groups(), 0), literal(m.groups(), 3)
            except ValueError:
                continue
            patterns.append(pattern)
            texts.setdefault(pattern, []).append(text)
        # Every raw string literal is a candidate too: the tests write their patterns raw.
        patterns += [m.group(2) for m in RAW_ANY.finditer(source) if m.group(2)]
        for rx in (SINGLE, LET):
            for m in rx.finditer(source):
                try:
                    patterns.append(literal(m.groups(), 0))
                except ValueError:
                    pass
        for pattern in patterns:
            found.setdefault(pattern, [])
            for text in texts.get(pattern, []):
                if text not in found[pattern] and len(found[pattern]) < 12:
                    found[pattern].append(text)
    out = [{'pattern': p, 'texts': t} for p, t in sorted(found.items())]
    target = Path(__file__).parent / 'corpus' / 'upstream.json'
    target.parent.mkdir(exist_ok=True)
    target.write_text(json.dumps(out, ensure_ascii=False, indent=0), encoding='utf-8')
    print(len(out), 'patterns,', sum(len(e['texts']) for e in out), 'texts')


main(sys.argv[1])
