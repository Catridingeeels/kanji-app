// The app shell changes often and is small; the data files change rarely
// and are 3 MB. Caching them separately means an app update doesn't make
// the phone download the data again. Bump SHELL for code changes, DATA when
// kanji_data.json, strokes.json or components.json are rebuilt.
const SHELL = 'kanji-shell-v13';
const DATA = 'kanji-data-v1';
const SHELL_ASSETS = ['./', './index.html', './style.css', './app.js'];
const DATA_ASSETS = ['./kanji_data.json', './strokes.json', './components.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(Promise.all([
    caches.open(SHELL).then((c) => c.addAll(SHELL_ASSETS)),
    caches.open(DATA).then((c) => c.addAll(DATA_ASSETS)),
  ]));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then((r) => r || fetch(e.request))
  );
});
