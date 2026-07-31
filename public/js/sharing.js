/**
 * Sharing lucid dreams between the two accounts, without giving the server
 * anything it can read.
 *
 * Each person holds an ECDH keypair. A shared dream is encrypted under a fresh
 * content key, and only that key is wrapped to the secret the two of them can
 * both derive. The server stores the ciphertext and the wrapped key and can
 * open neither.
 */

import { api } from './api.js';
import {
  generateShareKeys,
  exportPublicKey,
  importPublicKey,
  wrapPrivateKey,
  unwrapPrivateKey,
  sealShare,
  openShare,
} from './crypto.js';
import { normalise } from './dream.js';

export const sharing = {
  ready: false,
  privateKey: null,
  peer: null, // { username, publicKey: CryptoKey } once they have keys too
  peerName: null,
  /** Entry ids of my own dreams currently shared out. */
  sharedByMe: new Set(),
  /** Their dreams, decrypted. */
  inbox: [],
  error: null,
};

/**
 * Makes sure this account has a keypair, generating one the first time.
 * Safe to call on every unlock.
 */
export async function initSharing(vaultKey) {
  sharing.error = null;
  try {
    const keys = await api.getKeys();

    if (keys.publicKey && keys.wrappedPrivate) {
      sharing.privateKey = await unwrapPrivateKey(vaultKey, keys.wrappedPrivate, keys.wrappedIv);
    } else {
      const pair = await generateShareKeys();
      const wrapped = await wrapPrivateKey(vaultKey, pair.privateKey);
      await api.publishKeys({
        publicKey: await exportPublicKey(pair.publicKey),
        wrappedPrivate: wrapped.wrapped,
        wrappedIv: wrapped.iv,
      });
      sharing.privateKey = pair.privateKey;
    }

    sharing.peerName = keys.peer?.username || null;
    sharing.peer =
      keys.peer?.publicKey
        ? { username: keys.peer.username, publicKey: await importPublicKey(keys.peer.publicKey) }
        : null;
    sharing.ready = true;
  } catch (err) {
    sharing.ready = false;
    sharing.error = err.message;
  }
  return sharing.ready;
}

/** True when there is somebody to share with who has opened the app. */
export function canShare() {
  return sharing.ready && !!sharing.peer && !!sharing.privateKey;
}

export function isShared(entryId) {
  return sharing.sharedByMe.has(entryId);
}

export async function share(entry) {
  if (!canShare()) throw new Error('There is nobody to share with yet.');
  const { id, dreamedAt, createdAt, updatedAt, pending, ...dream } = entry;
  const sealed = await sealShare(sharing.privateKey, sharing.peer.publicKey, id, normalise(dream));
  await api.putShare(id, { ...sealed, dreamedAt });
  sharing.sharedByMe.add(id);
}

export async function unshare(entryId) {
  await api.unshare(entryId);
  sharing.sharedByMe.delete(entryId);
}

/** Pulls and decrypts whatever they have shared. */
export async function refreshInbox() {
  if (!sharing.ready) return sharing.inbox;
  const res = await api.listShares();
  sharing.sharedByMe = new Set(res.sharedByMe || []);

  if (res.peer?.publicKey && !sharing.peer) {
    // They generated keys since we last looked.
    sharing.peer = {
      username: res.peer.username,
      publicKey: await importPublicKey(res.peer.publicKey),
    };
  }
  sharing.peerName = res.peer?.username || sharing.peerName;

  const out = [];
  for (const row of res.inbox || []) {
    if (!sharing.peer) break;
    try {
      const payload = await openShare(
        sharing.privateKey,
        sharing.peer.publicKey,
        row.entry_id,
        row,
      );
      out.push({
        ...normalise(payload),
        id: row.entry_id,
        dreamedAt: row.dreamed_at,
        from: row.from_username,
      });
    } catch {
      out.push({
        id: row.entry_id,
        dreamedAt: row.dreamed_at,
        from: row.from_username,
        undecryptable: true,
        title: '',
        body: '',
      });
    }
  }
  sharing.inbox = out.sort((a, b) => b.dreamedAt - a.dreamedAt);
  return sharing.inbox;
}

export function forgetSharing() {
  sharing.ready = false;
  sharing.privateKey = null;
  sharing.peer = null;
  sharing.peerName = null;
  sharing.sharedByMe = new Set();
  sharing.inbox = [];
}
