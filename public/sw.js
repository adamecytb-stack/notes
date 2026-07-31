/**
 * Service worker.
 *
 * Caches the app shell so Nocturne opens instantly with no network — which is
 * the normal case at 3am. API traffic is never cached: entries live in
 * IndexedDB and are reconciled by store.js.
 */

/**
 * Rewritten to the commit SHA at deploy time by scripts/stamp-version.mjs.
 *
 * It has to live in this file's bytes: a browser decides whether to update by
 * byte-comparing sw.js, so if only app.js changed and this file did not, the
 * phone would never look. Stamping it on every deploy means any change to
 * anything triggers the update.
 */
const VERSION = 'dev';
const CACHE = `nocturne-${VERSION}`;

/**
 * Note "/" rather than "/index.html": Cloudflare's asset server 307-redirects
 * the latter to the former, and a redirect cannot be stored in a Cache.
 */
const SHELL = [
  '/',
  '/css/app.css',
  '/js/app.js',
  '/js/api.js',
  '/js/companion.js',
  '/js/crypto.js',
  '/js/dream.js',
  '/js/idb.js',
  '/js/reminders.js',
  '/js/settings.js',
  '/js/sharing.js',
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
      // A cache per version, so the new shell is assembled alongside the old
      // one rather than on top of it. Nothing serves out of it until activate,
      // which is what stops a half-updated app — new HTML against old
      // JavaScript is a blank screen, not a stale screen.
      const cache = await caches.open(CACHE);
      // Added one at a time on purpose: with addAll, a single failed URL throws
      // away the entire offline shell.
      await Promise.all(
        SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})),
      );
      // Deliberately no skipWaiting() here. Taking over mid-session would swap
      // the code under someone who is part-way through typing a dream. The new
      // worker waits until the app asks, or until the next cold start.
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

self.addEventListener('message', (event) => {
  // The app sends this once it is safe to swap — nothing unsaved on screen.
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
  if (event.data === 'VERSION') event.source?.postMessage({ type: 'VERSION', version: VERSION });
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

  /*
   * Cache-first with no background refresh, on purpose.
   *
   * This cache belongs to one version and is treated as immutable for its
   * lifetime. Refreshing individual files inside it would put a new app.js
   * next to an old index.html — exactly the mismatch the versioned cache
   * exists to prevent. New files only ever arrive as a complete set, when a
   * new worker installs.
   */
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const cached = await cache.match('/');
        if (cached) return cached;
        try {
          // A navigate-mode Request cannot be passed to fetch(); use its URL.
          const res = await fetch(request.url);
          if (res.ok) cache.put('/', res.clone());
          return res;
        } catch {
          return OFFLINE_FALLBACK.clone();
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      try {
        const res = await fetch(request);
        if (res.ok) {
          const copy = res.clone();
          event.waitUntil(cache.put(request, copy));
        }
        return res;
      } catch {
        return Response.error();
      }
    })(),
  );
});

/**
 * Reminders arrive as a bare push with no payload — the wording lives here
 * rather than crossing the wire, so the push service learns nothing.
 *
 * Before roughly 10am it reads as "write down what you remember"; the rest of
 * the day it is a reality check, which is the habit that actually produces
 * lucid dreams. The prompts vary because a notification you stop reading is a
 * notification that stops working.
 */
const CHECKS = [
  'Are you dreaming right now? Look at your hands and count the fingers.',
  'Reality check. Read some text, look away, read it again — does it hold still?',
  'Is this a dream? Pinch your nose closed and try to breathe in.',
  'Check: how did you get here? Can you remember the last hour clearly?',
  'Look at a clock, look away, look back. Reality check.',
];

const MORNINGS = [
  'Anything you remember? Stay still and let it come back first.',
  'What did you dream? Write it down before you move.',
  'Even a fragment counts. What is left of last night?',
];

const pick = (list) => list[Math.floor(Math.random() * list.length)];

self.addEventListener('push', (event) => {
  const hour = new Date().getHours();
  const morning = hour < 10;
  event.waitUntil(
    self.registration.showNotification(morning ? 'Nocturne' : 'Reality check', {
      body: morning ? pick(MORNINGS) : pick(CHECKS),
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: 'nocturne-nudge',
      renotify: true,
      data: { url: morning ? '/?capture=1' : '/' },
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
