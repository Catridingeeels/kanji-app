#!/usr/bin/env python3
"""
Build joyo_table.json from the official 常用漢字表 (2010) PDF.

The table is published by the Agency for Cultural Affairs (文化庁):
https://www.bunka.go.jp/kokugo_nihongo/sisaku/joho/joho/kijun/naikaku/pdf/joyokanjihyo_20101130.pdf

Usage:
  python3 build_joyo_table.py path/to/joyokanjihyo_20101130.pdf

Needs `pdftotext` (poppler). For each of the 2136 kanji, in table order, it
records the old form (if any) and every official reading with the table's
example words. A reading the table indents (一字下げ: special or very
limited use, like サッ in 早速) is marked `special`.

Two passes over the PDF:
  1. `pdftotext -layout` text gives the structure: kanji, readings, examples.
  2. `pdftotext -bbox` gives each word's exact x position, which shows the
     one-character indent of special readings. The layout text can't show it
     reliably, because its column spacing drifts with glyph widths.
The readings from both passes are matched one to one, and the totals are
checked against the counts the table states: 2136 kanji, 2352 on, 2036 kun.
"""

import collections
import html
import json
import re
import subprocess
import sys
from pathlib import Path

OUTPUT_PATH = Path(__file__).resolve().parent / "joyo_table.json"

KANJI = r"[㐀-鿿豈-﫿\U00020000-\U0002ffff]"
KANA = r"[ァ-ヶーぁ-ん]+"

# Kanji line: the kanji, then an old form （亞）, an allowed variant ［遡］ or a
# bare old form (弁   辨), then the first reading and its examples. The old
# form of 亀 is an image, so its （ ） comes out empty.
ENTRY_RE = re.compile(
    r"^ {8,18}(" + KANJI + r")(?:（([^）]*)）|［[^］]*］|\s+(" + KANJI + r"))?\s*(" + KANA + r")\s*(.*)$")
# Another reading of the same kanji.
READING_RE = re.compile(r"^ {24,36}(" + KANA + r")(?:\s+(.*))?$")
# 餅's second line starts with its old form: "（餠） もち   餅屋，尻餅".
OLD_FORM_READING_RE = re.compile(r"^ {8,18}（([^）]*)）\s+(" + KANA + r")\s*(.*)$")
# An example list that wrapped onto its own line: "昨今   今朝（けさ）".
WRAPPED_RE = re.compile(r"^ {33,40}(" + KANJI + r".*)$")

EXPECTED = {"kanji": 2136, "on": 2352, "kun": 2036}


def pdftotext(pdf, *args):
    return subprocess.run(["pdftotext", *args, str(pdf), "-"],
                          check=True, capture_output=True, text=True).stdout


def split_examples(rest):
    """Split the text after a reading into the example words and the notes column."""
    parts = re.split(r"\s{2,}", rest.strip(), maxsplit=1)
    examples = [x for x in parts[0].split("，") if x] if parts[0] else []
    note = parts[1] if len(parts) > 1 else ""
    return examples, note


def parse_line(line, entries, started):
    """Add one line of layout text to `entries`. Returns whether the table has started."""
    if "indd" in line:  # print footer
        return started
    m = ENTRY_RE.match(line)
    if m and m.group(1) == "亜":
        started = True
    if not started:
        return started
    if m:
        old = (m.group(2) or m.group(3) or "").strip() or None
        entries.append({"kanji": m.group(1), "old": old,
                        "readings": [{"reading": m.group(4), "rest": [m.group(5)]}]})
        return started
    o = OLD_FORM_READING_RE.match(line)
    if o:
        entries[-1]["old"] = entries[-1]["old"] or o.group(1)
        entries[-1]["readings"].append({"reading": o.group(2), "rest": [o.group(3)]})
        return started
    w = WRAPPED_RE.match(line)
    if w:
        entries[-1]["readings"][-1]["rest"].append(w.group(1))
        return started
    r = READING_RE.match(line)
    if r:
        entries[-1]["readings"].append({"reading": r.group(1), "rest": [r.group(2) or ""]})
    return started


def parse_layout(pdf):
    """Pass 1: kanji, readings and examples from the layout text."""
    entries, started = [], False
    for page in pdftotext(pdf, "-layout").split("\f"):
        if entries and entries[-1]["kanji"] == "腕":  # the table's last kanji; 付表 follows
            break
        for line in page.splitlines():
            started = parse_line(line, entries, started)

    for e in entries:
        for r in e["readings"]:
            r["examples"], notes = [], []
            for chunk in r.pop("rest"):
                ex, note = split_examples(chunk)
                r["examples"] += ex
                if note:
                    notes.append(note)
            r["note"] = " ".join(notes)
            r["on"] = bool(re.fullmatch(r"[ァ-ヶー]+", r["reading"]))
    return entries


def parse_indents(pdf):
    """Pass 2: (reading, indented?) for every reading-column word, in page order."""
    word_re = re.compile(r'<word xMin="([\d.]+)" yMin="([\d.]+)"[^>]*>([^<]*)</word>')
    out = []
    for page in pdftotext(pdf, "-bbox").split("<page ")[1:]:
        words = [(float(x), float(y), html.unescape(t)) for x, y, t in word_re.findall(page)]
        kana = [(x, y, t) for x, y, t in words if re.fullmatch(KANA, t) and 160 < x < 200]
        if not kana:
            continue
        # The reading column starts at the leftmost x seen most often on this page.
        base = min(x for x, _ in collections.Counter(round(x, 1) for x, _, _ in kana).most_common(3))
        for x, y, t in sorted(kana, key=lambda w: (w[1], w[0])):
            if abs(x - base) < 1:
                out.append((t, False))
            elif 8 < x - base < 13:  # one 10.5pt character of indent
                out.append((t, True))
    return out


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    pdf = Path(sys.argv[1])

    entries = parse_layout(pdf)
    readings = [r for e in entries for r in e["readings"]]
    indents = parse_indents(pdf)

    # Match the two passes reading by reading. Reading-column words that aren't
    # readings (stray header kana) are skipped; every reading must be found.
    i = 0
    for r in readings:
        while i < len(indents) and indents[i][0] != r["reading"]:
            i += 1
        if i == len(indents):
            sys.exit(f"Couldn't find the position of reading {r['reading']} in the PDF.")
        r["special"] = indents[i][1]
        i += 1

    counts = {"kanji": len(entries),
              "on": sum(r["on"] for r in readings),
              "kun": sum(not r["on"] for r in readings)}
    special = sum(r["special"] for r in readings)
    print(f"{counts['kanji']} kanji, {counts['on']} on, {counts['kun']} kun readings ({special} special)")
    if counts != EXPECTED:
        sys.exit(f"Expected {EXPECTED}: the PDF parse is off.")

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:  # one kanji per line, for readable diffs
        f.write("[\n" + ",\n".join(json.dumps(e, ensure_ascii=False) for e in entries) + "\n]\n")
    print(f"Wrote {OUTPUT_PATH.name}")


if __name__ == "__main__":
    main()
