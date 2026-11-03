(() => {
  'use strict';

  const state = {
    data: [], index: 0, animating: false, groups: [],
    strokes: null,       // kanji -> [path d strings], from strokes.json
    components: null,    // kanji -> component nodes, from components.json
    partIndex: null,     // component element -> [indices into data] that contain it
    kanjiIndex: null,    // kanji -> index into data
    dataReady: null,     // promise for kanji_data.json
    drawings: null,      // promise for the two fetches above
    part: null,          // component element currently selected on the card
    backStack: [],       // indices to return to after jumping from the parts list
  };
  const $ = (id) => document.getElementById(id);
  let els;

  // ── Init ──

  async function init() {
    els = {
      loading: $('loading'),
      main: $('main'),
      card: $('card'),
      container: $('cardContainer'),
      kanji: $('kanjiDisplay'),
      meanings: $('meanings'),
      onyomiNav: $('onyomiNav'),
      onReadings: $('onyomiReadings'),
      kunReadings: $('kunyomiReadings'),
      onGroup: $('onyomiGroup'),
      kunGroup: $('kunyomiGroup'),
      words: $('wordsList'),
      wordsSection: $('wordsSection'),
      counter: $('counter'),
      progress: $('progressFill'),
      hint: $('navHint'),
      strokeModal: $('strokeModal'),
      strokeCanvas: $('strokeCanvas'),
      strokePlay: $('strokePlay'),
      strokeClose: $('strokeClose'),
      strokeBackdrop: $('strokeBackdrop'),
      strokeCount: $('strokeCount'),
      compareBtn: $('compareBtn'),
      compareSearch: $('compareSearch'),
      compareInput: $('compareInput'),
      compareResults: $('compareResults'),
      compareTray: $('compareTray'),
      strokeBtn: $('strokeBtn'),
      partsSheet: $('partsSheet'),
      partsChips: $('partsChips'),
      partsTitle: $('partsTitle'),
      partsGrid: $('partsGrid'),
      partsClose: $('partsClose'),
      backPill: $('backPill'),
      backKanji: $('backKanji'),
    };

    // Every fetch starts at once. The card renders as soon as the kanji data
    // is in, with the font glyph until the drawings arrive.
    state.dataReady = fetch('kanji_data.json').then((r) => r.json());
    loadDrawings().then(renderGlyph);
    state.data = await state.dataReady;
    state.kanjiIndex = new Map(state.data.map((d, i) => [d.kanji, i]));

    // Resume at the last kanji seen. Older versions saved an index (kanjiPos).
    const savedKanji = localStorage.getItem('kanjiCurrent');
    const savedIndex = parseInt(localStorage.getItem('kanjiPos'), 10);
    const i = savedKanji ? state.data.findIndex((d) => d.kanji === savedKanji) : savedIndex;
    if (i >= 0 && i < state.data.length) state.index = i;

    buildOnyomiNav();
    // Show the page before the first render, so the nav can scroll to the
    // current group (scrollIntoView does nothing while #main is hidden)
    els.loading.classList.add('hidden');
    els.main.classList.remove('hidden');
    render();
    bindTouch();
    bindKeys();
    bindStrokeModal();
    bindParts();
    bindBack();
    bindCompare();
    showHint();
    registerSW();
  }

  // ── Onyomi nav ──

  function buildOnyomiNav() {
    // Build ordered list of unique groups with their first index
    const seen = new Set();
    for (let i = 0; i < state.data.length; i++) {
      const g = state.data[i].group;
      if (!seen.has(g)) {
        seen.add(g);
        state.groups.push({ label: g, startIndex: i });
      }
    }

    const frag = document.createDocumentFragment();
    state.groups.forEach((g, gi) => {
      const pill = document.createElement('button');
      pill.className = 'onyomi-pill';
      pill.textContent = g.label;
      pill.dataset.gi = gi;
      pill.addEventListener('click', () => {
        goTo(g.startIndex, g.startIndex > state.index ? 'next' : 'prev');
      });
      frag.appendChild(pill);
    });
    els.onyomiNav.appendChild(frag);
  }

  function updateNavHighlight() {
    const cur = state.data[state.index].group;
    const pills = els.onyomiNav.children;
    for (let i = 0; i < pills.length; i++) {
      const gi = parseInt(pills[i].dataset.gi, 10);
      if (state.groups[gi].label === cur) {
        pills[i].classList.add('active');
        pills[i].scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
      } else {
        pills[i].classList.remove('active');
      }
    }
  }

  // ── Render ──

  function render() {
    const d = state.data[state.index];
    if (!d) return;

    renderGlyph();
    els.meanings.textContent = d.meanings.slice(0, 4).join(', ');
    els.counter.textContent = `${state.index + 1}\u2009/\u2009${state.data.length}`;

    // Readings
    renderReadings(els.onReadings, els.onGroup, d.onyomi, d.special);
    renderReadings(els.kunReadings, els.kunGroup, d.kunyomi, d.special);

    // Words
    if (d.words && d.words.length) {
      els.wordsSection.style.display = '';
      els.words.innerHTML = d.words.map((w) =>
        `<div class="word-item">` +
          `<div class="word-main">` +
            `<span class="word-kanji">${esc(w.word)}</span>` +
            `<span class="word-reading">${esc(w.reading)}</span>` +
          `</div>` +
          `<div class="word-meaning">${esc(w.meaning)}</div>` +
        `</div>`
      ).join('');
    } else {
      els.wordsSection.style.display = 'none';
    }

    // Progress
    els.progress.style.width = `${((state.index + 1) / state.data.length) * 100}%`;
    localStorage.setItem('kanjiCurrent', d.kanji);

    updateNavHighlight();
  }

  // The kanji itself: drawn from its stroke paths when they're loaded (so the
  // parts can be tapped and highlighted), the plain font glyph otherwise.
  function renderGlyph() {
    const d = state.data[state.index];
    if (!d) return;
    const paths = state.strokes && state.strokes[d.kanji];
    if (!paths || !paths.length) {
      els.kanji.textContent = d.kanji;
      return;
    }
    const hits = paths.map((p, i) => `<path class="hit" data-i="${i}" d="${p}"/>`).join('');
    els.kanji.innerHTML = glyphSvg(d.kanji, null, hits);
    highlightPart();
  }

  // SVG markup for a kanji drawn from its strokes; null if they're not loaded
  function glyphSvg(kanji, selected, extra) {
    const paths = state.strokes && state.strokes[kanji];
    if (!paths || !paths.length) return null;
    return `<svg class="kanji-svg" viewBox="0 0 109 109" data-kanji="${esc(kanji)}">` +
      strokePaths(paths, selected) + (extra || '') + `</svg>`;
  }

  function strokePaths(paths, selected) {
    return paths.map((p, i) =>
      `<path class="st${selected ? (selected.has(i) ? ' sel' : ' dim') : ''}" data-i="${i}" d="${p}"/>`
    ).join('');
  }

  // Kun readings mark okurigana with a dot (あわ.れむ); it's shown dimmed.
  // Special readings (indented in the official table: limited use, like
  // サッ in 早速) are dimmed as a whole.
  function renderReadings(valuesEl, groupEl, readings, special) {
    if (!readings.length) {
      groupEl.classList.add('empty');
      return;
    }
    groupEl.classList.remove('empty');
    valuesEl.innerHTML = readings.map((r) => {
      const [stem, okuri] = r.split('.');
      const text = esc(stem) + (okuri ? `<span class="okurigana">${esc(okuri)}</span>` : '');
      return special.includes(r)
        ? `<span class="reading special" title="Special reading: limited use">${text}</span>`
        : `<span class="reading">${text}</span>`;
    }).join('\u3001');
  }

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ESC[c]);
  }

  // ── Navigation ──

  // opts.keepBack: navigation along the back trail (a jump from the parts
  // list, or a step back), which keeps the trail and the compare tray; any
  // other navigation clears both.
  async function goTo(i, dir, opts) {
    if (state.animating) return;

    // Bounce at edges
    if (i < 0 || i >= state.data.length) {
      bounce(i < 0 ? 1 : -1);
      return;
    }

    const keepBack = !!(opts && opts.keepBack);
    state.animating = true;
    const card = els.card;
    const out = dir === 'next' ? -1 : 1;
    try {
      // Slide out
      card.style.transition = 'transform 0.1s ease-in, opacity 0.1s ease-in';
      card.style.transform = `translateY(${out * 18}%)`;
      card.style.opacity = '0';
      await sleep(100);

      // Update
      state.index = i;
      if (keepBack) {
        closeCompareSearch();
        const pinned = els.compareTray.querySelector(`.compare-card[data-kanji="${state.data[i].kanji}"]`);
        if (pinned) removeCompareCard(pinned);
      } else {
        clearCompare();
        state.backStack.length = 0;
        saveHistory();
      }
      closeParts();
      updateBackPill();
      render();

      // Position for entrance
      card.style.transition = 'none';
      card.style.transform = `translateY(${-out * 14}%)`;
      void card.offsetHeight;

      // Slide in
      card.style.transition = 'transform 0.18s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.15s ease-out';
      card.style.transform = 'translateY(0)';
      card.style.opacity = '1';
      await sleep(180);
    } finally {
      state.animating = false;
    }
    // A back/forward gesture that arrived mid-animation
    if (pendingHistory) restoreHistory(pendingHistory);
  }

  function bounce(dir) {
    const card = els.card;
    card.style.transition = 'transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1)';
    card.style.transform = `translateY(${dir * 12}px)`;
    setTimeout(() => {
      card.style.transform = 'translateY(0)';
    }, 170);
  }

  function next() { goTo(state.index + 1, 'next'); }
  function prev() { goTo(state.index - 1, 'prev'); }

  // ── Back trail ──
  //
  // A jump from the parts list pushes a history entry whose state holds the
  // target index and the trail of indices to return through. Browser history
  // is the source of truth, so the ← pill, the phone's back gesture and the
  // forward button all agree. Ordinary navigation rewrites the current entry
  // with an empty trail.

  let pendingHistory = null;

  function bindBack() {
    els.backPill.addEventListener('click', goBack);
    window.addEventListener('popstate', (e) => {
      const h = e.state;
      if (!h || !Array.isArray(h.trail)) return;
      if (state.animating) { pendingHistory = h; return; }
      restoreHistory(h);
    });
    // After a reload the entry is still there: pick its trail back up
    const h = history.state;
    if (h && Array.isArray(h.trail) && h.index === state.index && h.trail.every(validIndex)) {
      state.backStack = h.trail.slice();
    } else {
      saveHistory();
    }
    updateBackPill();
  }

  function validIndex(i) {
    return Number.isInteger(i) && i >= 0 && i < state.data.length;
  }

  function historyEntry(index, trail) {
    return { index, trail: trail.slice() };
  }

  function saveHistory() {
    try { history.replaceState(historyEntry(state.index, state.backStack), ''); } catch (e) { /* no history */ }
  }

  // Jump from the parts list, remembering where we came from
  function jumpTo(i) {
    if (state.animating || i === state.index) return;
    state.backStack.push(state.index);
    try { history.pushState(historyEntry(i, state.backStack), ''); } catch (e) { /* no history */ }
    goTo(i, i > state.index ? 'next' : 'prev', { keepBack: true });
  }

  function goBack() {
    if (state.animating || !state.backStack.length) return;
    const h = history.state;
    if (h && Array.isArray(h.trail) && h.trail.length) {
      history.back();   // popstate does the rest
      return;
    }
    // No usable history (file://): step back by hand
    restoreHistory(historyEntry(state.backStack[state.backStack.length - 1], state.backStack.slice(0, -1)));
  }

  function restoreHistory(h) {
    pendingHistory = null;
    if (!validIndex(h.index)) return;
    state.backStack = h.trail.filter(validIndex);
    if (h.index === state.index) { updateBackPill(); return; }
    goTo(h.index, h.index > state.index ? 'next' : 'prev', { keepBack: true });
  }

  function updateBackPill() {
    const n = state.backStack.length;
    els.backPill.classList.toggle('visible', n > 0);
    if (n) els.backKanji.textContent = state.data[state.backStack[n - 1]].kanji;
  }

  // ── Touch ──

  function bindTouch() {
    let startY = 0, startX = 0, curY = 0, dragging = false, t0 = 0;
    let ignored = false;
    const card = els.card;
    const container = els.container;

    container.addEventListener('touchstart', (e) => {
      ignored = !els.compareSearch.classList.contains('hidden');
      if (state.animating || ignored) return;
      const touch = e.touches[0];
      startY = curY = touch.clientY;
      startX = touch.clientX;
      dragging = false;
      t0 = Date.now();
      card.style.transition = 'none';
    }, { passive: true });

    container.addEventListener('touchmove', (e) => {
      if (state.animating || ignored) return;
      const touch = e.touches[0];
      const dy = touch.clientY - startY;
      const dx = touch.clientX - startX;

      if (!dragging) {
        if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx) * 1.2) {
          dragging = true;
        } else {
          return;
        }
      }

      e.preventDefault();
      curY = touch.clientY;
      const dampened = dy * 0.45;
      card.style.transform = `translateY(${dampened}px)`;
      card.style.opacity = `${Math.max(0.4, 1 - Math.abs(dy) / 400)}`;
    }, { passive: false });

    container.addEventListener('touchend', () => {
      if (ignored) { ignored = false; return; }
      if (!dragging || state.animating) {
        card.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
        card.style.transform = 'translateY(0)';
        card.style.opacity = '1';
        return;
      }

      const dy = curY - startY;
      const v = Math.abs(dy) / (Date.now() - t0);

      if (Math.abs(dy) > 40 || v > 0.25) {
        dy < 0 ? next() : prev();
      } else {
        card.style.transition = 'transform 0.3s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.3s ease';
        card.style.transform = 'translateY(0)';
        card.style.opacity = '1';
      }
      dragging = false;
    }, { passive: true });
  }

  // ── Keyboard ──

  function strokeModalOpen() {
    return !els.strokeModal.classList.contains('hidden');
  }

  function bindKeys() {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && strokeModalOpen()) {
        closeStrokeModal(); return;
      }
      if (strokeModalOpen()) return;
      if (e.key === 'Escape' && partsOpen()) {
        closeParts(); return;
      }
      if (e.target === els.compareInput) return;
      switch (e.key) {
        case 'ArrowDown': case 'ArrowRight': case ' ':
          e.preventDefault(); next(); break;
        case 'ArrowUp': case 'ArrowLeft':
          e.preventDefault(); prev(); break;
      }
    });
  }

  // ── Stroke order modal ──

  function loadDrawings() {
    if (state.drawings) return state.drawings;
    const get = (url) => fetch(url).then((r) => {
      if (!r.ok) throw new Error(`${url}: ${r.status}`);
      return r.json();
    });
    state.drawings = Promise.all([get('strokes.json'), get('components.json'), state.dataReady])
      .then(([strokes, components]) => {
        state.strokes = strokes;
        state.components = components;
        buildPartIndex();
      })
      .catch(() => {
        state.drawings = null;   // so the next tap tries again
      });
    return state.drawings;
  }

  function bindStrokeModal() {
    els.strokeBtn.addEventListener('click', async () => {
      const kanji = state.data[state.index].kanji;
      await loadDrawings();
      const paths = state.strokes && state.strokes[kanji];
      if (!paths || !paths.length) return;
      openStrokeModal(paths);
    });
    els.strokePlay.addEventListener('click', () => {
      const svg = els.strokeCanvas.querySelector('svg');
      if (svg) animateStrokes(svg);
    });
    els.strokeClose.addEventListener('click', closeStrokeModal);
    els.strokeBackdrop.addEventListener('click', closeStrokeModal);
  }

  function openStrokeModal(paths) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 109 109');

    paths.forEach((d) => {
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '3');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(path);
    });

    els.strokeCanvas.innerHTML = '';
    els.strokeCanvas.appendChild(svg);
    els.strokeCount.textContent = `${paths.length} stroke${paths.length === 1 ? '' : 's'}`;
    els.strokeModal.classList.remove('hidden');
    animateStrokes(svg);
  }

  function animateStrokes(svg) {
    const paths = svg.querySelectorAll('path');
    const n = paths.length;
    const dur = Math.max(0.25, 0.55 - n * 0.012);
    const gap = 0.12;

    paths.forEach((p) => {
      const len = p.getTotalLength();
      p.style.transition = 'none';
      p.style.strokeDasharray = len;
      p.style.strokeDashoffset = len;
      p.style.opacity = '0';
    });

    let delay = 80;
    paths.forEach((p) => {
      setTimeout(() => {
        p.style.opacity = '1';
        p.style.transition = `stroke-dashoffset ${dur}s ease`;
        p.style.strokeDashoffset = '0';
      }, delay);
      delay += (dur + gap) * 1000;
    });
  }

  function closeStrokeModal() {
    els.strokeModal.classList.add('hidden');
    els.strokeCanvas.innerHTML = '';
  }

  // ── Parts ──
  //
  // components.json gives each kanji's KanjiVG decomposition as a list of
  // nodes {e: element, s: [stroke indices], p: parent index, o?: original
  // form}, node 0 being the kanji itself. Tapping a stroke on the card selects
  // the smallest part containing it; tapping it again climbs to the next
  // larger one. The sheet lists every other jōyō kanji that has that part.

  function buildPartIndex() {
    state.partIndex = new Map();
    state.data.forEach((d, i) => {
      const nodes = state.components[d.kanji];
      if (!nodes) return;
      const seen = new Set();
      nodes.forEach((n) => {
        if (seen.has(n.e)) return;
        seen.add(n.e);
        if (!state.partIndex.has(n.e)) state.partIndex.set(n.e, []);
        state.partIndex.get(n.e).push(i);
      });
    });
  }

  function partNodes(kanji) {
    return (state.components && state.components[kanji]) || [];
  }

  // Clusters are unnamed KanjiVG groups of two or more parts that aren't a
  // character themselves (the 冖+心+夂 under 愛). Their element is "+" and
  // the pieces joined by "+", with "·n" for n strokes outside the pieces:
  // "+冖+心+夂". A few parts carry KanjiVG's own names for shapes with no
  // character (CDP-8BC4 in 原); those are drawn too, but have no label.
  function isCluster(element) {
    return element[0] === '+';
  }

  function isDrawn(element) {
    return isCluster(element) || Array.from(element).length > 1;
  }

  function clusterLabel(element) {
    if (!isCluster(element)) return '';
    const [pieces, loose] = element.slice(1).split('\u00b7');
    const parts = pieces.split('+');
    if (loose) parts.push(`${loose} stroke${loose === '1' ? '' : 's'}`);
    return parts.join(' + ');
  }

  // Distinct parts of the current kanji, in stroke order. The kanji itself,
  // and clusters, count as parts only when other kanji contain them.
  function partsOfCurrent() {
    const kanji = state.data[state.index].kanji;
    const seen = new Map();
    partNodes(kanji).forEach((n, i) => {
      const uses = (state.partIndex.get(n.e) || []).length;
      if ((i === 0 || isCluster(n.e)) && uses < 2) return;
      if (!seen.has(n.e)) seen.set(n.e, { e: n.e, o: n.o, first: i === 0 ? Infinity : n.s[0], uses });
    });
    return [...seen.values()].sort((a, b) => a.first - b.first);
  }

  // Stroke indices of a part within a kanji (all occurrences: both 木 in 林)
  function partStrokes(kanji, element) {
    const set = new Set();
    partNodes(kanji).forEach((n) => {
      if (n.e === element) n.s.forEach((i) => set.add(i));
    });
    return set;
  }

  function bindParts() {
    els.kanji.addEventListener('click', async (e) => {
      await loadDrawings();
      if (!state.partIndex) return;
      const hit = e.target.closest && e.target.closest('path.hit');
      if (hit) {
        tapStroke(parseInt(hit.dataset.i, 10));
      } else if (partsOpen()) {
        closeParts();
      } else {
        openParts(null);
      }
    });

    els.partsClose.addEventListener('click', closeParts);

    els.partsChips.addEventListener('click', (e) => {
      const chip = e.target.closest('.part-chip');
      if (chip) openParts(chip.dataset.e);
    });

    els.partsGrid.addEventListener('click', (e) => {
      const cell = e.target.closest('.part-cell');
      if (!cell) return;
      const i = parseInt(cell.dataset.i, 10);
      if (e.target.closest('.part-cell-add')) {
        // Pin to the compare tray and stay in the list
        addCompareCard(state.data[i].kanji);
        cell.classList.add('added');
        return;
      }
      jumpTo(i);
    });
  }

  function tapStroke(stroke) {
    const kanji = state.data[state.index].kanji;
    const shown = new Set(partsOfCurrent().map((p) => p.e));
    // Parts containing this stroke, smallest first, each element once
    const cands = [];
    partNodes(kanji)
      .filter((n) => shown.has(n.e) && n.s.includes(stroke))
      .sort((a, b) => a.s.length - b.s.length)
      .forEach((n) => { if (!cands.includes(n.e)) cands.push(n.e); });
    if (!cands.length) {
      partsOpen() ? closeParts() : openParts(null);
      return;
    }
    const k = cands.indexOf(state.part);
    openParts(cands[(k + 1) % cands.length]);
  }

  function partsOpen() {
    return els.partsSheet.classList.contains('open');
  }

  function openParts(element) {
    state.part = element;
    renderChips();
    renderPartList();
    highlightPart();
    els.partsSheet.classList.add('open');
    els.partsSheet.setAttribute('aria-hidden', 'false');
  }

  function closeParts() {
    if (!partsOpen() && state.part === null) return;
    state.part = null;
    gridJob++;   // stop any list still being built
    els.partsSheet.classList.remove('open');
    els.partsSheet.setAttribute('aria-hidden', 'true');
    highlightPart();
    // Let the sheet slide away, then drop the grid (hundreds of small SVGs)
    setTimeout(() => { if (!partsOpen()) els.partsGrid.innerHTML = ''; }, 300);
  }

  // Colour the selected part on the card and on any compare cards
  function highlightPart() {
    const svgs = [els.kanji.querySelector('svg'), ...els.compareTray.querySelectorAll('svg')];
    svgs.forEach((svg) => {
      if (!svg) return;
      const sel = state.part ? partStrokes(svg.dataset.kanji, state.part) : null;
      svg.querySelectorAll('path.st').forEach((p) => {
        const i = parseInt(p.dataset.i, 10);
        p.classList.toggle('sel', !!sel && sel.has(i));
        p.classList.toggle('dim', !!sel && !sel.has(i));
      });
    });
  }

  function renderChips() {
    const parts = partsOfCurrent();
    els.partsChips.innerHTML = parts.map((p) =>
      `<button class="part-chip${p.e === state.part ? ' active' : ''}${readingSeries(p.e).phonetic ? ' phon' : ''}" data-e="${esc(p.e)}"` +
        (p.o ? ` title="${esc('form of ' + p.o)}"` : '') +
        (isCluster(p.e) ? ` title="${esc(clusterLabel(p.e))}"` : '') + `>` +
        (isDrawn(p.e) ? clusterGlyph(p.e) : esc(p.e)) +
        `<span class="part-chip-count">${p.uses - 1}</span>` +
      `</button>`
    ).join('');
    fitClusterGlyphs(els.partsChips);
    const active = els.partsChips.querySelector('.active');
    if (active) active.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }

  let gridJob = 0;

  function renderPartList() {
    gridJob++;
    els.partsGrid.innerHTML = '';
    els.partsGrid.scrollTop = 0;

    const parts = partsOfCurrent();
    if (!state.part) {
      els.partsTitle.textContent = parts.length
        ? 'Tap a part of the kanji, or pick one above'
        : 'No parts recorded for this kanji';
      return;
    }

    const info = parts.find((p) => p.e === state.part) || { e: state.part };
    const cur = state.data[state.index];
    const others = (state.partIndex.get(state.part) || []).filter((i) => i !== state.index);
    const series = readingSeries(state.part);

    // The list: cell indices, with header rows ({label, n}) when the part is
    // phonetic. Otherwise kanji sharing an on'yomi with the current one come
    // first, the rest in table order.
    let list;
    if (series.phonetic) {
      list = [];
      const placed = new Set();
      series.groups.forEach((g) => {
        if (g.members.size < 2) return;
        const mem = others.filter((i) => g.members.has(i) && !placed.has(i));
        if (!mem.length) return;
        list.push({ label: [...g.readings].join('・'), n: mem.length });
        mem.forEach((i) => { placed.add(i); list.push(i); });
      });
      const rest = others.filter((i) => !placed.has(i));
      if (rest.length) list.push({ label: 'other readings', n: rest.length, other: true }, ...rest);
    } else {
      const shared = [], rest = [];
      others.forEach((i) => (state.data[i].onyomi.some((r) => cur.onyomi.includes(r)) ? shared : rest).push(i));
      list = shared.concat(rest);
    }

    const label = isDrawn(info.e)
      ? clusterGlyph(info.e) + (isCluster(info.e) ? ` <b>${esc(clusterLabel(info.e))}</b>` : '')
      : `<b>${esc(info.e)}</b>` + (info.o ? ` <span>(form of ${esc(info.o)})</span>` : '');
    const phon = series.phonetic
      ? ` · reads <b class="series">${esc([...series.top.readings].join('・'))}</b> in ${series.top.members.size} of ${series.total}`
      : '';
    els.partsTitle.innerHTML = others.length
      ? `${label} · in ${others.length} other kanji${phon}`
      : `${label} · no other jōyō kanji has this part`;
    fitClusterGlyphs(els.partsTitle);

    // Build the grid in time-boxed batches so a 400-kanji part doesn't freeze
    // the tap. The job captures its inputs: the card may move on before it
    // finishes, and closeParts() cancels it by bumping gridJob.
    const job = gridJob;
    const ctx = {
      part: state.part,
      cur,
      pinned: new Set([...els.compareTray.children].map((c) => c.dataset.kanji)),
    };
    let pos = 0;
    const batch = (count, budgetMs) => {
      const frag = document.createDocumentFragment();
      const t0 = performance.now();
      const end = count ? Math.min(pos + count, list.length) : list.length;
      do {
        const it = list[pos++];
        frag.appendChild(typeof it === 'number' ? partCell(it, ctx) : groupHeader(it));
      } while (pos < end && (count || performance.now() - t0 < budgetMs));
      els.partsGrid.appendChild(frag);
    };
    const step = () => {
      if (job !== gridJob) return;
      batch(0, 6);
      if (pos < list.length) requestAnimationFrame(step);
    };
    if (!list.length) return;
    // Enough to fill the visible rows now; the rest once the sheet has slid in
    batch(20);
    if (pos < list.length) setTimeout(step, partsOpen() ? 0 : 260);
  }

  function groupHeader(g) {
    const h = document.createElement('div');
    h.className = 'part-group' + (g.other ? ' other' : '');
    h.innerHTML = `${esc(g.label)}<span>${g.n}</span>`;
    return h;
  }

  // ── Phonetic series ──
  //
  // A part that gives most of its kanji the same on'yomi is their phonetic
  // component: 复 reads フク in 復 腹 複 覆. Readings differing only in the
  // voicing of the first kana (ハ/バ in 波 婆) count as one series.

  const DEVOICE = {
    ガ: 'カ', ギ: 'キ', グ: 'ク', ゲ: 'ケ', ゴ: 'コ', ザ: 'サ', ジ: 'シ', ズ: 'ス', ゼ: 'セ', ゾ: 'ソ',
    ダ: 'タ', ヂ: 'チ', ヅ: 'ツ', デ: 'テ', ド: 'ト', バ: 'ハ', ビ: 'ヒ', ブ: 'フ', ベ: 'ヘ', ボ: 'ホ',
    パ: 'ハ', ピ: 'ヒ', プ: 'フ', ペ: 'ヘ', ポ: 'ホ',
  };
  const seriesCache = new Map();

  function readingSeries(element) {
    if (seriesCache.has(element)) return seriesCache.get(element);
    const idxs = state.partIndex.get(element) || [];
    const groups = new Map();
    idxs.forEach((i) => {
      state.data[i].onyomi.forEach((r) => {
        const key = (DEVOICE[r[0]] || r[0]) + r.slice(1);
        if (!groups.has(key)) groups.set(key, { readings: new Set(), members: new Set() });
        groups.get(key).readings.add(r);
        groups.get(key).members.add(i);
      });
    });
    const sorted = [...groups.values()].sort((a, b) => b.members.size - a.members.size);
    const top = sorted[0];
    const result = {
      total: idxs.length,
      groups: sorted,
      top,
      phonetic: !!top && top.members.size >= 2 && top.members.size >= idxs.length * 0.4,
    };
    seriesCache.set(element, result);
    return result;
  }

  function partCell(i, ctx) {
    const d = state.data[i];
    const cell = document.createElement('div');
    cell.className = 'part-cell' + (ctx.pinned.has(d.kanji) ? ' added' : '');
    cell.dataset.i = i;
    cell.setAttribute('role', 'button');
    const glyph = glyphSvg(d.kanji, partStrokes(d.kanji, ctx.part))
      || `<span class="part-cell-kanji">${esc(d.kanji)}</span>`;
    cell.innerHTML =
      `<button class="part-cell-add" aria-label="Add to compare" title="Add to compare"></button>` +
      glyph + readingsLine(d.kanji, 'part-cell-on', ctx.cur) +
      `<span class="part-cell-meaning">${esc(d.meanings[0] || '')}</span>`;
    return cell;
  }

  // A cluster has no character to show, so draw it from the current kanji's
  // own strokes, cropped to those strokes. The crop needs getBBox(), which
  // needs the SVG in the DOM, so it's measured once and cached per
  // kanji + part.
  const cropCache = new Map();

  function clusterGlyph(element) {
    const kanji = state.data[state.index].kanji;
    const paths = state.strokes[kanji] || [];
    const strokes = partStrokes(kanji, element);
    const d = paths.map((p, i) => strokes.has(i) ? `<path class="st" d="${p}"/>` : '').join('');
    const crop = cropCache.get(`${kanji}|${element}`);
    const attrs = crop
      ? `viewBox="${crop.viewBox}" style="--sw:${crop.sw}"`
      : `viewBox="0 0 109 109" data-fit="${esc(kanji)}|${esc(element)}"`;
    return `<svg class="kanji-svg cluster-glyph" ${attrs}>${d}</svg>`;
  }

  function fitClusterGlyphs(root) {
    root.querySelectorAll('svg.cluster-glyph[data-fit]').forEach((svg) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      svg.querySelectorAll('path').forEach((p) => {
        const b = p.getBBox();
        x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
        x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height);
      });
      if (x0 === Infinity) return;
      // Square crop around the strokes, padded for stroke width
      const pad = 7;
      const size = Math.max(x1 - x0, y1 - y0) + pad * 2;
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const crop = {
        viewBox: `${cx - size / 2} ${cy - size / 2} ${size} ${size}`,
        // Keep the stroke weight similar to a full-size chip character
        sw: Math.max(5.5, size / 109 * 9),
      };
      svg.setAttribute('viewBox', crop.viewBox);
      svg.style.setProperty('--sw', `${crop.sw}`);
      cropCache.set(svg.dataset.fit, crop);
      svg.removeAttribute('data-fit');
    });
  }

  // ── Compare ──

  function bindCompare() {
    els.compareBtn.addEventListener('click', toggleCompareSearch);

    // Prevent touch events in search area from reaching card swipe handler
    ['touchstart', 'touchmove', 'touchend'].forEach((evt) => {
      els.compareSearch.addEventListener(evt, (e) => e.stopPropagation(), { passive: false });
    });

    let debounce = 0;
    els.compareInput.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => searchKanji(els.compareInput.value.trim()), 80);
    });

    els.compareInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeCompareSearch();
        e.stopPropagation();
      }
    });
  }

  function toggleCompareSearch() {
    const open = els.compareSearch.classList.contains('hidden');
    if (open) {
      els.compareSearch.classList.remove('hidden');
      els.compareBtn.classList.add('active');
      els.compareInput.value = '';
      els.compareResults.classList.remove('visible');
      els.compareInput.focus();
    } else {
      closeCompareSearch();
    }
  }

  function closeCompareSearch() {
    els.compareSearch.classList.add('hidden');
    els.compareBtn.classList.remove('active');
    els.compareResults.classList.remove('visible');
    els.compareInput.blur();
  }

  function searchKanji(query) {
    if (!query) {
      els.compareResults.classList.remove('visible');
      return;
    }

    const q = query.toLowerCase();
    const current = state.data[state.index].kanji;
    const matches = [];

    for (let i = 0; i < state.data.length && matches.length < 8; i++) {
      const d = state.data[i];
      if (d.kanji === current) continue;

      // Match by kanji character, meanings, or readings
      if (d.kanji === query ||
          d.meanings.some((m) => m.toLowerCase().includes(q)) ||
          d.onyomi.some((r) => r.includes(query) || katToHira(r).includes(q)) ||
          d.kunyomi.some((r) => r.replace('.', '').includes(q))) {
        matches.push(d);
      }
    }

    if (!matches.length) {
      els.compareResults.classList.remove('visible');
      return;
    }

    els.compareResults.innerHTML = matches.map((d) =>
      `<div class="compare-result-item" data-kanji="${esc(d.kanji)}">` +
        `<span class="compare-result-kanji">${esc(d.kanji)}</span>` +
        `<span class="compare-result-info">${esc(d.meanings.slice(0, 3).join(', '))}</span>` +
      `</div>`
    ).join('');

    els.compareResults.querySelectorAll('.compare-result-item').forEach((el) => {
      el.addEventListener('click', () => {
        addCompareCard(el.dataset.kanji);
        closeCompareSearch();
      });
    });

    els.compareResults.classList.add('visible');
  }

  function katToHira(s) {
    return s.replace(/[\u30A1-\u30F6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  }

  function trayHas(kanji) {
    return !!els.compareTray.querySelector(`.compare-card[data-kanji="${kanji}"]`);
  }

  function addCompareCard(kanji) {
    const tray = els.compareTray;
    if (trayHas(kanji)) return;
    // Max 2 comparison cards
    if (tray.children.length >= 2) removeCompareCard(tray.firstChild);

    const card = document.createElement('div');
    card.className = 'compare-card';
    card.dataset.kanji = kanji;
    card.innerHTML =
      `<button class="compare-card-close" aria-label="Remove">&times;</button>` +
      (glyphSvg(kanji) || `<span class="compare-card-kanji">${esc(kanji)}</span>`) +
      readingsLine(kanji, 'compare-card-readings', state.data[state.index]);

    card.querySelector('.compare-card-close').addEventListener('click', () => {
      removeCompareCard(card);
    });

    tray.appendChild(card);
    highlightPart();
  }

  // On'yomi line for a compare card or parts-list cell. Lookalikes often
  // share a sound, so readings the current kanji also has are shown brighter.
  // Falls back to the first kun reading when there's no on'yomi.
  function readingsLine(kanji, cls, cur) {
    const d = state.data[state.kanjiIndex.get(kanji)];
    if (d.onyomi.length) {
      const items = d.onyomi.map((r) => {
        const c = ['on'];
        if (cur.onyomi.includes(r)) c.push('shared');
        if (d.special.includes(r)) c.push('special');
        return `<span class="${c.join(' ')}">${esc(r)}</span>`;
      });
      return `<span class="${cls} reading-line">${items.join('\u3001')}</span>`;
    }
    if (d.kunyomi.length) {
      const stem = d.kunyomi[0].split('.')[0];
      return `<span class="${cls} reading-line"><span class="kun">${esc(stem)}</span></span>`;
    }
    return `<span class="${cls} reading-line"></span>`;
  }

  function removeCompareCard(card) {
    const i = state.kanjiIndex.get(card.dataset.kanji);
    const cell = els.partsGrid.querySelector(`.part-cell[data-i="${i}"]`);
    if (cell) cell.classList.remove('added');
    card.remove();
  }

  function clearCompare() {
    els.compareTray.innerHTML = '';
    closeCompareSearch();
  }

  // ── Util ──

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function showHint() {
    if (localStorage.getItem('kanjiHintShown')) return;
    els.hint.classList.add('visible');
    setTimeout(() => {
      els.hint.classList.remove('visible');
      localStorage.setItem('kanjiHintShown', '1');
    }, 2500);
  }

  function registerSW() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
