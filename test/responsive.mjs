/**
 * The app at four shapes: a phone, a phone on its side, a tablet, a laptop.
 *
 * Layout bugs at sizes you do not carry around are easy to ship and hard to
 * notice, so this walks the same path at each one and fails on anything it
 * cannot reach — a button under the fold on a short window, a panel centred
 * off-screen, a sheet whose Done is unclickable.
 *
 *   npm run dev
 *   npm run seed && npm run test:responsive
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { BASE, check, report } from './vault.mjs';

const OUT = process.env.SHOTS_DIR || 'screenshots/responsive';
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';

const SIZES = [
  ['phone', 390, 844],
  ['landscape', 844, 390],
  ['tablet', 834, 1112],
  ['desktop', 1440, 900],
];

/** Everything that must be reachable, whatever the window is doing. */
const inView = (page, sel) =>
  page.$eval(sel, (n) => {
    const r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight + 1;
  });

(async () => {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  const errors = [];

  for (const [name, width, height] of SIZES) {
    console.log(`\n— ${name} ${width}×${height} —`);
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));

    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1900);
    await page.screenshot({ path: `${OUT}/${name}-lock.png` });

    // The lock screen has to be usable, not merely present: on a short window
    // it has to scroll rather than hide the button under the fold.
    await page.locator('#lock-submit').scrollIntoViewIfNeeded();
    check(`${name}: the unlock button can be reached`, await inView(page, '#lock-submit'));

    await page.fill('#f-username', 'ada');
    await page.fill('#f-passphrase', 'correct-horse-battery');
    await page.click('#lock-submit');
    await page.waitForSelector('#screen-journal.is-active', { timeout: 30000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/${name}-journal.png` });
    check(`${name}: record stays on screen`, await inView(page, '#record'));

    await page.click('#record');
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${OUT}/${name}-compose.png` });
    check(`${name}: the question is on screen`, await inView(page, '#q-lucid'));
    check(`${name}: Next is on screen`, await inView(page, '#compose-next'));
    check(`${name}: Done is on screen`, await inView(page, '#compose-cancel'));

    await page.click('#compose-cancel');
    await page.waitForTimeout(500);
    await page.click('#open-settings');
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${OUT}/${name}-settings.png` });
    check(`${name}: settings scrolls to its end`, await page.isVisible('#set-storage'));

    await ctx.close();
  }

  check('no uncaught page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  process.exit(report() ? 1 : 0);
})();
