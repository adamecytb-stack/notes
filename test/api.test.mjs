/**
 * API + crypto tests.
 *
 * Run against a local dev server:
 *   npm run dev            (in one terminal)
 *   npm run test:api       (in another)
 */

import { execSync } from 'node:child_process';
import {
  BASE,
  SETUP_CODE,
  deriveIdentity,
  encryptEntry,
  decryptEntry,
  randomHex,
  makeClient,
  check,
  report,
} from './vault.mjs';

const DREAM = {
  title: 'Falling through the library',
  body: 'I was descending past shelves that never ended. Every book had my handwriting in it.',
};

const client = makeClient();
const call = client.call.bind(client);

(async () => {
  // Start from an empty journal so seat limits and usernames are predictable.
  execSync(
    `npx wrangler d1 execute dreams --local --command "DELETE FROM entries; DELETE FROM sessions; DELETE FROM users; DELETE FROM login_attempts;"`,
    { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'ignore'] },
  );

  console.log('\n— setup —');
  const username = 'ada';
  const salt = randomHex(16);
  const ada = await deriveIdentity('correct-horse-battery', salt);

  let r = await call('POST', '/api/auth/register', {
    username, authProof: ada.authProof, kdfSalt: salt, setupCode: SETUP_CODE,
  });
  check('register first user', r.status === 200, JSON.stringify(r.json));

  r = await call('POST', '/api/auth/register', {
    username: 'mallory', authProof: ada.authProof, kdfSalt: salt, setupCode: 'wrong-code',
  });
  check('register rejects wrong setup code', r.status === 403);

  console.log('\n— a short setup code cannot be brute-forced —');
  let lockedAfter = 0;
  for (let i = 0; i < 8; i++) {
    const guess = await call('POST', '/api/auth/register', {
      username: `guess${i}`, authProof: ada.authProof, kdfSalt: salt, setupCode: String(1000 + i),
    });
    if (guess.status === 429) { lockedAfter = i + 1; break; }
  }
  check('sign-up locks out after repeated wrong codes', lockedAfter > 0,
    lockedAfter ? `(after ${lockedAfter} guesses)` : '(never locked — brute-forceable!)');

  // Clear the lockout so the rest of the suite can register normally.
  execSync(
    `npx wrangler d1 execute dreams --local --command "DELETE FROM login_attempts"`,
    { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'ignore'] },
  );

  console.log('\n— writing a dream —');
  const entryId = crypto.randomUUID();
  const blob = await encryptEntry(ada.vaultKey, entryId, { v: 1, ...DREAM });
  r = await call('POST', '/api/entries', { id: entryId, ...blob, dreamedAt: Date.now() });
  check('create entry', r.status === 200, JSON.stringify(r.json));

  r = await call('GET', '/api/entries?since=0');
  const row = r.json.entries?.[0];
  check('entry comes back', !!row);
  const wire = JSON.stringify(r.json);
  check('API response carries no plaintext',
    !wire.includes('library') && !wire.includes('handwriting'));

  const round = await decryptEntry(ada.vaultKey, row.id, row.iv, row.ciphertext);
  check('decrypts to the original', round.title === DREAM.title && round.body === DREAM.body);

  console.log('\n— the database itself —');
  const dump = execSync(
    `npx wrangler d1 execute dreams --local --command "SELECT ciphertext FROM entries" --json`,
    { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  check('stored rows are unreadable',
    !dump.includes('library') && !dump.includes('handwriting'));

  console.log('\n— tamper resistance —');
  try {
    await decryptEntry(ada.vaultKey, crypto.randomUUID(), row.iv, row.ciphertext);
    check('blob is bound to its entry id', false, '(decrypted under a different id!)');
  } catch {
    check('blob is bound to its entry id', true);
  }

  const wrongKey = await deriveIdentity('not-the-passphrase', salt);
  try {
    await decryptEntry(wrongKey.vaultKey, row.id, row.iv, row.ciphertext);
    check('wrong passphrase cannot decrypt', false);
  } catch {
    check('wrong passphrase cannot decrypt', true);
  }

  console.log('\n— auth —');
  client.cookie = '';
  r = await call('GET', '/api/entries');
  check('entries require a session', r.status === 401);

  r = await call('POST', '/api/auth/salt', { username: 'nobody-here' });
  check('unknown username still returns a salt', r.status === 200 && !!r.json.salt);

  r = await call('POST', '/api/auth/login', { username, authProof: 'f'.repeat(64) });
  check('wrong passphrase rejected', r.status === 401);

  r = await call('POST', '/api/auth/salt', { username });
  const relogin = await deriveIdentity('correct-horse-battery', r.json.salt);
  r = await call('POST', '/api/auth/login', { username, authProof: relogin.authProof });
  check('correct passphrase logs in', r.status === 200, JSON.stringify(r.json));

  console.log('\n— two seats, and only two —');
  const salt2 = randomHex(16);
  const grace = await deriveIdentity('a-second-persons-passphrase', salt2);
  r = await call('POST', '/api/auth/register', {
    username: 'grace', authProof: grace.authProof, kdfSalt: salt2, setupCode: SETUP_CODE,
  });
  check('second user can register', r.status === 200, JSON.stringify(r.json));

  const salt3 = randomHex(16);
  const carol = await deriveIdentity('a-third-person', salt3);
  r = await call('POST', '/api/auth/register', {
    username: 'carol', authProof: carol.authProof, kdfSalt: salt3, setupCode: SETUP_CODE,
  });
  check('third user is refused', r.status === 403, JSON.stringify(r.json));

  console.log('\n— the two journals are separate —');
  // Currently signed in as grace.
  r = await call('GET', '/api/entries?since=0');
  check("second user sees none of the first user's entries", (r.json.entries || []).length === 0);
  r = await call('DELETE', `/api/entries/${entryId}`);
  check("second user cannot delete the first user's entry", r.status === 404);

  console.log('\n— CPU budget —');
  // A Worker on the free plan is killed at 10ms CPU per request. Server-side
  // key stretching once blew that by 10x and made every login fail with a
  // generic 500, so the auth paths are timed here to stop it coming back.
  // Wall-clock is a loose proxy for CPU, hence the generous ceiling.
  r = await call('POST', '/api/auth/salt', { username });
  const freshProof = await deriveIdentity('correct-horse-battery', r.json.salt);
  const timed = async (label, fn) => {
    const t0 = performance.now();
    await fn();
    const ms = performance.now() - t0;
    check(`${label} stays well inside the CPU budget`, ms < 250, `(${ms.toFixed(0)}ms round trip)`);
  };
  await timed('login', () =>
    call('POST', '/api/auth/login', { username, authProof: freshProof.authProof }));
  await timed('rejected login', () =>
    call('POST', '/api/auth/login', { username: 'ghost', authProof: 'a'.repeat(64) }));

  console.log('\n— headers —');
  r = await call('GET', '/api/status');
  const csp = r.headers.get('content-security-policy') || '';
  check('CSP restricts scripts to same origin', csp.includes("script-src 'self'"));
  check('CSP forbids framing', csp.includes("frame-ancestors 'none'"));

  const shell = await fetch(new URL('/settings', BASE));
  check('client-side routes serve the app shell',
    shell.status === 200 && (await shell.text()).includes('Nocturne'));

  process.exit(report() ? 1 : 0);
})();
