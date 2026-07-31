/**
 * Stamps a version into public/sw.js just before deploying.
 *
 *   node scripts/stamp-version.mjs [version]
 *
 * A browser decides whether a service worker has changed by byte-comparing the
 * file. Without this, editing app.js and nothing else would leave sw.js
 * identical, the phone would never notice, and the installed app would sit on
 * old code indefinitely.
 *
 * Defaults to the current commit SHA. The repo keeps 'dev' — only the deployed
 * copy is stamped — so this never produces a dirty working tree.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const target = new URL('../public/sw.js', import.meta.url);

function currentVersion() {
  if (process.argv[2]) return process.argv[2];
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return `t${Date.now()}`;
  }
}

const version = currentVersion();
const source = readFileSync(target, 'utf8');
const stamped = source.replace(/^const VERSION = '[^']*';$/m, `const VERSION = '${version}';`);

if (stamped === source) {
  console.error('Could not find the VERSION line in public/sw.js — refusing to deploy stale.');
  process.exit(1);
}

writeFileSync(target, stamped);
console.log(`stamped service worker version: ${version}`);
