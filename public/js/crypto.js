/**
 * Client-side vault.
 *
 * One passphrase is stretched with PBKDF2 into a root secret, which is then
 * split by HKDF into two independent subkeys:
 *
 *   auth proof  -> sent to the server to prove who you are
 *   vault key   -> never leaves this device, encrypts every dream
 *
 * Because the two are separate HKDF outputs, handing the proof to the server
 * tells it nothing at all about the key that opens your journal.
 */

const PBKDF2_ROUNDS = 210_000; // ~0.3s on an iPhone; paid once at unlock
const te = new TextEncoder();
const td = new TextDecoder();

/* ---------------------------------------------------------------- helpers */

export function toB64(buf) {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromB64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomHex(bytes = 16) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

/* ------------------------------------------------------------ derivation  */

async function hkdf(rootBits, info, { asKey }) {
  const root = await crypto.subtle.importKey('raw', rootBits, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const params = {
    name: 'HKDF',
    hash: 'SHA-256',
    salt: new Uint8Array(32), // root is already salted + stretched by PBKDF2
    info: te.encode(info),
  };
  if (asKey) {
    // extractable: false — even a script running on this page cannot read the
    // raw bytes back out of this key.
    return crypto.subtle.deriveKey(params, root, { name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
  }
  return crypto.subtle.deriveBits(params, root, 256);
}

/**
 * @returns {{authProof: string, vaultKey: CryptoKey}}
 */
export async function deriveIdentity(passphrase, saltHex, onProgress) {
  onProgress?.();
  const material = await crypto.subtle.importKey('raw', te.encode(passphrase), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const rootBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: te.encode(saltHex), iterations: PBKDF2_ROUNDS },
    material,
    256,
  );

  const [proofBits, vaultKey] = await Promise.all([
    hkdf(rootBits, 'dj:auth:v1', { asKey: false }),
    hkdf(rootBits, 'dj:vault:v1', { asKey: true }),
  ]);

  return { authProof: toHex(proofBits), vaultKey };
}

/* ------------------------------------------------------------ encryption  */

/**
 * The entry id is bound in as additional authenticated data, so a blob cannot
 * be moved from one entry to another without the decryption failing.
 */
export async function encryptEntry(vaultKey, entryId, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: te.encode(entryId) },
    vaultKey,
    te.encode(JSON.stringify(payload)),
  );
  return { iv: toB64(iv), ciphertext: toB64(ciphertext) };
}

export async function decryptEntry(vaultKey, entryId, ivB64, ciphertextB64) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(ivB64), additionalData: te.encode(entryId) },
    vaultKey,
    fromB64(ciphertextB64),
  );
  return JSON.parse(td.decode(plain));
}

/* --------------------------------------------------- key persistence (IDB) */

import { idbGet, idbPut, idbDel } from './idb.js';

const KEY_ID = 'vaultKey';

/**
 * Stores the CryptoKey object itself. Because it was derived as
 * non-extractable, what lands on disk is a handle the browser will only ever
 * use for encrypt/decrypt — the raw key bytes are not recoverable from it.
 */
export async function rememberKey(vaultKey, username) {
  await idbPut('vault', KEY_ID, { key: vaultKey, username });
}

export async function recallKey() {
  const rec = await idbGet('vault', KEY_ID);
  return rec?.key instanceof CryptoKey ? rec : null;
}

export async function forgetKey() {
  await idbDel('vault', KEY_ID);
}
