/**
 * Nocturne — app controller.
 *
 * The one rule that shapes everything here: the path from "awake, remembering"
 * to "typing" must be a single tap with no waiting. Sync, decryption and
 * network failures all happen behind that.
 */

import {
  state,
  subscribe,
  sortedEntries,
  tryResume,
  unlock,
  createAccount,
  signOut,
  lock,
  sync,
  saveEntry,
  removeEntry,
  changePassphrase,
  exportJson,
  exportText,
} from './store.js';
import { api, ApiError } from './api.js';
import { prefs, setPref, applyPrefs } from './settings.js';
import {
  $,
  el,
  icon,
  toast,
  openModal,
  closeModal,
  confirm as confirmDialog,
  download,
  nightOf,
  nightLabel,
  clockParts,
  greeting,
  fullStamp,
  toLocalInputValue,
  bytesLabel,
} from './ui.js';
import { idbGetAll } from './idb.js';
import { starfield, moonSvg, moonPhase, phaseName } from './sky.js';
import {
  emptyEntry,
  normalise,
  computeStats,
  environmentInsights,
  nightKey,
  tipFor,
  DREAM_SIGNS,
  LUCID_TRIGGERS,
  DURATIONS,
  ENDINGS,
  PLACES,
  SUBSTANCES,
} from './dream.js';
import {
  sharing,
  initSharing,
  canShare,
  isShared,
  share as shareEntry,
  unshare as unshareEntry,
  refreshInbox,
  forgetSharing,
  reseal,
} from './sharing.js';
import {
  push,
  DEFAULT_CHECKS,
  blockedReason,
  refreshPushState,
  enableReminders,
  disableReminders,
  updateSchedule,
  sendTest,
  bedtimeNudgeAt,
  suggestedWbtb,
  wbtbAt,
} from './reminders.js';
import {
  hasConsented,
  grantConsent,
  revokeConsent,
  buildPatternPrompt,
  buildRoutinePrompt,
  buildEntryPrompt,
  ask,
} from './companion.js';

const APP_VERSION = '0.3.0';

/* ------------------------------------------------------------------ views */

let currentView = 'lock';
let composing = null; // { id, dreamedAt }

const SCREENS = {
  lock: '#screen-lock',
  journal: '#screen-journal',
  patterns: '#screen-patterns',
  tonight: '#screen-tonight',
  settings: '#screen-settings',
};

/*
 * How deep each screen sits. Going deeper slides in from the right, coming
 * back slides from the left — the direction carries the sense of where you
 * are, which a plain crossfade throws away.
 */
const DEPTH = { lock: 0, journal: 1, patterns: 2, tonight: 2, settings: 2, compose: 2 };
let lastDepth = 0;

function showView(view, { push = true } = {}) {
  const base = view === 'compose' ? 'journal' : view;
  currentView = view;

  const depth = DEPTH[view] ?? 1;
  document.body.dataset.nav = depth < lastDepth ? 'back' : 'forward';
  lastDepth = depth;
  // Lets the stylesheet treat the sky differently where there is a lot of
  // text to read versus where it is the whole point of the screen.
  document.body.dataset.view = base;

  for (const [name, sel] of Object.entries(SCREENS)) {
    $(sel).classList.toggle('is-active', name === base);
  }
  $('#sheet').classList.toggle('is-open', view === 'compose');

  if (push && view !== 'lock') {
    const entry = { view };
    if (history.state?.view !== view) history.pushState(entry, '');
  }
  if (view === 'settings') refreshSettings();
  if (view === 'patterns') renderPatterns();
  if (view !== 'tonight') stopWbtbTimer();
}

window.addEventListener('popstate', (e) => {
  if (!state.ready) return showView('lock', { push: false });
  const view = e.state?.view || 'journal';
  if (currentView === 'compose' && view !== 'compose') closeCompose({ pop: false });
  else showView(view, { push: false });
});

/* ============================================================ LOCK SCREEN */

let mode = 'signin'; // | 'signup'

function setMode(next) {
  mode = next;
  const signup = mode === 'signup';
  $('#field-setup').classList.toggle('hidden', !signup);
  $('#lock-submit-label').textContent = signup ? 'Vytvoriť denník' : 'Odomknúť';
  $('#lock-switch').textContent = signup
    ? 'Už máš účet? Prihlás sa'
    : 'Prvýkrát tu? Vytvor si účet';
  $('#f-passphrase').setAttribute('autocomplete', signup ? 'new-password' : 'current-password');
  $('#lock-sub').textContent = signup
    ? 'Vyber si heslo, ktoré nezabudneš. Je to jediná vec, ktorá dokáže dešifrovať tvoje sny — ani server to nedokáže.'
    : 'Tvoje sny sa zašifrujú v tomto telefóne skôr, než ho vôbec opustia.';
  $('#lock-error').textContent = '';
}

$('#lock-switch').addEventListener('click', () => setMode(mode === 'signin' ? 'signup' : 'signin'));

$('#lock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('#f-username').value.trim();
  const passphrase = $('#f-passphrase').value;
  const setupCode = $('#f-setup').value;
  const errorNode = $('#lock-error');
  const submit = $('#lock-submit');
  const label = $('#lock-submit-label');

  errorNode.textContent = '';
  if (!username || !passphrase) {
    errorNode.textContent = 'Obe polia, prosím.';
    return;
  }
  if (mode === 'signup' && passphrase.length < 10) {
    errorNode.textContent = 'Použi aspoň 10 znakov — toto je jediný kľúč k tvojim snom.';
    return;
  }

  submit.disabled = true;
  const original = label.textContent;
  label.textContent = mode === 'signup' ? 'Vytváram…' : 'Odomykám…';
  submit.prepend(el('span', 'spinner'));

  try {
    if (mode === 'signup') await createAccount(username, passphrase, setupCode);
    else await unlock(username, passphrase);

    $('#f-passphrase').value = '';
    $('#f-setup').value = '';
    enterJournal();
  } catch (err) {
    errorNode.textContent =
      err instanceof ApiError && err.status === 0
        ? 'Bez pripojenia. Skús to, keď budeš mať signál.'
        : err.message || 'Niečo sa pokazilo.';
    // Re-trigger the shake even if the message is identical.
    errorNode.style.animation = 'none';
    void errorNode.offsetWidth;
    errorNode.style.animation = '';
  } finally {
    submit.disabled = false;
    submit.querySelector('.spinner')?.remove();
    label.textContent = original;
  }
});

function enterJournal() {
  history.replaceState({ view: 'journal' }, '');
  showView('journal', { push: false });
  renderJournal();
  // Whether the companion can run at all is a server-side fact (is a Gemini
  // key configured), so ask rather than assume.
  api
    .me()
    .then(async (me) => {
      aiAvailable = !!me.aiAvailable;
      push.available = !!me.pushAvailable;
      push.publicKey = me.vapidPublicKey;

      // Sharing needs the vault key, so it can only start once unlocked.
      if (state.vaultKey && (await initSharing(state.vaultKey))) {
        await refreshInbox().catch(() => {});
        await healSharing();
        renderJournal();
      }
    })
    .catch(() => {});
}

/**
 * Puts sharing back together after either side has had to replace its keypair.
 *
 * Both repairs are silent and automatic on purpose: the failure they undo was
 * never the user's doing, and asking someone to understand elliptic-curve key
 * rotation at 3am is not a reasonable thing to do.
 */
async function healSharing() {
  if (sharing.peerRotated) {
    const resealed = await reseal((id) => state.entries.get(id)).catch(() => 0);
    sharing.peerRotated = false;
    await refreshInbox().catch(() => {});
    if (resealed) toast(`Znovu som s ním zdieľal ${resealed} ${resealed === 1 ? 'sen' : resealed < 5 ? 'sny' : 'snov'}`);
  }
  if (sharing.repaired) {
    sharing.repaired = false;
    toast('Zdieľanie je znovu pripojené');
  }
}

/* =============================================================== JOURNAL */

/** 'mine' | 'theirs' */
let tab = 'mine';

$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (!btn) return;
  tab = btn.dataset.tab;
  for (const b of $('#tabs').children) {
    b.setAttribute('aria-pressed', String(b === btn));
  }
  renderJournal();
  if (tab === 'theirs') refreshInbox().then(renderJournal).catch(() => {});
});

function renderJournal() {
  $('#greeting').textContent = greeting();

  // The second tab only makes sense once there is somebody on the other end.
  const hasPeer = !!sharing.peerName;
  $('#tabs').classList.toggle('hidden', !hasPeer);
  if (hasPeer) $('#tab-theirs').textContent = sharing.peerName;
  if (!hasPeer && tab !== 'mine') tab = 'mine';

  const entries = tab === 'theirs' ? sharing.inbox : sortedEntries();
  const count = entries.length;
  $('#entry-count').textContent =
    tab === 'theirs'
      ? count === 0
        ? ''
        : `${count} ${count === 1 ? 'zdieľaný' : count < 5 ? 'zdieľané' : 'zdieľaných'} s tebou`
      : count === 0
        ? ''
        : count === 1
          ? '1 uložený sen'
          : `${count} ${count < 5 ? 'uložené sny' : 'uložených snov'}`;

  const offline = state.lastError === 'offline' || !navigator.onLine;
  $('#offline-banner').classList.toggle('hidden', !offline);

  const timeline = $('#timeline');
  timeline.replaceChildren();

  if (!count) {
    timeline.appendChild(tab === 'theirs' ? renderEmptyShared() : renderEmpty());
    return;
  }

  let lastNight = null;
  let index = 0;

  for (const entry of entries) {
    const night = nightOf(entry.dreamedAt);
    if (night !== lastNight) {
      lastNight = night;
      const mark = el('div', 'daymark');
      mark.appendChild(el('span', 't-meta', nightLabel(night)));
      timeline.appendChild(mark);
    }
    timeline.appendChild(renderEntry(entry, index++));
  }
}

function renderEntry(entry, index) {
  const node = el('button', 'entry');
  node.type = 'button';
  // Set via CSSOM rather than a style attribute so the strict CSP holds.
  node.style.setProperty('--i', String(Math.min(index, 12)));
  if (entry.undecryptable) node.classList.add('entry--broken');

  const when = el('div', 'entry__when');
  const { hour, minute } = clockParts(entry.dreamedAt);
  const time = el('span', 'entry__time');
  time.append(hour, el('i', null, '·'), minute);
  when.append(time);

  const { heading, excerpt } = summarise(entry);

  if (entry.lucid) node.classList.add('entry--lucid');

  const body = el('div', 'entry__body');
  const title = el('h3', 'entry__title');
  if (entry.pending) title.appendChild(el('span', 'entry__flag'));
  // Lucid dreams are the point of the whole app — they get to look different.
  if (entry.lucid) title.appendChild(el('span', 'entry__lucid', 'lucid'));
  title.append(heading);
  body.appendChild(title);
  if (excerpt) body.appendChild(el('p', 'entry__excerpt', excerpt));

  node.append(when, body);
  // Their dreams are read-only — there is nothing of yours to edit.
  node.addEventListener('click', () =>
    entry.from ? showSharedDream(entry) : openCompose(entry),
  );
  return node;
}

/** Read-only view of a dream the other person shared. */
function showSharedDream(entry) {
  const slot = el('div', 'reading');
  if (entry.undecryptable) {
    slot.appendChild(el('p', 'error', 'Toto sa nepodarilo dešifrovať.'));
  } else {
    if (entry.body) slot.appendChild(el('p', 'reading__p', entry.body));
    const facts = [];
    if (entry.lucid) {
      if (entry.trigger) facts.push(`Uvedomil si to vďaka: ${entry.trigger}`);
      if (entry.actions) facts.push(`Keď to vedel: ${entry.actions}`);
      if (entry.duration) facts.push(`Trvalo: ${entry.duration}`);
      if (entry.ending) facts.push(`Skončilo: ${entry.ending}`);
    }
    if (entry.signs?.length) facts.push(`Znaky sna: ${entry.signs.join('; ')}`);
    for (const f of facts) slot.appendChild(el('p', 'note', f));
  }

  openModal({
    title: entry.title || (entry.lucid ? 'Lucidný sen' : 'Sen'),
    body: `${entry.from} · ${fullStamp(entry.dreamedAt)}`,
    slot,
    actions: [{ label: 'Zavrieť', kind: 'btn--ghost', onClick: closeModal }],
  });
}

function renderEmptyShared() {
  const wrap = el('div', 'empty');
  const mark = icon('i-spark', 56);
  mark.classList.add('empty__mark');
  wrap.append(
    mark,
    el('h2', 'empty__title', `Od ${sharing.peerName} zatiaľ nič`),
    el(
      'p',
      'empty__body',
      canShare()
        ? 'Lucidné sny, ktoré si ktokoľvek z vás zapíše, sa sem zdieľajú automaticky. Obyčajné ostávajú súkromné.'
        : 'Musí si raz otvoriť appku, aby vznikli jeho kľúče, potom zdieľanie funguje na obe strany.',
    ),
  );
  return wrap;
}

function renderEmpty() {
  const wrap = el('div', 'empty');
  const mark = icon('i-moon', 56);
  mark.classList.add('empty__mark');
  wrap.append(
    mark,
    el('h2', 'empty__title', 'Zatiaľ nič zapísané'),
    el(
      'p',
      'empty__body',
      'Dreams fade in about ninety seconds. When you wake with one, open this and start typing — tidy it up later.',
    ),
  );
  return wrap;
}

/**
 * Most dreams get written down without a title — you're half asleep. For those,
 * lift the opening sentence up to act as one and show what follows beneath it,
 * so the row never repeats itself.
 */
function summarise(entry) {
  if (entry.undecryptable) {
    return {
      heading: 'Nepodarilo sa dešifrovať',
      excerpt: 'Tento záznam bol napísaný iným heslom.',
    };
  }

  const body = (entry.body || '').trim();
  const title = (entry.title || '').trim();
  if (title) return { heading: title, excerpt: body };
  if (!body) return { heading: 'Untitled dream', excerpt: '' };

  const sentence = body.match(/^[\s\S]{1,72}?[.!?…](?=\s|$)/);
  const heading = sentence ? sentence[0] : body.split('\n')[0].slice(0, 56).trim();
  const rest = body.slice(heading.length).trim();
  return { heading: heading || 'Untitled dream', excerpt: rest };
}

$('#open-settings').addEventListener('click', () => {
  showView('settings');
  // Whether the companion and reminders can run depends on server-side keys,
  // which can be added after this phone last loaded. Re-asking here means the
  // switches come alive on the next visit to Settings rather than needing the
  // app to be closed and reopened.
  void recheckCapabilities();
});
$('#settings-back').addEventListener('click', () => history.back());
$('#open-patterns').addEventListener('click', () => showView('patterns'));
$('#patterns-back').addEventListener('click', () => history.back());

/* ============================================================== PATTERNS */

const DAY_MS = 86_400_000;

function renderPatterns() {
  const entries = sortedEntries();
  const stats = computeStats(entries);

  $('#streak-n').textContent = String(stats.streak);
  $('#streak-label').textContent =
    stats.streak === 0
      ? 'zatiaľ žiadna séria — dnešnou nocou sa začína'
      : stats.streak === 1
        ? 'noc zatiaľ'
        : 'nocí v rade';

  $('#stat-lucid').textContent = String(stats.lucidCount);
  $('#stat-rate').textContent = `${stats.lucidRate}%`;
  $('#stat-total').textContent = String(stats.total);
  $('#stat-longest').textContent = String(stats.longest);

  renderCalendar(stats);
  renderSigns(stats);
  renderChecks();
  renderConditions(entries);
}

/**
 * Six weeks ending tonight, drawn as a sky rather than a grid.
 *
 * The layout is still a calendar underneath — seven columns, one row a week —
 * so a night keeps its position and last Tuesday stays findable. What changes
 * is what a night looks like: nothing written is empty sky, a written night is
 * a faint star, a lucid night burns. Lucid nights within a few days of each
 * other are joined, because a run of them is the thing worth seeing.
 */
function renderCalendar(stats) {
  const cal = $('#cal');
  cal.replaceChildren();

  const today = nightKey(Date.now());
  const WEEKS = 6;
  const COLS = 7;
  const start = new Date(today - (WEEKS * COLS - 1) * DAY_MS);
  const shift = (start.getDay() + 6) % 7; // Monday = 0
  start.setDate(start.getDate() - shift);
  start.setHours(0, 0, 0, 0);

  const total = WEEKS * COLS + shift;
  const rows = Math.ceil(total / COLS);

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${COLS * 10} ${rows * 10}`);
  svg.setAttribute('class', 'starmap');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Tvojich posledných šesť týždňov. Jasné hviezdy sú lucidné noci.');

  /*
   * Jittered off the lattice, and varied in size, so it reads as a sky rather
   * than a spreadsheet — evenly spaced identical dots look like a grid no
   * matter how dim they are. Both come from the date, so a night keeps its
   * position and brightness between renders instead of twitching about.
   */
  const at = (i, key) => {
    const wobble = (n) => (((key / DAY_MS + n) * 2654435761) % 1000) / 1000 - 0.5;
    return {
      x: (i % COLS) * 10 + 5 + wobble(1) * 5.2,
      y: Math.floor(i / COLS) * 10 + 5 + wobble(2) * 5.2,
      // 0.45–0.95, so the empty sky has depth instead of a uniform stipple.
      dim: 0.45 + (wobble(3) + 0.5) * 0.5,
    };
  };

  const lucid = [];
  const stars = [];
  for (let i = 0; i < total; i++) {
    const key = start.getTime() + i * DAY_MS;
    if (key > today) continue;
    const night = stats.nights.get(key);
    const p = at(i, key);
    if (night?.lucid) lucid.push({ ...p, key });
    // Every night gets a star, including the ones you did not write. The
    // unwritten ones are barely lit — they are what makes the written ones
    // read as a sky rather than as five dots in an empty box.
    stars.push({ ...p, key, night });
  }

  // Constellation lines first, so they sit behind the stars they join.
  for (let a = 0; a < lucid.length; a++) {
    for (let b = a + 1; b < lucid.length; b++) {
      if (Math.round((lucid[b].key - lucid[a].key) / DAY_MS) > 4) continue;
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', lucid[a].x.toFixed(2));
      line.setAttribute('y1', lucid[a].y.toFixed(2));
      line.setAttribute('x2', lucid[b].x.toFixed(2));
      line.setAttribute('y2', lucid[b].y.toFixed(2));
      line.setAttribute('class', 'starmap__link');
      svg.appendChild(line);
    }
  }

  for (const star of stars) {
    const { night, key } = star;
    const stamp = new Date(key).toLocaleDateString('sk-SK', { day: 'numeric', month: 'long' });
    const label = night
      ? `${stamp}: ${night.logged} ${night.logged === 1 ? 'sen' : night.logged < 5 ? 'sny' : 'snov'}${night.lucid ? ', lucidný' : ''}`
      : `${stamp}: zatiaľ nič napísané`;

    const dot = document.createElementNS(ns, 'circle');
    dot.setAttribute('cx', star.x.toFixed(2));
    dot.setAttribute('cy', star.y.toFixed(2));
    dot.setAttribute('r', night?.lucid ? '2.3' : night ? '1.25' : star.dim.toFixed(2));
    let cls = 'starmap__star';
    if (night?.lucid) cls += ' is-lucid';
    else if (night) cls += ' is-logged';
    if (key === today) cls += ' is-today';
    dot.setAttribute('class', cls);
    // Staggered so they do not all breathe in time with each other.
    dot.style.setProperty('--delay', `${((key / DAY_MS) % 7) * 0.4}s`);

    const title = document.createElementNS(ns, 'title');
    title.textContent = label;
    dot.appendChild(title);
    dot.addEventListener('click', () => toast(label));
    svg.appendChild(dot);
  }

  cal.appendChild(svg);

  const first = new Date(start);
  const label =
    first.getMonth() === new Date(today).getMonth()
      ? new Date(today).toLocaleDateString('sk-SK', { month: 'long' })
      : `${first.toLocaleDateString('sk-SK', { month: 'short' })} – ${new Date(today).toLocaleDateString('sk-SK', { month: 'short' })}`;
  $('#cal-label').textContent = `Posledných šesť týždňov · ${label}`;

  const lit = stats.lucidNights;
  $('#cal-note').textContent = lit
    ? `${lit} ${lit === 1 ? 'lucidná noc' : lit < 5 ? 'lucidné noci' : 'lucidných nocí'} za posledných šesť týždňov.`
    : 'Každá noc, ktorú zapíšeš, sa stane hviezdou. Tie lucidné horia.';
}

function renderBars(node, rows, max) {
  node.replaceChildren();
  for (const row of rows) {
    const line = el('div', 'bar');
    line.appendChild(el('span', 'bar__label', row.label));
    const track = el('span', 'bar__track');
    const fill = el('span', 'bar__fill');
    fill.style.setProperty('--w', `${Math.round((row.value / max) * 100)}%`);
    if (row.warm) fill.classList.add('bar__fill--warm');
    track.appendChild(fill);
    line.appendChild(track);
    line.appendChild(el('span', 'bar__value', row.display));
    node.appendChild(line);
  }
}

function renderSigns(stats) {
  const rows = [...stats.signTally.entries()]
    .map(([label, value]) => ({ label, value, display: String(value) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 6);

  $('#signs-group').classList.toggle('hidden', rows.length === 0);
  if (!rows.length) return;

  const top = rows[0];
  $('#signs-note').textContent =
    top.value >= 3
      ? `„${top.label}“ máš v ${top.value} snoch. Pred spaním si to predstav a povedz si, že keď to uvidíš, budeš vedieť, že snívaš.`
      : 'Označ zvláštne časti ešte v pár snoch a tie opakujúce sa sa tu ukážu.';

  renderBars($('#signs'), rows, rows[0].value);
}

function renderConditions(entries) {
  const insights = environmentInsights(entries);
  $('#cond-group').classList.toggle('hidden', insights.length === 0);
  if (!insights.length) {
    return;
  }

  $('#cond-note').textContent =
    'Podiel nocí, ktoré boli lucidné, pre okolnosti zapísané aspoň trikrát. Malé čísla — ber to ako náznak, nie ako zistenie.';

  renderBars(
    $('#conditions'),
    insights.map((i) => ({
      label: i.label,
      value: i.rate,
      display: `${i.rate}% of ${i.total}`,
      warm: i.rate > 0,
    })),
    Math.max(100, ...insights.map((i) => i.rate)),
  );
}

/* ======================================================== REALITY CHECKS */

/*
 * A reality check only works if it is done properly — actually entertaining
 * the possibility, not waving a hand at it. Counting them is what makes people
 * do that, so the tally is the feature. It stays on this phone: the server has
 * no business knowing how often anyone questions reality.
 */

const dayKey = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 10);

function logCheck() {
  const log = { ...(prefs.checkLog || {}) };
  const key = dayKey();
  log[key] = (log[key] || 0) + 1;
  // Six weeks is all Patterns draws, so older days are dead weight.
  const cutoff = dayKey(Date.now() - 42 * DAY_MS);
  for (const k of Object.keys(log)) if (k < cutoff) delete log[k];
  setPref('checkLog', log);
  return log[key];
}

function checkStats() {
  const log = prefs.checkLog || {};
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const key = dayKey(Date.now() - i * DAY_MS);
    days.push({ key, count: log[key] || 0 });
  }
  return {
    days,
    total: days.reduce((sum, d) => sum + d.count, 0),
    today: log[dayKey()] || 0,
  };
}

function renderChecks() {
  const { days, total, today } = checkStats();
  $('#checks-group').classList.toggle('hidden', total === 0);
  if (!total) return;

  $('#checks-note').textContent =
    `${total} za posledné dva týždne, ${(total / 14).toFixed(1)} denne. Dnes ${today}. ` +
    'Zvyk sa do snov prenesie, až keď je úprimný — pýtaj sa poriadne, zakaždým.';

  const node = $('#checks-spark');
  node.replaceChildren();
  const max = Math.max(1, ...days.map((d) => d.count));
  for (const day of days) {
    const bar = el('span', 'spark');
    bar.style.setProperty('--h', `${Math.round((day.count / max) * 100)}%`);
    if (!day.count) bar.classList.add('is-empty');
    bar.title = `${day.key}: ${day.count}`;
    node.appendChild(bar);
  }
}

/** Offered after a reality-check nudge, and from the journal at any time. */
function askedRealityCheck() {
  const n = logCheck();
  renderChecks();
  toast(n === 1 ? 'Skontrolované. Dnes prvý.' : `Skontrolované. Dnes ${n}.`);
}

$('#do-check').addEventListener('click', askedRealityCheck);

/* ================================================================ TONIGHT */

/**
 * The two moments that actually produce lucid dreams: the minutes before you
 * fall asleep, and the wake in the small hours. Everything else in this app
 * happens after the fact — this is the only screen that happens in time to
 * change the outcome.
 */

let mantraCount = 0;
let wbtbTimer = null;
let wbtbLeft = 0;

const MANTRA_TARGET = 8;
const WBTB_MINUTES = 20;

const lowerFirst = (str) => (str ? str[0].toLowerCase() + str.slice(1) : str);

function openTonight(mode = 'bed') {
  const entries = sortedEntries();
  const stats = computeStats(entries);
  const top = stats.topSign;
  const sign = top && top.count >= 2 ? top.name : null;
  const wbtbMode = mode === 'wbtb';

  $('#tonight-title').textContent = wbtbMode ? 'Prebudenie a späť do postele' : 'Pred spaním';
  $('#tonight-lede').textContent = wbtbMode
    ? 'Si hore v najlepšom REM okne noci. Ostaň hore, svetlo tlmené, potom sa vráť s tým, že si to všimneš.'
    : 'Jedna minúta teraz je viac než hodina snaženia neskôr.';

  $('#wbtb-panel').classList.toggle('hidden', !wbtbMode);
  if (wbtbMode) startWbtbTimer();
  else stopWbtbTimer();

  $('#tonight-sign').textContent = sign || 'Zatiaľ málo snov';
  $('#tonight-sign-note').textContent = sign
    ? `Objavilo sa to v ${top.count} tvojich snoch. Predstav si to teraz a predstav si, ako to chytíš.`
    : 'Označ nemožné časti v pár snoch a tá, ktorá sa stále vracia, sa tu ukáže.';

  // The signs read as sentences ("Something impossible felt normal"), so they
  // have to be quoted rather than dropped into the middle of one.
  $('#mantra-text').textContent = sign
    ? `Keď nabudúce — ${lowerFirst(sign)} — uvedomím si, že snívam.`
    : 'Keď mi nabudúce niečo nebude dávať zmysel, uvedomím si, že snívam.';

  mantraCount = 0;
  renderMantra();
  renderReenter(entries, wbtbMode);
  showView('tonight');
}

function renderMantra() {
  const pips = $('#mantra-pips');
  pips.replaceChildren();
  for (let i = 0; i < MANTRA_TARGET; i++) {
    const pip = el('span', 'pip');
    if (i < mantraCount) pip.classList.add('is-lit');
    pips.appendChild(pip);
  }
  $('#mantra-count').textContent =
    mantraCount === 0
      ? 'Ťukni pri každom zopakovaní'
      : mantraCount >= MANTRA_TARGET
        ? 'To stačí. Choď na to spať.'
        : `${mantraCount} z ${MANTRA_TARGET}`;
}

$('#mantra').addEventListener('click', () => {
  mantraCount = Math.min(MANTRA_TARGET, mantraCount + 1);
  renderMantra();
  if (mantraCount === MANTRA_TARGET) toast('Teraz choď spať a stále na to mysli');
});

/**
 * A dream to replay on the way down. Prefers a lucid one — re-entering a dream
 * you have already been lucid in is the shortest route back to another.
 */
function renderReenter(entries, wbtbMode) {
  const pick =
    entries.find((e) => e.lucid) || entries.find((e) => (e.body || '').length > 80) || entries[0];

  $('#reenter-group').classList.toggle('hidden', !pick);
  if (!pick) return;

  const node = $('#reenter');
  node.replaceChildren();
  node.appendChild(el('h3', 'reenter__title', pick.title || 'Untitled'));
  node.appendChild(el('p', 'reenter__body', (pick.body || '').slice(0, 320)));
  if (pick.lucid) node.appendChild(el('span', 'reenter__flag', 'v tomto si bol lucidný'));
  $('#reenter-note').textContent = wbtbMode
    ? 'Prečítaj si ho, potom si ľahni späť a nadviaž tam, kde skončil.'
    : 'Prehrávaj si ho, kým zaspávaš — a tentoraz si to všimni.';
}

function startWbtbTimer() {
  stopWbtbTimer();
  wbtbLeft = WBTB_MINUTES * 60;
  paintWbtb();
  wbtbTimer = setInterval(() => {
    wbtbLeft -= 1;
    paintWbtb();
    if (wbtbLeft <= 0) {
      stopWbtbTimer();
      $('#wbtb-note').textContent =
        'To je dvadsať minút. Choď si teraz ľahnúť s tým, že si to všimneš.';
      toast('Čas. Späť do postele.');
    }
  }, 1000);
}

function paintWbtb() {
  const left = Math.max(0, wbtbLeft);
  $('#wbtb-clock').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

function stopWbtbTimer() {
  clearInterval(wbtbTimer);
  wbtbTimer = null;
}

$('#wbtb-go').addEventListener('click', () => {
  stopWbtbTimer();
  showView('journal');
  toast('Veľa šťastia. Počítaj s tým, že si to všimneš.');
});

$('#tonight-done').addEventListener('click', () => {
  stopWbtbTimer();
  showView('journal');
});

$('#tonight-back').addEventListener('click', () => showView('journal'));
$('#open-tonight').addEventListener('click', () => openTonight('bed'));
$('#open-tonight-journal').addEventListener('click', () => openTonight('bed'));

/* ================================================================ COMPOSE */

const titleInput = $('#compose-title');
const bodyInput = $('#compose-body');
const statusNode = $('#compose-status');
let saveTimer = null;
let dirty = false;

/* --------------------------------------------------- the reflect controls */

/** Working copy of everything the questions collect for the open entry. */
let draft = emptyEntry();

/* ------------------------------------------------------------- the steps */

const STEPS = ['lucid', 'name', 'story', 'feel', 'detail', 'context'];
let step = 0;

/**
 * Only the current step is on screen. The lucid answer is first because it is
 * one tap and decides which questions come later — asking it before there is
 * any typing keeps the 3am path to two taps.
 */
let leaveTimer = null;

function showStep(next) {
  const previous = step;
  step = Math.max(0, Math.min(STEPS.length - 1, next));

  /*
   * The outgoing question leaves rather than vanishing. It is lifted out of
   * the flow while it goes, so the incoming one can take its place at the same
   * moment — otherwise the two would stack and the whole sheet would jump.
   *
   * The DOM swap is still synchronous, which matters: iOS only raises the
   * keyboard for a focus() inside the tap that caused it, so the animation
   * cannot be allowed to delay the step change.
   */
  clearTimeout(leaveTimer);
  const back = step < previous;
  for (const section of document.querySelectorAll('.step')) {
    const index = Number(section.dataset.step);
    section.classList.remove('is-leaving', 'is-leaving-back');
    if (index === previous && previous !== step) {
      section.classList.add(back ? 'is-leaving-back' : 'is-leaving');
    }
    section.classList.toggle('is-active', index === step);
  }
  document.querySelector('.compose').classList.toggle('is-back', back);
  leaveTimer = setTimeout(() => {
    for (const section of document.querySelectorAll('.step')) {
      section.classList.remove('is-leaving', 'is-leaving-back');
    }
  }, 340);

  $('#compose-back').classList.toggle('is-hidden', step === 0);
  const last = step === STEPS.length - 1;
  $('#compose-next').textContent = last ? 'Uložiť' : 'Ďalej';

  renderDots();
  $('#compose-scroll').scrollTop = 0;

  // Put the cursor where the answer goes, so typing can start immediately.
  if (STEPS[step] === 'name') titleInput.focus();
  if (STEPS[step] === 'story') {
    // The bubble has no measurable height until it is on screen.
    fitBody();
    bodyInput.focus();
  }
  if (STEPS[step] === 'context') refreshTip();
}

function renderDots() {
  const dots = $('#compose-dots');
  dots.replaceChildren();
  for (let i = 0; i < STEPS.length; i++) {
    const dot = el('span', 'dot-step');
    if (i === step) dot.classList.add('is-here');
    else if (i < step) dot.classList.add('is-done');
    dots.appendChild(dot);
  }
}

$('#compose-back').addEventListener('click', () => showStep(step - 1));

$('#compose-next').addEventListener('click', async () => {
  if (step < STEPS.length - 1) {
    // Nothing is mandatory — every step can be walked past.
    showStep(step + 1);
    return;
  }
  clearTimeout(saveTimer);
  const hasContent = titleInput.value.trim() || bodyInput.value.trim();
  const id = composing?.id;
  if (hasContent) await commit();
  closeCompose();
  if (!hasContent) return;

  if (prefs.aiAfterEntry && hasConsented() && aiAvailable) {
    const entry = state.entries.get(id) || sortedEntries()[0];
    if (entry) showReading('K tomuto snu', (all) => buildEntryPrompt(entry, all));
  } else {
    toast('Uložené');
  }
});

/* --------------------------------------------------------------- the faces */

const MOODS = [
  { label: 'Awful', curve: 11 },
  { label: 'Uneasy', curve: 14 },
  { label: 'Neutral', curve: 15.6 },
  { label: 'Good', curve: 18 },
  { label: 'Wonderful', curve: 20.5 },
];

/**
 * Drawn rather than emoji: the mouth is one quadratic whose control point
 * slides from above the line (a frown) to below it (a grin), which keeps the
 * five faces a single consistent family instead of five unrelated glyphs.
 */
function faceSvg(curve) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');

  const ring = document.createElementNS(ns, 'circle');
  ring.setAttribute('cx', '12');
  ring.setAttribute('cy', '12');
  ring.setAttribute('r', '9.2');
  ring.setAttribute('fill', 'none');
  ring.setAttribute('stroke', 'currentColor');
  ring.setAttribute('stroke-width', '1.4');
  svg.appendChild(ring);

  for (const cx of [8.9, 15.1]) {
    const eye = document.createElementNS(ns, 'circle');
    eye.setAttribute('cx', String(cx));
    eye.setAttribute('cy', '10');
    eye.setAttribute('r', '1.15');
    eye.setAttribute('fill', 'currentColor');
    svg.appendChild(eye);
  }

  const mouth = document.createElementNS(ns, 'path');
  mouth.setAttribute('d', `M7.6 15.4 Q12 ${curve} 16.4 15.4`);
  mouth.setAttribute('fill', 'none');
  mouth.setAttribute('stroke', 'currentColor');
  mouth.setAttribute('stroke-width', '1.4');
  mouth.setAttribute('stroke-linecap', 'round');
  svg.appendChild(mouth);

  return svg;
}

function buildFaces() {
  const node = $('#q-mood');
  node.replaceChildren();
  MOODS.forEach((mood, i) => {
    const btn = el('button', 'face');
    btn.type = 'button';
    btn.setAttribute('aria-pressed', 'false');
    btn.setAttribute('aria-label', mood.label);
    btn.appendChild(faceSvg(mood.curve));
    btn.addEventListener('click', () => {
      const already = btn.getAttribute('aria-pressed') === 'true';
      draft.mood = already ? 0 : i + 1;
      setFaces(draft.mood);
      mark();
    });
    node.appendChild(btn);
  });
}

function setFaces(value) {
  const node = $('#q-mood');
  [...node.children].forEach((b, i) =>
    b.setAttribute('aria-pressed', String(i + 1 === value)),
  );
  $('#q-mood-label').textContent = value ? MOODS[value - 1].label : '';
}

/** Multi-select chip group. */
function chipGroup(node, options, { onChange }) {
  node.replaceChildren();
  for (const label of options) {
    const chip = el('button', 'chip', label);
    chip.type = 'button';
    chip.setAttribute('aria-pressed', 'false');
    chip.addEventListener('click', () => {
      const on = chip.getAttribute('aria-pressed') === 'true';
      chip.setAttribute('aria-pressed', String(!on));
      onChange(
        [...node.querySelectorAll('[aria-pressed="true"]')].map((c) => c.textContent),
      );
    });
    node.appendChild(chip);
  }
}

/** Pick-one chip group. */
function chipOne(node, options, { onChange }) {
  node.replaceChildren();
  for (const label of options) {
    const chip = el('button', 'chip', label);
    chip.type = 'button';
    chip.setAttribute('aria-pressed', 'false');
    chip.addEventListener('click', () => {
      const already = chip.getAttribute('aria-pressed') === 'true';
      for (const c of node.children) c.setAttribute('aria-pressed', 'false');
      chip.setAttribute('aria-pressed', String(!already));
      onChange(already ? '' : label);
    });
    node.appendChild(chip);
  }
}

/** 1–5 rating. */
function scale(node, { onChange }) {
  node.replaceChildren();
  for (let n = 1; n <= 5; n++) {
    const dot = el('button', 'scale__dot', String(n));
    dot.type = 'button';
    dot.setAttribute('aria-pressed', 'false');
    dot.addEventListener('click', () => {
      const already = dot.getAttribute('aria-pressed') === 'true';
      const value = already ? 0 : n;
      [...node.children].forEach((d, i) => d.setAttribute('aria-pressed', String(i < value)));
      onChange(value);
    });
    node.appendChild(dot);
  }
}

function setChips(node, values) {
  const wanted = new Set(Array.isArray(values) ? values : [values]);
  for (const chip of node.children) {
    chip.setAttribute('aria-pressed', String(wanted.has(chip.textContent)));
  }
}

function setScale(node, value) {
  [...node.children].forEach((d, i) => d.setAttribute('aria-pressed', String(i < value)));
}

const mark = () => {
  dirty = true;
  statusNode.textContent = 'Ukladám…';
  statusNode.classList.remove('is-saved');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void commit({ silent: true }), 2000);
  refreshTip();
};

buildFaces();

chipOne($('#q-trigger'), LUCID_TRIGGERS, {
  onChange: (v) => {
    draft.trigger = v;
    mark();
  },
});
chipOne($('#q-duration'), DURATIONS, {
  onChange: (v) => {
    draft.duration = v;
    mark();
  },
});
chipOne($('#q-ending'), ENDINGS, {
  onChange: (v) => {
    draft.ending = v;
    mark();
  },
});
chipOne($('#q-place'), PLACES, {
  onChange: (v) => {
    draft.env.place = v;
    mark();
  },
});
chipGroup($('#q-signs'), DREAM_SIGNS, {
  onChange: (v) => {
    draft.signs = v;
    mark();
  },
});
chipGroup($('#q-substances'), SUBSTANCES, {
  onChange: (v) => {
    draft.env.substances = v;
    mark();
  },
});
scale($('#q-excitement'), {
  onChange: (v) => {
    draft.excitement = v;
    mark();
  },
});
scale($('#q-vividness'), {
  onChange: (v) => {
    draft.vividness = v;
    mark();
  },
});

$('#q-lucid').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-lucid]');
  if (!btn) return;
  const wasLucid = draft.lucid;
  draft.lucid = btn.dataset.lucid === 'yes';
  for (const b of $('#q-lucid').children) {
    b.setAttribute('aria-pressed', String(b === btn));
  }
  showBranch();
  mark();
  /*
   * Answering moves you on without a second tap — but not instantly. The
   * button has to be seen to take the answer first, or the screen simply
   * changes under your thumb and it reads as a glitch rather than a reply.
   * The pressed state paints, then the step turns.
   *
   * Still synchronous, and that is deliberate: iOS only raises the keyboard
   * for a focus() inside the tap that caused it, so the step change cannot be
   * moved into a timeout. The pause is the animation on the button, not a
   * delay before the work.
   */
  if (step === 0) {
    btn.classList.add('is-taking');
    setTimeout(() => btn.classList.remove('is-taking'), 420);
    showStep(1);
  }

  // Answering "yes" for the first time turns sharing on, since that is the
  // whole reason the two of them are doing this together.
  if (wasLucid !== true && defaultShareFor(draft.lucid) && !$('#q-share').matches('[aria-pressed="true"]')) {
    $('#q-share').setAttribute('aria-pressed', 'true');
    const id = composing?.id || (await commit({ silent: true }));
    if (id) {
      try {
        await shareEntry(state.entries.get(id));
      } catch {
        $('#q-share').setAttribute('aria-pressed', 'false');
      }
    }
  }
});

// Free-text fields all follow the same shape.
const TEXT_FIELDS = [
  ['#q-prior', (v) => (draft.priorActivity = v)],
  ['#q-actions', (v) => (draft.actions = v)],
  ['#q-theme', (v) => (draft.theme = v)],
  ['#q-bedtime', (v) => (draft.env.bedtime = v)],
  ['#q-envnotes', (v) => (draft.env.notes = v)],
  ['#q-trigger-other', (v) => v && (draft.trigger = v)],
];
for (const [sel, set] of TEXT_FIELDS) {
  $(sel).addEventListener('input', (e) => {
    set(e.target.value);
    mark();
  });
}

$('#q-signs-other').addEventListener('input', (e) => {
  // Typed signs live alongside the tapped ones without clobbering them.
  const tapped = [...$('#q-signs').querySelectorAll('[aria-pressed="true"]')].map(
    (c) => c.textContent,
  );
  draft.signs = e.target.value.trim() ? [...tapped, e.target.value.trim()] : tapped;
  mark();
});

$('#q-woke').addEventListener('click', (e) => {
  const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
  e.currentTarget.setAttribute('aria-pressed', String(on));
  draft.env.wokeInNight = on;
  mark();
});

function showBranch() {
  const answered = draft.lucid !== null && draft.lucid !== undefined;
  $('#branch-lucid').classList.toggle('hidden', draft.lucid !== true);
  $('#branch-ordinary').classList.toggle('hidden', draft.lucid !== false);
  $('#share-row').classList.toggle('hidden', !answered || !canShare());
  if (canShare()) {
    $('#share-label').textContent = `Zdieľať to s ${sharing.peerName}`;
  }
}

/** Lucid dreams share by default; that preference is what the toggle starts at. */
function defaultShareFor(lucid) {
  return canShare() && lucid === true && prefs.shareLucid !== false;
}

$('#q-share').addEventListener('click', async (e) => {
  const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
  e.currentTarget.setAttribute('aria-pressed', String(on));
  // Sharing needs a saved entry to point at, so make sure it exists first.
  const id = composing?.id || (await commit({ silent: true }));
  if (!id) {
    e.currentTarget.setAttribute('aria-pressed', 'false');
    toast('Najprv niečo napíš');
    return;
  }
  try {
    if (on) {
      await shareEntry(state.entries.get(id));
      toast(`Zdieľané s ${sharing.peerName}`);
    } else {
      await unshareEntry(id);
      toast('Už nie je zdieľané');
    }
  } catch (err) {
    e.currentTarget.setAttribute('aria-pressed', String(!on));
    toast(err.message || 'Zdieľanie sa nepodarilo zmeniť');
  }
});

function refreshTip() {
  const tip = tipFor(
    { ...draft, title: titleInput.value, body: bodyInput.value },
    computeStats(sortedEntries()),
  );
  $('#tip-title').textContent = tip.title;
  $('#tip-body').textContent = tip.body;
}

/** Loads an existing entry's answers back into the controls. */
function fillReflect(entry) {
  draft = normalise(entry);

  setChips($('#q-trigger'), draft.trigger);
  setChips($('#q-duration'), draft.duration);
  setChips($('#q-ending'), draft.ending);
  setChips($('#q-place'), draft.env.place);
  setChips($('#q-signs'), draft.signs);
  setChips($('#q-substances'), draft.env.substances);
  setScale($('#q-excitement'), draft.excitement);
  setScale($('#q-vividness'), draft.vividness);
  setFaces(draft.mood);

  $('#q-prior').value = draft.priorActivity;
  $('#q-actions').value = draft.actions;
  $('#q-theme').value = draft.theme;
  $('#q-bedtime').value = draft.env.bedtime;
  $('#q-envnotes').value = draft.env.notes;
  $('#q-trigger-other').value = '';
  $('#q-signs-other').value = '';
  $('#q-woke').setAttribute('aria-pressed', String(draft.env.wokeInNight));

  const isNew = !entry;
  for (const b of $('#q-lucid').children) {
    b.setAttribute('aria-pressed', String(!isNew && draft.lucid === (b.dataset.lucid === 'yes')));
  }
  $('#q-share').setAttribute('aria-pressed', String(!!entry && isShared(entry.id)));
  showBranch();
  refreshTip();
}

/**
 * Opens the writing sheet. Focus happens synchronously inside the tap handler
 * — iOS will not raise the keyboard from an async continuation.
 */
function openCompose(entry) {
  composing = entry
    ? { id: entry.id, dreamedAt: entry.dreamedAt }
    : { id: null, dreamedAt: Date.now() };

  titleInput.value = entry?.title || '';
  bodyInput.value = entry?.body || '';
  dirty = false;
  statusNode.textContent = '';
  statusNode.classList.remove('is-saved');
  $('#compose-delete').classList.toggle('hidden', !entry);
  updateWhenLabel();

  fillReflect(entry);
  showView('compose');
  // A new dream starts on the lucid question; reopening an old one starts on
  // what it says, since that is what you came back to read.
  showStep(entry ? 2 : 0);
  if (entry) bodyInput.setSelectionRange(bodyInput.value.length, bodyInput.value.length);
}

function updateWhenLabel() {
  $('#compose-when').textContent = fullStamp(composing.dreamedAt);
}

$('#record').addEventListener('click', () => openCompose(null));

/**
 * Grows the story bubble to fit what is in it.
 *
 * A textarea does not resize itself, so a long dream would scroll inside a
 * small box while the page behind it stayed still — which reads, correctly, as
 * not being able to scroll. Growing the bubble instead means the page scrolls,
 * the way it does when you write a long message anywhere else.
 */
function fitBody() {
  bodyInput.style.height = 'auto';
  bodyInput.style.height = `${bodyInput.scrollHeight}px`;
}

for (const input of [titleInput, bodyInput]) {
  // Encrypted autosave: after two seconds of stillness the dream is safe,
  // whether or not anyone reaches the end of the questions.
  input.addEventListener('input', mark);
}

bodyInput.addEventListener('input', fitBody);

async function commit({ silent = false } = {}) {
  if (!composing) return null;
  const title = titleInput.value.trim();
  const body = bodyInput.value.trim();
  if (!title && !body) return null;

  try {
    const id = await saveEntry({
      ...draft,
      id: composing.id,
      title,
      body,
      dreamedAt: composing.dreamedAt,
    });
    composing.id = id;
    // Once it exists it can be thrown away again, even if it was new a moment ago.
    $('#compose-delete').classList.remove('hidden');
    dirty = false;
    statusNode.textContent = state.entries.get(id)?.pending ? 'Uložené v tomto telefóne' : 'Uložené';
    statusNode.classList.add('is-saved');
    renderJournal();
    return id;
  } catch (err) {
    statusNode.textContent = 'Nepodarilo sa uložiť';
    if (!silent) toast(err.message || 'Nepodarilo sa uložiť');
    return null;
  }
}

// "Done" leaves at any point and keeps whatever is written — you should never
// have to reach the last step to save a dream.
$('#compose-cancel').addEventListener('click', async () => {
  clearTimeout(saveTimer);
  if (dirty && (titleInput.value.trim() || bodyInput.value.trim())) await commit({ silent: true });
  closeCompose();
});

$('#compose-delete').addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: 'Zmazať tento sen?',
    body: 'Odstráni sa aj zo servera. Toto sa nedá vrátiť.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  clearTimeout(saveTimer);
  if (composing.id) await removeEntry(composing.id);
  closeCompose();
  renderJournal();
  toast('Zmazané');
});

/** Lets you file a dream under the night it actually happened. */
$('#compose-when').addEventListener('click', () => {
  const input = el('input', 'input');
  input.type = 'datetime-local';
  input.value = toLocalInputValue(composing.dreamedAt);
  const wrap = el('div', 'stack');
  wrap.appendChild(input);

  openModal({
    title: 'Kedy bol tento sen?',
    body: 'Sny pred poludním sa zaraďujú pod predchádzajúcu noc.',
    slot: wrap,
    actions: [
      {
        label: 'Set',
        kind: 'btn--primary',
        onClick: async () => {
          const ts = new Date(input.value).getTime();
          if (Number.isFinite(ts)) {
            composing.dreamedAt = ts;
            updateWhenLabel();
            if (composing.id || titleInput.value.trim() || bodyInput.value.trim()) {
              await commit({ silent: true });
            }
          }
          closeModal();
        },
      },
      { label: 'Cancel', kind: 'btn--ghost', onClick: closeModal },
    ],
  });
});

function closeCompose({ pop = true } = {}) {
  composing = null;
  titleInput.value = '';
  bodyInput.value = '';
  $('#sheet').classList.remove('is-open');
  if (pop && history.state?.view === 'compose') history.back();
  else showView('journal', { push: false });
  renderJournal();
}

/* =============================================================== SETTINGS */

/**
 * Re-reads the two server-side facts that gate features — is a Gemini key set,
 * are VAPID keys set — and repaints the rows that depend on them.
 */
async function recheckCapabilities() {
  try {
    const me = await api.me();
    aiAvailable = !!me.aiAvailable;
    push.available = !!me.pushAvailable;
    push.publicKey = me.vapidPublicKey;
  } catch {
    return; // offline; whatever we knew at sign-in still stands
  }
  refreshCompanion();
  await refreshPushState();
  updateNotifyHint();
}

function refreshSettings() {
  $('#set-username').textContent = state.username || '—';

  for (const btn of document.querySelectorAll('#theme-seg button')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.themeValue === prefs.theme));
  }
  $('#text-size').value = String(prefs.textScale);
  $('#set-autolock').setAttribute('aria-pressed', String(prefs.autoLock));
  $('#set-privacy-screen').setAttribute('aria-pressed', String(prefs.privacyScreen));
  $('#notif-time').value = prefs.notifyTime;
  renderCheckTimes();
  refreshTonightRows();
  refreshPushState().then(updateNotifyHint);
  updateNotifyHint();

  refreshSharing();
  refreshCompanion();

  $('#about-note').textContent = `Nocturne ${APP_VERSION} · Záznamy sú v tomto zariadení zašifrované cez AES-GCM. Server ukladá len šifrovaný text a nevie ho prečítať.`;

  idbGetAll('entries').then((rows) => {
    const bytes = rows.reduce((sum, r) => sum + (r.ciphertext?.length || 0), 0);
    $('#set-storage').textContent = bytesLabel(bytes);
  });
}

document.querySelector('#theme-seg').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-theme-value]');
  if (!btn) return;
  setPref('theme', btn.dataset.themeValue);
  refreshSettings();
});

$('#text-size').addEventListener('input', (e) => setPref('textScale', Number(e.target.value)));

$('#set-autolock').addEventListener('click', (e) => {
  setPref('autoLock', e.currentTarget.getAttribute('aria-pressed') !== 'true');
  refreshSettings();
});

$('#set-privacy-screen').addEventListener('click', (e) => {
  setPref('privacyScreen', e.currentTarget.getAttribute('aria-pressed') !== 'true');
  refreshSettings();
});

$('#set-passphrase').addEventListener('click', openPassphraseDialog);

$('#set-signout').addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: 'Odhlásiť sa?',
    body: 'Sny ostanú na serveri. Na ich opätovné prečítanie budeš potrebovať heslo.',
    confirmLabel: 'Odhlásiť sa',
  });
  if (!ok) return;
  await signOut();
  forgetSharing();
  history.replaceState({ view: 'lock' }, '');
  showView('lock', { push: false });
  setMode('signin');
});

$('#set-export-text').addEventListener('click', () => {
  download(`nocturne-${new Date().toISOString().slice(0, 10)}.txt`, exportText());
  toast('Exportované');
});

$('#set-export-json').addEventListener('click', () => {
  download(`nocturne-${new Date().toISOString().slice(0, 10)}.json`, exportJson(), 'application/json');
  toast('Exportované');
});

$('#set-delete').addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: 'Zmazať tvoj denník?',
    body: 'Každý sen, ktorý si napísal, sa natrvalo vymaže zo servera. Ak si chceš nechať kópiu, najprv exportuj.',
    confirmLabel: 'Zmazať všetko',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.deleteAccount();
    await signOut();
    history.replaceState({ view: 'lock' }, '');
    showView('lock', { push: false });
    setMode('signin');
    toast('Denník zmazaný');
  } catch (err) {
    toast(err.message || 'Nepodarilo sa zmazať');
  }
});

/* ------------------------------------------------------- change passphrase */

function openPassphraseDialog() {
  const form = el('div', 'stack');
  const make = (label, id, autocomplete) => {
    const field = el('div', 'field');
    const lab = el('label', 'field__label', label);
    lab.htmlFor = id;
    const input = el('input', 'input');
    input.type = 'password';
    input.id = id;
    input.autocomplete = autocomplete;
    field.append(lab, input);
    form.appendChild(field);
    return input;
  };

  const current = make('Súčasné heslo', 'pp-current', 'current-password');
  const next = make('Nové heslo', 'pp-next', 'new-password');
  const again = make('Nové heslo ešte raz', 'pp-again', 'new-password');
  const error = el('p', 'error');
  form.appendChild(error);

  openModal({
    title: 'Zmeniť heslo',
    body: 'Každý záznam sa v tomto telefóne dešifruje a zašifruje nanovo. Nechaj appku otvorenú, kým to dobehne.',
    slot: form,
    actions: [
      {
        label: 'Zmeniť',
        kind: 'btn--primary',
        onClick: async (btn) => {
          error.textContent = '';
          if (next.value.length < 10) {
            error.textContent = 'Použi aspoň 10 znakov.';
            return;
          }
          if (next.value !== again.value) {
            error.textContent = 'Nové heslá sa nezhodujú.';
            return;
          }
          btn.disabled = true;
          btn.textContent = 'Re-encrypting…';
          try {
            await changePassphrase(current.value, next.value);
            closeModal();
            toast('Heslo zmenené');
          } catch (err) {
            error.textContent = err.message || 'Nepodarilo sa to zmeniť.';
            btn.disabled = false;
            btn.textContent = 'Zmeniť';
          }
        },
      },
      { label: 'Cancel', kind: 'btn--ghost', onClick: closeModal },
    ],
  });
}

/* ------------------------------------------------------- dream companion  */

let aiAvailable = false;

function refreshCompanion() {
  const on = hasConsented();
  $('#set-ai').setAttribute('aria-pressed', String(on));
  $('#set-ai-auto').setAttribute('aria-pressed', String(!!prefs.aiAfterEntry));

  const hint = $('#ai-hint');
  if (!aiAvailable) {
    hint.textContent = 'Na serveri zatiaľ nie je nastavený Gemini kľúč, takže toto nepobeží.';
  } else if (on) {
    hint.textContent =
      'Zapnuté. Text sna sa tu dešifruje a pri vyžiadaní rozboru sa odošle do Google Gemini.';
  } else {
    hint.textContent = 'Vypnuté. Kým to nezapneš, nikam sa nič neposiela.';
  }

  for (const id of ['#ai-patterns', '#ai-routine']) {
    $(id).classList.toggle('is-muted', !on || !aiAvailable);
  }
  $('#set-ai-auto').closest('.row').classList.toggle('is-muted', !on || !aiAvailable);
}

/**
 * The consent gate. Everything else in this app is built so the server cannot
 * read a dream; turning this on is the one place that stops being true, so it
 * says so in as many words rather than burying it.
 */
function askConsent() {
  return new Promise((resolve) => {
    const body = el('div', 'stack');
    const points = [
      'Tvoje sny sa v tomto telefóne dešifrujú a odošlú sa na prečítanie do Google Gemini.',
      'They pass through your own server on the way. Everywhere else in this app, the server only ever sees ciphertext.',
      'On Gemini’s free tier, Google may use what you send to improve its products. Enabling billing on the key stops that.',
      'Kým si nevypýtaš rozbor, nič sa neodosiela, a spoločník si nič neukladá.',
    ];
    for (const p of points) {
      const row = el('p', 'note');
      row.textContent = `· ${p}`;
      body.appendChild(row);
    }

    openModal({
      title: 'Skôr než si niečo prečíta',
      body: 'Toto je jediná funkcia, ktorá posiela tvoje sny preč z telefónu. Prečítaj si to poriadne.',
      slot: body,
      dismissable: false,
      actions: [
        {
          label: 'Rozumiem — zapnúť',
          kind: 'btn--primary',
          onClick: () => {
            closeModal();
            resolve(true);
          },
        },
        {
          label: 'No thanks',
          kind: 'btn--ghost',
          onClick: () => {
            closeModal();
            resolve(false);
          },
        },
      ],
    });
  });
}

$('#set-ai').addEventListener('click', async (e) => {
  if (e.currentTarget.getAttribute('aria-pressed') === 'true') {
    revokeConsent();
    setPref('aiAfterEntry', false);
    refreshCompanion();
    return;
  }
  if (!aiAvailable) {
    toast('Na serveri nie je nastavený Gemini kľúč');
    return;
  }
  if (await askConsent()) grantConsent();
  refreshCompanion();
});

$('#set-ai-auto').addEventListener('click', (e) => {
  if (!hasConsented()) {
    toast('Najprv zapni spoločníka');
    return;
  }
  setPref('aiAfterEntry', e.currentTarget.getAttribute('aria-pressed') !== 'true');
  refreshCompanion();
});

/** Opens the reading panel, then fills it in when the answer arrives. */
async function showReading(title, buildPrompt) {
  if (!hasConsented() || !aiAvailable) {
    toast(aiAvailable ? 'Najprv zapni spoločníka' : 'Na serveri nie je nastavený Gemini kľúč');
    return;
  }

  const entries = sortedEntries();
  if (!entries.length) {
    toast('Najprv si zapíš nejaký sen');
    return;
  }

  const slot = el('div', 'reading');
  slot.appendChild(el('div', 'spinner'));
  openModal({
    title,
    slot,
    actions: [{ label: 'Zavrieť', kind: 'btn--ghost', onClick: closeModal }],
  });

  try {
    const { text, truncated } = await ask(buildPrompt(entries));
    slot.replaceChildren();
    // Plain paragraphs, set as text — never innerHTML with model output.
    for (const para of text.split(/\n{2,}/)) {
      if (para.trim()) slot.appendChild(el('p', 'reading__p', para.trim()));
    }
    // Half a thought looks like a bad answer unless it says it was cut off.
    if (truncated) slot.appendChild(el('p', 'note', '(Odpoveď bola odseknutá — došiel jej limit.)'));
  } catch (err) {
    slot.replaceChildren(el('p', 'error', err.message || 'To nevyšlo.'));
  }
}

$('#ai-patterns').addEventListener('click', () =>
  showReading('Čo vidím v tvojich snoch', buildPatternPrompt),
);

$('#ai-routine').addEventListener('click', () =>
  showReading('Tvoje časovanie spánku', buildRoutinePrompt),
);

/* --------------------------------------------------------- notifications  */

const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent);

function updateNotifyHint() {
  const blocked = blockedReason();
  $('#notif-hint').textContent =
    blocked ||
    (push.subscribed
      ? 'Zapnuté. Pripomienky prídu aj so zavretou appkou.'
      : 'Zvyk, ktorý sa raz vykoná aj v sne. Niekoľkokrát denne.');
  $('#set-notify').setAttribute('aria-pressed', String(push.subscribed));
  for (const id of ['#notif-time-row', '#notif-checks-row', '#notif-test']) {
    $(id).classList.toggle('hidden', !push.subscribed);
  }
}

/** The reality-check times, each tappable to turn off. */
function renderCheckTimes() {
  const node = $('#notif-checks');
  node.replaceChildren();
  const active = new Set(prefs.checkTimes || DEFAULT_CHECKS);
  for (const time of DEFAULT_CHECKS) {
    const chip = el('button', 'chip', time);
    chip.type = 'button';
    chip.setAttribute('aria-pressed', String(active.has(time)));
    chip.addEventListener('click', async () => {
      const on = chip.getAttribute('aria-pressed') !== 'true';
      chip.setAttribute('aria-pressed', String(on));
      const next = DEFAULT_CHECKS.filter((t) =>
        t === time ? on : (prefs.checkTimes || DEFAULT_CHECKS).includes(t),
      );
      setPref('checkTimes', next);
      await updateSchedule().catch(() => {});
    });
    node.appendChild(chip);
  }
}

$('#set-notify').addEventListener('click', async (e) => {
  const turningOn = e.currentTarget.getAttribute('aria-pressed') !== 'true';
  try {
    if (turningOn) {
      await enableReminders();
      toast('Pripomienky zapnuté');
    } else {
      await disableReminders();
      toast('Pripomienky vypnuté');
    }
  } catch (err) {
    toast(err.message || 'Pripomienky sa nepodarilo zmeniť');
  }
  refreshSettings();
});

$('#notif-time').addEventListener('change', async (e) => {
  setPref('notifyTime', e.target.value);
  await updateSchedule().catch(() => {});
});

/* ------------------------------------------------------- bedtime and WBTB */

const pretty = (t) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
  if (!m) return '';
  const d = new Date();
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return d.toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit', hour12: false });
};

function refreshTonightRows() {
  $('#set-bedtime').value = prefs.bedtime;
  $('#set-bednudge').setAttribute('aria-pressed', String(!!prefs.bedtimeNudge));
  $('#set-wbtb').setAttribute('aria-pressed', String(!!prefs.wbtb));
  $('#wbtb-time-row').classList.toggle('hidden', !prefs.wbtb);
  $('#wbtb-time').value = prefs.wbtbTime || suggestedWbtb();

  // Both ride on the reminder subscription, so say so rather than letting a
  // switch sit on with nothing behind it.
  const noPush = !push.subscribed;
  const at = bedtimeNudgeAt();
  $('#bednudge-hint').textContent = noPush
    ? 'Najprv zapni pripomienky vyššie.'
    : prefs.bedtimeNudge && at
      ? `O ${pretty(at)}, dvadsať minút pred spaním, nech si zopakuješ úmysel.`
      : 'Dvadsať minút pred spaním, nech si zopakuješ úmysel.';

  const wake = wbtbAt();
  $('#wbtb-hint').textContent = noPush
    ? 'Najprv zapni pripomienky vyššie.'
    : prefs.wbtb && wake
      ? `Zobudí ťa o ${pretty(wake)}. Ostaň hore dvadsať minút, potom sa vráť s úmyslom.`
      : 'Najlepšia šanca, aká existuje. Zobudí ťa v neskorom REM, päť hodín po zaspaní.';
}

$('#set-bedtime').addEventListener('change', async (e) => {
  setPref('bedtime', e.target.value);
  // The wake time follows bedtime unless it has been moved by hand.
  if (!prefs.wbtbTime) $('#wbtb-time').value = suggestedWbtb();
  refreshTonightRows();
  await updateSchedule().catch(() => {});
});

$('#set-bednudge').addEventListener('click', async (e) => {
  const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
  if (on && !push.subscribed) return toast('Najprv zapni pripomienky');
  setPref('bedtimeNudge', on);
  refreshTonightRows();
  await updateSchedule().catch(() => {});
  toast(on ? `Nastavené na ${pretty(bedtimeNudgeAt())}` : 'Pripomienka pred spaním vypnutá');
});

$('#set-wbtb').addEventListener('click', async (e) => {
  const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
  if (on && !push.subscribed) return toast('Najprv zapni pripomienky');
  setPref('wbtb', on);
  refreshTonightRows();
  await updateSchedule().catch(() => {});
  toast(on ? `Zobudím ťa o ${pretty(wbtbAt())}` : 'Prebudenie a späť do postele vypnuté');
});

$('#wbtb-time').addEventListener('change', async (e) => {
  setPref('wbtbTime', e.target.value);
  refreshTonightRows();
  await updateSchedule().catch(() => {});
});

$('#notif-test').addEventListener('click', async () => {
  try {
    await sendTest();
    toast('Odoslané — o chvíľu by malo prísť');
  } catch (err) {
    toast(err.message || 'Nepodarilo sa odoslať');
  }
});

/* ------------------------------------------------------------- sharing UI */

function refreshSharing() {
  $('#set-share').setAttribute('aria-pressed', String(prefs.shareLucid !== false));
  const hint = $('#share-hint');
  if (sharing.error) {
    // Never silent again: this used to fail invisibly and look like the other
    // person had simply stopped writing.
    hint.textContent = `Zdieľanie na tomto telefóne nefunguje — ${sharing.error}. Ťukni nižšie na „Znovu pripojiť zdieľanie“.`;
  } else if (!sharing.peerName) {
    hint.textContent = 'Zatiaľ nikto iný nemá účet.';
  } else if (!canShare()) {
    hint.textContent = `${sharing.peerName} si musí raz otvoriť appku, aby zdieľanie fungovalo.`;
  } else {
    hint.textContent = `Lucidné sny idú ${sharing.peerName} automaticky. Obyčajné ostávajú súkromné.`;
  }
  $('#share-count').textContent = sharing.inbox.length ? String(sharing.inbox.length) : '—';
  $('#share-repair').classList.toggle('hidden', !sharing.error && canShare());
}

/** The manual version of the automatic repair, for when it is still stuck. */
$('#share-repair').addEventListener('click', async () => {
  if (!state.vaultKey) return;
  toast('Pripájam znovu…');
  await initSharing(state.vaultKey);
  await refreshInbox().catch(() => {});
  await healSharing();
  renderJournal();
  refreshSettings();
  toast(canShare() ? 'Zdieľanie zase funguje' : sharing.error || 'Stále nepripojené');
});

$('#set-share').addEventListener('click', (e) => {
  setPref('shareLucid', e.currentTarget.getAttribute('aria-pressed') !== 'true');
  refreshSharing();
});

/* ---------------------------------------------------------- device guards */

// Blur the screen the moment the app goes to the background, so the dream
// isn't sitting in the iOS app switcher.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'hidden') {
    if (prefs.privacyScreen) document.body.classList.add('is-private');
    if (prefs.autoLock && state.ready) {
      clearTimeout(saveTimer);
      if (composing) await commit({ silent: true });
      await lock();
      history.replaceState({ view: 'lock' }, '');
      showView('lock', { push: false });
    }
  } else {
    document.body.classList.remove('is-private');
    if (state.ready) sync().then(renderJournal);
  }
});

window.addEventListener('online', () => {
  if (state.ready) sync().then(renderJournal);
});
window.addEventListener('offline', renderJournal);

subscribe(() => {
  if (currentView === 'journal' || currentView === 'compose') renderJournal();
});

/* ------------------------------------------------------------------ boot  */

/**
 * The boot screen covers the gap between first paint and a usable app —
 * recalling the vault key and decrypting a journal is not instant, and the
 * alternative is a blank frame followed by a jump. It is in the HTML rather
 * than built here so it is on screen before any of this has parsed.
 */
const bootedAt = Date.now();

/*
 * A splash that appears for 150ms and vanishes is a flicker, not a splash, so
 * it is held for a beat even when the vault opens instantly. Long enough to
 * read as deliberate, short enough that nobody is kept waiting.
 */
const BOOT_FLOOR_MS = 650;

function dismissBoot() {
  const boot = $('#boot');
  if (!boot || boot.classList.contains('is-gone')) return;
  const wait = Math.max(0, BOOT_FLOOR_MS - (Date.now() - bootedAt));
  setTimeout(() => {
    boot.classList.add('is-gone');
    // Left in the DOM for the length of the fade, then taken out so it can
    // never swallow a tap.
    setTimeout(() => boot.remove(), 900);
  }, wait);
}

function paintSky() {
  starfield($('#sky'));

  const phase = moonPhase();
  $('#boot-moon').replaceChildren(moonSvg(72, phase));
  $('#lock-moon').replaceChildren(moonSvg(64, phase));
  // The real phase, tonight. It is the one thing on the lock screen that is
  // different every time you open it.
  $('#lock-phase').textContent = phaseName(phase);
}

async function boot() {
  applyPrefs();
  paintSky();
  setMode('signin');

  const resumed = await tryResume();
  if (resumed) {
    enterJournal();
  } else {
    history.replaceState({ view: 'lock' }, '');
    showView('lock', { push: false });
    // If nobody has claimed a seat yet, start on the create-account form.
    api
      .status()
      .then((s) => {
        if (s.seats === 2) setMode('signup');
      })
      .catch(() => {});
  }

  dismissBoot();

  // Opened from a notification, or the Home Screen shortcut.
  if (state.ready) openFromLink(new URLSearchParams(location.search));

  // Same thing when the app was already open — the URL will not change, so the
  // service worker says which nudge was tapped instead.
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data?.type === 'NUDGE' && state.ready) {
      openFromLink(new URLSearchParams(`${e.data.kind}=1`));
    }
  });

  watchForUpdates();
}

/**
 * Where a tapped notification lands. Each nudge exists to make one thing
 * happen, so it opens that thing rather than the journal.
 */
function openFromLink(params) {
  const go = (k) => params.get(k) === '1';
  /*
   * The query string is dropped as it is read, so a nudge fires once and once
   * only. Without this, an installed app that restores its last URL would log
   * a fresh reality check on every cold start — and a tally you cannot trust
   * is worse than no tally at all.
   */
  history.replaceState({ view: 'journal' }, '', location.pathname);

  if (go('capture') || go('morning')) return openCompose(null);
  if (go('tonight') || go('bedtime')) return openTonight('bed');
  if (go('wbtb')) return openTonight('wbtb');
  if (go('check')) return askedRealityCheck();
}

/* ---------------------------------------------------------------- updates */

let reloading = false;

/**
 * Applies a waiting update, but never while a dream is half-written.
 *
 * The service worker deliberately does not take over on its own, so this is
 * what decides when the swap happens: silently if nothing is on screen,
 * otherwise by asking.
 */
function applyUpdate(worker) {
  worker.postMessage('SKIP_WAITING');
}

function offerUpdate(worker) {
  const composing = $('#sheet').classList.contains('is-open');
  if (!composing) return applyUpdate(worker); // nothing to lose, just swap

  const bar = $('#update-bar');
  bar.classList.remove('hidden');
  bar.onclick = () => {
    bar.classList.add('hidden');
    applyUpdate(worker);
  };
}

async function watchForUpdates() {
  if (!('serviceWorker' in navigator)) return;

  let registration;
  try {
    registration = await navigator.serviceWorker.register('/sw.js');
  } catch {
    return;
  }

  // The new worker calling skipWaiting is what fires this; reload once so the
  // page and the worker are the same version.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });

  if (registration.waiting) offerUpdate(registration.waiting);

  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener('statechange', () => {
      // "installed" with an existing controller means an update, not a first run.
      if (installing.state === 'installed' && navigator.serviceWorker.controller) {
        offerUpdate(installing);
      }
    });
  });

  // Coming back to the app is the natural moment to look for a new version.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') registration.update().catch(() => {});
  });
  setInterval(() => registration.update().catch(() => {}), 60 * 60 * 1000);
}

boot().catch((err) => {
  // A boot that throws must still hand over to the lock screen rather than
  // leaving the splash up forever.
  console.error(err);
  dismissBoot();
  showView('lock', { push: false });
});
