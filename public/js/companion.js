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
  new Date(ts).toLocaleString('sk-SK', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });

/** Renders one dream as plain text. Empty fields are dropped, not sent blank. */
function renderEntry(raw, { full = true } = {}) {
  const e = normalise(raw);
  const lines = [`--- ${dateLine(raw.dreamedAt)}${e.lucid ? '  [LUCIDNÝ]' : ''}`];

  if (e.title) lines.push(`Názov: ${e.title}`);
  if (full && e.body) lines.push(e.body);
  else if (e.body) lines.push(e.body.slice(0, 400));

  if (e.vividness) lines.push(`Živosť: ${e.vividness}/5`);
  if (e.signs.length) lines.push(`Všimnuté zvláštnosti: ${e.signs.join('; ')}`);
  if (e.theme) lines.push(`O čom to podľa mňa bolo: ${e.theme}`);

  if (e.lucid) {
    if (e.trigger) lines.push(`Uvedomil som si to vďaka: ${e.trigger}`);
    if (e.priorActivity) lines.push(`Tesne predtým som robil: ${e.priorActivity}`);
    if (e.actions) lines.push(`Keď som to vedel, robil som: ${e.actions}`);
    if (e.excitement) lines.push(`Vzrušenie: ${e.excitement}/5`);
    if (e.duration) lines.push(`Trvalo: ${e.duration}`);
    if (e.ending) lines.push(`Skončilo: ${e.ending}`);
  }

  const env = [];
  if (e.env.place) env.push(`spal som: ${e.env.place}`);
  if (e.env.bedtime) env.push(`išiel som spať o ${e.env.bedtime}`);
  if (e.env.wokeInNight) env.push('v noci som sa zobudil');
  if (e.env.substances.length) env.push(e.env.substances.join(', ').toLowerCase());
  if (env.length) lines.push(`Okolnosti: ${env.join('; ')}`);
  if (e.env.notes) lines.push(`Poznámky: ${e.env.notes}`);

  return lines.join('\n');
}

function statsBlock(entries) {
  const s = computeStats(entries);
  const parts = [
    `${s.total} zapísaných snov za ${s.nightsLogged} nocí.`,
    `${s.lucidCount} z nich bolo lucidných (${s.lucidRate} %).`,
    `Aktuálna séria ${s.streak} nocí, najdlhšia ${s.longest}.`,
  ];

  const env = environmentInsights(entries);
  if (env.length) {
    parts.push(
      'Miera lucidity podľa okolností (len okolnosti videné 3× a viac): ' +
        env.map((e) => `${e.label} ${e.rate} % z ${e.total}`).join('; '),
    );
  }

  const signs = [...s.signTally.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, n]) => `${name} (${n})`);
  if (signs.length) parts.push(`Najčastejšie zvláštnosti: ${signs.join('; ')}`);

  return parts.join('\n');
}

/** A reading of the single dream just written. */
export function buildEntryPrompt(entry, allEntries) {
  return [
    'Práve som si zapísal tento sen. Prečítaj si ho a povedz mi, čo je z neho užitočné pre lucidné snívanie.',
    '',
    renderEntry(entry),
    '',
    'Pre kontext, takto na tom celkovo som:',
    statsBlock(allEntries),
    '',
    'Buď stručný — pár viet. Sústreď sa na to, čo v TOMTO sne by sa mohlo stať znakom sna alebo spúšťačom uvedomenia.',
  ].join('\n');
}

/** The full diagnosis — patterns across everything. */
export function buildPatternPrompt(allEntries) {
  const recent = [...allEntries].sort((a, b) => b.dreamedAt - a.dreamedAt).slice(0, PATTERN_WINDOW);

  return [
    'Prejdi môj snový denník a povedz mi, aké vzorce v ňom vidíš.',
    '',
    'Celkovo:',
    statsBlock(allEntries),
    '',
    `Tu je mojich posledných ${recent.length} snov, od najnovšieho:`,
    '',
    recent.map((e) => renderEntry(e)).join('\n\n'),
    '',
    'Chcem vedieť: ktoré opakujúce sa prvky sa oplatí trénovať ako znaky sna, ktorá cesta k uvedomeniu funguje konkrétne mne, a či niektoré okolnosti súvisia s tým, že sa mi podarí zlucidnieť. Buď úprimný, ak zatiaľ nie je dosť dát.',
  ].join('\n');
}

/** Sleep-timing advice from when they actually dream. */
export function buildRoutinePrompt(allEntries) {
  const times = allEntries
    .slice(0, 60)
    .map((e) => {
      const d = new Date(e.dreamedAt);
      return `${d.toLocaleDateString('sk-SK', { weekday: 'short' })} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}${e.lucid ? ' (lucidný)' : ''}`;
    })
    .join(', ');

  return [
    'Toto sú časy, kedy som sa zobudil a zapísal si sen, od najnovšieho:',
    times,
    '',
    statsBlock(allEntries),
    '',
    'Podľa toho, kedy naozaj snívam a budím sa — kedy by som mal chodiť spať a kedy by mi pokus o prebudenie a späť do postele padol do najlepšieho REM okna? Daj mi konkrétne časy a povedz, z čoho ich vyvodzuješ.',
  ].join('\n');
}

/* ------------------------------------------------------------------ send  */

export class CompanionError extends Error {}

export async function ask(prompt) {
  if (!hasConsented()) {
    throw new CompanionError('Snový spoločník je v Nastaveniach vypnutý.');
  }
  try {
    const res = await api.ai(prompt);
    return res;
  } catch (err) {
    throw new CompanionError(
      err?.status === 0 ? 'Bez pripojenia — spoločník potrebuje internet.' : err.message,
    );
  }
}
