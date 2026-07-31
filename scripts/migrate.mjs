/**
 * Applies migrations.sql one statement at a time.
 *
 *   node scripts/migrate.mjs           # local
 *   node scripts/migrate.mjs --remote  # the deployed database
 *
 * SQLite cannot express "add this column only if it is missing", so each
 * statement is run on its own and a duplicate-column error is treated as
 * already-done. Anything else is a real failure and stops the run.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const remote = process.argv.includes('--remote');
const statements = readFileSync(new URL('../migrations.sql', import.meta.url), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('--'));

let applied = 0;
let already = 0;

for (const statement of statements) {
  try {
    execFileSync(
      'npx',
      ['wrangler', 'd1', 'execute', 'dreams', remote ? '--remote' : '--local', '--command', statement],
      { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' },
    );
    applied += 1;
  } catch (err) {
    const message = `${err.stderr || ''}${err.stdout || ''}`;
    if (/duplicate column name/i.test(message)) {
      already += 1;
      continue;
    }
    console.error(`\nFailed: ${statement}\n${message}`);
    process.exit(1);
  }
}

console.log(`migrations: ${applied} applied, ${already} already present`);
