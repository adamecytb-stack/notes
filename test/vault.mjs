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
