(() => {
  'use strict';

  const state = { data: [], index: 0, animating: false, groups: [], strokes: null };
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
    };

    const res = await fetch('kanji_data.json');
    state.data = await res.json();

    const saved = localStorage.getItem('kanjiPos');
    if (saved !== null) {
      const i = parseInt(saved, 10);
      if (i >= 0 && i < state.data.length) state.index = i;
    }

    buildOnyomiNav();
    render();
    els.loading.classList.add('hidden');
    els.main.classList.remove('hidden');
    bindTouch();
    bindKeys();
    bindStrokeModal();
    bindCompare();
    showHint();
    registerSW();
  }

  // ── Onyomi nav ──

  function buildOnyomiNav() {
    // Build ordered list of unique groups with their first index
    const seen = new Set();
    for (let i = 0; i < state.data.length; i++) {
      const g = state.data[i].onyomiGroup;
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
    const cur = state.data[state.index].onyomiGroup;
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

    els.kanji.textContent = d.kanji;
    els.meanings.textContent = d.meanings.slice(0, 4).join(', ');
    els.counter.textContent = `${state.index + 1}\u2009/\u2009${state.data.length}`;

    // Readings
    if (d.onyomi.length) {
      els.onReadings.textContent = d.onyomi.join('\u3001');
      els.onGroup.classList.remove('empty');
    } else {
      els.onGroup.classList.add('empty');
    }

    if (d.kunyomi.length) {
      els.kunReadings.textContent = d.kunyomi.join('\u3001');
      els.kunGroup.classList.remove('empty');
    } else {
      els.kunGroup.classList.add('empty');
    }

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
    localStorage.setItem('kanjiPos', state.index);

    updateNavHighlight();
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // ── Navigation ──

  async function goTo(i, dir) {
    if (state.animating) return;

    // Bounce at edges
    if (i < 0 || i >= state.data.length) {
      bounce(i < 0 ? 1 : -1);
      return;
    }

    state.animating = true;
    const card = els.card;
    const out = dir === 'next' ? -1 : 1;

    // Slide out
    card.style.transition = 'transform 0.1s ease-in, opacity 0.1s ease-in';
    card.style.transform = `translateY(${out * 18}%)`;
    card.style.opacity = '0';
    await sleep(100);

    // Update
    state.index = i;
    clearCompare();
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

    state.animating = false;
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

  // ── Touch ──

  function bindTouch() {
    let startY = 0, startX = 0, curY = 0, dragging = false, t0 = 0;
    const card = els.card;
    const container = els.container;

    container.addEventListener('touchstart', (e) => {
      if (state.animating) return;
      const touch = e.touches[0];
      startY = curY = touch.clientY;
      startX = touch.clientX;
      dragging = false;
      t0 = Date.now();
      card.style.transition = 'none';
    }, { passive: true });

    container.addEventListener('touchmove', (e) => {
      if (state.animating) return;
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
      switch (e.key) {
        case 'ArrowDown': case 'ArrowRight': case ' ':
          e.preventDefault(); next(); break;
        case 'ArrowUp': case 'ArrowLeft':
          e.preventDefault(); prev(); break;
      }
    });
  }

  // ── Stroke order modal ──

  async function loadStrokes() {
    if (state.strokes) return state.strokes;
    try {
      const res = await fetch('strokes.json');
      state.strokes = await res.json();
    } catch (e) {
      state.strokes = {};
    }
    return state.strokes;
  }

  function bindStrokeModal() {
    els.kanji.addEventListener('click', async () => {
      const kanji = state.data[state.index].kanji;
      const strokes = await loadStrokes();
      const paths = strokes[kanji];
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
    els.strokeCount.textContent = `${paths.length} strokes`;
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

  // ── Compare ──

  function bindCompare() {
    els.compareBtn.addEventListener('click', toggleCompareSearch);

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

  function addCompareCard(kanji) {
    const tray = els.compareTray;
    // Max 2 comparison cards
    if (tray.children.length >= 2) tray.removeChild(tray.firstChild);

    const card = document.createElement('div');
    card.className = 'compare-card';
    card.innerHTML =
      `<button class="compare-card-close" aria-label="Remove">&times;</button>` +
      `<span class="compare-card-kanji">${esc(kanji)}</span>`;

    card.querySelector('.compare-card-close').addEventListener('click', () => {
      card.remove();
    });

    tray.appendChild(card);
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
