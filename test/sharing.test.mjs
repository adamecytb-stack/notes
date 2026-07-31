/**
 * Sharing between the two accounts.
 *
 * The claim under test is that a dream can travel from one person to the other
 * while the server holds only bytes it cannot open. Both halves of the
 * conversation are simulated here, and the database is dumped to check.
 *
 *   npm run dev
 *   npm run test:sharing
 */

import { execSync } from 'node:child_process';
import {
  SETUP_CODE, deriveIdentity, encryptEntry, randomHex, makeClient, check, report,
  generateShareKeys, exportPublicKey, importPublicKey, wrapPrivateKey, unwrapPrivateKey,
  sealShare, openShare,
} from './vault.mjs';

const DREAM = {
  v: 2,
  title: 'The lighthouse that walked',
  body: 'It came down off the rocks and walked into the town. Nobody ran.',
  lucid: true,
  trigger: 'Something did not make logical sense',
  actions: 'Flew alongside it',
  signs: ['Something impossible felt normal'],
};

/** Signs a user in and sets up their sharing keys, the way the app does. */
async function setUpUser(username, passphrase) {
  const client = makeClient();
  const kdfSalt = randomHex(16);
  const id = await deriveIdentity(passphrase, kdfSalt);
  const reg = await client.call('POST', '/api/auth/register', {
    username, authProof: id.authProof, kdfSalt, setupCode: SETUP_CODE,
  });
  if (reg.status !== 200) throw new Error(`register ${username}: ${JSON.stringify(reg.json)}`);

  const pair = await generateShareKeys();
  const wrapped = await wrapPrivateKey(id.vaultKey, pair.privateKey);
  const pub = await exportPublicKey(pair.publicKey);
  const res = await client.call('POST', '/api/keys', {
    publicKey: pub, wrappedPrivate: wrapped.wrapped, wrappedIv: wrapped.iv,
  });
  if (res.status !== 200) throw new Error(`keys ${username}: ${JSON.stringify(res.json)}`);

  return { client, username, vaultKey: id.vaultKey, pair, publicKey: pub, wrapped };
}

(async () => {
  execSync(
    `npx wrangler d1 execute dreams --local --command "DELETE FROM shares; DELETE FROM entries; DELETE FROM sessions; DELETE FROM users; DELETE FROM login_attempts; DELETE FROM ai_usage; DELETE FROM push_subscriptions;"`,
    { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'ignore'] },
  );

  console.log('\n— both people get keys —');
  const ada = await setUpUser('ada', 'correct-horse-battery');
  const grace = await setUpUser('grace', 'a-second-persons-passphrase');
  check('two accounts with sharing keys', !!ada.publicKey && !!grace.publicKey);

  let r = await ada.client.call('GET', '/api/keys');
  check('ada sees grace as her peer', r.json.peer?.username === 'grace');
  check('ada gets grace\'s public key', typeof r.json.peer?.publicKey === 'string');

  console.log('\n— the private key survives a new device —');
  const restored = await unwrapPrivateKey(ada.vaultKey, r.json.wrappedPrivate, r.json.wrappedIv);
  check('wrapped private key unwraps with the vault key', !!restored);

  const wrongVault = await deriveIdentity('not-her-passphrase', 'somesalt');
  try {
    await unwrapPrivateKey(wrongVault.vaultKey, r.json.wrappedPrivate, r.json.wrappedIv);
    check('a wrong passphrase cannot unwrap it', false, '(it unwrapped!)');
  } catch {
    check('a wrong passphrase cannot unwrap it', true);
  }

  console.log('\n— ada shares a lucid dream —');
  const entryId = crypto.randomUUID();
  const own = await encryptEntry(ada.vaultKey, entryId, DREAM);
  r = await ada.client.call('POST', '/api/entries', {
    id: entryId, ...own, dreamedAt: Date.now(),
  });
  check('entry created', r.status === 200, JSON.stringify(r.json));

  const gracePub = await importPublicKey(r.json.publicKey || (await ada.client.call('GET', '/api/keys')).json.peer.publicKey);
  const sealed = await sealShare(ada.pair.privateKey, gracePub, entryId, DREAM);
  r = await ada.client.call('PUT', `/api/shares/${entryId}`, { ...sealed, dreamedAt: Date.now() });
  check('share accepted', r.status === 200 && r.json.sharedWith === 'grace', JSON.stringify(r.json));

  console.log('\n— grace can read it, the server cannot —');
  r = await grace.client.call('GET', '/api/shares');
  const row = r.json.inbox?.[0];
  check('it arrives in her inbox', !!row && row.from_username === 'ada');

  const wire = JSON.stringify(r.json);
  check('the API response carries no plaintext',
    !wire.includes('lighthouse') && !wire.includes('Nobody ran'));

  const adaPub = await importPublicKey(r.json.peer.publicKey);
  const opened = await openShare(grace.pair.privateKey, adaPub, row.entry_id, row);
  check('grace decrypts it to the original',
    opened.title === DREAM.title && opened.body === DREAM.body, JSON.stringify(opened).slice(0, 90));
  check('the lucid detail comes through too', opened.trigger === DREAM.trigger);

  const dump = execSync(
    `npx wrangler d1 execute dreams --local --command "SELECT * FROM shares" --json`,
    { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  check('the stored share is unreadable',
    !dump.includes('lighthouse') && !dump.includes('Nobody ran'));

  console.log('\n— only the two of them —');
  const stranger = await generateShareKeys();
  try {
    await openShare(stranger.privateKey, adaPub, row.entry_id, row);
    check('a third keypair cannot open it', false, '(it opened!)');
  } catch {
    check('a third keypair cannot open it', true);
  }
  try {
    await openShare(grace.pair.privateKey, adaPub, crypto.randomUUID(), row);
    check('the share is bound to its entry id', false, '(opened under another id!)');
  } catch {
    check('the share is bound to its entry id', true);
  }

  console.log('\n— ownership —');
  r = await grace.client.call('DELETE', `/api/shares/${entryId}`);
  const stillThere = await grace.client.call('GET', '/api/shares');
  check('the recipient cannot delete the share', (stillThere.json.inbox || []).length === 1);

  r = await ada.client.call('GET', '/api/shares');
  check('ada sees what she has shared out', (r.json.sharedByMe || []).includes(entryId));

  r = await ada.client.call('PUT', `/api/shares/${crypto.randomUUID()}`, {
    ...sealed, dreamedAt: Date.now(),
  });
  check('cannot share an entry you do not own', r.status === 404, JSON.stringify(r.json));

  console.log('\n— unsharing —');
  r = await ada.client.call('DELETE', `/api/shares/${entryId}`);
  check('the owner can unshare', r.status === 200);
  r = await grace.client.call('GET', '/api/shares');
  check('it disappears from her inbox', (r.json.inbox || []).length === 0);

  console.log('\n— keys are not silently replaceable —');
  const newPair = await generateShareKeys();
  r = await ada.client.call('POST', '/api/keys', {
    publicKey: await exportPublicKey(newPair.publicKey),
    wrappedPrivate: ada.wrapped.wrapped,
    wrappedIv: ada.wrapped.iv,
  });
  check('republishing a different public key is refused', r.status === 409, JSON.stringify(r.json));

  process.exit(report() ? 1 : 0);
})();
