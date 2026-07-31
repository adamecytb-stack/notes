/**
 * The guided flow and the patterns screen, driven through the real UI.
 *
 *   npm run dev
 *   npm run seed && npm run test:lucid
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

  console.log('\n— the questions stay out of the way until there is a dream —');
  await page.click('#record');
  await page.waitForTimeout(400);
  check('reflect hidden on a blank entry', await page.isHidden('#reflect'));

  await page.fill('#compose-body', 'I was in a corridor where every door opened onto the same beach.');
  await page.waitForTimeout(300);
  check('reflect appears once something is written', await page.isVisible('#reflect'));
  check('branches stay closed until lucid is answered', await page.isHidden('#branch-tail'));

  console.log('\n— the lucid branch —');
  await page.click('#q-lucid button[data-lucid="yes"]');
  await page.waitForTimeout(300);
  check('lucid branch opens', await page.isVisible('#branch-lucid'));
  check('ordinary branch stays closed', await page.isHidden('#branch-ordinary'));
  check('shared tail opens', await page.isVisible('#branch-tail'));

  await page.click('#q-trigger button:has-text("Something did not make logical sense")');
  await page.fill('#q-prior', 'Trying to read a sign that kept changing');
  await page.fill('#q-actions', 'Looked at my hands, then flew straight up');
  await page.click('#q-excitement button:nth-child(5)');
  await page.click('#q-duration button:has-text("A few minutes")');
  await page.click('#q-ending button:has-text("I woke straight up")');
  await page.click('#q-vividness button:nth-child(4)');
  await page.waitForTimeout(300);

  const tipTitle = await page.textContent('#tip-title');
  check('tip responds to how the dream ended', /rub your hands|stay still/i.test(tipTitle),
    `(saw: "${tipTitle}")`);

  console.log('\n— conditions —');
  await page.click('.fold__head');
  await page.waitForTimeout(300);
  await page.click('#q-place button:has-text("A friend\'s")');
  await page.click('#q-woke');
  await page.click('#q-substances button:has-text("Caffeine")');
  await page.waitForTimeout(2600); // let the encrypted autosave land

  await page.click('#compose-save');
  await page.waitForTimeout(1200);

  console.log('\n— it survives the round trip —');
  check('lucid badge shows in the journal', (await page.$$('.entry__lucid')).length > 0);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.click('.entry--lucid');
  await page.waitForTimeout(700);

  check('lucid answer reloaded',
    (await page.getAttribute('#q-lucid button[data-lucid="yes"]', 'aria-pressed')) === 'true');
  check('trigger reloaded',
    (await page.getAttribute('#q-trigger button:has-text("Something did not make logical sense")', 'aria-pressed')) === 'true');
  check('free text reloaded', (await page.inputValue('#q-actions')).includes('flew straight up'));
  check('excitement reloaded',
    (await page.getAttribute('#q-excitement button:nth-child(5)', 'aria-pressed')) === 'true');
  check('conditions reloaded',
    (await page.getAttribute('#q-woke', 'aria-pressed')) === 'true');
  await page.click('#compose-cancel');
  await page.waitForTimeout(600);

  console.log('\n— patterns —');
  await page.click('#open-patterns');
  await page.waitForTimeout(900);
  check('streak counted', Number(await page.textContent('#streak-n')) >= 1,
    `(showed ${await page.textContent('#streak-n')})`);
  check('lucid tallied', Number(await page.textContent('#stat-lucid')) >= 1);
  check('calendar drawn', (await page.$$('.cal__cell')).length >= 42);
  check('a lucid night is marked', (await page.$$('.cal__cell.is-lucid')).length >= 1);

  console.log('\n— the ordinary branch —');
  await page.click('#patterns-back');
  await page.waitForTimeout(600);
  await page.click('#record');
  await page.fill('#compose-body', 'A train platform that was also my old kitchen.');
  await page.waitForTimeout(300);
  await page.click('#q-lucid button[data-lucid="no"]');
  await page.waitForTimeout(300);
  check('ordinary branch opens', await page.isVisible('#branch-ordinary'));
  check('lucid branch stays closed', await page.isHidden('#branch-lucid'));

  await page.click('#q-signs button:has-text("A place that was two places at once")');
  await page.waitForTimeout(2600);
  await page.click('#compose-save');
  await page.waitForTimeout(1000);

  await page.click('#open-patterns');
  await page.waitForTimeout(900);
  check('dream signs surface once tagged', (await page.$$('#signs .bar')).length >= 1);

  check('no uncaught page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  process.exit(report() ? 1 : 0);
})();
