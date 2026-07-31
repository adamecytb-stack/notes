/**
 * Stands in for a browser's push service (FCM, Apple, Mozilla).
 *
 * It does what a real one does with the parts that matter: parses the VAPID
 * Authorization header and cryptographically verifies the JWT against the
 * public key the server claims. A signature the worker got wrong fails here
 * exactly as it would in production.
 *
 * Endpoints:
 *   POST /push/ok    -> 201
 *   POST /push/gone  -> 410, the code that means "forget this subscription"
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.PUSH_STUB_PORT || 8789);
export const received = [];

const fromB64Url = (s) => {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b + '='.repeat((4 - (b.length % 4)) % 4), 'base64');
};

async function verifyVapid(authHeader) {
  const m = /^vapid t=([^,]+),\s*k=(.+)$/.exec(authHeader || '');
  if (!m) return { ok: false, why: 'malformed Authorization header' };

  const [, jwt, publicKeyB64] = m;
  const parts = jwt.split('.');
  if (parts.length !== 3) return { ok: false, why: 'jwt is not three parts' };

  const [header, claims, signature] = parts;
  let parsedHeader, parsedClaims;
  try {
    parsedHeader = JSON.parse(fromB64Url(header).toString());
    parsedClaims = JSON.parse(fromB64Url(claims).toString());
  } catch {
    return { ok: false, why: 'jwt segments are not json' };
  }
  if (parsedHeader.alg !== 'ES256') return { ok: false, why: `alg is ${parsedHeader.alg}` };

  const sig = fromB64Url(signature);
  if (sig.length !== 64) return { ok: false, why: `signature is ${sig.length} bytes, need 64` };

  const key = await crypto.subtle.importKey(
    'raw', fromB64Url(publicKeyB64), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
  );
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, key, sig,
    new TextEncoder().encode(`${header}.${claims}`),
  );
  return ok ? { ok: true, claims: parsedClaims } : { ok: false, why: 'signature does not verify' };
}

const server = createServer((req, res) => {
  // Lets the test read back what the worker actually sent.
  if (req.url === '/__received') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(received));
  }

  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    const result = await verifyVapid(req.headers.authorization);
    received.push({ url: req.url, body: raw, vapid: result, ttl: req.headers.ttl });

    if (!result.ok) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: result.why }));
    }
    if (req.url === '/push/gone') {
      res.writeHead(410);
      return res.end();
    }
    res.writeHead(201);
    res.end();
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`push stub on :${PORT}`));

export default server;
