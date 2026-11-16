// Offline cache for レパートリー練習帳 and タクティクス練習帳. Bump VERSION when the file list changes.
const VERSION = 'rt-v2';
const FILES = ['./', 'index.html', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png',
  'tactics.html', 'tactics.webmanifest', 'puzzles.json', 'ticon-180.png', 'ticon-192.png', 'ticon-512.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
const pageKey = url => (new URL(url).pathname.endsWith('/tactics.html') ? 'tactics.html' : 'index.html');
// Pages and the puzzle file: try the network briefly (to pick up updates), fall back to the cached copy when offline.
async function fresh(req, key) {
  const cached = await caches.match(key, { ignoreSearch: true });
  try {
    const net = await Promise.race([fetch(req), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))]);
    if (net && net.ok) { const copy = net.clone(); caches.open(VERSION).then(c => c.put(key, copy)); }
    return net;
  } catch (err) { return cached || Response.error(); }
}
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (req.mode === 'navigate') { e.respondWith(fresh(req, pageKey(req.url))); return; }
  if (new URL(req.url).pathname.endsWith('/puzzles.json')) { e.respondWith(fresh(req, 'puzzles.json')); return; }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req)));
});
