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

/*
 * A believable journal, including the parts the app is actually about: two
 * lucid nights, a dream sign that recurs often enough to be worth rehearsing,
 * and enough sleep conditions logged for the patterns to have something to
 * chew on. The first entry is deliberately v1-shaped — old entries still have
 * to decrypt and render, and this is what proves it.
 */
const DREAMS = [
  {
    at: at(0, 3, 14),
    v: 1,
    title: 'Falling through the library',
    body: 'I was descending past shelves that never ended, slowly, like the air was thicker than it should be. Every book I pulled out had my own handwriting inside it, but in a language I could not read while awake.',
  },
  {
    at: at(0, 5, 2),
    title: '',
    body: 'Something about a train platform. My mother was there, much younger. She kept checking a watch that had no hands and telling me there was still time.',
    mood: 3,
    vividness: 3,
    signs: ['Text or numbers that would not hold still', 'Someone who should not have been there'],
    env: { place: 'Home', bedtime: '23:20', wokeInNight: false, substances: [], notes: '' },
  },
  {
    at: at(1, 4, 41),
    title: 'The house with one more room',
    body: 'Our old house, except there was a door in the hallway that had never been there. Behind it, a room full of grey daylight and furniture under sheets. I knew, in the dream, that it had always been there and I had simply never counted the doors.',
    mood: 2,
    vividness: 4,
    signs: ['A house with a room that should not exist', 'Something impossible felt normal'],
    theme: 'Somewhere familiar that had grown',
    env: { place: 'Home', bedtime: '23:00', wokeInNight: true, substances: [], notes: '' },
  },
  {
    at: at(2, 2, 8),
    title: 'Swimming in the road',
    body: 'The street outside was water but nobody else seemed to notice. I swam to the corner shop and bought bread and it stayed dry. Halfway back I stopped and thought: bread does not stay dry. And then I knew.',
    lucid: true,
    mood: 5,
    vividness: 5,
    signs: ['Water — swimming, flooding, drowning', 'Something impossible felt normal'],
    trigger: 'Something did not make logical sense',
    priorActivity: 'Swimming back from the shop holding the bread',
    actions: 'Looked at my hands, rubbed them together, then went up over the rooftops',
    excitement: 4,
    duration: 'A few minutes',
    ending: 'It faded and I lost awareness',
    env: {
      place: "A friend's",
      bedtime: '00:10',
      wokeInNight: true,
      substances: ['Caffeine'],
      notes: 'Stayed over, slept badly, woke about four',
    },
  },
  {
    at: at(4, 6, 20),
    title: 'Teeth again',
    body: 'The teeth one. I keep having the teeth one. This time they came out cleanly, like beads on a string, and I was more embarrassed than frightened.',
    mood: 2,
    vividness: 3,
    signs: ['Teeth, hair, or my body changing', 'Something impossible felt normal'],
    env: { place: 'Home', bedtime: '23:45', wokeInNight: false, substances: ['Late meal'], notes: '' },
  },
  {
    at: at(6, 5, 30),
    title: 'The corridor of clocks',
    body: 'A corridor lined with clocks, none of them agreeing. I looked at one, looked away, looked back, and it had gone from ten past to nearly midnight. That was the moment — I remember actually saying it out loud, this is a dream.',
    lucid: true,
    mood: 4,
    vividness: 5,
    signs: ['Text or numbers that would not hold still', 'Something impossible felt normal'],
    trigger: 'Something did not make logical sense',
    priorActivity: 'Walking down the corridor looking for a way out',
    actions: 'Said it out loud, touched the wall to hold it steady, then opened a door on purpose',
    excitement: 3,
    duration: 'Under a minute',
    ending: 'I woke straight up',
    env: {
      place: 'Home',
      bedtime: '22:50',
      wokeInNight: true,
      substances: [],
      notes: 'Woke at four and went back to sleep after twenty minutes',
    },
  },
  {
    at: at(9, 3, 55),
    title: 'A city that was also a piano',
    body: 'Walking across a city where the streets were black and white and pressing down as I stepped. Each street a note. I was trying to walk a tune I half remembered.',
    mood: 4,
    vividness: 4,
    signs: ['Something impossible felt normal'],
    theme: 'Trying to remember something',
    env: { place: 'Home', bedtime: '23:30', wokeInNight: false, substances: ['Screen right before bed'], notes: '' },
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
    const { at: dreamedAt, v = 2, ...rest } = dream;
    // A v1 entry only ever carried a title and a body; anything richer would
    // not be a real one, and this seed exists partly to prove they still open.
    const payload = v === 1 ? { v: 1, title: rest.title, body: rest.body } : { v: 2, ...rest };
    const blob = await encryptEntry(ada.vaultKey, id, payload);
    const res = await call('POST', '/api/entries', { id, ...blob, dreamedAt });
    if (res.status !== 200) throw new Error('seed failed: ' + JSON.stringify(res.json));
  }

  console.log(`reset and seeded ${DREAMS.length} dreams for ada`);
})();
