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
  if (!username) return bad('Neplatné meno');

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
  if (!username) return bad('Meno musí mať 2 – 32 znakov: písmená, čísla, . _ -');
  if (typeof body.authProof !== 'string' || !/^[a-f0-9]{64}$/.test(body.authProof)) {
    return bad('Neplatné prihlasovacie údaje');
  }
  if (typeof body.kdfSalt !== 'string' || !/^[a-f0-9]{32,64}$/.test(body.kdfSalt)) {
    return bad('Neplatná soľ');
  }
  if (!env.SETUP_CODE) return bad('Server nie je nastavený na registráciu', 503);

  // Sign-up needs the same backoff login has. Without it, a short setup code is
  // only a few thousand requests away from someone claiming one of the two
  // seats. Keyed globally rather than per-username, because the attacker picks
  // the username.
  const lock = await checkLock(env, REGISTER_KEY);
  if (lock.locked) {
    return json(
      { error: `Priveľa pokusov. Skús to o ${lock.retryAfter} s.`, retryAfter: lock.retryAfter },
      429,
    );
  }

  if (typeof body.setupCode !== 'string' || !timingSafeEqual(body.setupCode, env.SETUP_CODE)) {
    await recordFailure(env, REGISTER_KEY);
    return bad('Ten inštalačný kód nesedí', 403);
  }

  const { count } = await env.DB.prepare('SELECT COUNT(*) AS count FROM users').first();
  if (count >= MAX_USERS) return bad('Tento denník už má svojich dvoch ľudí', 403);

  const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ?')
    .bind(username)
    .first();
  if (existing) return bad('Toto meno je už obsadené', 409);

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
  if (!username) return bad('Nesprávne meno alebo heslo', 401);
  if (typeof body.authProof !== 'string' || !/^[a-f0-9]{64}$/.test(body.authProof)) {
    return bad('Nesprávne meno alebo heslo', 401);
  }

  const lock = await checkLock(env, username);
  if (lock.locked) {
    return json(
      { error: `Priveľa pokusov. Skús to o ${lock.retryAfter} s.`, retryAfter: lock.retryAfter },
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
    return bad('Nesprávne meno alebo heslo', 401);
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
  if (!isB64(body.iv, 32)) return 'Neplatný iv';
  if (!isB64(body.ciphertext, MAX_CIPHERTEXT_CHARS)) return 'Záznam je príliš veľký';
  if (!isTimestamp(body.dreamedAt)) return 'Neplatný dátum';
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

  if (!res.meta.changes) return bad('Taký záznam neexistuje', 404);
  return json({ id, updatedAt: now });
}

async function deleteEntry(env, session, id) {
  const now = Date.now();
  const res = await env.DB.prepare(
    'UPDATE entries SET deleted_at = ?, updated_at = ?, ciphertext = ?, iv = ? WHERE id = ? AND user_id = ?',
  )
    .bind(now, now, '', '', id, session.userId)
    .run();
  if (!res.meta.changes) return bad('Taký záznam neexistuje', 404);
  return json({ id, deletedAt: now });
}

/**
 * Changing a passphrase re-encrypts every entry under a new key. The phone
 * sends the whole re-encrypted set plus new credentials; we swap them together
 * so we can never end up with a new password and old ciphertext.
 */
async function handleRekey(request, env, session) {
  const body = await readJson(request);
  if (!Array.isArray(body.entries)) return bad('Chýbajú záznamy');
  if (typeof body.authProof !== 'string' || !/^[a-f0-9]{64}$/.test(body.authProof)) {
    return bad('Neplatné prihlasovacie údaje');
  }
  if (typeof body.kdfSalt !== 'string' || !/^[a-f0-9]{32,64}$/.test(body.kdfSalt)) {
    return bad('Neplatná soľ');
  }
  if (typeof body.currentProof !== 'string' || !/^[a-f0-9]{64}$/.test(body.currentProof)) {
    return bad('Neplatné prihlasovacie údaje');
  }

  const user = await env.DB.prepare('SELECT verifier, verifier_salt FROM users WHERE id = ?')
    .bind(session.userId)
    .first();
  if (!user) return bad('Taký účet neexistuje', 404);

  if (!(await verifierMatches(body.currentProof, user.verifier_salt, user.verifier))) {
    return bad('Súčasné heslo nesedí', 403);
  }

  for (const e of body.entries) {
    if (typeof e.id !== 'string' || !/^[a-f0-9-]{36}$/.test(e.id)) return bad('Neplatné id záznamu');
    const err = validateEntryPayload(e);
    if (err) return bad(err);
  }

  /*
   * The sharing private key is wrapped with the vault key, so a new passphrase
   * makes the stored copy unopenable. It has to be re-wrapped in the same
   * batch as the entries — leaving it behind is what silently killed sharing
   * for good, with no way back short of rotating the whole keypair.
   */
  const rewrapping = body.wrappedPrivate !== undefined || body.wrappedIv !== undefined;
  if (rewrapping) {
    if (!isB64(body.wrappedPrivate, 4096)) return bad('Neplatný zabalený kľúč');
    if (!isB64(body.wrappedIv, 32)) return bad('Neplatný iv');
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
    rewrapping
      ? env.DB.prepare(
          `UPDATE users SET kdf_salt = ?, verifier = ?, verifier_salt = ?,
             wrapped_private = ?, wrapped_iv = ? WHERE id = ?`,
        ).bind(
          body.kdfSalt,
          verifier,
          verifierSalt,
          body.wrappedPrivate,
          body.wrappedIv,
          session.userId,
        )
      : env.DB.prepare(
          'UPDATE users SET kdf_salt = ?, verifier = ?, verifier_salt = ? WHERE id = ?',
        ).bind(body.kdfSalt, verifier, verifierSalt, session.userId),
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

/* ---------------------------------------------------------------- shares  */

/** The other account, if there is one. Two seats means "the peer" is unambiguous. */
async function findPeer(env, userId) {
  return env.DB.prepare(
    'SELECT id, username, public_key FROM users WHERE id != ? ORDER BY created_at LIMIT 1',
  )
    .bind(userId)
    .first();
}

/**
 * Publishes this account's public key and stores the wrapped private half.
 *
 * `replace: true` rotates the keypair. That is only ever sent when the client
 * has found it genuinely cannot unwrap the private key it has — which used to
 * be a dead end, because the old code refused every republish and left sharing
 * broken with no way back. Rotating strands the shares wrapped to the old key,
 * so those are cleared here and both sides re-seal from plaintext they still
 * hold.
 */
async function handlePublishKeys(request, env, session) {
  const body = await readJson(request);
  if (!isB64(body.publicKey, 256)) return bad('Neplatný verejný kľúč');
  if (!isB64(body.wrappedPrivate, 4096)) return bad('Neplatný zabalený kľúč');
  if (!isB64(body.wrappedIv, 32)) return bad('Neplatný iv');

  const existing = await env.DB.prepare('SELECT public_key FROM users WHERE id = ?')
    .bind(session.userId)
    .first();
  const changing = existing?.public_key && existing.public_key !== body.publicKey;
  if (changing && body.replace !== true) {
    return bad('Tento účet už má kľúče na zdieľanie', 409);
  }

  const statements = [
    env.DB.prepare(
      'UPDATE users SET public_key = ?, wrapped_private = ?, wrapped_iv = ? WHERE id = ?',
    ).bind(body.publicKey, body.wrappedPrivate, body.wrappedIv, session.userId),
  ];

  if (changing) {
    // Nothing sealed to the old key can be opened by anyone any more, on
    // either side. Leaving it would show as a permanently broken dream.
    statements.push(
      env.DB.prepare('DELETE FROM shares WHERE owner_id = ?').bind(session.userId),
      env.DB.prepare('DELETE FROM shares WHERE recipient_id = ?').bind(session.userId),
    );
  }

  await env.DB.batch(statements);
  return json({ ok: true, rotated: !!changing });
}

async function handleGetKeys(env, session) {
  const me = await env.DB.prepare(
    'SELECT public_key, wrapped_private, wrapped_iv FROM users WHERE id = ?',
  )
    .bind(session.userId)
    .first();
  const peer = await findPeer(env, session.userId);
  return json({
    publicKey: me?.public_key || null,
    wrappedPrivate: me?.wrapped_private || null,
    wrappedIv: me?.wrapped_iv || null,
    peer: peer ? { username: peer.username, publicKey: peer.public_key || null } : null,
  });
}

async function handlePutShare(request, env, session, entryId) {
  const body = await readJson(request);
  if (!isB64(body.iv, 32) || !isB64(body.wrapIv, 32)) return bad('Neplatný iv');
  if (!isB64(body.ciphertext, MAX_CIPHERTEXT_CHARS)) return bad('Záznam je príliš veľký');
  if (!isB64(body.wrappedKey, 512)) return bad('Neplatný zabalený kľúč');
  if (!isTimestamp(body.dreamedAt)) return bad('Neplatný dátum');

  const owned = await env.DB.prepare(
    'SELECT id FROM entries WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
  )
    .bind(entryId, session.userId)
    .first();
  if (!owned) return bad('Taký záznam neexistuje', 404);

  const peer = await findPeer(env, session.userId);
  if (!peer) return bad('Zatiaľ nie je s kým zdieľať', 409);
  if (!peer.public_key) return bad('Odkedy pribudlo zdieľanie, ešte si appku neotvorili', 409);

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO shares (entry_id, owner_id, recipient_id, iv, ciphertext, wrapped_key, wrap_iv,
                         dreamed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(entry_id) DO UPDATE SET
       iv = excluded.iv, ciphertext = excluded.ciphertext,
       wrapped_key = excluded.wrapped_key, wrap_iv = excluded.wrap_iv,
       dreamed_at = excluded.dreamed_at, updated_at = excluded.updated_at
     WHERE shares.owner_id = excluded.owner_id`,
  )
    .bind(entryId, session.userId, peer.id, body.iv, body.ciphertext, body.wrappedKey,
      body.wrapIv, body.dreamedAt, now, now)
    .run();

  return json({ ok: true, sharedWith: peer.username });
}

async function handleUnshare(env, session, entryId) {
  await env.DB.prepare('DELETE FROM shares WHERE entry_id = ? AND owner_id = ?')
    .bind(entryId, session.userId)
    .run();
  return json({ ok: true });
}

/** Everything the other person has shared with me, plus what I've shared out. */
async function handleListShares(env, session) {
  const inbox = await env.DB.prepare(
    `SELECT s.entry_id, s.iv, s.ciphertext, s.wrapped_key, s.wrap_iv, s.dreamed_at,
            s.updated_at, u.username AS from_username
       FROM shares s JOIN users u ON u.id = s.owner_id
      WHERE s.recipient_id = ?
      ORDER BY s.dreamed_at DESC`,
  )
    .bind(session.userId)
    .all();

  const mine = await env.DB.prepare('SELECT entry_id FROM shares WHERE owner_id = ?')
    .bind(session.userId)
    .all();

  const peer = await findPeer(env, session.userId);
  return json({
    inbox: inbox.results ?? [],
    sharedByMe: (mine.results ?? []).map((r) => r.entry_id),
    peer: peer ? { username: peer.username, publicKey: peer.public_key || null } : null,
  });
}

/* ------------------------------------------------------------ web push    */

/**
 * Push is sent with no payload at all.
 *
 * A payload would have to be encrypted per RFC 8291 (ECDH against the
 * subscription key, HKDF, an aes128gcm record). The reminder text is generic —
 * "do a reality check" — so it lives in the service worker instead, and the
 * push is a bare authenticated poke. Less code, less to get wrong, and nothing
 * personal crosses the wire.
 */
function b64urlFromBytes(bytes) {
  return toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlFromString(str) {
  return b64urlFromBytes(te.encode(str));
}

function bytesFromB64url(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Signs the VAPID JWT that proves this server owns the application key. */
async function vapidHeaders(env, endpoint) {
  const { origin } = new URL(endpoint);
  const header = b64urlFromString(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64urlFromString(
    JSON.stringify({
      aud: origin,
      exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
      sub: env.VAPID_SUBJECT || 'mailto:nocturne@example.com',
    }),
  );

  const key = await crypto.subtle.importKey(
    'pkcs8',
    bytesFromB64url(env.VAPID_PRIVATE_KEY),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  // WebCrypto returns raw r||s, which is exactly what JWS ES256 wants.
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    te.encode(`${header}.${claims}`),
  );

  return {
    Authorization: `vapid t=${header}.${claims}.${b64urlFromBytes(sig)}, k=${env.VAPID_PUBLIC_KEY}`,
    TTL: '3600',
    'Content-Length': '0',
  };
}

async function sendPush(env, endpoint) {
  const res = await fetch(endpoint, { method: 'POST', headers: await vapidHeaders(env, endpoint) });
  return res.status;
}

async function handleSubscribe(request, env, session) {
  const body = await readJson(request);
  // Real push endpoints are always https. The escape hatch exists only so the
  // test suite can point at a local stub, and is never set in production.
  const allowInsecure = env.PUSH_ALLOW_INSECURE === '1';
  const scheme = allowInsecure ? /^https?:\/\// : /^https:\/\//;
  if (typeof body.endpoint !== 'string' || !scheme.test(body.endpoint)) {
    return bad('Neplatné prihlásenie na odber');
  }
  if (body.endpoint.length > 2048) return bad('Neplatné prihlásenie na odber');

  // Range-checked, not just shape-checked: "25:99" matches HH:MM but is not a
  // time, and would sit in the table forever never matching a clock.
  const clean = (t) => {
    const m = /^(\d{2}):(\d{2})$/.exec(t || '');
    if (!m) return '';
    const [, h, min] = m;
    return Number(h) < 24 && Number(min) < 60 ? t : '';
  };
  const morning = clean(body.morningTime || '');
  const checks = String(body.checkTimes || '')
    .split(',')
    .map((t) => clean(t.trim()))
    .filter(Boolean)
    .slice(0, 8)
    .join(',');
  const bedtime = clean(body.bedtimeTime || '');
  const wbtb = clean(body.wbtbTime || '');
  const tz = typeof body.timezone === 'string' && body.timezone.length < 64 ? body.timezone : 'UTC';

  await env.DB.prepare(
    `INSERT INTO push_subscriptions
       (id, user_id, endpoint, timezone, morning_time, check_times, bedtime_time, wbtb_time, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       timezone = excluded.timezone,
       morning_time = excluded.morning_time,
       check_times = excluded.check_times,
       bedtime_time = excluded.bedtime_time,
       wbtb_time = excluded.wbtb_time`,
  )
    .bind(newId(), session.userId, body.endpoint, tz, morning, checks, bedtime, wbtb, Date.now())
    .run();

  return json({ ok: true });
}

async function handleUnsubscribe(request, env, session) {
  const body = await readJson(request);
  await env.DB.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?')
    .bind(session.userId, body.endpoint || '')
    .run();
  return json({ ok: true });
}

/** Sends one immediately so the user can confirm it actually arrives. */
async function handleTestPush(request, env, session) {
  if (!env.VAPID_PRIVATE_KEY) return bad('Pripomienky nie sú na tomto serveri nastavené', 503);
  const subs = await env.DB.prepare(
    'SELECT endpoint FROM push_subscriptions WHERE user_id = ?',
  )
    .bind(session.userId)
    .all();
  if (!subs.results?.length) return bad('Tento telefón nie je zaregistrovaný na pripomienky', 404);

  const results = [];
  for (const sub of subs.results) {
    try {
      results.push(await sendPush(env, sub.endpoint));
    } catch {
      results.push(0);
    }
  }
  const ok = results.some((s) => s >= 200 && s < 300);
  return json({ ok, statuses: results }, ok ? 200 : 502);
}

/** Local wall-clock time for a subscription, as minutes since midnight. */
function localSlot(timezone, now) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    }).formatToParts(now);
    const get = (t) => parts.find((p) => p.type === t)?.value ?? '00';
    return {
      date: `${get('year')}-${get('month')}-${get('day')}`,
      minutes: Number(get('hour')) * 60 + Number(get('minute')),
    };
  } catch {
    return null; // an unknown timezone should skip, not throw
  }
}

const CRON_WINDOW_MIN = 15;

/**
 * Fires reminders whose local time has just come round. Runs on a cron trigger,
 * so notifications arrive with the app closed.
 */
async function runReminders(env, now = new Date()) {
  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) return { sent: 0, skipped: 'no vapid keys' };

  const subs = await env.DB.prepare('SELECT * FROM push_subscriptions').all();
  let sent = 0;

  for (const sub of subs.results ?? []) {
    const local = localSlot(sub.timezone, now);
    if (!local) continue;

    /*
     * Order is priority, because at most one nudge goes out per run and a
     * collision has to resolve somehow. The wake-back-to-bed alarm comes
     * first: it is the one that is useless if it arrives late, and the one
     * someone explicitly asked to be woken by.
     */
    const wanted = [
      sub.wbtb_time,
      sub.bedtime_time,
      sub.morning_time,
      ...String(sub.check_times).split(','),
    ]
      .map((t) => String(t || '').trim())
      .filter((t) => /^\d{2}:\d{2}$/.test(t));

    for (const time of wanted) {
      const [h, m] = time.split(':').map(Number);
      const target = h * 60 + m;
      const delta = local.minutes - target;
      if (delta < 0 || delta >= CRON_WINDOW_MIN) continue;

      const slot = `${local.date} ${time}`;
      if (sub.last_fired === slot) continue; // already sent this one today

      try {
        const status = await sendPush(env, sub.endpoint);
        if (status === 404 || status === 410) {
          // The browser has thrown the subscription away; stop retrying it.
          await env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(sub.id).run();
          break;
        }
        if (status >= 200 && status < 300) sent += 1;
      } catch {
        /* transient — the next window will try again */
      }

      await env.DB.prepare('UPDATE push_subscriptions SET last_fired = ? WHERE id = ?')
        .bind(slot, sub.id)
        .run();
      break; // at most one nudge per run
    }
  }

  return { sent };
}

/* ---------------------------------------------------------------- the AI  */

// Overridable so the endpoint can be tested against a stub without a real key.
const DEFAULT_GEMINI_HOST = 'https://generativelanguage.googleapis.com';
const AI_DAILY_CAP = 40; // per person; the free key allows ~1500/day in total
const AI_MIN_GAP_MS = 4_000; // free tier is ~15 req/min across the whole key
const AI_MAX_CHARS = 60_000; // roughly 40 dreams of context

/*
 * Room for the answer, and a ceiling on the thinking that comes before it.
 *
 * Current Gemini flash models reason before they reply, and that reasoning is
 * spent from the same output budget as the text. With a small budget the model
 * can think its way through the whole allowance and return a candidate with no
 * parts at all and finishReason MAX_TOKENS — a 200 response containing nothing,
 * which looks from the app exactly like the companion has stopped working.
 */
const AI_MAX_OUTPUT_TOKENS = 4_096;
const AI_THINKING_BUDGET = 1_024;

/**
 * This is the one endpoint that sees dream text in the clear — everything else
 * here handles ciphertext only. The phone decrypts, posts plaintext, we relay
 * it to Gemini and return the reply. Nothing is written to the database, and
 * nothing is logged.
 */
const COACH_PROMPT = `You are the dream companion inside Nocturne, a private journal two friends use with one goal: having lucid dreams — realising you are dreaming while it is happening.

You are reading dreams someone wrote down within minutes of waking. Treat them as private and take them seriously; never mock the content, however strange.

What you are actually for:
- Spotting dream signs. Recurring people, places, objects, or impossibilities that show up across their dreams are the things they can learn to notice from inside a dream. Name them specifically and say how often you saw them.
- Spotting awareness triggers. When they did become lucid, work out what tipped them off, and tell them how to train that specific route rather than lucid dreaming in general.
- Spotting conditions. If lucidity clusters around particular nights — sleeping somewhere unfamiliar, waking in the night, a later bedtime — say so, and say plainly how thin the evidence is.
- Concrete next steps. Reality checks tied to their own dream signs, wake-back-to-bed timing, stabilising techniques when dreams collapse early.

How to write:
- Talk to them directly, in plain sentences. No headers, no bullet lists unless you are genuinely enumerating dream signs.
- Be specific to the dreams in front of you. Quote small details back. Generic lucid dreaming advice they could have found anywhere is a failure.
- Keep it to a few short paragraphs. They are reading this on a phone, often half awake.
- Say when you do not have enough data yet. Three dreams is not a pattern, and telling them so is more useful than inventing one.
- Do not diagnose medical or psychiatric conditions, and do not interpret dreams as hidden messages about their life. You are looking for mechanical patterns that help them get lucid, not symbolism.

Language — this matters:
- The two people using this journal are Slovak, and they write their dreams in Slovak. Everything you are given to read will be in Slovak, including the dream text, the titles, the notes about the night, and any answers they picked.
- Always reply in Slovak. Natural, fluent, conversational Slovak — not a translation of an English sentence and not formal written Slovak. Address them as "ty".
- Use the correct diacritics throughout. Slovak without them reads as broken.
- The field labels around the dream text are in English because they come from the app; the dream itself is the Slovak part. Do not remark on the mix, and do not answer in English because of it.
- When you quote a detail back to them, quote it in their own Slovak words rather than translating it.
- Keep the lucid dreaming terms they would actually use: "lucidný sen", "znak sna", "test reality", "prebudenie a späť do postele" for wake-back-to-bed.`;

async function checkAiBudget(env, userId) {
  const today = new Date().toISOString().slice(0, 10);
  const row = await env.DB.prepare('SELECT day, count, last_at FROM ai_usage WHERE user_id = ?')
    .bind(userId)
    .first();

  const now = Date.now();
  const sameDay = row?.day === today;
  const used = sameDay ? row.count : 0;

  if (used >= AI_DAILY_CAP) {
    return { ok: false, error: `To je ${AI_DAILY_CAP} rozborov za dnes — denný limit. Skús to zajtra.` };
  }
  if (row && now - row.last_at < AI_MIN_GAP_MS) {
    return { ok: false, error: 'Nechaj medzi rozbormi pár sekúnd.' };
  }

  await env.DB.prepare(
    `INSERT INTO ai_usage (user_id, day, count, last_at) VALUES (?, ?, 1, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       day = excluded.day,
       count = CASE WHEN ai_usage.day = excluded.day THEN ai_usage.count + 1 ELSE 1 END,
       last_at = excluded.last_at`,
  )
    .bind(userId, today, now)
    .run();

  return { ok: true, remaining: AI_DAILY_CAP - used - 1 };
}

/** What this key is actually allowed to call. Only used to explain a 404. */
async function listGeminiModels(env, host) {
  try {
    const res = await fetch(`${host}/v1beta/models`, {
      headers: { 'x-goog-api-key': env.GEMINI_API_KEY },
    });
    if (!res.ok) return [];
    const payload = await res.json();
    return (payload?.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => String(m.name || '').replace(/^models\//, ''))
      .filter((name) => name.includes('flash'))
      .slice(0, 6);
  } catch {
    return [];
  }
}

async function handleAi(request, env, session) {
  if (!env.GEMINI_API_KEY) {
    return bad('Snový spoločník zatiaľ nie je pre tento denník zapnutý.', 503);
  }

  const body = await readJson(request);
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) return bad('Niet čo čítať');
  if (body.prompt.length > AI_MAX_CHARS) return bad('To je naraz priveľa', 413);

  const budget = await checkAiBudget(env, session.userId);
  if (!budget.ok) return json({ error: budget.error }, 429);

  const model = env.GEMINI_MODEL || 'gemini-3.6-flash';
  const host = env.GEMINI_HOST || DEFAULT_GEMINI_HOST;

  const call = (withThinking) => {
    const generationConfig = {
      temperature: 0.8,
      maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
      ...(withThinking ? { thinkingConfig: { thinkingBudget: AI_THINKING_BUDGET } } : {}),
    };
    return fetch(`${host}/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: COACH_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: body.prompt }] }],
        generationConfig,
      }),
    });
  };

  let res;
  try {
    res = await call(true);
    /*
     * Not every model knows thinkingConfig, and the ones that do not reject the
     * whole request rather than ignoring the field. Retrying once without it
     * means a model change cannot take the companion down.
     */
    if (res.status === 400) {
      const peek = await res.clone().json().catch(() => ({}));
      if (/thinking/i.test(peek?.error?.message || '')) res = await call(false);
    }
  } catch {
    return json({ error: 'Nepodarilo sa spojiť so snovým spoločníkom.' }, 502);
  }

  const payload = await res.json().catch(() => ({}));

  if (!res.ok) {
    // Surface the real reason — a wrong model name and an exhausted quota are
    // very different problems and both are easy to hit on the free tier.
    const reason = payload?.error?.message || `Gemini returned ${res.status}`;
    if (res.status === 429) {
      return json({ error: 'Gemini je teraz preťažené. Skús to o minútu.' }, 429);
    }
    if (res.status === 404) {
      // A dead end otherwise: the fix is to pick a different name, and only
      // Google knows which names this key is allowed to use.
      const usable = await listGeminiModels(env, host);
      return json(
        {
          error:
            `Model „${model}“ neexistuje alebo naň tvoj kľúč nemá prístup.` +
            (usable.length
              ? ` Nastav GEMINI_MODEL na niektorý z týchto: ${usable.join(', ')}.`
              : ' Nastav GEMINI_MODEL na taký, ktorý tvoj kľúč podporuje.'),
        },
        502,
      );
    }
    console.error('gemini', res.status, reason);
    return json({ error: reason }, 502);
  }

  const blocked = payload?.promptFeedback?.blockReason;
  if (blocked) {
    return json(
      { error: 'Gemini tento sen odmietlo prečítať. Sny občas spustia jeho bezpečnostné filtre — na tom, čo si napísal, nie je nič zlé.' },
      422,
    );
  }

  const candidate = payload?.candidates?.[0];
  const finish = candidate?.finishReason;
  const usage = payload?.usageMetadata;

  const text = (candidate?.content?.parts || [])
    .map((p) => p.text || '')
    .join('')
    .trim();

  if (!text) {
    /*
     * "Nothing to say" was the same message for four different failures, and
     * none of them were guessable from the app. The reason Google gives is the
     * whole diagnosis, so it goes in the message.
     */
    console.error('gemini empty', { finish, model, usage });
    if (finish === 'MAX_TOKENS') {
      return json(
        {
          error:
            'Gemini minulo celý limit na premýšľanie a nezvýšilo mu na odpoveď. ' +
            'Skús to znova — ak sa to opakuje, treba zvýšiť AI_MAX_OUTPUT_TOKENS.',
        },
        502,
      );
    }
    if (finish === 'SAFETY' || finish === 'RECITATION') {
      return json(
        { error: 'Gemini tento sen odmietlo prečítať. Sny občas spustia jeho bezpečnostné filtre — na tom, čo si napísal, nie je nič zlé.' },
        422,
      );
    }
    return json(
      { error: `Snový spoločník nemal čo povedať${finish ? ` (${finish})` : ''}.` },
      502,
    );
  }

  // A truncated answer is not a failure, but the app should be able to say so
  // rather than quietly showing half a thought.
  return json({ text, remaining: budget.remaining, model, truncated: finish === 'MAX_TOKENS' });
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
  if (!session) return bad('Nie si prihlásený', 401);

  if (path === '/api/auth/me' && method === 'GET') {
    return json({
      username: session.username,
      aiAvailable: !!env.GEMINI_API_KEY,
      pushAvailable: !!(env.VAPID_PRIVATE_KEY && env.VAPID_PUBLIC_KEY),
      vapidPublicKey: env.VAPID_PUBLIC_KEY || null,
    });
  }

  if (path === '/api/ai' && method === 'POST') return handleAi(request, env, session);

  if (path === '/api/keys' && method === 'GET') return handleGetKeys(env, session);
  if (path === '/api/keys' && method === 'POST') return handlePublishKeys(request, env, session);
  if (path === '/api/shares' && method === 'GET') return handleListShares(env, session);

  const shareMatch = path.match(/^\/api\/shares\/([a-f0-9-]{36})$/);
  if (shareMatch) {
    if (method === 'PUT') return handlePutShare(request, env, session, shareMatch[1]);
    if (method === 'DELETE') return handleUnshare(env, session, shareMatch[1]);
  }

  if (path === '/api/push/subscribe' && method === 'POST') {
    return handleSubscribe(request, env, session);
  }
  if (path === '/api/push/unsubscribe' && method === 'POST') {
    return handleUnsubscribe(request, env, session);
  }
  if (path === '/api/push/test' && method === 'POST') return handleTestPush(request, env, session);

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

  return bad('Nenájdené', 404);
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
      return withSecurityHeaders(json({ error: 'Niečo sa pokazilo' }, 500));
    }
  },

  /** Fires due reminders, and tidies up expired sessions along the way. */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          const result = await runReminders(env);
          if (result.sent) console.log('reminders sent', result.sent);
        } catch (err) {
          console.error('reminders', err);
        }
        await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()).run();
      })(),
    );
  },
};
