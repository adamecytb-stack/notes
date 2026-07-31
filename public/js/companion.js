/**
 * The dream companion.
 *
 * This is the only place in the app where dream text leaves the phone in the
 * clear. Everything is gated on an explicit opt-in stored on the device, and
 * the prompt is assembled here — not on the server — so it is visible exactly
 * what gets sent.
 */

import { api } from './api.js';
import { prefs, setPref } from './settings.js';
import { computeStats, environmentInsights, normalise } from './dream.js';

/** How many dreams to include when looking for patterns. */
const PATTERN_WINDOW = 40;

export function hasConsented() {
  return prefs.aiConsent === true;
}

export function grantConsent() {
  setPref('aiConsent', true);
}

export function revokeConsent() {
  setPref('aiConsent', false);
}

/* ------------------------------------------------------- prompt assembly  */

const dateLine = (ts) =>
  new Date(ts).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });

/** Renders one dream as plain text. Empty fields are dropped, not sent blank. */
function renderEntry(raw, { full = true } = {}) {
  const e = normalise(raw);
  const lines = [`--- ${dateLine(raw.dreamedAt)}${e.lucid ? '  [LUCID]' : ''}`];

  if (e.title) lines.push(`Title: ${e.title}`);
  if (full && e.body) lines.push(e.body);
  else if (e.body) lines.push(e.body.slice(0, 400));

  if (e.vividness) lines.push(`Vividness: ${e.vividness}/5`);
  if (e.signs.length) lines.push(`Odd things noticed: ${e.signs.join('; ')}`);
  if (e.theme) lines.push(`What it seemed to be about: ${e.theme}`);

  if (e.lucid) {
    if (e.trigger) lines.push(`Became aware because: ${e.trigger}`);
    if (e.priorActivity) lines.push(`Was doing just before: ${e.priorActivity}`);
    if (e.actions) lines.push(`Once aware, did: ${e.actions}`);
    if (e.excitement) lines.push(`Excitement: ${e.excitement}/5`);
    if (e.duration) lines.push(`Lasted: ${e.duration}`);
    if (e.ending) lines.push(`Ended: ${e.ending}`);
  }

  const env = [];
  if (e.env.place) env.push(`slept at ${e.env.place}`);
  if (e.env.bedtime) env.push(`bedtime ${e.env.bedtime}`);
  if (e.env.wokeInNight) env.push('woke during the night');
  if (e.env.substances.length) env.push(e.env.substances.join(', ').toLowerCase());
  if (env.length) lines.push(`Context: ${env.join('; ')}`);
  if (e.env.notes) lines.push(`Notes: ${e.env.notes}`);

  return lines.join('\n');
}

function statsBlock(entries) {
  const s = computeStats(entries);
  const parts = [
    `${s.total} dreams recorded across ${s.nightsLogged} nights.`,
    `${s.lucidCount} were lucid (${s.lucidRate}%).`,
    `Current streak ${s.streak} nights, longest ${s.longest}.`,
  ];

  const env = environmentInsights(entries);
  if (env.length) {
    parts.push(
      'Lucidity rate by condition (only conditions seen 3+ times): ' +
        env.map((e) => `${e.label} ${e.rate}% of ${e.total}`).join('; '),
    );
  }

  const signs = [...s.signTally.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, n]) => `${name} (${n})`);
  if (signs.length) parts.push(`Most frequent odd elements: ${signs.join('; ')}`);

  return parts.join('\n');
}

/** A reading of the single dream just written. */
export function buildEntryPrompt(entry, allEntries) {
  return [
    'I just wrote this dream down. Read it and tell me what is useful for getting lucid.',
    '',
    renderEntry(entry),
    '',
    'For context, here is where I am overall:',
    statsBlock(allEntries),
    '',
    'Keep it short — a few sentences. Focus on anything in THIS dream that could become a dream sign or an awareness trigger.',
  ].join('\n');
}

/** The full diagnosis — patterns across everything. */
export function buildPatternPrompt(allEntries) {
  const recent = [...allEntries].sort((a, b) => b.dreamedAt - a.dreamedAt).slice(0, PATTERN_WINDOW);

  return [
    'Go through my dream journal and tell me what patterns you see.',
    '',
    'Overall:',
    statsBlock(allEntries),
    '',
    `Here are my last ${recent.length} dreams, newest first:`,
    '',
    recent.map((e) => renderEntry(e)).join('\n\n'),
    '',
    'What I want to know: which recurring elements are worth training as dream signs, what route into awareness seems to work for me specifically, and whether anything about my conditions correlates with getting lucid. Be honest if there is not enough data yet.',
  ].join('\n');
}

/** Sleep-timing advice from when they actually dream. */
export function buildRoutinePrompt(allEntries) {
  const times = allEntries
    .slice(0, 60)
    .map((e) => {
      const d = new Date(e.dreamedAt);
      return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}${e.lucid ? ' (lucid)' : ''}`;
    })
    .join(', ');

  return [
    'These are the times I woke up and recorded a dream, most recent first:',
    times,
    '',
    statsBlock(allEntries),
    '',
    'Based on when I actually seem to be dreaming and waking, when should I go to sleep, and when would a wake-back-to-bed attempt land in my best REM window? Give me specific times, and say what you are inferring them from.',
  ].join('\n');
}

/* ------------------------------------------------------------------ send  */

export class CompanionError extends Error {}

export async function ask(prompt) {
  if (!hasConsented()) {
    throw new CompanionError('The dream companion is switched off in Settings.');
  }
  try {
    const res = await api.ai(prompt);
    return res;
  } catch (err) {
    throw new CompanionError(
      err?.status === 0 ? 'No connection — the companion needs the internet.' : err.message,
    );
  }
}
