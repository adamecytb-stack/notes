/**
 * Data layer.
 *
 * Holds the vault key in memory, keeps a ciphertext-only cache in IndexedDB so
 * the journal opens instantly and works offline, and reconciles with the
 * server when there's signal. A dream written with no bars is saved locally and
 * pushed the moment the network comes back — writing must never fail.
 */

import { api, ApiError } from './api.js';
import {
  deriveIdentity,
  encryptEntry,
  decryptEntry,
  rememberKey,
  recallKey,
  forgetKey,
  randomHex,
} from './crypto.js';
import { idbGet, idbGetAll, idbPut, idbDel, idbClear } from './idb.js';
import { normalise, emptyEntry } from './dream.js';

const listeners = new Set();

export const state = {
  username: null,
  vaultKey: null,
  /** id -> { id, dreamedAt, createdAt, updatedAt, pending, title, body } */
  entries: new Map(),
  ready: false,
  syncing: false,
  lastError: null,
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) fn(state);
}

/** Newest night first. */
export function sortedEntries() {
  return [...state.entries.values()].sort((a, b) => b.dreamedAt - a.dreamedAt);
}

/* ------------------------------------------------------------- unlocking  */

export async function tryResume() {
  const rec = await recallKey();
  if (!rec) return false;
  state.vaultKey = rec.key;
  state.username = rec.username;
  await loadCache();
  state.ready = true;
  emit();
  // Confirm the session is still valid, but don't block the UI on it.
  api.me()
    .then((me) => {
      state.username = me.username;
      emit();
      return sync();
    })
    .catch((err) => {
      if (err instanceof ApiError && err.status === 401) lock();
    });
  return true;
}

export async function unlock(username, passphrase, onProgress) {
  const { salt } = await api.salt(username);
  const { authProof, vaultKey } = await deriveIdentity(passphrase, salt, onProgress);
  const me = await api.login({ username, authProof });

  state.username = me.username;
  state.vaultKey = vaultKey;
  await rememberKey(vaultKey, me.username);
  await loadCache();
  state.ready = true;
  emit();
  await sync();
}

export async function createAccount(username, passphrase, setupCode, onProgress) {
  const kdfSalt = randomHex(16);
  const { authProof, vaultKey } = await deriveIdentity(passphrase, kdfSalt, onProgress);
  const me = await api.register({ username, authProof, kdfSalt, setupCode });

  state.username = me.username;
  state.vaultKey = vaultKey;
  await rememberKey(vaultKey, me.username);
  state.entries.clear();
  state.ready = true;
  emit();
}

/** Drops the key from this device. Ciphertext stays; it's unreadable without it. */
export async function lock() {
  state.vaultKey = null;
  state.ready = false;
  state.entries.clear();
  await forgetKey();
  emit();
}

export async function signOut() {
  await api.logout().catch(() => {});
  await Promise.all([forgetKey(), idbClear('entries'), idbDel('meta', 'lastSync')]);
  state.vaultKey = null;
  state.username = null;
  state.ready = false;
  state.entries.clear();
  emit();
}

/* ----------------------------------------------------------------- cache  */

async function decryptRow(row) {
  try {
    const payload = await decryptEntry(state.vaultKey, row.id, row.iv, row.ciphertext);
    // normalise() fills in anything a v1 entry predates, so old dreams keep
    // rendering as the model grows.
    return {
      ...normalise(payload),
      id: row.id,
      dreamedAt: row.dreamedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      pending: !!row.pending,
    };
  } catch {
    // Wrong key, or a corrupted blob. Surface it rather than dropping it
    // silently, so it's obvious something is off.
    return {
      ...emptyEntry(),
      id: row.id,
      dreamedAt: row.dreamedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      pending: !!row.pending,
      undecryptable: true,
    };
  }
}

async function loadCache() {
  const rows = await idbGetAll('entries');
  state.entries.clear();
  for (const row of rows) {
    if (row.deletedAt) continue;
    state.entries.set(row.id, await decryptRow(row));
  }
  emit();
}

/* ------------------------------------------------------------------ sync  */

export async function sync() {
  if (!state.vaultKey || state.syncing) return;
  state.syncing = true;
  state.lastError = null;
  emit();

  try {
    await flushPending();

    const since = (await idbGet('meta', 'lastSync')) || 0;
    const { entries: rows, serverTime } = await api.listEntries(since);

    for (const row of rows) {
      const local = {
        id: row.id,
        iv: row.iv,
        ciphertext: row.ciphertext,
        dreamedAt: row.dreamed_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        deletedAt: row.deleted_at,
        pending: false,
      };
      if (row.deleted_at) {
        await idbDel('entries', row.id);
        state.entries.delete(row.id);
        continue;
      }
      // Never let the server clobber an edit this device hasn't pushed yet.
      const cached = await idbGet('entries', row.id);
      if (cached?.pending) continue;

      await idbPut('entries', row.id, local);
      state.entries.set(row.id, await decryptRow(local));
    }

    await idbPut('meta', 'lastSync', serverTime);
  } catch (err) {
    state.lastError = err instanceof ApiError && err.status === 0 ? 'offline' : err.message;
    if (err instanceof ApiError && err.status === 401) await lock();
  } finally {
    state.syncing = false;
    emit();
  }
}

async function flushPending() {
  const rows = await idbGetAll('entries');
  for (const row of rows.filter((r) => r.pending)) {
    try {
      if (row.deletedAt) {
        await api.deleteEntry(row.id);
        await idbDel('entries', row.id);
        continue;
      }
      const payload = { iv: row.iv, ciphertext: row.ciphertext, dreamedAt: row.dreamedAt };
      // Upsert: the server treats POST with a known id as an update, which
      // makes a retried request harmless.
      const res = await api.createEntry({ id: row.id, ...payload });
      await idbPut('entries', row.id, { ...row, pending: false, updatedAt: res.updatedAt });
      const entry = state.entries.get(row.id);
      if (entry) entry.pending = false;
    } catch (err) {
      if (err instanceof ApiError && err.status === 0) return; // still offline; try later
      if (err instanceof ApiError && err.status === 401) return;
      // A permanently rejected entry shouldn't jam the queue forever.
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        await idbPut('entries', row.id, { ...row, pending: false });
      }
    }
  }
}

/* ------------------------------------------------------------- mutations  */

/**
 * Saves immediately to disk, then pushes. Returns as soon as it's safe locally.
 *
 * `payload` is the whole dream — everything in dream.js's model — and it is all
 * encrypted together. Only `dreamedAt` stays in the clear, so the list can sort
 * without decrypting.
 */
export async function saveEntry({ id, dreamedAt, ...payload }) {
  const entryId = id || crypto.randomUUID();
  const when = dreamedAt || Date.now();
  const dream = normalise(payload);
  const { iv, ciphertext } = await encryptEntry(state.vaultKey, entryId, dream);
  const now = Date.now();
  const existing = await idbGet('entries', entryId);

  const row = {
    id: entryId,
    iv,
    ciphertext,
    dreamedAt: when,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    deletedAt: null,
    pending: true,
  };

  await idbPut('entries', entryId, row);
  state.entries.set(entryId, {
    ...dream,
    id: entryId,
    dreamedAt: when,
    createdAt: row.createdAt,
    updatedAt: now,
    pending: true,
  });
  emit();

  try {
    const res = existing && !existing.pending && id
      ? await api.updateEntry(entryId, { iv, ciphertext, dreamedAt: when })
      : await api.createEntry({ id: entryId, iv, ciphertext, dreamedAt: when });
    await idbPut('entries', entryId, { ...row, pending: false, updatedAt: res.updatedAt });
    const entry = state.entries.get(entryId);
    if (entry) entry.pending = false;
    emit();
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 0) state.lastError = err.message;
    emit(); // stays pending; flushPending will retry
  }

  return entryId;
}

export async function removeEntry(id) {
  const row = await idbGet('entries', id);
  state.entries.delete(id);
  emit();

  try {
    await api.deleteEntry(id);
    await idbDel('entries', id);
  } catch {
    if (row) await idbPut('entries', id, { ...row, deletedAt: Date.now(), pending: true });
  }
}

/* ------------------------------------------------- passphrase replacement  */

/**
 * Re-encrypts everything under a new passphrase. The old key decrypts, the new
 * key re-encrypts, and the swap is sent to the server in one batch.
 */
export async function changePassphrase(currentPassphrase, nextPassphrase, onProgress) {
  const { salt } = await api.salt(state.username);
  const current = await deriveIdentity(currentPassphrase, salt, onProgress);

  const nextSalt = randomHex(16);
  const next = await deriveIdentity(nextPassphrase, nextSalt, onProgress);

  const rows = await idbGetAll('entries');
  const reEncrypted = [];
  for (const row of rows) {
    if (row.deletedAt) continue;
    const payload = await decryptEntry(state.vaultKey, row.id, row.iv, row.ciphertext);
    const blob = await encryptEntry(next.vaultKey, row.id, payload);
    reEncrypted.push({ id: row.id, iv: blob.iv, ciphertext: blob.ciphertext, dreamedAt: row.dreamedAt });
  }

  await api.rekey({
    currentProof: current.authProof,
    authProof: next.authProof,
    kdfSalt: nextSalt,
    entries: reEncrypted,
  });

  state.vaultKey = next.vaultKey;
  await rememberKey(next.vaultKey, state.username);
  for (const e of reEncrypted) {
    const row = await idbGet('entries', e.id);
    await idbPut('entries', e.id, { ...row, iv: e.iv, ciphertext: e.ciphertext, pending: false });
  }
  emit();
}

/* ---------------------------------------------------------------- export  */

export function exportJson() {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      username: state.username,
      entries: sortedEntries().map(({ id, createdAt, updatedAt, pending, ...dream }) => ({
        ...dream,
        dreamedAt: new Date(dream.dreamedAt).toISOString(),
      })),
    },
    null,
    2,
  );
}

export function exportText() {
  return sortedEntries()
    .map((e) => {
      const d = new Date(e.dreamedAt);
      const stamp = d.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' });
      return `${stamp}\n${e.title ? e.title + '\n' : ''}\n${e.body}\n\n${'—'.repeat(24)}\n`;
    })
    .join('\n');
}
