/**
 * Reality-check reminders.
 *
 * The push service stub verifies the VAPID JWT signature for real, so a
 * mis-signed token fails here the way it would against Apple or Google.
 *
 *   npm run dev
 *   npm run stub:push
 *   npm run test:push
 */

import { execSync } from 'node:child_process';
import { SETUP_CODE, deriveIdentity, randomHex, makeClient, check, report } from './vault.mjs';

const STUB = process.env.PUSH_STUB || 'http://127.0.0.1:8789';

const client = makeClient();
const call = client.call.bind(client);

const rows = (sql) =>
  JSON.parse(
    execSync(`npx wrangler d1 execute dreams --local --command "${sql}" --json`, {
      cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }),
  )[0].results;

(async () => {
  execSync(
    `npx wrangler d1 execute dreams --local --command "DELETE FROM push_subscriptions; DELETE FROM sessions; DELETE FROM users;"`,
    { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'ignore'] },
  );

  const kdfSalt = randomHex(16);
  const ada = await deriveIdentity('correct-horse-battery', kdfSalt);
  let r = await call('POST', '/api/auth/register', {
    username: 'ada', authProof: ada.authProof, kdfSalt, setupCode: SETUP_CODE,
  });
  if (r.status !== 200) throw new Error('register: ' + JSON.stringify(r.json));

  console.log('\n— availability —');
  r = await call('GET', '/api/auth/me');
  check('server reports reminders are configured', r.json.pushAvailable === true);
  check('the app is given the public key to subscribe with',
    typeof r.json.vapidPublicKey === 'string' && r.json.vapidPublicKey.length > 40);

  console.log('\n— subscribing —');
  r = await call('POST', '/api/push/subscribe', {
    endpoint: `${STUB}/push/ok`,
    timezone: 'Europe/Prague',
    morningTime: '07:15',
    checkTimes: '10:30,13:00,16:00,19:30',
    bedtimeTime: '22:40',
    wbtbTime: '04:00',
  });
  check('subscription accepted', r.status === 200, JSON.stringify(r.json));

  let stored = rows('SELECT * FROM push_subscriptions');
  check('the times are stored', stored[0]?.morning_time === '07:15');
  check('the bedtime nudge is stored', stored[0]?.bedtime_time === '22:40');
  check('the wake-back-to-bed alarm is stored', stored[0]?.wbtb_time === '04:00');
  check('the timezone is stored, not an offset', stored[0]?.timezone === 'Europe/Prague');
  check('nothing personal is stored',
    !JSON.stringify(stored).toLowerCase().includes('dream'), JSON.stringify(stored[0]));

  r = await call('POST', '/api/push/subscribe', {
    endpoint: `${STUB}/push/ok`, timezone: 'Europe/Prague',
    morningTime: 'not-a-time', checkTimes: '10:30,rubbish,25:99',
    bedtimeTime: '24:00', wbtbTime: '4:00',
  });
  stored = rows('SELECT * FROM push_subscriptions');
  check('rubbish times are dropped rather than stored',
    stored[0].morning_time === '' && stored[0].check_times === '10:30',
    JSON.stringify({ m: stored[0].morning_time, c: stored[0].check_times }));
  check('an out-of-range hour is dropped', stored[0].bedtime_time === '',
    `(kept "${stored[0].bedtime_time}")`);
  check('an unpadded time is dropped rather than half-parsed', stored[0].wbtb_time === '',
    `(kept "${stored[0].wbtb_time}")`);
  check('re-subscribing updates rather than duplicating', stored.length === 1);

  // Locally PUSH_ALLOW_INSECURE lets the stub be plain http, so this checks the
  // validation that is always on rather than the scheme rule.
  r = await call('POST', '/api/push/subscribe', { endpoint: 'not-a-url' });
  check('a garbage endpoint is refused', r.status === 400, JSON.stringify(r.json));
  r = await call('POST', '/api/push/subscribe', { endpoint: `https://x.example/${'y'.repeat(3000)}` });
  check('an absurdly long endpoint is refused', r.status === 400);

  console.log('\n— actually sending one —');
  r = await call('POST', '/api/push/test');
  check('the push service accepted it', r.status === 200 && r.json.ok === true,
    JSON.stringify(r.json));
  check('it was a 201 from the service', (r.json.statuses || []).includes(201),
    JSON.stringify(r.json.statuses));

  const stub = await fetch(`${STUB}/__received`).then((x) => x.json()).catch(() => null);
  if (stub) {
    const last = stub[stub.length - 1];
    check('the VAPID signature verified against the public key', last?.vapid?.ok === true,
      last?.vapid?.why);
    check('the audience is the push service origin',
      last?.vapid?.claims?.aud === new URL(STUB).origin, last?.vapid?.claims?.aud);
    check('no payload was sent', !last?.body);
    check('a TTL was set', !!last?.ttl);
  }

  console.log('\n— a dead subscription is cleaned up —');
  await call('POST', '/api/push/subscribe', {
    endpoint: `${STUB}/push/gone`, timezone: 'UTC', morningTime: '07:15', checkTimes: '',
  });
  r = await call('POST', '/api/push/test');
  check('a 410 is reported rather than swallowed',
    (r.json.statuses || []).includes(410), JSON.stringify(r.json.statuses));

  console.log('\n— unsubscribing —');
  r = await call('POST', '/api/push/unsubscribe', { endpoint: `${STUB}/push/ok` });
  check('unsubscribe accepted', r.status === 200);
  stored = rows('SELECT * FROM push_subscriptions');
  check('the row is gone', !stored.some((s) => s.endpoint.endsWith('/push/ok')));

  const saved = client.cookie;
  client.cookie = '';
  r = await call('POST', '/api/push/subscribe', { endpoint: `${STUB}/push/ok` });
  check('subscribing requires a session', r.status === 401);
  client.cookie = saved;

  process.exit(report() ? 1 : 0);
})();
