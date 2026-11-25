/* NEXUS ServiceFlow service worker.
 * - App shell + built assets cached so the technician app opens without a connection.
 * - API requests are never cached here (data caching is per-user in the app, cleared on logout).
 * - Web push: shows job notifications and opens the right screen when tapped.
 */
const SHELL_CACHE = 'sf-shell';
const ASSET_CACHE = 'sf-assets';

async function precache() {
  const res = await fetch('/precache.json', { cache: 'no-store' });
  if (!res.ok) return;
  const { version, assets } = await res.json();
  const cache = await caches.open(ASSET_CACHE);
  const have = new Set((await cache.keys()).map((r) => new URL(r.url).pathname));
  // Hashed file names never change content, so only fetch what is missing.
  await Promise.all(assets.filter((a) => !have.has(a)).map((a) => cache.add(a).catch(() => undefined)));
  // Drop assets from older builds.
  const keep = new Set(assets);
  await Promise.all((await cache.keys()).filter((r) => !keep.has(new URL(r.url).pathname)).map((r) => cache.delete(r)));
  const shell = await caches.open(SHELL_CACHE);
  await shell.put('/index.html', await fetch('/index.html', { cache: 'no-store' }));
  await shell.put('/__version', new Response(version));
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== SHELL_CACHE && n !== ASSET_CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'refresh-precache') event.waitUntil(precache());
  if (event.data === 'clear-caches') event.waitUntil(Promise.all([caches.delete(SHELL_CACHE), caches.delete(ASSET_CACHE)]));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/sw.js' || url.pathname === '/precache.json') return;

  // Page navigations: network first (fresh deploys), fall back to the cached app shell offline.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok && (res.headers.get('content-type') || '').includes('text/html')) {
          (await caches.open(SHELL_CACHE)).put('/index.html', res.clone());
        }
        return res;
      } catch {
        return (await caches.match('/index.html', { cacheName: SHELL_CACHE })) || new Response('Offline', { status: 503 });
      }
    })());
    return;
  }

  // Built assets: cache first (content-hashed, immutable).
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/') || url.pathname === '/favicon.svg' || url.pathname === '/manifest.webmanifest') {
    event.respondWith((async () => {
      const cached = await caches.match(req, { cacheName: ASSET_CACHE });
      if (cached) return cached;
      const res = await fetch(req);
      if (res.ok) (await caches.open(ASSET_CACHE)).put(req, res.clone());
      return res;
    })());
  }
});

// ── Web push ───────────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: event.data && event.data.text() }; }
  const title = data.title || 'NEXUS ServiceFlow';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || undefined,
    tag: data.tag || undefined,
    renotify: !!data.tag,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    data: { link: data.link || null },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || '/tech';
  const target = new URL(link, self.location.origin);
  if (target.origin !== self.location.origin) return; // only ever open our own pages
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin && 'focus' in w) {
        await w.focus();
        if ('navigate' in w) { try { await w.navigate(target.href); } catch { /* cross-scope */ } }
        return;
      }
    }
    await self.clients.openWindow(target.href);
  })());
});
