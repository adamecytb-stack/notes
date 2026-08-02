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

/** Remembers which of their public keys we last sealed to, across restarts. */
const PEER_KEY_MEMO = 'nocturne.peerKey';

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
  /** Set when this phone had to rotate its keypair to get working again. */
  repaired: false,
  /** Set when they rotated theirs, so old dreams of theirs are gone. */
  peerRotated: false,
};

/**
 * Makes sure this account has a usable keypair, generating one the first time
 * and repairing one it cannot open. Safe to call on every unlock.
 */
export async function initSharing(vaultKey) {
  sharing.error = null;
  sharing.repaired = false;
  try {
    const keys = await api.getKeys();

    if (keys.publicKey && keys.wrappedPrivate) {
      try {
        sharing.privateKey = await unwrapPrivateKey(vaultKey, keys.wrappedPrivate, keys.wrappedIv);
      } catch {
        /*
         * The stored key was wrapped under a vault key this phone no longer
         * has — which is what a passphrase change used to leave behind. There
         * is no way to recover the key itself, so the only route back is a new
         * pair. Everything sealed to the old one is already unreadable by
         * both of us, so nothing readable is lost by replacing it.
         */
        await freshKeypair(vaultKey, { replace: true });
        sharing.repaired = true;
      }
    } else {
      await freshKeypair(vaultKey);
    }

    sharing.peerName = keys.peer?.username || null;
    sharing.peer =
      keys.peer?.publicKey
        ? { username: keys.peer.username, publicKey: await importPublicKey(keys.peer.publicKey) }
        : null;
    if (keys.peer?.publicKey) notePeerKey(keys.peer.publicKey);
    sharing.ready = true;
  } catch (err) {
    sharing.ready = false;
    sharing.error = err.message;
  }
  return sharing.ready;
}

async function freshKeypair(vaultKey, { replace = false } = {}) {
  const pair = await generateShareKeys();
  const wrapped = await wrapPrivateKey(vaultKey, pair.privateKey);
  await api.publishKeys({
    publicKey: await exportPublicKey(pair.publicKey),
    wrappedPrivate: wrapped.wrapped,
    wrappedIv: wrapped.iv,
    ...(replace ? { replace: true } : {}),
  });
  sharing.privateKey = pair.privateKey;
  // Whatever we had shared out was sealed to the key we just replaced.
  sharing.sharedByMe = new Set();
}

/**
 * Notices when they have rotated their key. Anything we sealed to the old one
 * is unopenable for them now, so it has to be sealed again — which this phone
 * can do unattended, because it still holds the plaintext.
 */
function notePeerKey(publicKeyB64) {
  let previous = null;
  try {
    previous = localStorage.getItem(PEER_KEY_MEMO);
    localStorage.setItem(PEER_KEY_MEMO, publicKeyB64);
  } catch {
    return false;
  }
  const rotated = !!previous && previous !== publicKeyB64;
  if (rotated) sharing.peerRotated = true;
  return rotated;
}

/** True when there is somebody to share with who has opened the app. */
export function canShare() {
  return sharing.ready && !!sharing.peer && !!sharing.privateKey;
}

export function isShared(entryId) {
  return sharing.sharedByMe.has(entryId);
}

export async function share(entry) {
  if (!canShare()) throw new Error('Zatiaľ nie je s kým zdieľať.');
  const { id, dreamedAt, createdAt, updatedAt, pending, ...dream } = entry;
  const sealed = await sealShare(sharing.privateKey, sharing.peer.publicKey, id, normalise(dream));
  await api.putShare(id, { ...sealed, dreamedAt });
  sharing.sharedByMe.add(id);
}

export async function unshare(entryId) {
  await api.unshare(entryId);
  sharing.sharedByMe.delete(entryId);
}

/**
 * Re-seals everything currently shared out to whatever their public key is
 * now. Called when they have rotated it — the ciphertext on the server is
 * addressed to a key they no longer hold, and only this phone can fix that,
 * because only this phone can still read the dreams in the clear.
 */
export async function reseal(entriesById) {
  if (!canShare()) return 0;
  let done = 0;
  for (const id of [...sharing.sharedByMe]) {
    const entry = entriesById(id);
    if (!entry) continue;
    try {
      await share(entry);
      done += 1;
    } catch {
      /* one failure must not strand the rest */
    }
  }
  return done;
}

/** Pulls and decrypts whatever they have shared. */
export async function refreshInbox() {
  if (!sharing.ready) return sharing.inbox;
  const res = await api.listShares();
  sharing.sharedByMe = new Set(res.sharedByMe || []);

  if (res.peer?.publicKey) {
    const rotated = notePeerKey(res.peer.publicKey);
    if (rotated || !sharing.peer) {
      sharing.peer = {
        username: res.peer.username,
        publicKey: await importPublicKey(res.peer.publicKey),
      };
    }
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
