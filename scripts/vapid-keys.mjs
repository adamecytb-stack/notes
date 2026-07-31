/**
 * Generates the VAPID keypair that identifies this server to push services.
 *
 *   node scripts/vapid-keys.mjs
 *
 * Set both printed values as secrets. They must stay stable — regenerating
 * invalidates every existing subscription and every phone has to re-enable
 * reminders.
 */

const toB64Url = (buf) =>
  Buffer.from(new Uint8Array(buf)).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
  'sign',
  'verify',
]);

const publicKey = toB64Url(await crypto.subtle.exportKey('raw', pair.publicKey));
const privateKey = toB64Url(await crypto.subtle.exportKey('pkcs8', pair.privateKey));

console.log(`
VAPID_PUBLIC_KEY
${publicKey}

VAPID_PRIVATE_KEY
${privateKey}

From a computer:
  npx wrangler secret put VAPID_PUBLIC_KEY
  npx wrangler secret put VAPID_PRIVATE_KEY

From a phone: add both as GitHub repository secrets and re-run the deploy.
`);
