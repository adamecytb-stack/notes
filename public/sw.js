/**
 * Service worker.
 *
 * Caches the app shell so Nocturne opens instantly with no network — which is
 * the normal case at 3am. API traffic is never cached: entries live in
 * IndexedDB and are reconciled by store.js.
 */

const CACHE = 'nocturne-v2';

/**
 * Note "/" rather than "/index.html": Cloudflare's asset server 307-redirects
 * the latter to the former, and a redirect cannot be stored in a Cache.
 */
const SHELL = [
  '/',
  '/css/app.css',
  '/js/app.js',
  '/js/api.js',
  '/js/crypto.js',
  '/js/idb.js',
  '/js/settings.js',
  '/js/store.js',
  '/js/ui.js',
  '/fonts/fraunces-latin.woff2',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Added one at a time on purpose: with addAll, a single failed URL throws
      // away the entire offline shell.
      await Promise.all(
        SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

const OFFLINE_FALLBACK = new Response(
  '<!doctype html><meta charset="utf-8"><title>Nocturne</title><body style="background:#0c0a09">',
  { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } },
);

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // always live

  // Navigations: serve the cached shell instantly, refresh it in the background.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const cached = await cache.match('/');

        // A navigate-mode Request cannot be passed to fetch(); use its URL.
        const fromNetwork = () =>
          fetch(request.url).then((res) => {
            if (res.ok) cache.put('/', res.clone());
            return res;
          });

        if (cached) {
          event.waitUntil(fromNetwork().catch(() => {}));
          return cached;
        }
        return fromNetwork().catch(() => cached || OFFLINE_FALLBACK.clone());
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached) {
        event.waitUntil(
          fetch(request)
            .then(async (res) => {
              if (res.ok) (await caches.open(CACHE)).put(request, res.clone());
            })
            .catch(() => {}),
        );
        return cached;
      }
      try {
        const res = await fetch(request);
        if (res.ok) {
          const copy = res.clone();
          event.waitUntil(caches.open(CACHE).then((c) => c.put(request, copy)));
        }
        return res;
      } catch {
        return Response.error();
      }
    })(),
  );
});

/**
 * Push handling is here and ready; what is not built yet is the server side
 * that signs and sends the message. See README → Notifications.
 */
self.addEventListener('push', (event) => {
  let data = { title: 'Nocturne', body: 'Anything you remember?' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    /* keep the default copy */
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: 'nocturne-nudge',
      data: { url: '/?capture=1' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) return client.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});
