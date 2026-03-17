#!/usr/bin/env python3
"""
Build strokes.json for the kanji study PWA.

Pipeline:
  1. Download KanjiVG release zip (cached)
  2. Read kanji_data.json for the set of kanji
  3. Extract SVG stroke paths from the zip for each kanji
  4. Output strokes.json mapping kanji -> array of path d strings
"""

import json
import os
import sys
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
CACHE_DIR = BASE_DIR / "cache"
KANJI_DATA_PATH = BASE_DIR / "kanji_data.json"
OUTPUT_PATH = BASE_DIR / "strokes.json"

KANJIVG_URL = "https://github.com/KanjiVG/kanjivg/releases/download/r20250816/kanjivg-20250816-main.zip"
KANJIVG_ZIP = CACHE_DIR / "kanjivg-20250816-main.zip"

SVG_NS = "{http://www.w3.org/2000/svg}"


# ---------------------------------------------------------------------------
# Step 1: Download KanjiVG
# ---------------------------------------------------------------------------
def download_kanjivg():
    """Download the KanjiVG release zip, with caching."""
    print("Step 1: Downloading KanjiVG...")
    if KANJIVG_ZIP.exists():
        print(f"  Cached: {KANJIVG_ZIP.name} ({KANJIVG_ZIP.stat().st_size / 1024 / 1024:.1f} MB)")
        return

    print(f"  Downloading {KANJIVG_URL} ...")
    try:
        urllib.request.urlretrieve(KANJIVG_URL, str(KANJIVG_ZIP))
    except Exception as e:
        print(f"  ERROR downloading: {e}", file=sys.stderr)
        sys.exit(1)
    print(f"  Downloaded: {KANJIVG_ZIP.name} ({KANJIVG_ZIP.stat().st_size / 1024 / 1024:.1f} MB)")


# ---------------------------------------------------------------------------
# Step 2: Load kanji set
# ---------------------------------------------------------------------------
def load_kanji_list():
    """Load the list of kanji from kanji_data.json."""
    print("Step 2: Loading kanji from kanji_data.json...")
    with open(str(KANJI_DATA_PATH), "r", encoding="utf-8") as f:
        data = json.load(f)
    kanji_list = [entry["kanji"] for entry in data]
    print(f"  Loaded {len(kanji_list)} kanji.")
    return kanji_list


# ---------------------------------------------------------------------------
# Step 3: Extract stroke paths from KanjiVG
# ---------------------------------------------------------------------------
def extract_strokes(kanji_list):
    """Extract SVG stroke path data for each kanji from the KanjiVG zip."""
    print("Step 3: Extracting stroke paths...")

    strokes = {}
    missing = []
    total_paths = 0

    with zipfile.ZipFile(str(KANJIVG_ZIP)) as zf:
        zip_names = set(zf.namelist())

        for kanji in kanji_list:
            svg_path = f"kanji/{ord(kanji):05x}.svg"

            if svg_path not in zip_names:
                missing.append(kanji)
                continue

            with zf.open(svg_path) as f:
                tree = ET.parse(f)
                root = tree.getroot()

            paths = root.findall(f".//{SVG_NS}path")
            d_values = []
            for path_elem in paths:
                d = path_elem.get("d")
                if d:
                    d_values.append(d)

            strokes[kanji] = d_values
            total_paths += len(d_values)

    print(f"  Extracted strokes for {len(strokes)} kanji.")
    print(f"  Total strokes (paths): {total_paths}")
    if missing:
        print(f"  Missing from KanjiVG ({len(missing)}): {''.join(missing)}")

    return strokes, missing, total_paths


# ---------------------------------------------------------------------------
# Step 4: Output JSON
# ---------------------------------------------------------------------------
def main():
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    # Step 1: Download KanjiVG
    download_kanjivg()

    # Step 2: Load kanji list
    kanji_list = load_kanji_list()

    # Step 3: Extract stroke paths
    strokes, missing, total_paths = extract_strokes(kanji_list)

    # Step 4: Write output
    print("Step 4: Writing strokes.json...")
    with open(str(OUTPUT_PATH), "w", encoding="utf-8") as f:
        json.dump(strokes, f, ensure_ascii=False)

    file_size = OUTPUT_PATH.stat().st_size
    print(f"\nDone! Wrote {len(strokes)} kanji entries to {OUTPUT_PATH}")
    print(f"  File size: {file_size / 1024:.1f} KB ({file_size / 1024 / 1024:.2f} MB)")
    print(f"  Total kanji processed: {len(strokes)}")
    print(f"  Missing from KanjiVG: {len(missing)}")
    print(f"  Total strokes: {total_paths}")
    print(f"  Avg strokes per kanji: {total_paths / len(strokes):.1f}" if strokes else "")

    # Show a sample entry
    sample_kanji = kanji_list[0]
    if sample_kanji in strokes:
        sample = {sample_kanji: strokes[sample_kanji]}
        print(f"\n  Sample entry ({sample_kanji}, {len(strokes[sample_kanji])} strokes):")
        print(f"  {json.dumps(sample, ensure_ascii=False)[:300]}")


if __name__ == "__main__":
    main()
