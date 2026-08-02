/**
 * Functional checks driven through the real UI: encrypted autosave, changing a
 * passphrase (which re-encrypts everything), and writing with no signal.
 *
 *   npm run dev            (in one terminal)
 *   npm run seed && npm run test:flows
 */

import { chromium, devices } from 'playwright';
import { BASE, check, report, goToStep, keepDream } from './vault.mjs';

const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';

const titles = (page) =>
  page.$$eval('.entry__title', (ns) => ns.map((n) => n.textContent.trim()));

(async () => {
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  const ctx = await browser.newContext({ ...devices['iPhone 13 Pro'], deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.fill('#f-username', 'ada');
  await page.fill('#f-passphrase', 'correct-horse-battery');
  await page.click('#lock-submit');
  await page.waitForSelector('#screen-journal.is-active', { timeout: 30000 });
  await page.waitForTimeout(1200);

  const before = await titles(page);
  check('journal decrypts on sign-in', before.length > 0, `(${before.length} entries)`);

  console.log('\n— writing a new dream —');
  await page.click('#record');
  await goToStep(page, 'story');
  await page.fill('#compose-body', 'A corridor of doors that all opened onto the same beach.');
  await page.waitForTimeout(2600);
  const status = await page.textContent('#compose-status');
  check('autosaves without pressing Keep', /Uložené/.test(status), `(status: "${status}")`);
  await keepDream(page);
  await page.waitForTimeout(900);
  const afterWrite = await titles(page);
  check('new dream appears in the timeline',
    afterWrite.some((t) => t.includes('corridor of doors')));

  console.log('\n— changing the passphrase —');
  await page.click('#open-settings');
  await page.waitForTimeout(500);
  await page.click('#set-passphrase');
  await page.waitForTimeout(400);
  await page.fill('#pp-current', 'correct-horse-battery');
  await page.fill('#pp-next', 'a-much-longer-new-passphrase');
  await page.fill('#pp-again', 'a-much-longer-new-passphrase');
  await page.click('#modal-actions .btn--primary');
  await page.waitForFunction(
    () => !document.querySelector('#modal').classList.contains('is-open'),
    null,
    { timeout: 60000 },
  );
  await page.waitForTimeout(800);

  await page.click('#settings-back');
  await page.waitForTimeout(800);
  const afterRekey = await titles(page);
  check('every entry still readable after rekey',
    afterRekey.length === afterWrite.length &&
      afterRekey.every((t, i) => t === afterWrite[i]),
    `(${afterRekey.length} vs ${afterWrite.length})`);
  check('no undecryptable entries after rekey',
    (await page.$$('.entry--broken')).length === 0);

  console.log('\n— old passphrase must stop working —');
  await page.click('#open-settings');
  await page.waitForTimeout(400);
  page.once('dialog', (d) => d.accept());
  await page.click('#set-signout');
  await page.waitForTimeout(300);
  await page.click('#modal-actions .btn--primary');
  await page.waitForSelector('#screen-lock.is-active', { timeout: 15000 });

  await page.fill('#f-username', 'ada');
  await page.fill('#f-passphrase', 'correct-horse-battery');
  await page.click('#lock-submit');
  await page.waitForTimeout(3000);
  const err = await page.textContent('#lock-error');
  check('old passphrase is rejected', /Nesprávne/i.test(err), `(saw: "${err}")`);

  console.log('\n— new passphrase works —');
  await page.fill('#f-passphrase', 'a-much-longer-new-passphrase');
  await page.click('#lock-submit');
  await page.waitForSelector('#screen-journal.is-active', { timeout: 30000 });
  await page.waitForTimeout(1500);
  const afterRelogin = await titles(page);
  check('entries readable with the new passphrase',
    afterRelogin.length === afterRekey.length, `(${afterRelogin.length} vs ${afterRekey.length})`);

  console.log('\n— offline capture —');
  await ctx.setOffline(true);
  await page.click('#record');
  await goToStep(page, 'story');
  await page.fill('#compose-body', 'Written with no signal at all.');
  await page.waitForTimeout(2600);
  await keepDream(page);
  await page.waitForTimeout(700);
  const offlineTitles = await titles(page);
  check('dream is kept while offline',
    offlineTitles.some((t) => t.includes('no signal')));
  check('pending marker shown', (await page.$$('.entry__flag')).length > 0);

  await ctx.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(2500);
  check('pending marker clears once back online',
    (await page.$$('.entry__flag')).length === 0);

  await page.waitForTimeout(1500); // let the context finish coming back online
  for (let attempt = 0; ; attempt++) {
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
      break;
    } catch (err) {
      if (attempt >= 2) throw err;
      await page.waitForTimeout(1500);
    }
  }
  await page.waitForTimeout(2500);
  const afterReload = await titles(page);
  check('offline dream survived a reload',
    afterReload.some((t) => t.includes('no signal')));
  check('session resumes without re-entering the passphrase',
    await page.$eval('#screen-journal', (n) => n.classList.contains('is-active')));

  check('no uncaught page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  process.exit(report() ? 1 : 0);
})();
