/**
 * Resets the local database and fills it with a believable journal, so the UI
 * can be looked at with real content in it.
 *
 *   npm run seed
 *
 * Creates `ada` / `correct-horse-battery`.
 */

import { execSync } from 'node:child_process';
import { SETUP_CODE, deriveIdentity, encryptEntry, randomHex, makeClient } from './vault.mjs';

const { call } = makeClient();

const at = (daysAgo, hour, minute) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
};

const DREAMS = [
  {
    at: at(0, 3, 14),
    title: 'Falling through the library',
    body: 'I was descending past shelves that never ended, slowly, like the air was thicker than it should be. Every book I pulled out had my own handwriting inside it, but in a language I could not read while awake.',
  },
  {
    at: at(0, 5, 2),
    title: '',
    body: 'Something about a train platform. My mother was there, much younger. She kept checking a watch that had no hands and telling me there was still time.',
  },
  {
    at: at(1, 4, 41),
    title: 'The house with one more room',
    body: 'Our old house, except there was a door in the hallway that had never been there. Behind it, a room full of grey daylight and furniture under sheets. I knew, in the dream, that it had always been there and I had simply never counted the doors.',
  },
  {
    at: at(2, 2, 8),
    title: 'Swimming in the road',
    body: 'The street outside was water but nobody else seemed to notice. I swam to the corner shop and bought bread and it stayed dry.',
  },
  {
    at: at(4, 6, 20),
    title: 'Teeth again',
    body: 'The teeth one. I keep having the teeth one. This time they came out cleanly, like beads on a string, and I was more embarrassed than frightened.',
  },
  {
    at: at(9, 3, 55),
    title: 'A city that was also a piano',
    body: 'Walking across a city where the streets were black and white and pressing down as I stepped. Each street a note. I was trying to walk a tune I half remembered.',
  },
];

(async () => {
  execSync(
    `npx wrangler d1 execute dreams --local --command "DELETE FROM entries; DELETE FROM sessions; DELETE FROM users; DELETE FROM login_attempts;"`,
    { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'ignore'] },
  );

  const kdfSalt = randomHex(16);
  const ada = await deriveIdentity('correct-horse-battery', kdfSalt);
  const reg = await call('POST', '/api/auth/register', {
    username: 'ada',
    authProof: ada.authProof,
    kdfSalt,
    setupCode: SETUP_CODE,
  });
  if (reg.status !== 200) throw new Error('register failed: ' + JSON.stringify(reg.json));

  for (const dream of DREAMS) {
    const id = crypto.randomUUID();
    const blob = await encryptEntry(ada.vaultKey, id, { v: 1, title: dream.title, body: dream.body });
    const res = await call('POST', '/api/entries', { id, ...blob, dreamedAt: dream.at });
    if (res.status !== 200) throw new Error('seed failed: ' + JSON.stringify(res.json));
  }

  console.log(`reset and seeded ${DREAMS.length} dreams for ada`);
})();
