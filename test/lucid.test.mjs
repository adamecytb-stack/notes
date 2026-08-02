/**
 * The guided flow and the patterns screen, driven through the real UI.
 *
 *   npm run dev
 *   npm run seed && npm run test:lucid
 */

import { chromium, devices } from 'playwright';
import { BASE, check, report, goToStep, keepDream, stepIndex } from './vault.mjs';

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

  console.log('\n— one question at a time, lucid first —');
  await page.click('#record');
  await page.waitForTimeout(400);
  check('a new dream opens on the lucid question', (await stepIndex(page)) === 0);
  check('the question is asked before anything is typed',
    await page.isVisible('#q-lucid'));
  check('nothing else is on screen yet', await page.isHidden('#compose-body'));
  check('there is nowhere to go back to', await page.isHidden('#compose-back'));

  console.log('\n— answering moves you on by itself —');
  await page.click('#q-lucid button[data-lucid="yes"]');
  await page.waitForTimeout(400);
  check('answering advances without a second tap', (await stepIndex(page)) === 1);
  check('the name is asked second', await page.isVisible('#compose-title'));
  check('back is offered now', await page.isVisible('#compose-back'));

  await page.fill('#compose-title', 'The corridor of doors');
  await page.click('#compose-next');
  await page.waitForTimeout(300);
  check('what happened is asked third', await page.isVisible('#compose-body'));
  await page.fill('#compose-body', 'I was in a corridor where every door opened onto the same beach.');

  /*
   * A long dream has to scroll the page, not scroll inside a small box. The
   * bubble grows to fit instead of trapping the text, and the step is centred
   * with auto margins rather than justify-content — centred flex content that
   * overflows a scroll container cannot be scrolled back to.
   */
  console.log('\n— a long dream still scrolls —');
  const LONG = Array.from({ length: 12 }, (_, i) =>
    `Paragraph ${i + 1}. Every door in the corridor opened onto the same stretch of beach, ` +
    'and each time I went through one the tide was a little further out than before.',
  ).join('\n\n');
  await page.fill('#compose-body', LONG);
  await page.waitForTimeout(400);
  const scrolling = await page.evaluate(() => {
    const box = document.querySelector('.compose');
    const field = document.querySelector('#compose-body');
    const at = box.scrollTop;
    box.scrollTop = 99999;
    const max = box.scrollTop;
    box.scrollTop = at;
    return {
      trapped: field.scrollHeight > field.clientHeight + 2,
      pageScrolls: max > 0,
    };
  });
  check('the bubble grows instead of trapping the text', !scrolling.trapped);
  check('and the page scrolls', scrolling.pageScrolls);
  await page.fill('#compose-body', 'I was in a corridor where every door opened onto the same beach.');
  await page.waitForTimeout(300);

  console.log('\n— the faces —');
  await page.click('#compose-next');
  await page.waitForTimeout(300);
  check('five faces to choose from', (await page.$$('#q-mood .face')).length === 5);
  await page.click('#q-mood .face:nth-child(5)');
  await page.waitForTimeout(200);
  check('picking a face names the feeling',
    (await page.textContent('#q-mood-label')).trim().length > 0,
    `(saw: "${await page.textContent('#q-mood-label')}")`);
  check('the chosen face is the pressed one',
    (await page.getAttribute('#q-mood .face:nth-child(5)', 'aria-pressed')) === 'true');

  console.log('\n— the lucid branch —');
  await page.click('#compose-next');
  await page.waitForTimeout(300);
  check('lucid branch opens', await page.isVisible('#branch-lucid'));
  check('ordinary branch stays closed', await page.isHidden('#branch-ordinary'));

  await page.click('#q-trigger button:has-text("Niečo nedávalo logický zmysel")');
  await page.fill('#q-prior', 'Trying to read a sign that kept changing');
  await page.fill('#q-actions', 'Looked at my hands, then flew straight up');
  await page.click('#q-excitement button:nth-child(5)');
  await page.click('#q-duration button:has-text("Pár minút")');
  await page.click('#q-ending button:has-text("Hneď som sa zobudil")');
  await page.click('#q-vividness button:nth-child(4)');
  await page.waitForTimeout(300);

  console.log('\n— conditions, and the tip that reads them —');
  await page.click('#compose-next');
  await page.waitForTimeout(300);
  const tipTitle = await page.textContent('#tip-title');
  check('tip responds to how the dream ended', /pošúchaj si dlane|ostaň bez pohybu/i.test(tipTitle),
    `(saw: "${tipTitle}")`);
  check('the last step offers Keep, not Next',
    (await page.textContent('#compose-next')).trim() === 'Uložiť');

  await page.click('#q-place button:has-text("U kamaráta")');
  await page.click('#q-woke');
  await page.click('#q-substances button:has-text("Kofeín")');
  await page.waitForTimeout(2600); // let the encrypted autosave land

  await page.click('#compose-next');
  await page.waitForTimeout(1200);

  console.log('\n— it survives the round trip —');
  check('lucid badge shows in the journal', (await page.$$('.entry__lucid')).length > 0);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.click('.entry--lucid');
  await page.waitForTimeout(700);

  check('reopening lands on what the dream says', (await stepIndex(page)) === 2);
  check('the story reloaded', (await page.inputValue('#compose-body')).includes('same beach'));

  await goToStep(page, 'lucid');
  check('lucid answer reloaded',
    (await page.getAttribute('#q-lucid button[data-lucid="yes"]', 'aria-pressed')) === 'true');

  await goToStep(page, 'feel');
  check('the face reloaded',
    (await page.getAttribute('#q-mood .face:nth-child(5)', 'aria-pressed')) === 'true');

  await goToStep(page, 'detail');
  check('trigger reloaded',
    (await page.getAttribute('#q-trigger button:has-text("Niečo nedávalo logický zmysel")', 'aria-pressed')) === 'true');
  check('free text reloaded', (await page.inputValue('#q-actions')).includes('flew straight up'));
  check('excitement reloaded',
    (await page.getAttribute('#q-excitement button:nth-child(5)', 'aria-pressed')) === 'true');

  await goToStep(page, 'context');
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
  check('the sky is drawn', (await page.$$('.starmap__star')).length >= 1);
  check('a lucid night burns', (await page.$$('.starmap__star.is-lucid')).length >= 1);
  check('the whole six weeks is drawn, lit or not',
    (await page.$$('.starmap__star')).length >= 42);
  check('unwritten nights stay dim rather than absent',
    (await page.$$('.starmap__star:not(.is-logged):not(.is-lucid)')).length >= 1);

  console.log('\n— the ordinary branch —');
  await page.click('#patterns-back');
  await page.waitForTimeout(600);
  await page.click('#record');
  await page.waitForTimeout(400);
  await page.click('#q-lucid button[data-lucid="no"]');
  await page.waitForTimeout(400);
  await goToStep(page, 'story');
  await page.fill('#compose-body', 'A train platform that was also my old kitchen.');
  await goToStep(page, 'detail');
  check('ordinary branch opens', await page.isVisible('#branch-ordinary'));
  check('lucid branch stays closed', await page.isHidden('#branch-lucid'));

  await page.click('#q-signs button:has-text("Miesto, ktoré bolo dvoma miestami naraz")');
  await page.waitForTimeout(2600);
  await keepDream(page);
  await page.waitForTimeout(1000);

  await page.click('#open-patterns');
  await page.waitForTimeout(900);
  check('dream signs surface once tagged', (await page.$$('#signs .bar')).length >= 1);

  check('no uncaught page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  process.exit(report() ? 1 : 0);
})();
