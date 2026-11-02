#!/usr/bin/env python3
"""
Build strokes.json for the kanji study PWA.

Pipeline:
  1. Download KanjiVG release zip (cached)
  2. Read kanji_data.json for the set of kanji
  3. Extract SVG stroke paths and the component decomposition for each kanji
  4. Output strokes.json (kanji -> array of path d strings) and
     components.json (kanji -> list of component nodes)

Component nodes come from KanjiVG's <g kvg:element="..."> groups. Each node is
  {"e": element, "s": [stroke indices], "p": parent node index, "o": original form?}
Node 0 is the kanji itself. Components split into several groups
(kvg:part="1", "2", ...) are merged into one node, and single-stroke
components (丶, 丿, 一 ...) are dropped: a list of every kanji with a dot
in it is not useful.

Unnamed groups with two or more named pieces (the 冖+心+夂 at the bottom of
愛, which isn't a character) become cluster nodes whose element is "+" and
the pieces in order, e.g. "+冖心夂", with "·n" appended when n of the
cluster's strokes lie outside its named pieces. The app draws these from the
kanji's own strokes.
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
COMPONENTS_PATH = BASE_DIR / "components.json"

KANJIVG_URL = "https://github.com/KanjiVG/kanjivg/releases/download/r20250816/kanjivg-20250816-main.zip"
KANJIVG_ZIP = CACHE_DIR / "kanjivg-20250816-main.zip"

SVG_NS = "{http://www.w3.org/2000/svg}"
KVG_NS = "{http://kanjivg.tagaini.net}"


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
def decompose(root_g):
    """Flatten a KanjiVG stroke group into component nodes (see module doc)."""
    nodes = []          # {"e", "s", "p", "o"?}
    merged = {}         # (named parent, element, number) -> node index, for kvg:part groups
    counter = [0]       # stroke index in document order
    clusters = {}       # node index -> {"pieces": [elements], "piece_strokes": set()}

    def named_ancestor(i):
        while i >= 0 and i in clusters:
            i = nodes[i]["p"]
        return i

    def walk(g, parent, cluster):
        """Returns the set of stroke indices under g."""
        element = g.get(KVG_NS + "element")
        node = parent
        if element and g is root_g:
            nodes.append({"e": element, "s": [], "p": -1})
            node = 0
        elif element:
            key = (named_ancestor(parent), element, g.get(KVG_NS + "number"))
            if g.get(KVG_NS + "part") and key in merged:
                node = merged[key]
            else:
                nodes.append({"e": element, "s": [], "p": parent})
                node = len(nodes) - 1
                original = g.get(KVG_NS + "original")
                if original:
                    nodes[node]["o"] = original
                if g.get(KVG_NS + "part"):
                    merged[key] = node
            if cluster is not None:
                clusters[cluster]["pieces"].append(element)
        else:
            # Unnamed group: a cluster of parts that isn't a character itself,
            # like the 冖+心+夂 at the bottom of 愛. Becomes a part keyed by
            # its pieces, if it has at least two.
            nodes.append({"e": None, "s": [], "p": parent})
            node = len(nodes) - 1
            clusters[node] = {"pieces": [], "piece_strokes": set()}
        inner = cluster if element is None else None
        if element is None:
            inner = node
        under = set()
        for child in g:
            if child.tag == SVG_NS + "g":
                sub = walk(child, node, inner)
                under |= sub
                if child.get(KVG_NS + "element") and inner is not None:
                    clusters[inner]["piece_strokes"] |= sub
            elif child.tag == SVG_NS + "path":
                i = counter[0]
                counter[0] += 1
                under.add(i)
                # A stroke belongs to its node and every ancestor
                n = node
                while n >= 0:
                    nodes[n]["s"].append(i)
                    n = nodes[n]["p"]
        if element is None:
            # Strokes of a merged kvg:part group are credited to the node of
            # its first part, whose parent may lie outside this cluster, so
            # take the cluster's strokes from the group itself
            nodes[node]["s"] = sorted(under)
        return under

    walk(root_g, -1, None)

    # Name the clusters: "+冖心夂", plus "·n" when n strokes sit outside the pieces
    for i, info in clusters.items():
        n = nodes[i]
        parent_strokes = set(nodes[n["p"]]["s"]) if n["p"] >= 0 else set()
        if len(info["pieces"]) < 2 or set(n["s"]) == parent_strokes:
            continue
        loose = len(set(n["s"]) - info["piece_strokes"])
        n["e"] = "+" + "".join(info["pieces"]) + (f"\u00b7{loose}" if loose else "")

    # Drop unnamed clusters and single-stroke components. Children are
    # reparented to the nearest kept ancestor.
    keep = [i for i, n in enumerate(nodes) if i == 0 or (n["e"] and len(n["s"]) > 1)]
    remap = {old: new for new, old in enumerate(keep)}
    out = []
    for i in keep:
        n = dict(nodes[i])
        p = n["p"]
        while p >= 0 and p not in remap:
            p = nodes[p]["p"]
        n["p"] = remap.get(p, -1)
        n["s"] = sorted(set(n["s"]))
        out.append(n)
    return out


def extract_strokes(kanji_list):
    """Extract stroke paths and component nodes for each kanji from the KanjiVG zip."""
    print("Step 3: Extracting stroke paths and components...")

    strokes = {}
    components = {}
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

            # The first <g> is StrokePaths_xxxxx; its first child is the kanji group
            stroke_group = root.find(f"{SVG_NS}g")
            kanji_group = stroke_group.find(f"{SVG_NS}g") if stroke_group is not None else None
            if kanji_group is not None:
                nodes = decompose(kanji_group)
                if len(nodes[0]["s"]) != len(d_values):
                    print(f"  WARNING: {kanji}: {len(nodes[0]['s'])} strokes in groups, {len(d_values)} paths")
                components[kanji] = nodes

    print(f"  Extracted strokes for {len(strokes)} kanji.")
    print(f"  Total strokes (paths): {total_paths}")
    if missing:
        print(f"  Missing from KanjiVG ({len(missing)}): {''.join(missing)}")

    return strokes, components, missing, total_paths


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
    strokes, components, missing, total_paths = extract_strokes(kanji_list)

    # Step 4: Write output
    print("Step 4: Writing strokes.json and components.json...")
    with open(str(OUTPUT_PATH), "w", encoding="utf-8") as f:
        json.dump(strokes, f, ensure_ascii=False)
    with open(str(COMPONENTS_PATH), "w", encoding="utf-8") as f:
        json.dump(components, f, ensure_ascii=False, separators=(",", ":"))

    # Component index summary
    index = {}
    for kanji, nodes in components.items():
        for n in nodes:
            index.setdefault(n["e"], set()).add(kanji)
    top = sorted(index.items(), key=lambda kv: -len(kv[1]))[:12]
    print(f"  {len(index)} distinct components; most common: "
          + ", ".join(f"{e} ({len(k)})" for e, k in top))
    print(f"  components.json: {COMPONENTS_PATH.stat().st_size / 1024:.1f} KB")

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
