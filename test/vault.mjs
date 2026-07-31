/**
 * A Node mirror of public/js/crypto.js, used by the tests to prove that what
 * the browser encrypts is exactly what the server stores — and that the server
 * cannot read it. If this file and crypto.js ever disagree, the tests fail.
 */

export const BASE = process.env.NOCTURNE_BASE || 'http://127.0.0.1:8787';
export const SETUP_CODE = process.env.NOCTURNE_SETUP_CODE || 'local-dev-code';

const te = new TextEncoder();
const td = new TextDecoder();

export const toHex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
export const toB64 = (b) => Buffer.from(new Uint8Array(b)).toString('base64');
export const fromB64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
export const randomHex = (n) => toHex(crypto.getRandomValues(new Uint8Array(n)));

async function hkdf(rootBits, info, asKey) {
  const root = await crypto.subtle.importKey('raw', rootBits, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const params = { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: te.encode(info) };
  return asKey
    ? crypto.subtle.deriveKey(params, root, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    : crypto.subtle.deriveBits(params, root, 256);
}

export async function deriveIdentity(passphrase, saltHex) {
  const material = await crypto.subtle.importKey('raw', te.encode(passphrase), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const rootBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: te.encode(saltHex), iterations: 210_000 },
    material,
    256,
  );
  const [proofBits, vaultKey] = await Promise.all([
    hkdf(rootBits, 'dj:auth:v1', false),
    hkdf(rootBits, 'dj:vault:v1', true),
  ]);
  return { authProof: toHex(proofBits), vaultKey };
}

export async function encryptEntry(key, id, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: te.encode(id) },
    key,
    te.encode(JSON.stringify(payload)),
  );
  return { iv: toB64(iv), ciphertext: toB64(ciphertext) };
}

export async function decryptEntry(key, id, ivB64, ctB64) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(ivB64), additionalData: te.encode(id) },
    key,
    fromB64(ctB64),
  );
  return JSON.parse(td.decode(plain));
}

/** A tiny cookie-aware client, so tests exercise the same session flow the app does. */
export function makeClient() {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    set cookie(v) {
      cookie = v;
    },
    async call(method, path, body) {
      const res = await fetch(BASE + path, {
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(cookie ? { cookie } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual',
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const text = await res.text();
      let json = {};
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text.slice(0, 200) };
      }
      return { status: res.status, json, headers: res.headers };
    },
  };
}

/* ---------------------------------------------------------------- sharing */

/** Mirrors the sharing half of public/js/crypto.js. */
export async function generateShareKeys() {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveKey',
    'deriveBits',
  ]);
}

export const exportPublicKey = async (key) => toB64(await crypto.subtle.exportKey('raw', key));

export const importPublicKey = (b64) =>
  crypto.subtle.importKey('raw', fromB64(b64), { name: 'ECDH', namedCurve: 'P-256' }, true, []);

export async function wrapPrivateKey(vaultKey, privateKey) {
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', privateKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: te.encode('dj:sharekey:v1') },
    vaultKey,
    pkcs8,
  );
  return { wrapped: toB64(wrapped), iv: toB64(iv) };
}

export async function unwrapPrivateKey(vaultKey, wrappedB64, ivB64) {
  const pkcs8 = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(ivB64), additionalData: te.encode('dj:sharekey:v1') },
    vaultKey,
    fromB64(wrappedB64),
  );
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveKey',
    'deriveBits',
  ]);
}

const sharedSecret = (mine, theirs) =>
  crypto.subtle.deriveKey({ name: 'ECDH', public: theirs }, mine, { name: 'AES-GCM', length: 256 },
    false, ['encrypt', 'decrypt']);

export async function sealShare(myPrivateKey, theirPublicKey, entryId, payload) {
  const contentKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt', 'decrypt',
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: te.encode(entryId) },
    contentKey, te.encode(JSON.stringify(payload)));

  const secret = await sharedSecret(myPrivateKey, theirPublicKey);
  const wrapIv = crypto.getRandomValues(new Uint8Array(12));
  const wrappedKey = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: wrapIv, additionalData: te.encode(entryId) },
    secret, await crypto.subtle.exportKey('raw', contentKey));

  return { iv: toB64(iv), ciphertext: toB64(ciphertext),
    wrappedKey: toB64(wrappedKey), wrapIv: toB64(wrapIv) };
}

export async function openShare(myPrivateKey, theirPublicKey, entryId, share) {
  const secret = await sharedSecret(myPrivateKey, theirPublicKey);
  const rawKey = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(share.wrap_iv), additionalData: te.encode(entryId) },
    secret, fromB64(share.wrapped_key));
  const contentKey = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(share.iv), additionalData: te.encode(entryId) },
    contentKey, fromB64(share.ciphertext));
  return JSON.parse(td.decode(plain));
}

/* ----------------------------------------------------- driving the compose */

/** Mirrors STEPS in public/js/app.js. */
export const COMPOSE_STEPS = ['lucid', 'name', 'story', 'feel', 'detail', 'context'];

export const stepIndex = (page) =>
  page.$eval('.step.is-active', (n) => Number(n.dataset.step));

/** Walks the sheet to a named step, forwards or back, the way a thumb would. */
export async function goToStep(page, name) {
  const target = COMPOSE_STEPS.indexOf(name);
  if (target < 0) throw new Error(`no such step: ${name}`);
  for (let guard = 0; guard <= COMPOSE_STEPS.length; guard++) {
    const at = await stepIndex(page);
    if (at === target) return;
    await page.click(at < target ? '#compose-next' : '#compose-back');
    await page.waitForTimeout(150);
  }
  throw new Error(`stuck before step ${name}`);
}

/** The last step's Next button is "Keep" — that is how a dream is filed. */
export async function keepDream(page) {
  await goToStep(page, 'context');
  await page.click('#compose-next');
}

/* --------------------------------------------------------------- reporting */

let pass = 0;
let fail = 0;

export function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name} ${detail}`);
  }
}

export function report() {
  console.log(`\n${pass} passed, ${fail} failed\n`);
  return fail;
}
