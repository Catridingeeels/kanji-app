#!/usr/bin/env python3
"""
Build kanji_data.json for the kanji study PWA.

Pipeline:
  1. Read joyo_table.json, the official 常用漢字表 (see build_joyo_table.py):
     the 2136 kanji in table order, every official reading, and the table's
     example words for each reading
  2. Add English meanings from KANJIDIC2
  3. Look the example words up in JMdict for their kana reading and English
  4. Pick up to three example words per kanji, each showing a different reading
  5. Output kanji_data.json
"""

import collections
import gzip
import json
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
CACHE_DIR = BASE_DIR / "cache"
TABLE_PATH = BASE_DIR / "joyo_table.json"
OUTPUT_PATH = BASE_DIR / "kanji_data.json"

KANJIDIC2_URL = "http://www.edrdg.org/kanjidic/kanjidic2.xml.gz"
KANJIDIC2_GZ = CACHE_DIR / "kanjidic2.xml.gz"
KANJIDIC2_XML = CACHE_DIR / "kanjidic2.xml"

JMDICT_URL = "http://ftp.edrdg.org/pub/Nihongo/JMdict_e.gz"
JMDICT_GZ = CACHE_DIR / "JMdict_e.gz"
JMDICT_XML = CACHE_DIR / "JMdict_e.xml"

MAX_DISPLAY_WORDS = 3
XML_LANG = "{http://www.w3.org/XML/1998/namespace}lang"
# JMdict tags that mark common words; nfXX ranks are handled separately
PRIORITY_TAGS = {"news1", "ichi1", "spec1", "ichi2", "news2", "spec2"}


# ---------------------------------------------------------------------------
# Downloads
# ---------------------------------------------------------------------------
def download_file(url, dest_gz, dest_xml):
    """Download a gzipped file and decompress it, with caching."""
    if dest_xml.exists():
        print(f"  Cached: {dest_xml.name}")
        return
    if not dest_gz.exists():
        print(f"  Downloading {url} ...")
        try:
            urllib.request.urlretrieve(url, str(dest_gz))
        except Exception as e:
            sys.exit(f"  ERROR downloading {url}: {e}")
    print(f"  Decompressing {dest_gz.name} ...")
    with gzip.open(dest_gz, "rb") as f_in, open(dest_xml, "wb") as f_out:
        while chunk := f_in.read(1024 * 1024):
            f_out.write(chunk)


# ---------------------------------------------------------------------------
# Kana helpers
# ---------------------------------------------------------------------------
def kata_to_hira(s):
    return "".join(chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in s)


VOICED = dict(zip("かきくけこさしすせそたちつてとはひふへほ", "がぎぐげござじずぜぞだぢづでどばびぶべぼ"))
SEMI_VOICED = dict(zip("はひふへほ", "ぱぴぷぺぽ"))
# i-row (連用形) and a-row (未然形) kana back to the u-row: 生い → 生う, 足らず → 足る
TO_U_ROW = dict(zip("いきぎしちにびみりわかがさたなばまら", "うくぐすつぬぶむるうくぐすつぬぶむる"))


def sound_variants(hira):
    """Forms a reading can take inside a word: 時 じ, 手紙 がみ (rendaku), 発 はっ / ぱっ."""
    forms = {hira}
    if hira[:1] in VOICED:
        forms.add(VOICED[hira[0]] + hira[1:])
    if hira[:1] in SEMI_VOICED:
        forms.add(SEMI_VOICED[hira[0]] + hira[1:])
    for f in list(forms):
        if len(f) >= 2 and f[-1] in "つくちき":  # gemination: 学 がく → 学校 がっこう
            forms.add(f[:-1] + "っ")
    return forms


def split_okurigana(kanji, kun, examples):
    """Mark where the okurigana starts in a kun reading: あわれむ + 哀れむ → あわ.れむ.

    The table writes kun readings whole, so the split comes from its example
    words: the kana right after the kanji. Examples where the kanji starts a
    plain kanji+kana word are tried first, since phrases like 哀れな話 carry
    extra kana that isn't okurigana. If no example shows the dictionary form,
    a conjugated one is used: 生い立ち gives お.う, 書き初め gives そ.める.
    """
    plain = [x for x in examples if re.fullmatch(re.escape(kanji) + r"[ぁ-ん]+", x)]
    tails = []
    for ex in plain + [x for x in examples if x not in plain]:
        i = ex.find(kanji)
        if i >= 0:
            tails.append(re.match(r"[ぁ-ん]*", ex[i + 1:]).group(0))
    # the longest start of a tail that ends the reading is the okurigana
    for tail in tails:
        for n in range(len(tail), 0, -1):
            if n < len(kun) and kun.endswith(tail[:n]):
                return kun[:-n] + "." + kun[-n:]
    # a conjugated verb: the last kana moves from the u-row to the i- or a-row
    # (生い立ち, 舌足らず), or an ichidan verb drops its る (書き初め)
    for tail in tails:
        for n in range(len(tail), 0, -1):
            for okuri in (tail[:n - 1] + TO_U_ROW.get(tail[n - 1], "?"), tail[:n] + "る"):
                if len(okuri) < len(kun) and kun.endswith(okuri):
                    return kun[:-len(okuri)] + "." + okuri
    return kun


# ---------------------------------------------------------------------------
# Step 1: The official table
# ---------------------------------------------------------------------------
def load_table():
    print("Step 1: Reading the official table...")
    with open(TABLE_PATH, encoding="utf-8") as f:
        table = json.load(f)
    for entry in table:
        for r in entry["readings"]:
            if r["on"]:
                r["display"] = r["reading"]
                r["stem"] = kata_to_hira(r["reading"])
            else:
                r["display"] = split_okurigana(entry["kanji"], r["reading"], r["examples"])
                r["stem"] = r["display"].split(".")[0]
    print(f"  {len(table)} kanji, {sum(len(e['readings']) for e in table)} readings.")
    return table


# ---------------------------------------------------------------------------
# Step 2: English meanings from KANJIDIC2
# ---------------------------------------------------------------------------
def parse_kanjidic2(kanji_set):
    print("Step 2: Parsing KANJIDIC2 for meanings...")
    download_file(KANJIDIC2_URL, KANJIDIC2_GZ, KANJIDIC2_XML)
    meanings = {}
    for _, elem in ET.iterparse(KANJIDIC2_XML):
        if elem.tag != "character":
            continue
        literal = elem.findtext("literal")
        if literal in kanji_set:
            # English meanings have no m_lang attribute
            meanings[literal] = [m.text for m in elem.iterfind(".//rmgroup/meaning") if m.get("m_lang") is None]
        elem.clear()
    missing = kanji_set - meanings.keys()
    print(f"  Meanings for {len(meanings)} kanji." + (f" Missing: {''.join(sorted(missing))}" if missing else ""))
    return meanings


# ---------------------------------------------------------------------------
# Step 3: Look example words up in JMdict
# ---------------------------------------------------------------------------
def priority_score(ke_pri, re_pri):
    """Lower is more common. nfXX is JMdict's frequency band (01-48);
    other priority tags count as fairly common; no tags at all ranks last."""
    def score(pris):
        nf = [int(p[2:]) for p in pris if p.startswith("nf")]
        if nf:
            return min(nf)
        return 5 if any(p in PRIORITY_TAGS for p in pris) else None
    ke, re_ = score(ke_pri), score(re_pri)
    if ke is not None:
        return ke
    return re_ + 3 if re_ is not None else 100


def example_forms(example):
    """Spellings to try in JMdict for one example, plus a reading hint if the table gives one.

    The table writes some examples as phrases or with a trailing particle or
    copula (安らかだ → 安らか, 早々に → 早々) or a part-of-speech tag
    (果たして〔副〕). 四日（よっか） and 三羽（ば） give a reading hint.
    """
    example = re.sub(r"\s*〔.*$", "", example)  # 果たして〔副〕 → 果たして
    hint = None
    m = re.fullmatch(r"(.+?)（(.+?)）", example)
    if m:  # 四日（よっか） is the whole reading; 三羽（ば） only the counter's
        example, hint = m.group(1), kata_to_hira(m.group(2))
    forms = [example]
    if len(example) > 2 and example[-1] in "だにとな":
        forms.append(example[:-1])
    return forms, hint


def parse_jmdict(wanted):
    """Index the JMdict entries for the spellings in `wanted`:
    spelling -> [(reading, score, meaning), ...]."""
    print("Step 3: Looking up example words in JMdict...")
    download_file(JMDICT_URL, JMDICT_GZ, JMDICT_XML)
    index = collections.defaultdict(list)
    for _, elem in ET.iterparse(JMDICT_XML):
        if elem.tag != "entry":
            continue
        kebs = [(k.findtext("keb"), [p.text for p in k.findall("ke_pri")]) for k in elem.findall("k_ele")]
        if not any(keb in wanted for keb, _ in kebs):
            elem.clear()
            continue
        rebs = [(r.findtext("reb"), [x.text for x in r.findall("re_restr")], [p.text for p in r.findall("re_pri")])
                for r in elem.findall("r_ele") if r.find("re_nokanji") is None]
        senses = [([x.text for x in s.findall("stagk")], [x.text for x in s.findall("stagr")],
                   [g.text for g in s.findall("gloss") if g.get(XML_LANG, "eng") == "eng" and g.text])
                  for s in elem.findall("sense")]
        for keb, ke_pri in kebs:
            if keb not in wanted:
                continue
            for reb, restr, re_pri in rebs:
                if restr and keb not in restr:
                    continue
                # first sense that applies to this spelling and reading
                glosses = next((g for stagk, stagr, g in senses
                                if g and (not stagk or keb in stagk) and (not stagr or reb in stagr)), None)
                if glosses:
                    index[keb].append((reb, priority_score(ke_pri, re_pri), "; ".join(glosses[:3])))
        elem.clear()
    print(f"  Found {len(index)} of {len(wanted)} spellings.")
    return index


def lookup_example(example, reading, jmdict):
    """The JMdict word for one table example, read with the table's reading.

    The reading check matters: the table lists 今日 under コン, so it is
    こんにち, not きょう (that reading is in the 付表).
    """
    if example.startswith("「"):  # a usage note, not a word
        return None
    forms, hint = example_forms(example)
    for form in forms:
        cands = jmdict.get(form, [])
        if hint:
            matches = [c for c in cands if hint in c[0]]
        else:
            matches = []
            for stem in stems(reading):
                variants = sound_variants(stem)
                matches = [c for c in cands if any(v in c[0] for v in variants)]
                if matches:
                    break
        if matches:
            reb, score, meaning = min(matches, key=lambda c: c[1])
            return {"word": form, "reading": reb, "meaning": meaning, "score": score}
    return None


def stems(reading):
    """Stems to match a reading by, strictest first.

    A kun reading's okurigana can change or vanish inside a word (干る in
    干物 ひもの, 恋う in 恋い慕う こいしたう), so after the stem, shorter
    starts of the reading are tried. This only chooses among the readings
    JMdict gives for the table's own example, so loose matching is safe.
    """
    yield reading["stem"]
    if not reading["on"]:
        whole = reading["reading"]
        for n in range(len(whole) - 1, 0, -1):
            if whole[:n] != reading["stem"]:
                yield whole[:n]


# ---------------------------------------------------------------------------
# Step 4: Pick the words to show
# ---------------------------------------------------------------------------
def is_plain_kun_word(word, entry, reading):
    """Whether `word` is the kun reading's own word: 早い for はや.い, 下 for した."""
    okuri = reading["display"].split(".")[1] if "." in reading["display"] else ""
    return not reading["on"] and word == entry["kanji"] + okuri


def select_words(entry, jmdict):
    """Up to MAX_DISPLAY_WORDS of the table's examples, one per reading where possible.

    Each reading's example is its plain word for a kun reading (早い), or else
    its most common example. The first on and first kun reading always get a
    slot. Remaining slots go to regular readings by how common their word is,
    then special (一字下げ) ones, then further examples. Words are shown in
    table order.
    """
    best, extras = {}, []
    for ri, r in enumerate(entry["readings"]):
        found = []
        for ei, ex in enumerate(r["examples"]):
            w = lookup_example(ex, r, jmdict)
            if w:
                plain = is_plain_kun_word(w["word"], entry, r)
                found.append((not plain, w["score"], ei, w))
        if found:
            found.sort(key=lambda f: f[:3])
            best[ri] = found[0][2:]
            extras += [(ri, ei, w) for _, _, ei, w in found[1:]]

    readings = entry["readings"]
    first_on = next((ri for ri, r in enumerate(readings) if r["on"] and ri in best), None)
    first_kun = next((ri for ri, r in enumerate(readings) if not r["on"] and ri in best), None)
    order = [ri for ri in (first_on, first_kun) if ri is not None]
    order += sorted((ri for ri in best if ri not in order),
                    key=lambda ri: (readings[ri]["special"], best[ri][1]["score"], ri))

    chosen, used = [], set()
    candidates = [(ri, *best[ri]) for ri in order] + sorted(extras, key=lambda x: (x[0], x[1]))
    for ri, ei, w in candidates:
        if len(chosen) < MAX_DISPLAY_WORDS and w["word"] not in used:
            chosen.append((ri, ei, w))
            used.add(w["word"])

    # No usable example (朕 has none; 崎's is ○○崎): try the kanji on its own
    if not chosen:
        for ri, r in enumerate(readings):
            w = lookup_example(entry["kanji"], r, jmdict)
            if w:
                chosen.append((ri, 0, w))
                break

    chosen.sort(key=lambda c: (c[0], c[1]))
    return [{k: w[k] for k in ("word", "reading", "meaning")} for _, _, w in chosen]


# ---------------------------------------------------------------------------
# Step 5: Assemble and output JSON
# ---------------------------------------------------------------------------
def main():
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    table = load_table()
    meanings = parse_kanjidic2({e["kanji"] for e in table})

    wanted = {e["kanji"] for e in table}  # for kanji with no usable example
    for e in table:
        for r in e["readings"]:
            for ex in r["examples"]:
                wanted.update(example_forms(ex)[0])
    jmdict = parse_jmdict(wanted)

    print("Step 4: Choosing example words...")
    output = []
    for e in table:
        readings = e["readings"]
        output.append({
            "kanji": e["kanji"],
            # the table sorts by first reading; kun-only kanji sort by their kun
            "group": readings[0]["reading"],
            "meanings": meanings.get(e["kanji"], []),
            "onyomi": [r["display"] for r in readings if r["on"]],
            "kunyomi": [r["display"] for r in readings if not r["on"]],
            "special": [r["display"] for r in readings if r["special"]],
            "words": select_words(e, jmdict),
        })

    counts = collections.Counter(len(o["words"]) for o in output)
    print("  Words per kanji: " + ", ".join(f"{n}: {counts[n]}" for n in sorted(counts)))
    no_words = [o["kanji"] for o in output if not o["words"]]
    if no_words:
        print(f"  No example word found for: {''.join(no_words)}")

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:  # one kanji per line, for readable diffs
        f.write("[\n" + ",\n".join(json.dumps(o, ensure_ascii=False) for o in output) + "\n]\n")
    print(f"Step 5: Wrote {len(output)} kanji to {OUTPUT_PATH.name}")


if __name__ == "__main__":
    main()
