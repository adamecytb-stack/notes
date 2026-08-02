/**
 * The two moments that actually produce lucid dreams: the minutes before sleep
 * and the wake in the small hours. Plus the reality-check tally, which is the
 * habit those two depend on.
 *
 *   npm run dev
 *   npm run seed && npm run test:tonight
 */

import { chromium, devices } from 'playwright';
import { BASE, check, report } from './vault.mjs';

const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  const ctx = await browser.newContext({ ...devices['iPhone 13 Pro'], deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.fill('#f-username', 'ada');
  await page.fill('#f-passphrase', 'correct-horse-battery');
  await page.click('#lock-submit');
  await page.waitForSelector('#screen-journal.is-active', { timeout: 30000 });
  await page.waitForTimeout(1500);

  console.log('\n— the bedtime ritual —');
  await page.click('#open-tonight-journal');
  await page.waitForTimeout(600);
  check('the Tonight screen opens', await page.isVisible('#screen-tonight.is-active'));
  check('it reads as a before-sleep screen',
    (await page.textContent('#tonight-title')).includes('Pred spaním'));
  check('the wake-back-to-bed timer stays out of the way', await page.isHidden('#wbtb-panel'));

  const sign = (await page.textContent('#tonight-sign')).trim();
  check('it names a dream sign from the journal',
    sign.length > 0 && sign !== 'Zatiaľ málo snov', `(saw: "${sign}")`);

  const mantra = await page.textContent('#mantra-text');
  check('the intention is built from that sign',
    /uvedomím si, že snívam/.test(mantra) &&
      mantra.toLowerCase().includes(sign.slice(0, 12).toLowerCase()),
    `(saw: "${mantra}")`);

  console.log('\n— saying it —');
  check('no pips lit to start', (await page.$$('#mantra-pips .pip.is-lit')).length === 0);
  for (let i = 0; i < 3; i++) await page.click('#mantra');
  await page.waitForTimeout(200);
  check('each tap lights one', (await page.$$('#mantra-pips .pip.is-lit')).length === 3);
  check('it counts out loud', /3 z 8/.test(await page.textContent('#mantra-count')));

  for (let i = 0; i < 6; i++) await page.click('#mantra');
  await page.waitForTimeout(200);
  check('it caps rather than running away',
    (await page.$$('#mantra-pips .pip.is-lit')).length === 8);
  check('and says when that is enough', /stačí/i.test(await page.textContent('#mantra-count')));

  console.log('\n— a dream to go back into —');
  check('one is offered', await page.isVisible('#reenter'));
  check('it prefers a lucid one', (await page.$$('#reenter .reenter__flag')).length === 1);

  await page.click('#tonight-done');
  await page.waitForTimeout(500);
  check('Good night returns to the journal', await page.isVisible('#screen-journal.is-active'));

  console.log('\n— woken for wake-back-to-bed —');
  await page.goto(`${BASE}/?wbtb=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2600);
  check('the alarm lands on the Tonight screen',
    await page.isVisible('#screen-tonight.is-active'));
  check('in wake-back-to-bed mode',
    (await page.textContent('#tonight-title')).includes('Prebudenie a späť do postele'));
  check('the timer is showing', await page.isVisible('#wbtb-panel'));

  const first = (await page.textContent('#wbtb-clock')).trim();
  check('it starts at twenty minutes', /^(20:00|19:5\d)$/.test(first), `(saw "${first}")`);
  await page.waitForTimeout(2200);
  const later = (await page.textContent('#wbtb-clock')).trim();
  check('and it counts down', later !== first, `(${first} → ${later})`);

  await page.click('#wbtb-go');
  await page.waitForTimeout(500);
  check('"going back in" returns to the journal',
    await page.isVisible('#screen-journal.is-active'));

  console.log('\n— reality checks that count —');
  await page.click('#open-patterns');
  await page.waitForTimeout(700);
  check('nothing to show before any are done', await page.isHidden('#checks-group'));
  await page.click('#patterns-back');
  await page.waitForTimeout(500);

  await page.click('#do-check');
  await page.waitForTimeout(400);

  /*
   * A check is only worth counting if it was a real one. Two taps seconds
   * apart are one moment of curiosity, so the second is refused rather than
   * quietly inflating the number that sits next to the lucid rate.
   */
  console.log('\n— and only one a minute —');
  await page.click('#do-check');
  await page.waitForTimeout(400);
  check('the second tap says how long to wait',
    /Ďalší test reality o \d+ s/.test(await page.textContent('#toast')),
    `(saw: "${await page.textContent('#toast')}")`);
  check('the button counts down instead of looking ready',
    /Ďalší o \d+ s/.test(await page.textContent('#do-check-hint')),
    `(saw: "${await page.textContent('#do-check-hint')}")`);

  await page.click('#open-patterns');
  await page.waitForTimeout(700);
  check('the tally appears once checks are done', await page.isVisible('#checks-group'));
  const note = await page.textContent('#checks-note');
  check('the refused tap was not counted', /1 za posledné dva týždne/.test(note),
    `(saw: "${note}")`);
  check('and says how many today', /Dnes 1/.test(note));

  // The gap is real time, so this proves it lifts rather than merely waiting.
  await page.click('#patterns-back');
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const p = JSON.parse(localStorage.getItem('nocturne.prefs') || '{}');
    p.lastCheckAt = Date.now() - 61_000;
    localStorage.setItem('nocturne.prefs', JSON.stringify(p));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2600);
  check('once the minute is up the button is ready again',
    /Snívam/.test(await page.textContent('#do-check-hint')),
    `(saw: "${await page.textContent('#do-check-hint')}")`);
  await page.click('#do-check');
  await page.waitForTimeout(400);
  await page.click('#open-patterns');
  await page.waitForTimeout(700);
  check('and the next check counts',
    /2 za posledné dva týždne/.test(await page.textContent('#checks-note')),
    `(saw: "${await page.textContent('#checks-note')}")`);
  check('a fortnight of bars is drawn', (await page.$$('#checks-spark .spark')).length === 14);

  console.log('\n— a tapped reality-check notification counts too —');
  await page.evaluate(() => {
    const p = JSON.parse(localStorage.getItem('nocturne.prefs') || '{}');
    p.lastCheckAt = 0;
    localStorage.setItem('nocturne.prefs', JSON.stringify(p));
  });
  await page.goto(`${BASE}/?check=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2600);
  await page.click('#open-patterns');
  await page.waitForTimeout(700);
  check('tapping the nudge logs one',
    /3 za posledné dva týždne/.test(await page.textContent('#checks-note')));

  /*
   * An installed app can be relaunched at whatever URL it was last on. If the
   * nudge link were not consumed as it is read, every cold start would log a
   * fresh check — and a tally you cannot trust is worse than no tally.
   */
  console.log('\n— and only counts once —');
  // Still inside the minute, so a relaunch cannot log another anyway — but the
  // link being consumed is what this is actually about.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.click('#open-patterns');
  await page.waitForTimeout(700);
  check('a relaunch does not log it again',
    /3 za posledné dva týždne/.test(await page.textContent('#checks-note')),
    `(saw: "${await page.textContent('#checks-note')}")`);

  check('no uncaught page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  process.exit(report() ? 1 : 0);
})();
