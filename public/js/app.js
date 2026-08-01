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

const APP_VERSION = '0.2.0';

/* ------------------------------------------------------------------ views */

let currentView = 'lock';
let composing = null; // { id, dreamedAt }

const SCREENS = {
  lock: '#screen-lock',
  journal: '#screen-journal',
  patterns: '#screen-patterns',
  settings: '#screen-settings',
};

function showView(view, { push = true } = {}) {
  const base = view === 'compose' ? 'journal' : view;
  currentView = view;

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
  $('#lock-submit-label').textContent = signup ? 'Create journal' : 'Unlock';
  $('#lock-switch').textContent = signup
    ? 'Already have an account? Sign in'
    : 'First time here? Create your account';
  $('#f-passphrase').setAttribute('autocomplete', signup ? 'new-password' : 'current-password');
  $('#lock-sub').textContent = signup
    ? 'Pick a passphrase you will not forget. It is the only thing that can decrypt your dreams — not even the server can.'
    : 'Your dreams are encrypted on this phone before they ever leave it.';
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
    errorNode.textContent = 'Both fields, please.';
    return;
  }
  if (mode === 'signup' && passphrase.length < 10) {
    errorNode.textContent = 'Use at least 10 characters — this is the only key to your dreams.';
    return;
  }

  submit.disabled = true;
  const original = label.textContent;
  label.textContent = mode === 'signup' ? 'Creating…' : 'Unlocking…';
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
        ? 'No connection. Try again when you have signal.'
        : err.message || 'Something went wrong.';
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
    if (resealed) toast(`Re-shared ${resealed} dream${resealed === 1 ? '' : 's'} with them`);
  }
  if (sharing.repaired) {
    sharing.repaired = false;
    toast('Sharing has been reconnected');
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
        : `${count} shared with you`
      : count === 0
        ? ''
        : count === 1
          ? '1 dream kept'
          : `${count} dreams kept`;

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
  const { hour, minute, meridiem } = clockParts(entry.dreamedAt);
  const time = el('span', 'entry__time');
  time.append(hour, el('i', null, '·'), minute);
  when.append(time, el('span', 'entry__meridiem', meridiem));

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
    slot.appendChild(el('p', 'error', 'This could not be decrypted.'));
  } else {
    if (entry.body) slot.appendChild(el('p', 'reading__p', entry.body));
    const facts = [];
    if (entry.lucid) {
      if (entry.trigger) facts.push(`Became aware because: ${entry.trigger}`);
      if (entry.actions) facts.push(`Once aware: ${entry.actions}`);
      if (entry.duration) facts.push(`Lasted: ${entry.duration}`);
      if (entry.ending) facts.push(`Ended: ${entry.ending}`);
    }
    if (entry.signs?.length) facts.push(`Dream signs: ${entry.signs.join('; ')}`);
    for (const f of facts) slot.appendChild(el('p', 'note', f));
  }

  openModal({
    title: entry.title || (entry.lucid ? 'A lucid dream' : 'A dream'),
    body: `${entry.from} · ${fullStamp(entry.dreamedAt)}`,
    slot,
    actions: [{ label: 'Close', kind: 'btn--ghost', onClick: closeModal }],
  });
}

function renderEmptyShared() {
  const wrap = el('div', 'empty');
  const mark = icon('i-spark', 56);
  mark.classList.add('empty__mark');
  wrap.append(
    mark,
    el('h2', 'empty__title', `Nothing from ${sharing.peerName} yet`),
    el(
      'p',
      'empty__body',
      canShare()
        ? 'Lucid dreams either of you record get shared here automatically. Ordinary ones stay private.'
        : 'They need to open the app once so their keys exist, then sharing works both ways.',
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
    el('h2', 'empty__title', 'Nothing written down yet'),
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
      heading: 'Could not be decrypted',
      excerpt: 'This entry was written with a different passphrase.',
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
      ? 'no streak yet — tonight starts one'
      : stats.streak === 1
        ? 'night so far'
        : 'nights in a row';

  $('#stat-lucid').textContent = String(stats.lucidCount);
  $('#stat-rate').textContent = `${stats.lucidRate}%`;
  $('#stat-total').textContent = String(stats.total);
  $('#stat-longest').textContent = String(stats.longest);

  renderCalendar(stats);
  renderSigns(stats);
  renderConditions(entries);
}

/**
 * Six weeks ending today, as a grid of nights. A night is "logged" if anything
 * was written for it; lucid nights glow.
 */
function renderCalendar(stats) {
  const cal = $('#cal');
  cal.replaceChildren();

  const today = nightKey(Date.now());
  const WEEKS = 6;
  // Back up to the Monday of the week containing the earliest day shown.
  const start = new Date(today - (WEEKS * 7 - 1) * DAY_MS);
  const shift = (start.getDay() + 6) % 7; // Monday = 0
  start.setDate(start.getDate() - shift);
  start.setHours(0, 0, 0, 0);

  for (const label of ['M', 'T', 'W', 'T', 'F', 'S', 'S']) {
    cal.appendChild(el('span', 'cal__dow', label));
  }

  for (let i = 0; i < WEEKS * 7 + shift; i++) {
    const key = start.getTime() + i * DAY_MS;
    if (key > today) {
      cal.appendChild(el('span', 'cal__cell cal__cell--future'));
      continue;
    }
    const night = stats.nights.get(key);
    const cell = el('button', 'cal__cell');
    cell.type = 'button';
    cell.textContent = String(new Date(key).getDate());
    if (night) cell.classList.add(night.lucid ? 'is-lucid' : 'is-logged');
    if (key === today) cell.classList.add('is-today');

    const stamp = new Date(key).toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
    cell.setAttribute(
      'aria-label',
      night
        ? `${stamp}: ${night.logged} dream${night.logged === 1 ? '' : 's'}${night.lucid ? ', lucid' : ''}`
        : `${stamp}: nothing written`,
    );
    cell.addEventListener('click', () => {
      if (!night) return toast('Nothing written that night');
      toast(cell.getAttribute('aria-label'));
    });
    cal.appendChild(cell);
  }

  const first = new Date(start);
  const label =
    first.getMonth() === new Date(today).getMonth()
      ? new Date(today).toLocaleDateString(undefined, { month: 'long' })
      : `${first.toLocaleDateString(undefined, { month: 'short' })} – ${new Date(today).toLocaleDateString(undefined, { month: 'short' })}`;
  $('#cal-label').textContent = `Last six weeks · ${label}`;
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
      ? `"${top.label}" is in ${top.value} of your dreams. Picture it before sleep and tell yourself that when you see it, you will know you are dreaming.`
      : 'Tag the odd parts of a few more dreams and the recurring ones will surface here.';

  renderBars($('#signs'), rows, rows[0].value);
}

function renderConditions(entries) {
  const insights = environmentInsights(entries);
  $('#cond-group').classList.toggle('hidden', insights.length === 0);
  if (!insights.length) {
    return;
  }

  $('#cond-note').textContent =
    'Share of nights that went lucid, for conditions you have logged at least three times. Small numbers — treat it as a hint, not a finding.';

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
function showStep(next) {
  step = Math.max(0, Math.min(STEPS.length - 1, next));

  for (const section of document.querySelectorAll('.step')) {
    section.classList.toggle('is-active', Number(section.dataset.step) === step);
  }

  $('#compose-back').classList.toggle('is-hidden', step === 0);
  const last = step === STEPS.length - 1;
  $('#compose-next').textContent = last ? 'Keep' : 'Next';

  renderDots();
  $('#compose-scroll').scrollTop = 0;

  // Put the cursor where the answer goes, so typing can start immediately.
  if (STEPS[step] === 'name') titleInput.focus();
  if (STEPS[step] === 'story') bodyInput.focus();
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
    if (entry) showReading('On this dream', (all) => buildEntryPrompt(entry, all));
  } else {
    toast('Kept');
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
  statusNode.textContent = 'Saving…';
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
  // Answering is the whole point of this step, so move on without a second tap.
  // Synchronously, not after a beat: iOS only raises the keyboard for a focus()
  // that happens inside the tap itself, and the next step wants the keyboard.
  if (step === 0) showStep(1);

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
    $('#share-label').textContent = `Share this with ${sharing.peerName}`;
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
    toast('Write something first');
    return;
  }
  try {
    if (on) {
      await shareEntry(state.entries.get(id));
      toast(`Shared with ${sharing.peerName}`);
    } else {
      await unshareEntry(id);
      toast('No longer shared');
    }
  } catch (err) {
    e.currentTarget.setAttribute('aria-pressed', String(!on));
    toast(err.message || 'Could not change sharing');
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

for (const input of [titleInput, bodyInput]) {
  // Encrypted autosave: after two seconds of stillness the dream is safe,
  // whether or not anyone reaches the end of the questions.
  input.addEventListener('input', mark);
}

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
    statusNode.textContent = state.entries.get(id)?.pending ? 'Saved on this phone' : 'Saved';
    statusNode.classList.add('is-saved');
    renderJournal();
    return id;
  } catch (err) {
    statusNode.textContent = 'Could not save';
    if (!silent) toast(err.message || 'Could not save');
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
    title: 'Delete this dream?',
    body: 'It will be removed from the server too. This cannot be undone.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  clearTimeout(saveTimer);
  if (composing.id) await removeEntry(composing.id);
  closeCompose();
  renderJournal();
  toast('Deleted');
});

/** Lets you file a dream under the night it actually happened. */
$('#compose-when').addEventListener('click', () => {
  const input = el('input', 'input');
  input.type = 'datetime-local';
  input.value = toLocalInputValue(composing.dreamedAt);
  const wrap = el('div', 'stack');
  wrap.appendChild(input);

  openModal({
    title: 'When was this dream?',
    body: 'Dreams before noon are filed under the night before.',
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
  refreshPushState().then(updateNotifyHint);
  updateNotifyHint();

  refreshSharing();
  refreshCompanion();

  $('#about-note').textContent = `Nocturne ${APP_VERSION} · Entries are encrypted with AES-GCM on this device. The server stores only ciphertext and cannot read them.`;

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
    title: 'Sign out?',
    body: 'Your dreams stay on the server. You will need your passphrase to read them again.',
    confirmLabel: 'Sign out',
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
  toast('Exported');
});

$('#set-export-json').addEventListener('click', () => {
  download(`nocturne-${new Date().toISOString().slice(0, 10)}.json`, exportJson(), 'application/json');
  toast('Exported');
});

$('#set-delete').addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: 'Delete your journal?',
    body: 'Every dream you have written will be erased from the server permanently. Export first if you want to keep a copy.',
    confirmLabel: 'Delete everything',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.deleteAccount();
    await signOut();
    history.replaceState({ view: 'lock' }, '');
    showView('lock', { push: false });
    setMode('signin');
    toast('Journal deleted');
  } catch (err) {
    toast(err.message || 'Could not delete');
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

  const current = make('Current passphrase', 'pp-current', 'current-password');
  const next = make('New passphrase', 'pp-next', 'new-password');
  const again = make('New passphrase again', 'pp-again', 'new-password');
  const error = el('p', 'error');
  form.appendChild(error);

  openModal({
    title: 'Change passphrase',
    body: 'Every entry is decrypted and re-encrypted on this phone. Keep the app open until it finishes.',
    slot: form,
    actions: [
      {
        label: 'Change it',
        kind: 'btn--primary',
        onClick: async (btn) => {
          error.textContent = '';
          if (next.value.length < 10) {
            error.textContent = 'Use at least 10 characters.';
            return;
          }
          if (next.value !== again.value) {
            error.textContent = 'The new passphrases do not match.';
            return;
          }
          btn.disabled = true;
          btn.textContent = 'Re-encrypting…';
          try {
            await changePassphrase(current.value, next.value);
            closeModal();
            toast('Passphrase changed');
          } catch (err) {
            error.textContent = err.message || 'Could not change it.';
            btn.disabled = false;
            btn.textContent = 'Change it';
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
    hint.textContent = 'No Gemini key is set on the server yet, so this cannot run.';
  } else if (on) {
    hint.textContent =
      'On. Dream text is decrypted here and sent to Google Gemini when you ask for a reading.';
  } else {
    hint.textContent = 'Off. Nothing is sent anywhere until you turn this on.';
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
      'Your dreams are decrypted on this phone and sent to Google Gemini to be read.',
      'They pass through your own server on the way. Everywhere else in this app, the server only ever sees ciphertext.',
      'On Gemini’s free tier, Google may use what you send to improve its products. Enabling billing on the key stops that.',
      'Nothing is sent until you ask for a reading, and nothing is stored by the companion.',
    ];
    for (const p of points) {
      const row = el('p', 'note');
      row.textContent = `· ${p}`;
      body.appendChild(row);
    }

    openModal({
      title: 'Before it reads anything',
      body: 'This is the only feature that sends your dreams off this phone. Read this properly.',
      slot: body,
      dismissable: false,
      actions: [
        {
          label: 'I understand — turn it on',
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
    toast('No Gemini key is set on the server');
    return;
  }
  if (await askConsent()) grantConsent();
  refreshCompanion();
});

$('#set-ai-auto').addEventListener('click', (e) => {
  if (!hasConsented()) {
    toast('Turn the companion on first');
    return;
  }
  setPref('aiAfterEntry', e.currentTarget.getAttribute('aria-pressed') !== 'true');
  refreshCompanion();
});

/** Opens the reading panel, then fills it in when the answer arrives. */
async function showReading(title, buildPrompt) {
  if (!hasConsented() || !aiAvailable) {
    toast(aiAvailable ? 'Turn the companion on first' : 'No Gemini key is set on the server');
    return;
  }

  const entries = sortedEntries();
  if (!entries.length) {
    toast('Write a dream down first');
    return;
  }

  const slot = el('div', 'reading');
  slot.appendChild(el('div', 'spinner'));
  openModal({
    title,
    slot,
    actions: [{ label: 'Close', kind: 'btn--ghost', onClick: closeModal }],
  });

  try {
    const { text } = await ask(buildPrompt(entries));
    slot.replaceChildren();
    // Plain paragraphs, set as text — never innerHTML with model output.
    for (const para of text.split(/\n{2,}/)) {
      if (para.trim()) slot.appendChild(el('p', 'reading__p', para.trim()));
    }
  } catch (err) {
    slot.replaceChildren(el('p', 'error', err.message || 'That did not work.'));
  }
}

$('#ai-patterns').addEventListener('click', () =>
  showReading('What I see in your dreams', buildPatternPrompt),
);

$('#ai-routine').addEventListener('click', () =>
  showReading('Your sleep timing', buildRoutinePrompt),
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
      ? 'On. Reminders arrive with the app closed.'
      : 'The habit that gets performed inside a dream. Several a day.');
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
      toast('Reminders on');
    } else {
      await disableReminders();
      toast('Reminders off');
    }
  } catch (err) {
    toast(err.message || 'Could not change reminders');
  }
  refreshSettings();
});

$('#notif-time').addEventListener('change', async (e) => {
  setPref('notifyTime', e.target.value);
  await updateSchedule().catch(() => {});
});

$('#notif-test').addEventListener('click', async () => {
  try {
    await sendTest();
    toast('Sent — it should arrive in a moment');
  } catch (err) {
    toast(err.message || 'Could not send');
  }
});

/* ------------------------------------------------------------- sharing UI */

function refreshSharing() {
  $('#set-share').setAttribute('aria-pressed', String(prefs.shareLucid !== false));
  const hint = $('#share-hint');
  if (sharing.error) {
    // Never silent again: this used to fail invisibly and look like the other
    // person had simply stopped writing.
    hint.textContent = `Sharing is not working on this phone — ${sharing.error}. Tap "Reconnect sharing" below.`;
  } else if (!sharing.peerName) {
    hint.textContent = 'Nobody else has an account yet.';
  } else if (!canShare()) {
    hint.textContent = `${sharing.peerName} needs to open the app once before sharing can work.`;
  } else {
    hint.textContent = `Lucid dreams go to ${sharing.peerName} automatically. Ordinary ones stay private.`;
  }
  $('#share-count').textContent = sharing.inbox.length ? String(sharing.inbox.length) : '—';
  $('#share-repair').classList.toggle('hidden', !sharing.error && canShare());
}

/** The manual version of the automatic repair, for when it is still stuck. */
$('#share-repair').addEventListener('click', async () => {
  if (!state.vaultKey) return;
  toast('Reconnecting…');
  await initSharing(state.vaultKey);
  await refreshInbox().catch(() => {});
  await healSharing();
  renderJournal();
  refreshSettings();
  toast(canShare() ? 'Sharing is working again' : sharing.error || 'Still not connected');
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

async function boot() {
  applyPrefs();
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

  // Launched from the Home Screen shortcut: go straight to writing.
  if (new URLSearchParams(location.search).get('capture') === '1' && state.ready) {
    history.replaceState({ view: 'journal' }, '');
    openCompose(null);
  }

  watchForUpdates();
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

boot();
