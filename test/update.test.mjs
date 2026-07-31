/**
 * Service worker updates.
 *
 * The question this answers is the one you cannot answer by reading the code:
 * if the app is installed and running, and a new version ships, does the phone
 * actually get it? So this loads the app, changes a shell file the way a deploy
 * would, and checks what the browser does next.
 *
 *   npm run dev
 *   npm run test:update
 */

import { chromium, devices } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { BASE, check, report } from './vault.mjs';

const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const SW = new URL('../public/sw.js', import.meta.url);
const CSS = new URL('../public/css/app.css', import.meta.url);

const swBefore = readFileSync(SW, 'utf8');
const cssBefore = readFileSync(CSS, 'utf8');
const restore = () => {
  writeFileSync(SW, swBefore);
  writeFileSync(CSS, cssBefore);
};

/** Stands in for a deploy: change an asset, then stamp a new version. */
function shipNewVersion(tag) {
  writeFileSync(CSS, `${cssBefore}\n/* shipped ${tag} */\n`);
  execSync(`node scripts/stamp-version.mjs ${tag}`, { cwd: process.cwd(), stdio: 'ignore' });
}

const swVersion = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const chan = new MessageChannel();
        navigator.serviceWorker.controller?.postMessage('VERSION');
        navigator.serviceWorker.addEventListener('message', (e) => {
          if (e.data?.type === 'VERSION') resolve(e.data.version);
        });
        setTimeout(() => resolve(null), 3000);
        chan.port1.close();
      }),
  );

(async () => {
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  const ctx = await browser.newContext({ ...devices['iPhone 13 Pro'], deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  try {
    execSync('node scripts/stamp-version.mjs one', { cwd: process.cwd(), stdio: 'ignore' });

    console.log('\n— first install —');
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20000 });
    check('a worker takes control on first load', await swVersion(page) === 'one');

    const cachedFirst = await page.evaluate(async () => {
      const names = await caches.keys();
      return names;
    });
    check('the cache is keyed by version', cachedFirst.includes('nocturne-one'),
      JSON.stringify(cachedFirst));

    console.log('\n— a new version ships while the app is open —');
    // Record the detection before triggering it: with nothing unsaved the app
    // applies the update immediately, so the "waiting" state is gone in
    // milliseconds and cannot be observed by polling for it afterwards.
    // sessionStorage rather than a window property: applying the update
    // reloads the page, which is correct behaviour but wipes anything held in
    // memory — including the flag recording that it happened.
    await page.evaluate(async () => {
      sessionStorage.removeItem('updateFound');
      const reg = await navigator.serviceWorker.getRegistration();
      reg.addEventListener('updatefound', () => {
        sessionStorage.setItem('updateFound', '1');
      });
    });

    shipNewVersion('two');
    // What the app does on returning to the foreground.
    await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      await reg.update();
    });
    await page.waitForTimeout(2500);

    check('the phone notices there is a new version',
      await page.evaluate(() => sessionStorage.getItem('updateFound') === '1'));

    console.log('\n— nothing unsaved, so it swaps by itself —');
    await page.waitForFunction(
      () => navigator.serviceWorker.controller && !document.querySelector('#sheet.is-open'),
      null,
      { timeout: 20000 },
    );
    await page.waitForTimeout(3500);
    const after = await swVersion(page);
    check('the running app is now on the new version', after === 'two', `(saw ${after})`);

    const names = await page.evaluate(() => caches.keys());
    check('the old version cache is deleted', !names.includes('nocturne-one'),
      JSON.stringify(names));
    check('only one version is cached', names.filter((n) => n.startsWith('nocturne-')).length === 1,
      JSON.stringify(names));

    console.log('\n— the shell is never mixed across versions —');
    const stamped = await page.evaluate(async () => {
      const cache = await caches.open('nocturne-two');
      const res = await cache.match('/css/app.css');
      return res ? (await res.text()).includes('shipped two') : null;
    });
    check('the cached CSS is the new one', stamped === true, `(saw ${stamped})`);

    console.log('\n— it still works offline afterwards —');
    await ctx.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    check('the app still opens with no network',
      await page.title() === 'Nocturne', `(title "${await page.title()}")`);
    await ctx.setOffline(false);

    check('no uncaught page errors', errors.length === 0, errors.join(' | '));
  } finally {
    restore();
    await browser.close();
  }

  process.exit(report() ? 1 : 0);
})();
