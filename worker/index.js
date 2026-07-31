/**
 * Dream Journal — API worker.
 *
 * The server is deliberately dumb about content. It authenticates two people,
 * hands out sessions, and stores opaque base64 blobs. It cannot read a dream,
 * and neither can anyone who steals the database.
 */

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_USERS = 2;
const MAX_CIPHERTEXT_CHARS = 512 * 1024; // ~384KB of dream, far past any real entry
const MAX_BODY_BYTES = 1024 * 1024;
const PBKDF2_VERIFIER_ROUNDS = 120_000;

const te = new TextEncoder();

/* ------------------------------------------------------------------ utils */

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

const bad = (msg, status = 400) => json({ error: msg }, status);

function toB64(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}

function toHex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Compares two strings without leaking where they diverge. */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sha256Hex(str) {
  return toHex(await crypto.subtle.digest('SHA-256', te.encode(str)));
}

async function pbkdf2Hex(password, salt, iterations, bits = 256) {
  const key = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const out = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: te.encode(salt), iterations },
    key,
    bits,
  );
  return toHex(out);
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    te.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(await crypto.subtle.sign('HMAC', key, te.encode(message)));
}

function randomHex(bytes = 32) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

function newId() {
  return crypto.randomUUID();
}

/** Reads JSON with a hard size ceiling so a huge POST can't be used to hurt us. */
async function readJson(request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY_BYTES) throw new Error('too large');
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new Error('too large');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('malformed JSON');
  }
}

function normaliseUsername(raw) {
  if (typeof raw !== 'string') return null;
  const u = raw.trim().toLowerCase();
  if (!/^[a-z0-9_.-]{2,32}$/.test(u)) return null;
  return u;
}

/** base64 of the expected byte length, and nothing exotic. */
function isB64(str, maxChars) {
  return (
    typeof str === 'string' &&
    str.length > 0 &&
    str.length <= maxChars &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(str)
  );
}

function isTimestamp(n) {
  return Number.isInteger(n) && n > 0 && n < 4102444800000; // < year 2100
}

/* --------------------------------------------------------------- verifier */

const VERIFIER_PREFIX = 'sha256$';

/**
 * Turns an auth proof into the value we store.
 *
 * Deliberately fast, and that is not a shortcut. All the expensive stretching
 * already happened on the phone: what arrives here is a 256-bit HKDF output,
 * not a human password. A slow KDF exists to make guessing a low-entropy
 * secret costly, and there is no low-entropy guess space here — brute-forcing
 * a 256-bit value is infeasible no matter how cheap each attempt is. It is the
 * same reasoning that lets session tokens be stored as a plain SHA-256.
 *
 * It also has to be fast: 120k PBKDF2 rounds cost ~100ms of CPU, and a Worker
 * on the free plan is killed at 10ms, which made every login fail.
 */
async function deriveVerifier(authProof, salt) {
  return VERIFIER_PREFIX + (await sha256Hex(`${salt}:${authProof}`));
}

/** Accepts the current scheme, and the original PBKDF2 one for old rows. */
async function verifierMatches(authProof, salt, stored) {
  if (typeof stored !== 'string') return false;
  if (stored.startsWith(VERIFIER_PREFIX)) {
    return timingSafeEqual(await deriveVerifier(authProof, salt), stored);
  }
  return timingSafeEqual(await pbkdf2Hex(authProof, salt, PBKDF2_VERIFIER_ROUNDS), stored);
}

/* --------------------------------------------------------------- sessions */

function sessionCookie(token, maxAgeSeconds) {
  const parts = [
    `dj_session=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  return parts.join('; ');
}

function readCookie(request, name) {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

async function createSession(env, userId) {
  const token = randomHex(32);
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  )
    .bind(await sha256Hex(token), userId, now, now + SESSION_TTL_MS)
    .run();
  return token;
}

/** Resolves the caller, or null. Also opportunistically reaps dead sessions. */
async function authenticate(request, env) {
  const token = readCookie(request, 'dj_session');
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const row = await env.DB.prepare(
    `SELECT s.user_id, s.expires_at, u.username
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
  )
    .bind(await sha256Hex(token))
    .first();
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?')
      .bind(await sha256Hex(token))
      .run();
    return null;
  }
  return { userId: row.user_id, username: row.username, token };
}

/* ------------------------------------------------------------- throttling */

const LOCK_STEPS = [0, 0, 0, 5_000, 15_000, 60_000, 300_000, 900_000];

/**
 * Throttle key for sign-up attempts. "!" is not a legal username character, so
 * this can never collide with a real account's failure count.
 */
const REGISTER_KEY = '!register';

async function checkLock(env, username) {
  const row = await env.DB.prepare(
    'SELECT fail_count, locked_until FROM login_attempts WHERE username = ?',
  )
    .bind(username)
    .first();
  if (!row) return { locked: false };
  const remaining = row.locked_until - Date.now();
  return remaining > 0
    ? { locked: true, retryAfter: Math.ceil(remaining / 1000) }
    : { locked: false };
}

async function recordFailure(env, username) {
  const row = await env.DB.prepare(
    'SELECT fail_count FROM login_attempts WHERE username = ?',
  )
    .bind(username)
    .first();
  const fails = (row?.fail_count ?? 0) + 1;
  const delay = LOCK_STEPS[Math.min(fails, LOCK_STEPS.length - 1)];
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO login_attempts (username, fail_count, last_fail_at, locked_until)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(username) DO UPDATE SET
       fail_count = excluded.fail_count,
       last_fail_at = excluded.last_fail_at,
       locked_until = excluded.locked_until`,
  )
    .bind(username, fails, now, now + delay)
    .run();
}

async function clearFailures(env, username) {
  await env.DB.prepare('DELETE FROM login_attempts WHERE username = ?').bind(username).run();
}

/* ------------------------------------------------------------------ auth  */

/**
 * Hands back the PBKDF2 salt for a username. For usernames that don't exist we
 * return a stable, fabricated salt derived from a server secret, so probing
 * this endpoint can't tell you who has an account.
 */
async function handleSalt(request, env) {
  const body = await readJson(request);
  const username = normaliseUsername(body.username);
  if (!username) return bad('Invalid username');

  const row = await env.DB.prepare('SELECT kdf_salt FROM users WHERE username = ?')
    .bind(username)
    .first();
  if (row) return json({ salt: row.kdf_salt });

  const decoy = await hmacHex(env.SALT_PEPPER || 'unconfigured-pepper', `salt:${username}`);
  return json({ salt: decoy.slice(0, 32) });
}

async function handleRegister(request, env) {
  const body = await readJson(request);
  const username = normaliseUsername(body.username);
  if (!username) return bad('Username must be 2–32 characters: letters, numbers, . _ -');
  if (typeof body.authProof !== 'string' || !/^[a-f0-9]{64}$/.test(body.authProof)) {
    return bad('Invalid credentials payload');
  }
  if (typeof body.kdfSalt !== 'string' || !/^[a-f0-9]{32,64}$/.test(body.kdfSalt)) {
    return bad('Invalid salt');
  }
  if (!env.SETUP_CODE) return bad('Server is not configured for sign-up', 503);

  // Sign-up needs the same backoff login has. Without it, a short setup code is
  // only a few thousand requests away from someone claiming one of the two
  // seats. Keyed globally rather than per-username, because the attacker picks
  // the username.
  const lock = await checkLock(env, REGISTER_KEY);
  if (lock.locked) {
    return json(
      { error: `Too many attempts. Try again in ${lock.retryAfter}s.`, retryAfter: lock.retryAfter },
      429,
    );
  }

  if (typeof body.setupCode !== 'string' || !timingSafeEqual(body.setupCode, env.SETUP_CODE)) {
    await recordFailure(env, REGISTER_KEY);
    return bad('That setup code is not right', 403);
  }

  const { count } = await env.DB.prepare('SELECT COUNT(*) AS count FROM users').first();
  if (count >= MAX_USERS) return bad('This journal already has its two people', 403);

  const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ?')
    .bind(username)
    .first();
  if (existing) return bad('That name is taken', 409);

  const verifierSalt = randomHex(16);
  const verifier = await deriveVerifier(body.authProof, verifierSalt);
  const id = newId();

  await env.DB.prepare(
    `INSERT INTO users (id, username, kdf_salt, verifier, verifier_salt, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, username, body.kdfSalt, verifier, verifierSalt, Date.now())
    .run();

  await clearFailures(env, REGISTER_KEY);
  const token = await createSession(env, id);
  return json({ username }, 200, {
    'set-cookie': sessionCookie(token, SESSION_TTL_MS / 1000),
  });
}

async function handleLogin(request, env) {
  const body = await readJson(request);
  const username = normaliseUsername(body.username);
  if (!username) return bad('Incorrect name or passphrase', 401);
  if (typeof body.authProof !== 'string' || !/^[a-f0-9]{64}$/.test(body.authProof)) {
    return bad('Incorrect name or passphrase', 401);
  }

  const lock = await checkLock(env, username);
  if (lock.locked) {
    return json(
      { error: `Too many attempts. Try again in ${lock.retryAfter}s.`, retryAfter: lock.retryAfter },
      429,
    );
  }

  const user = await env.DB.prepare(
    'SELECT id, username, verifier, verifier_salt FROM users WHERE username = ?',
  )
    .bind(username)
    .first();

  // Hash either way, even for unknown users, so response time doesn't reveal
  // whether the account exists.
  const salt = user?.verifier_salt ?? (await hmacHex(env.SALT_PEPPER || 'x', `vs:${username}`)).slice(0, 32);
  const stored = user?.verifier ?? (await deriveVerifier('no-such-account', salt));
  const ok = await verifierMatches(body.authProof, salt, stored);

  if (!user || !ok) {
    await recordFailure(env, username);
    return bad('Incorrect name or passphrase', 401);
  }

  await clearFailures(env, username);
  const token = await createSession(env, user.id);
  return json({ username: user.username }, 200, {
    'set-cookie': sessionCookie(token, SESSION_TTL_MS / 1000),
  });
}

async function handleLogout(request, env) {
  const token = readCookie(request, 'dj_session');
  if (token && /^[a-f0-9]{64}$/.test(token)) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?')
      .bind(await sha256Hex(token))
      .run();
  }
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
}

/* ---------------------------------------------------------------- entries */

async function listEntries(request, env, session) {
  const url = new URL(request.url);
  const since = Number(url.searchParams.get('since') || 0);
  const rows = await env.DB.prepare(
    `SELECT id, iv, ciphertext, dreamed_at, created_at, updated_at, deleted_at
       FROM entries
      WHERE user_id = ? AND updated_at > ?
      ORDER BY dreamed_at DESC`,
  )
    .bind(session.userId, Number.isFinite(since) ? since : 0)
    .all();
  return json({ entries: rows.results ?? [], serverTime: Date.now() });
}

function validateEntryPayload(body) {
  if (!isB64(body.iv, 32)) return 'Invalid iv';
  if (!isB64(body.ciphertext, MAX_CIPHERTEXT_CHARS)) return 'Entry is too large';
  if (!isTimestamp(body.dreamedAt)) return 'Invalid date';
  return null;
}

async function createEntry(request, env, session) {
  const body = await readJson(request);
  const err = validateEntryPayload(body);
  if (err) return bad(err);

  const id = typeof body.id === 'string' && /^[a-f0-9-]{36}$/.test(body.id) ? body.id : newId();
  const now = Date.now();

  // Upsert keyed on (id, user_id) so a retry from a flaky phone connection is
  // idempotent rather than creating a duplicate dream.
  await env.DB.prepare(
    `INSERT INTO entries (id, user_id, iv, ciphertext, dreamed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       iv = excluded.iv,
       ciphertext = excluded.ciphertext,
       dreamed_at = excluded.dreamed_at,
       updated_at = excluded.updated_at,
       deleted_at = NULL
     WHERE entries.user_id = excluded.user_id`,
  )
    .bind(id, session.userId, body.iv, body.ciphertext, body.dreamedAt, now, now)
    .run();

  return json({ id, createdAt: now, updatedAt: now });
}

async function updateEntry(request, env, session, id) {
  const body = await readJson(request);
  const err = validateEntryPayload(body);
  if (err) return bad(err);

  const now = Date.now();
  const res = await env.DB.prepare(
    `UPDATE entries
        SET iv = ?, ciphertext = ?, dreamed_at = ?, updated_at = ?
      WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
  )
    .bind(body.iv, body.ciphertext, body.dreamedAt, now, id, session.userId)
    .run();

  if (!res.meta.changes) return bad('No such entry', 404);
  return json({ id, updatedAt: now });
}

async function deleteEntry(env, session, id) {
  const now = Date.now();
  const res = await env.DB.prepare(
    'UPDATE entries SET deleted_at = ?, updated_at = ?, ciphertext = ?, iv = ? WHERE id = ? AND user_id = ?',
  )
    .bind(now, now, '', '', id, session.userId)
    .run();
  if (!res.meta.changes) return bad('No such entry', 404);
  return json({ id, deletedAt: now });
}

/**
 * Changing a passphrase re-encrypts every entry under a new key. The phone
 * sends the whole re-encrypted set plus new credentials; we swap them together
 * so we can never end up with a new password and old ciphertext.
 */
async function handleRekey(request, env, session) {
  const body = await readJson(request);
  if (!Array.isArray(body.entries)) return bad('Missing entries');
  if (typeof body.authProof !== 'string' || !/^[a-f0-9]{64}$/.test(body.authProof)) {
    return bad('Invalid credentials payload');
  }
  if (typeof body.kdfSalt !== 'string' || !/^[a-f0-9]{32,64}$/.test(body.kdfSalt)) {
    return bad('Invalid salt');
  }
  if (typeof body.currentProof !== 'string' || !/^[a-f0-9]{64}$/.test(body.currentProof)) {
    return bad('Invalid credentials payload');
  }

  const user = await env.DB.prepare('SELECT verifier, verifier_salt FROM users WHERE id = ?')
    .bind(session.userId)
    .first();
  if (!user) return bad('No such account', 404);

  if (!(await verifierMatches(body.currentProof, user.verifier_salt, user.verifier))) {
    return bad('Current passphrase is not right', 403);
  }

  for (const e of body.entries) {
    if (typeof e.id !== 'string' || !/^[a-f0-9-]{36}$/.test(e.id)) return bad('Invalid entry id');
    const err = validateEntryPayload(e);
    if (err) return bad(err);
  }

  const now = Date.now();
  const verifierSalt = randomHex(16);
  const verifier = await deriveVerifier(body.authProof, verifierSalt);

  const statements = body.entries.map((e) =>
    env.DB.prepare(
      'UPDATE entries SET iv = ?, ciphertext = ?, updated_at = ? WHERE id = ? AND user_id = ?',
    ).bind(e.iv, e.ciphertext, now, e.id, session.userId),
  );
  statements.push(
    env.DB.prepare('UPDATE users SET kdf_salt = ?, verifier = ?, verifier_salt = ? WHERE id = ?').bind(
      body.kdfSalt,
      verifier,
      verifierSalt,
      session.userId,
    ),
  );
  // Every other session was established under the old passphrase.
  statements.push(
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(
      session.userId,
      await sha256Hex(session.token),
    ),
  );

  await env.DB.batch(statements);
  return json({ ok: true, rekeyed: body.entries.length });
}

/* ------------------------------------------------------------------ route */

async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/auth/salt' && method === 'POST') return handleSalt(request, env);
  if (path === '/api/auth/register' && method === 'POST') return handleRegister(request, env);
  if (path === '/api/auth/login' && method === 'POST') return handleLogin(request, env);
  if (path === '/api/auth/logout' && method === 'POST') return handleLogout(request, env);

  if (path === '/api/status' && method === 'GET') {
    const { count } = await env.DB.prepare('SELECT COUNT(*) AS count FROM users').first();
    return json({ needsSetup: count < MAX_USERS, seats: MAX_USERS - count });
  }

  const session = await authenticate(request, env);
  if (!session) return bad('Not signed in', 401);

  if (path === '/api/auth/me' && method === 'GET') return json({ username: session.username });

  if (path === '/api/entries' && method === 'GET') return listEntries(request, env, session);
  if (path === '/api/entries' && method === 'POST') return createEntry(request, env, session);
  if (path === '/api/entries/rekey' && method === 'POST') return handleRekey(request, env, session);

  const entryMatch = path.match(/^\/api\/entries\/([a-f0-9-]{36})$/);
  if (entryMatch) {
    if (method === 'PUT') return updateEntry(request, env, session, entryMatch[1]);
    if (method === 'DELETE') return deleteEntry(env, session, entryMatch[1]);
  }

  if (path === '/api/account' && method === 'DELETE') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM entries WHERE user_id = ?').bind(session.userId),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(session.userId),
      env.DB.prepare('DELETE FROM users WHERE id = ?').bind(session.userId),
    ]);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
  }

  return bad('Not found', 404);
}

/**
 * A tight CSP is what keeps a stray script from ever seeing the vault key.
 * Everything the app needs is same-origin, so nothing external is allowed.
 */
const SECURITY_HEADERS = {
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; '),
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'permissions-policy': 'geolocation=(), camera=(), microphone=(), interest-cohort=()',
};

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      if (url.pathname.startsWith('/api/')) {
        const res = await handleApi(request, env, url);
        return withSecurityHeaders(res);
      }

      // Anything else is a client-side route: hand back the app shell.
      const shell = await env.ASSETS.fetch(new Request(new URL('/index.html', url), request));
      return withSecurityHeaders(shell);
    } catch (err) {
      if (err instanceof Error && (err.message === 'too large' || err.message === 'malformed JSON')) {
        return withSecurityHeaders(bad(err.message === 'too large' ? 'Request too large' : 'Malformed request'));
      }
      console.error('unhandled', err);
      return withSecurityHeaders(json({ error: 'Something went wrong' }, 500));
    }
  },

  /** Nightly tidy-up of expired sessions. */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()).run(),
    );
  },
};
