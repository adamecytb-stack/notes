/**
 * Captures the app on an iPhone viewport, for looking at the design without a
 * phone in hand.
 *
 *   npm run dev && npm run seed && npm run shots
 *
 * Writes to ./screenshots (override with SHOTS_DIR).
 */

import { chromium, devices } from 'playwright';
import { mkdirSync } from 'node:fs';
import { BASE, goToStep } from './vault.mjs';

const OUT = process.env.SHOTS_DIR || 'screenshots';
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';

const iphone = {
  ...devices['iPhone 13 Pro'],
  deviceScaleFactor: 2,
};

const errors = [];

(async () => {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  const ctx = await browser.newContext(iphone);
  const page = await ctx.newPage();

  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => errors.push('reqfail: ' + r.url() + ' ' + r.failure()?.errorText));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1400);
  await page.screenshot({ path: `${OUT}/1-lock.png` });

  // sign in
  await page.fill('#f-username', 'ada');
  await page.fill('#f-passphrase', 'correct-horse-battery');
  await page.click('#lock-submit');
  await page.waitForSelector('#screen-journal.is-active', { timeout: 30000 });
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${OUT}/2-journal.png` });
  await page.screenshot({ path: `${OUT}/2-journal-full.png`, fullPage: true });

  // compose, step by step
  await page.click('#record');
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/3a-lucid.png` });

  await page.click('#q-lucid button[data-lucid="yes"]');
  await page.waitForTimeout(600);
  await page.fill('#compose-title', 'The lighthouse that walked');
  await page.screenshot({ path: `${OUT}/3b-name.png` });

  await goToStep(page, 'story');
  await page.fill('#compose-body',
    'It came down off the rocks and walked into the town, very slowly, and nobody ran. The light kept turning the whole time and every time it passed over me I remembered something I had forgotten.');
  await page.waitForTimeout(2600); // let the encrypted autosave land
  await page.screenshot({ path: `${OUT}/3c-story.png` });

  await goToStep(page, 'feel');
  await page.click('#q-mood .face:nth-child(4)');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/3d-feel.png` });

  await goToStep(page, 'detail');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/3e-detail.png` });

  await goToStep(page, 'context');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/3f-context.png` });

  await page.click('#compose-cancel');
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/4-journal-after.png` });

  // patterns, with the sky
  await page.click('#open-patterns');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/4b-patterns.png` });
  await page.screenshot({ path: `${OUT}/4b-patterns-full.png`, fullPage: true });
  await page.click('#patterns-back');
  await page.waitForTimeout(700);

  // the bedtime ritual
  await page.click('#open-tonight-journal');
  await page.waitForTimeout(900);
  for (let i = 0; i < 5; i++) await page.click('#mantra');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/4c-tonight.png` });
  await page.screenshot({ path: `${OUT}/4d-tonight-full.png`, fullPage: true });

  // woken for wake-back-to-bed
  await page.goto(`${BASE}/?wbtb=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2800);
  await page.screenshot({ path: `${OUT}/4e-wbtb.png` });
  await page.click('#tonight-back'); // back to the journal, where Settings lives
  await page.waitForTimeout(700);

  // settings
  await page.click('#open-settings');
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/5-settings.png` });
  await page.screenshot({ path: `${OUT}/5-settings-full.png`, fullPage: true });

  // daybreak
  await page.click('#theme-seg button[data-theme-value="daybreak"]');
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/6-settings-daybreak.png` });
  await page.click('#settings-back');
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/7-journal-daybreak.png` });

  // back to nocturne for the modal shot
  await page.click('#open-settings');
  await page.waitForTimeout(500);
  await page.click('#theme-seg button[data-theme-value="nocturne"]');
  await page.waitForTimeout(400);
  await page.click('#set-passphrase');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/8-modal.png` });

  console.log(errors.length ? 'PAGE ERRORS:\n' + errors.join('\n') : 'no page errors');
  await browser.close();
})();
