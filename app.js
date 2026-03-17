(() => {
  'use strict';

  const state = { data: [], index: 0, animating: false };
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
      badge: $('onyomiBadge'),
      onReadings: $('onyomiReadings'),
      kunReadings: $('kunyomiReadings'),
      onGroup: $('onyomiGroup'),
      kunGroup: $('kunyomiGroup'),
      words: $('wordsList'),
      wordsSection: $('wordsSection'),
      counter: $('counter'),
      progress: $('progressFill'),
      hint: $('navHint'),
    };

    const res = await fetch('kanji_data.json');
    state.data = await res.json();

    const saved = localStorage.getItem('kanjiPos');
    if (saved !== null) {
      const i = parseInt(saved, 10);
      if (i >= 0 && i < state.data.length) state.index = i;
    }

    render();
    els.loading.classList.add('hidden');
    els.main.classList.remove('hidden');
    bindTouch();
    bindKeys();
    showHint();
    registerSW();
  }

  // ── Render ──

  function render() {
    const d = state.data[state.index];
    if (!d) return;

    els.kanji.textContent = d.kanji;
    els.meanings.textContent = d.meanings.slice(0, 4).join(', ');
    els.badge.textContent = d.onyomiGroup;
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
    card.style.transition = 'transform 0.18s ease-in, opacity 0.18s ease-in';
    card.style.transform = `translateY(${out * 22}%)`;
    card.style.opacity = '0';
    await sleep(180);

    // Update
    state.index = i;
    render();

    // Position for entrance
    card.style.transition = 'none';
    card.style.transform = `translateY(${-out * 18}%)`;
    void card.offsetHeight;

    // Slide in
    card.style.transition = 'transform 0.32s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.28s ease-out';
    card.style.transform = 'translateY(0)';
    card.style.opacity = '1';
    await sleep(320);

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

  function bindKeys() {
    document.addEventListener('keydown', (e) => {
      switch (e.key) {
        case 'ArrowDown': case 'ArrowRight': case ' ':
          e.preventDefault(); next(); break;
        case 'ArrowUp': case 'ArrowLeft':
          e.preventDefault(); prev(); break;
      }
    });
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
