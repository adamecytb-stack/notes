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
 * rather than crossing the wire, so the push service learns nothing. Not even
 * which kind of nudge it was: that is worked out on the phone, below.
 *
 * The prompts vary within each kind because a notification you stop reading is
 * a notification that stops working.
 */
const NUDGES = {
  bedtime: {
    title: 'Before you sleep',
    bodies: [
      'Say it until you mean it: the next time I am dreaming, I will realise I am dreaming.',
      'Repeat your intention. Picture your dream sign, and picture catching it.',
      'One minute of intention now beats an hour of trying later. Tap to run through it.',
    ],
    url: '/?tonight=1',
  },
  wbtb: {
    title: 'Wake back to bed',
    bodies: [
      'Stay up about twenty minutes, then go back with the intention. This is the window.',
      'You are in the best REM of the night. Get up, stay dim and calm, then go back in.',
      'Awake on purpose. Read one of your lucid dreams, then go back and expect another.',
    ],
    url: '/?wbtb=1',
  },
  morning: {
    title: 'Nocturne',
    bodies: [
      'Anything you remember? Stay still and let it come back first.',
      'What did you dream? Write it down before you move.',
      'Even a fragment counts. What is left of last night?',
    ],
    url: '/?capture=1',
  },
  check: {
    title: 'Reality check',
    bodies: [
      'Are you dreaming right now? Look at your hands and count the fingers.',
      'Reality check. Read some text, look away, read it again — does it hold still?',
      'Is this a dream? Pinch your nose closed and try to breathe in.',
      'Check: how did you get here? Can you remember the last hour clearly?',
      'Look at a clock, look away, look back. Reality check.',
    ],
    url: '/?check=1',
  },
};

const pick = (list) => list[Math.floor(Math.random() * list.length)];

/**
 * The times the app last registered, read straight out of IndexedDB. Times
 * only — never a dream, never a dream sign. Those stay encrypted and are read
 * by the app itself once the notification is tapped.
 */
function readSchedule() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      const req = indexedDB.open('dream-journal', 1);
      req.onerror = () => done(null);
      req.onblocked = () => done(null);
      // Opening at the app's own version must never trigger an upgrade from
      // here — if the store is missing, give up rather than create half a DB.
      req.onupgradeneeded = () => done(null);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('meta')) return done(null);
        const get = db.transaction('meta', 'readonly').objectStore('meta').get('schedule');
        get.onsuccess = () => done(get.result || null);
        get.onerror = () => done(null);
      };
    } catch {
      done(null);
    }
    setTimeout(() => done(null), 1500);
  });
}

const toMinutes = (t) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/**
 * Which nudge is this? The server sends an empty push, so the only clue is the
 * clock — but the phone knows the times it asked for, so it can match rather
 * than guess. Minutes wrap at midnight, otherwise a bedtime of 23:40 would
 * never match a push that lands at 00:02.
 */
function nudgeKind(schedule, now = new Date()) {
  const mins = now.getHours() * 60 + now.getMinutes();
  const gap = (a, b) => {
    const d = Math.abs(a - b);
    return Math.min(d, 1440 - d);
  };

  if (schedule) {
    const slots = [
      ['wbtb', schedule.wbtb],
      ['bedtime', schedule.bedtime],
      ['morning', schedule.morning],
      ...(schedule.checks || []).map((t) => ['check', t]),
    ];
    let best = null;
    for (const [kind, time] of slots) {
      const at = toMinutes(time);
      if (at === null) continue;
      const d = gap(mins, at);
      // The cron runs on a 15-minute window, so a nudge can legitimately land
      // that late. Beyond half an hour it is not this slot.
      if (d <= 30 && (!best || d < best.d)) best = { kind, d };
    }
    if (best) return best.kind;
  }

  // No schedule stored, or nothing close enough: fall back to the clock alone.
  const hour = now.getHours();
  if (hour >= 2 && hour < 5) return 'wbtb';
  if (hour < 10) return 'morning';
  if (hour >= 21) return 'bedtime';
  return 'check';
}

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      const kind = nudgeKind(await readSchedule());
      const nudge = NUDGES[kind] || NUDGES.check;
      await self.registration.showNotification(nudge.title, {
        body: pick(nudge.bodies),
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag: 'nocturne-nudge',
        renotify: true,
        // Waking someone is the entire point of the WBTB alarm, so it stays
        // on screen until it is dealt with.
        requireInteraction: kind === 'wbtb',
        data: { url: nudge.url, kind },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          // Already open, so the URL will not change on its own — tell the app
          // which nudge was tapped so it can show the right thing.
          client.postMessage({ type: 'NUDGE', kind: event.notification.data?.kind || 'check' });
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
