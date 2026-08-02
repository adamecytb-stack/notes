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

const STUB = process.env.GEMINI_STUB || 'http://127.0.0.1:8788';

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
  check('rate limit becomes a readable message', r.status === 429 && /preťažené/i.test(r.json.error),
    JSON.stringify(r.json));

  await new Promise((res) => setTimeout(res, 4200));
  r = await call('POST', '/api/ai', { prompt: 'TRIGGER_404' });
  check('unknown model names the fix', r.status === 502 && /GEMINI_MODEL/.test(r.json.error),
    JSON.stringify(r.json));

  await new Promise((res) => setTimeout(res, 4200));
  r = await call('POST', '/api/ai', { prompt: 'TRIGGER_BLOCKED' });
  check('safety block is explained, not blamed on the user',
    r.status === 422 && /nič zlé/i.test(r.json.error), JSON.stringify(r.json));

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

  /*
   * The quiet failures. Every one of these used to come back as the same
   * shrug — "nothing to say" — which is indistinguishable from the companion
   * being broken, and gives nobody anything to act on.
   */
  /*
   * The system prompt is what tells Gemini the dreams are Slovak and that it
   * must answer in Slovak. If it silently stopped arriving — a renamed field
   * would do it — the companion would still work, just in the wrong language,
   * and no other test would notice.
   */
  console.log('\n— the system prompt actually arrives —');
  const sent = await (await fetch(`${STUB}/__last`)).json();
  check('a system prompt was sent at all', typeof sent.system === 'string' && sent.system.length > 200,
    `(${(sent.system || '').length} chars)`);
  check('it tells the model the dreams are Slovak', /Slovak/.test(sent.system || ''));
  check('and to reply in Slovak', /Always reply in Slovak/.test(sent.system || ''));
  check('room is left for an answer after thinking',
    sent.maxTokens >= 4096 && sent.thinking?.thinkingBudget < sent.maxTokens,
    JSON.stringify({ maxTokens: sent.maxTokens, thinking: sent.thinking }));

  console.log('\n— a 200 with no answer in it says why —');
  r = await call('POST', '/api/ai', { prompt: 'TRIGGER_THOUGHT_ALL_TOKENS' });
  check('thinking through the whole budget is named as such',
    r.status === 502 && /premýšľanie/i.test(r.json.error), JSON.stringify(r.json));

  await new Promise((s) => setTimeout(s, 4200));
  r = await call('POST', '/api/ai', { prompt: 'TRIGGER_CANDIDATE_SAFETY' });
  check('a safety stop on the answer reads as a safety stop',
    r.status === 422 && /bezpečnostné/i.test(r.json.error), JSON.stringify(r.json));

  await new Promise((s) => setTimeout(s, 4200));
  r = await call('POST', '/api/ai', { prompt: 'TRIGGER_TRUNCATED' });
  check('a cut-off answer still arrives', r.status === 200 && !!r.json.text);
  check('and is flagged as cut off', r.json.truncated === true, JSON.stringify(r.json));

  await new Promise((s) => setTimeout(s, 4200));
  r = await call('POST', '/api/ai', { prompt: 'TRIGGER_NO_THINKING_SUPPORT' });
  check('a model that rejects thinkingConfig is retried without it',
    r.status === 200 && /bez premýšľania/.test(r.json.text || ''), JSON.stringify(r.json));

  await new Promise((s) => setTimeout(s, 4200));
  r = await call('POST', '/api/ai', { prompt: 'TRIGGER_404' });
  check('an unusable model name lists the ones that work',
    r.status === 502 && /gemini-stub-flash/.test(r.json.error), JSON.stringify(r.json));

  console.log('\n— the budget is per person —');
  execSync(
    `npx wrangler d1 execute dreams --local --command "UPDATE ai_usage SET count = 40, last_at = 0"`,
    { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'ignore'] },
  );
  r = await call('POST', '/api/ai', { prompt: 'one more' });
  check('daily cap stops further readings', r.status === 429 && /denný limit/i.test(r.json.error),
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
