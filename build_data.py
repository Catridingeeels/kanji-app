#!/usr/bin/env python3
"""
Build kanji_data.json for the kanji study PWA.

Pipeline:
  1. Extract ~2136 jouyou kanji from 常用漢字.xlsx (onyomi-grouped)
  2. Enrich with KANJIDIC2 (meanings, readings)
  3. Find common compound words from JMdict
  4. Output kanji_data.json
"""

import json
import gzip
import os
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
CACHE_DIR = BASE_DIR / "cache"
XLSX_PATH = Path.home() / "Downloads" / "常用漢字.xlsx"
OUTPUT_PATH = BASE_DIR / "kanji_data.json"

KANJIDIC2_URL = "http://www.edrdg.org/kanjidic/kanjidic2.xml.gz"
KANJIDIC2_GZ = CACHE_DIR / "kanjidic2.xml.gz"
KANJIDIC2_XML = CACHE_DIR / "kanjidic2.xml"

JMDICT_URL = "http://ftp.edrdg.org/pub/Nihongo/JMdict_e.gz"
JMDICT_GZ = CACHE_DIR / "JMdict_e.gz"
JMDICT_XML = CACHE_DIR / "JMdict_e.xml"

MAX_WORDS_PER_KANJI = 3


# ---------------------------------------------------------------------------
# Step 1: Extract kanji from xlsx
# ---------------------------------------------------------------------------
def extract_kanji_from_xlsx():
    """Extract kanji grouped by onyomi from the spreadsheet."""
    import openpyxl

    print("Step 1: Extracting kanji from xlsx...")
    wb = openpyxl.load_workbook(str(XLSX_PATH))
    ws = wb["漢字"]

    # Find all onyomi header columns (row 2, non-None, col >= 2)
    onyomi_cols = []
    for col in range(2, ws.max_column + 1):
        v = ws.cell(row=2, column=col).value
        if v is not None:
            onyomi_cols.append((col, str(v).strip()))

    kanji_list = []
    seen = set()

    for col, onyomi_label in onyomi_cols:
        for row in range(3, ws.max_row + 1):
            v = ws.cell(row=row, column=col).value
            if v is None:
                continue
            raw = str(v).strip()
            if not raw:
                continue
            # Strip parenthetical/bracket content: 亜（亞） → 亜, 貝  (かい) → 貝, 餌 ［餌］ → 餌
            kanji_char = re.sub(r"\s*[（(\[［].*?[）)\]］]", "", raw).strip()
            if len(kanji_char) != 1:
                print(f"  Warning: unexpected value after cleanup: {repr(raw)} -> {repr(kanji_char)}")
                continue
            if kanji_char in seen:
                print(f"  Warning: duplicate kanji {kanji_char} in col {col} ({onyomi_label})")
                continue
            seen.add(kanji_char)
            kanji_list.append({
                "kanji": kanji_char,
                "onyomiGroup": onyomi_label,
            })

    wb.close()
    print(f"  Extracted {len(kanji_list)} kanji from {len(onyomi_cols)} onyomi groups.")
    return kanji_list


# ---------------------------------------------------------------------------
# Step 2: Download and parse KANJIDIC2
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
            print(f"  ERROR downloading {url}: {e}", file=sys.stderr)
            sys.exit(1)
        print(f"  Downloaded: {dest_gz.name} ({dest_gz.stat().st_size / 1024 / 1024:.1f} MB)")
    else:
        print(f"  Cached: {dest_gz.name}")

    print(f"  Decompressing {dest_gz.name} ...")
    with gzip.open(str(dest_gz), "rb") as f_in:
        with open(str(dest_xml), "wb") as f_out:
            while True:
                chunk = f_in.read(1024 * 1024)
                if not chunk:
                    break
                f_out.write(chunk)
    print(f"  Decompressed: {dest_xml.name} ({dest_xml.stat().st_size / 1024 / 1024:.1f} MB)")


def parse_kanjidic2(kanji_set):
    """Parse KANJIDIC2 XML and return a dict mapping kanji -> info."""
    print("Step 2: Parsing KANJIDIC2...")
    download_file(KANJIDIC2_URL, KANJIDIC2_GZ, KANJIDIC2_XML)

    kd = {}
    # Use iterparse to handle large XML efficiently
    context = ET.iterparse(str(KANJIDIC2_XML), events=("end",))
    for event, elem in context:
        if elem.tag != "character":
            continue

        literal = elem.findtext("literal")
        if literal not in kanji_set:
            elem.clear()
            continue

        meanings = []
        onyomi = []
        kunyomi = []

        # readings and meanings are in reading_meaning group
        rmgroup = elem.find(".//rmgroup")
        if rmgroup is not None:
            for reading in rmgroup.findall("reading"):
                r_type = reading.get("r_type")
                if r_type == "ja_on":
                    onyomi.append(reading.text)
                elif r_type == "ja_kun":
                    kunyomi.append(reading.text)

            for meaning in rmgroup.findall("meaning"):
                # Only English meanings (no m_lang attribute = English)
                if meaning.get("m_lang") is None:
                    meanings.append(meaning.text)

        kd[literal] = {
            "meanings": meanings,
            "onyomi": onyomi,
            "kunyomi": kunyomi,
        }
        elem.clear()

    print(f"  Parsed data for {len(kd)} kanji.")
    return kd


# ---------------------------------------------------------------------------
# Step 3: Parse JMdict for common words
# ---------------------------------------------------------------------------
def parse_jmdict(kanji_set):
    """Parse JMdict XML to find common compound words for each kanji.

    Returns a dict: kanji -> list of (priority_score, word, reading, meaning)
    """
    print("Step 3: Parsing JMdict for common words...")
    download_file(JMDICT_URL, JMDICT_GZ, JMDICT_XML)

    # Priority tags that indicate common/important words
    PRIORITY_TAGS = {"news1", "ichi1", "spec1"}

    # Build per-kanji word lists
    kanji_words = {k: [] for k in kanji_set}

    entry_count = 0
    matched_count = 0

    context = ET.iterparse(str(JMDICT_XML), events=("end",))
    for event, elem in context:
        if elem.tag != "entry":
            continue
        entry_count += 1

        # Get kanji elements (k_ele)
        k_eles = elem.findall("k_ele")
        if not k_eles:
            elem.clear()
            continue

        # Get reading elements (r_ele)
        r_eles = elem.findall("r_ele")

        # Get sense/meaning elements
        senses = elem.findall("sense")

        for k_ele in k_eles:
            keb = k_ele.findtext("keb")  # kanji form of the word
            if not keb or len(keb) < 2:
                continue  # skip single-char entries

            # Check priority of this kanji element
            ke_pris = [p.text for p in k_ele.findall("ke_pri")]

            # Calculate a priority score (lower = more common)
            score = 100  # default: low priority
            has_priority = False
            for pri in ke_pris:
                if pri in PRIORITY_TAGS:
                    has_priority = True
                    score = min(score, 1)
                elif pri and pri.startswith("nf"):
                    has_priority = True
                    try:
                        nf_val = int(pri[2:])
                        score = min(score, nf_val)
                    except ValueError:
                        pass

            if not has_priority:
                continue  # skip non-priority entries

            # Get the first matching reading
            reading = None
            for r_ele in r_eles:
                # Check if this reading applies to this kanji form
                re_restr = [r.text for r in r_ele.findall("re_restr")]
                if re_restr and keb not in re_restr:
                    continue
                reading = r_ele.findtext("reb")
                break

            if not reading:
                continue

            # Get first English meaning
            meaning_parts = []
            if senses:
                first_sense = senses[0]
                for gloss in first_sense.findall("gloss"):
                    lang = gloss.get("{http://www.w3.org/XML/1998/namespace}lang", "eng")
                    if lang == "eng" and gloss.text:
                        meaning_parts.append(gloss.text)
            meaning = "; ".join(meaning_parts[:3]) if meaning_parts else None

            if not meaning:
                continue

            # Prefer shorter words (2 chars ideal for compounds)
            length_penalty = len(keb) - 2  # 0 for 2-char, 1 for 3-char, etc.
            adjusted_score = score + length_penalty * 5

            # Associate this word with each kanji in it that we care about
            for ch in keb:
                if ch in kanji_words:
                    kanji_words[ch].append((adjusted_score, keb, reading, meaning))
                    matched_count += 1

        elem.clear()

    print(f"  Processed {entry_count} JMdict entries, {matched_count} word-kanji associations.")

    # Sort and trim to top MAX_WORDS_PER_KANJI per kanji
    result = {}
    for k, words in kanji_words.items():
        if not words:
            result[k] = []
            continue
        # Sort by priority score (lower = better), then by word length
        words.sort(key=lambda x: (x[0], len(x[1])))
        # Deduplicate by word
        seen = set()
        unique = []
        for score, word, reading, meaning in words:
            if word not in seen:
                seen.add(word)
                unique.append({"word": word, "reading": reading, "meaning": meaning})
                if len(unique) >= MAX_WORDS_PER_KANJI:
                    break
        result[k] = unique

    kanji_with_words = sum(1 for v in result.values() if v)
    print(f"  Found words for {kanji_with_words}/{len(kanji_set)} kanji.")
    return result


# ---------------------------------------------------------------------------
# Step 4: Assemble and output JSON
# ---------------------------------------------------------------------------
def main():
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    # Step 1: Extract kanji
    kanji_list = extract_kanji_from_xlsx()
    kanji_set = {entry["kanji"] for entry in kanji_list}

    # Step 2: Enrich with KANJIDIC2
    kanjidic = parse_kanjidic2(kanji_set)

    # Step 3: Get common words from JMdict
    jmdict_words = parse_jmdict(kanji_set)

    # Step 4: Assemble final data
    print("Step 4: Assembling output...")
    output = []
    missing_kd = 0
    for entry in kanji_list:
        k = entry["kanji"]
        kd_info = kanjidic.get(k, {})
        if not kd_info:
            missing_kd += 1

        output.append({
            "kanji": k,
            "onyomiGroup": entry["onyomiGroup"],
            "meanings": kd_info.get("meanings", []),
            "onyomi": kd_info.get("onyomi", []),
            "kunyomi": kd_info.get("kunyomi", []),
            "words": jmdict_words.get(k, []),
        })

    if missing_kd:
        print(f"  Note: {missing_kd} kanji not found in KANJIDIC2.")

    # Write output
    with open(str(OUTPUT_PATH), "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    file_size = OUTPUT_PATH.stat().st_size / 1024
    print(f"\nDone! Wrote {len(output)} kanji entries to {OUTPUT_PATH}")
    print(f"  File size: {file_size:.1f} KB")

    # Quick stats
    with_meanings = sum(1 for e in output if e["meanings"])
    with_words = sum(1 for e in output if e["words"])
    total_words = sum(len(e["words"]) for e in output)
    print(f"  Kanji with meanings: {with_meanings}")
    print(f"  Kanji with words: {with_words}")
    print(f"  Total word entries: {total_words}")
    print(f"  First entry: {json.dumps(output[0], ensure_ascii=False)}")
    print(f"  Last entry: {json.dumps(output[-1], ensure_ascii=False)}")


if __name__ == "__main__":
    main()
