/**
 * Dream companion tests.
 *
 * Runs against the local dev server with test/gemini-stub.mjs standing in for
 * Google. Verifies the relay, the failure branches, the per-user budget, and —
 * most importantly — that nothing reaches the model unless it was asked for.
 *
 *   node test/gemini-stub.mjs &          (with GEMINI_HOST pointed at it)
 *   npm run dev
 *   npm run test:ai
 */

import { execSync } from 'node:child_process';
import { SETUP_CODE, deriveIdentity, randomHex, makeClient, check, report } from './vault.mjs';

const client = makeClient();
const call = client.call.bind(client);

(async () => {
  execSync(
    `npx wrangler d1 execute dreams --local --command "DELETE FROM entries; DELETE FROM sessions; DELETE FROM users; DELETE FROM login_attempts; DELETE FROM ai_usage;"`,
    { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'ignore'] },
  );

  const kdfSalt = randomHex(16);
  const ada = await deriveIdentity('correct-horse-battery', kdfSalt);
  let r = await call('POST', '/api/auth/register', {
    username: 'ada', authProof: ada.authProof, kdfSalt, setupCode: SETUP_CODE,
  });
  if (r.status !== 200) throw new Error('register failed: ' + JSON.stringify(r.json));

  console.log('\n— availability —');
  r = await call('GET', '/api/auth/me');
  check('server reports the companion is configured', r.json.aiAvailable === true);

  console.log('\n— a reading —');
  r = await call('POST', '/api/ai', { prompt: 'I dreamt of a library with no floor.' });
  check('relays to the model and returns text', r.status === 200 && /Stub read/.test(r.json.text),
    JSON.stringify(r.json).slice(0, 120));
  check('reports remaining budget', typeof r.json.remaining === 'number');

  console.log('\n— failure branches —');
  await new Promise((res) => setTimeout(res, 4200)); // clear the per-request gap
  r = await call('POST', '/api/ai', { prompt: 'TRIGGER_429' });
  check('rate limit becomes a readable message', r.status === 429 && /rate-limited/i.test(r.json.error),
    JSON.stringify(r.json));

  await new Promise((res) => setTimeout(res, 4200));
  r = await call('POST', '/api/ai', { prompt: 'TRIGGER_404' });
  check('unknown model names the fix', r.status === 502 && /GEMINI_MODEL/.test(r.json.error),
    JSON.stringify(r.json));

  await new Promise((res) => setTimeout(res, 4200));
  r = await call('POST', '/api/ai', { prompt: 'TRIGGER_BLOCKED' });
  check('safety block is explained, not blamed on the user',
    r.status === 422 && /nothing is wrong/i.test(r.json.error), JSON.stringify(r.json));

  console.log('\n— guard rails —');
  r = await call('POST', '/api/ai', { prompt: 'too soon' });
  check('minimum gap between readings is enforced', r.status === 429, JSON.stringify(r.json));

  await new Promise((res) => setTimeout(res, 4200));
  r = await call('POST', '/api/ai', { prompt: 'x'.repeat(70_000) });
  check('oversized prompt is refused', r.status === 413, JSON.stringify(r.json));

  r = await call('POST', '/api/ai', { prompt: '   ' });
  check('empty prompt is refused', r.status === 400);

  const saved = client.cookie;
  client.cookie = '';
  r = await call('POST', '/api/ai', { prompt: 'hello' });
  check('readings require a session', r.status === 401);
  client.cookie = saved;

  console.log('\n— the budget is per person —');
  execSync(
    `npx wrangler d1 execute dreams --local --command "UPDATE ai_usage SET count = 40, last_at = 0"`,
    { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'ignore'] },
  );
  r = await call('POST', '/api/ai', { prompt: 'one more' });
  check('daily cap stops further readings', r.status === 429 && /daily limit/i.test(r.json.error),
    JSON.stringify(r.json));

  console.log('\n— nothing is stored —');
  const dump = execSync(
    `npx wrangler d1 execute dreams --local --command "SELECT * FROM ai_usage" --json`,
    { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  check('usage table holds counters only, no dream text',
    !dump.includes('library') && !dump.includes('floor'), dump.slice(0, 200));

  process.exit(report() ? 1 : 0);
})();
