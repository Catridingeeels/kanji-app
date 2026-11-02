# 漢字: Jōyō Kanji Study

A phone-first web app for working through the jōyō kanji (常用漢字), grouped by on'yomi so that kanji sharing a sound sit together.

**Live:** https://catridingeeels.github.io/kanji-app/. Add it to your home screen and it works offline.

<img src="docs/screenshot.png" alt="A kanji card showing 亜 with its meanings, its on'yomi ア, and three example words" width="300">

## What it does

- Shows one kanji per card. Swipe up or down, or use the arrow keys, to move between cards.
- Groups cards by on'yomi (ア, アイ, アク …), with a jump bar along the top. Kanji with only kun'yomi readings are under `*`.
- Lists each kanji's meanings, its readings, and up to three common words that use it.
- Animates the stroke order when you tap the kanji.
- **Compare:** search by kanji, meaning or reading, then pin up to two lookalikes beside the current card.
- Installs as a PWA, and a service worker caches everything for offline use.

## How it's built

**The app** is plain JavaScript, HTML and CSS with no framework and no build step: `app.js`, `index.html`, `style.css` and `sw.js`.

**The data** comes from two Python scripts:

- `build_data.py` reads the kanji list, grouped by on'yomi, from a spreadsheet. It adds meanings and readings from KANJIDIC2, then scans all of JMdict for common words, ranked by JMdict's priority and frequency tags, and picks up to three example words per kanji. It also drops any reading that doesn't appear in a common word, so cards show only readings you'll actually meet. Output: `kanji_data.json`.
- `build_strokes.py` pulls each kanji's stroke paths out of KanjiVG. Output: `strokes.json`.

## Run it locally

```sh
python3 -m http.server
```

Then open http://localhost:8000. Opening `index.html` straight from disk won't work, because the app fetches its JSON files.

To rebuild the data, run `pip install openpyxl`, then `python3 build_data.py`, then `python3 build_strokes.py`. The dictionary files download into `cache/` on the first run. The source spreadsheet (`~/Downloads/常用漢字.xlsx`) isn't in this repo.

## Data and credits

- **KANJIDIC2** and **JMdict**: [Electronic Dictionary Research and Development Group](https://www.edrdg.org/), used under [CC BY-SA 4.0](https://www.edrdg.org/edrdg/licence.html).
- **KanjiVG**: © Ulrich Apel, [CC BY-SA 3.0](https://kanjivg.tagaini.net/).

`kanji_data.json` and `strokes.json` are derived from these sources and are shared under the same licenses.
