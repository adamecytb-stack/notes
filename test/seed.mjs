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
    title: 'Pád cez knižnicu',
    body: 'Klesal som popri policiach, ktoré nikdy neskončili, pomaly, akoby bol vzduch hustejší, než má byť. V každej knihe, ktorú som vytiahol, bolo moje vlastné písmo, ale v jazyku, ktorý v bdení neviem prečítať.',
  },
  {
    at: at(0, 5, 2),
    title: '',
    body: 'Niečo o nástupišti. Bola tam moja mama, oveľa mladšia. Stále pozerala na hodinky bez ručičiek a hovorila mi, že času je ešte dosť.',
    mood: 3,
    vividness: 3,
    signs: ['Text alebo čísla, ktoré neostávali rovnaké', 'Niekto, kto tam nemal čo robiť'],
    env: { place: 'Doma', bedtime: '23:20', wokeInNight: false, substances: [], notes: '' },
  },
  {
    at: at(1, 4, 41),
    title: 'Dom s jednou miestnosťou navyše',
    body: 'Náš starý dom, len v chodbe boli dvere, ktoré tam nikdy neboli. Za nimi miestnosť plná sivého denného svetla a nábytok pod plachtami. V sne som vedel, že tam boli vždy a ja som len nikdy nespočítal dvere.',
    mood: 2,
    vividness: 4,
    signs: ['Dom s miestnosťou, ktorá tam nemá byť', 'Niečo nemožné mi prišlo úplne normálne'],
    theme: 'Známe miesto, ktoré narástlo',
    env: { place: 'Doma', bedtime: '23:00', wokeInNight: true, substances: [], notes: '' },
  },
  {
    at: at(2, 2, 8),
    title: 'Plávanie po ulici',
    body: 'Ulica vonku bola voda, ale nikto si to zrejme nevšímal. Doplával som do obchodu na rohu, kúpil chlieb a ostal suchý. V polovici cesty späť som zastal a pomyslel si: chlieb suchý neostane. A vtedy som to vedel.',
    lucid: true,
    mood: 5,
    vividness: 5,
    signs: ['Voda — plávanie, záplava, topenie', 'Niečo nemožné mi prišlo úplne normálne'],
    trigger: 'Niečo nedávalo logický zmysel',
    priorActivity: 'Plávanie späť z obchodu s chlebom v ruke',
    actions: 'Pozrel som si na ruky, pošúchal ich a potom som vyletel nad strechy',
    excitement: 4,
    duration: 'Pár minút',
    ending: 'Vyblednul a stratil som uvedomenie',
    env: {
      place: 'U kamaráta',
      bedtime: '00:10',
      wokeInNight: true,
      substances: ['Kofeín'],
      notes: 'Prespal som tam, spal zle, zobudil sa okolo štvrtej',
    },
  },
  {
    at: at(4, 6, 20),
    title: 'Zase zuby',
    body: 'Ten so zubami. Stále mám ten so zubami. Tentoraz vypadli čisto, ako korálky na šnúrke, a bol som skôr v rozpakoch než vydesený.',
    mood: 2,
    vividness: 3,
    signs: ['Zuby, vlasy alebo moje telo sa menili', 'Niečo nemožné mi prišlo úplne normálne'],
    env: { place: 'Doma', bedtime: '23:45', wokeInNight: false, substances: ['Neskoré jedlo'], notes: '' },
  },
  {
    at: at(6, 5, 30),
    title: 'Chodba s hodinami',
    body: 'Chodba lemovaná hodinami, žiadne sa nezhodovali. Pozrel som na jedny, pozrel inam, pozrel späť a z desiatich po bolo takmer o polnoci. To bol ten moment — pamätám si, že som to naozaj povedal nahlas, toto je sen.',
    lucid: true,
    mood: 4,
    vividness: 5,
    signs: ['Text alebo čísla, ktoré neostávali rovnaké', 'Niečo nemožné mi prišlo úplne normálne'],
    trigger: 'Niečo nedávalo logický zmysel',
    priorActivity: 'Kráčal som chodbou a hľadal východ',
    actions: 'Povedal som to nahlas, dotkol sa steny, aby to držalo, a potom naschvál otvoril dvere',
    excitement: 3,
    duration: 'Menej ako minútu',
    ending: 'Hneď som sa zobudil',
    env: {
      place: 'Doma',
      bedtime: '22:50',
      wokeInNight: true,
      substances: [],
      notes: 'Zobudil som sa o štvrtej a po dvadsiatich minútach som si ľahol späť',
    },
  },
  {
    at: at(9, 3, 55),
    title: 'Mesto, ktoré bolo aj klavírom',
    body: 'Prechádzal som mestom, kde boli ulice čierne a biele a pri každom kroku sa stláčali. Každá ulica jedna nota. Snažil som sa prejsť melódiu, ktorú som si spola pamätal.',
    mood: 4,
    vividness: 4,
    signs: ['Niečo nemožné mi prišlo úplne normálne'],
    theme: 'Snaha si na niečo spomenúť',
    env: { place: 'Doma', bedtime: '23:30', wokeInNight: false, substances: ['Obrazovka tesne pred spaním'], notes: '' },
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
