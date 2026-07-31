/**
 * The dream model and the lucidity coaching that sits on top of it.
 *
 * The whole app points at one goal: noticing you are dreaming, while you are
 * dreaming. Everything captured here exists because it feeds back into that —
 * dream signs you can learn to recognise, what was happening the moment
 * awareness arrived, and which nights it tends to happen on.
 */

/* ------------------------------------------------------------ the payload */

/**
 * Entry payload, version 2. Version 1 entries were `{title, body}` only; they
 * still decrypt and simply arrive with the newer fields empty.
 */
export function emptyEntry() {
  return {
    v: 2,
    title: '',
    body: '',
    lucid: false,
    vividness: 0, // 1–5, 0 = unanswered

    // Ordinary dreams: the raw material for recognising a dream sign later.
    signs: [], // recurring elements noticed — the things to reality-check against
    theme: '', // what the dream seemed to be about

    // Lucid dreams: what worked, so it can be repeated.
    trigger: '', // what tipped you off
    priorActivity: '', // what you were doing in the dream just before
    actions: '', // what you did once you knew
    excitement: 0, // 1–5 — high excitement is the usual cause of waking straight up
    duration: '', // rough length
    ending: '', // how it ended

    // Context, for spotting what actually moves the needle.
    env: {
      place: '',
      bedtime: '',
      wokeInNight: false,
      substances: [],
      notes: '',
    },
  };
}

/** Fills in anything missing so v1 entries and partial saves render safely. */
export function normalise(payload) {
  const base = emptyEntry();
  if (!payload || typeof payload !== 'object') return base;
  return {
    ...base,
    ...payload,
    signs: Array.isArray(payload.signs) ? payload.signs : [],
    env: { ...base.env, ...(payload.env || {}) },
  };
}

/* ------------------------------------------------------- common dream signs */

/**
 * The recurring oddities most people's dreams reuse. Tapping them is faster
 * than typing at 3am, and the tally across entries is what eventually becomes
 * a personal dream sign worth reality-checking against.
 */
export const DREAM_SIGNS = [
  'Something impossible felt normal',
  'A place that was two places at once',
  'Someone who should not have been there',
  'Text or numbers that would not hold still',
  'Flying, floating, or falling',
  'Teeth, hair, or my body changing',
  'Being chased or watched',
  'Back at school or an old job',
  'A house with a room that should not exist',
  'Losing something I could not find',
  'Technology behaving strangely',
  'Water — swimming, flooding, drowning',
];

export const LUCID_TRIGGERS = [
  'Something did not make logical sense',
  'I did a reality check out of habit',
  'I recognised a recurring dream sign',
  'The dream got unusually vivid',
  'I nearly woke up and slipped back in',
  'Someone in the dream told me',
  'I just knew, with no reason',
];

export const DURATIONS = ['Seconds', 'Under a minute', 'A few minutes', 'Long — 10 min or more'];

export const ENDINGS = [
  'I woke straight up',
  'It faded and I lost awareness',
  'I stayed in but stopped being lucid',
  'I chose to wake up',
];

export const PLACES = ['Home', "A friend's", 'Somewhere new', 'Travelling'];

export const SUBSTANCES = ['Caffeine', 'Alcohol', 'Late meal', 'Screen right before bed', 'None'];

/* ------------------------------------------------------------------- tips */

/**
 * Advice keyed to what actually happened, not generic technique dumps. Each
 * tip fires on a specific condition so what you read is about the dream you
 * just wrote down.
 */
const TIPS = [
  {
    id: 'first-lucid',
    when: (e, s) => e.lucid && s.lucidCount <= 1,
    title: 'That was your first one here',
    body: 'Whatever you did in the hours before this, write it in the notes below. The first few lucid dreams are the cheapest data you will ever get about what works for you.',
  },
  {
    id: 'woke-immediately',
    when: (e) => e.lucid && e.ending === 'I woke straight up',
    title: 'Next time, stay still and rub your hands together',
    body: 'Waking instantly is almost always excitement — the jolt pulls you out. Two things reliably hold the dream: spin slowly on the spot, or rub your palms together and stare at them. Both give your senses something to hold onto instead of the bedroom.',
  },
  {
    id: 'high-excitement',
    when: (e) => e.lucid && e.excitement >= 4 && e.ending !== 'I woke straight up',
    title: 'You held it despite the adrenaline',
    body: 'Getting excited and not waking up is the hard part, and you did it. Whatever you did in those first seconds is your technique now — it is written above, so read it back before bed tonight.',
  },
  {
    id: 'faded',
    when: (e) => e.lucid && e.ending === 'It faded and I lost awareness',
    title: 'Say it out loud inside the dream',
    body: 'Awareness leaks away quietly. Repeating "this is a dream" every few seconds, out loud in the dream, keeps it anchored. Touching things — a wall, the ground — works too.',
  },
  {
    id: 'short',
    when: (e) => e.lucid && (e.duration === 'Seconds' || e.duration === 'Under a minute'),
    title: 'Length comes from stabilising, not from luck',
    body: 'Short lucid dreams are normal early on. Before you try to do anything, spend the first few seconds stabilising: look at your hands, touch a surface, say what you are seeing. The doing can wait.',
  },
  {
    id: 'logic-trigger',
    when: (e) => e.lucid && e.trigger === 'Something did not make logical sense',
    title: 'That is your trigger — feed it',
    body: 'You become aware when something breaks logic. So train the noticing while awake: several times a day, when something is mildly odd or surprising, actually stop and ask whether you are dreaming. You are strengthening exactly the reflex that already works for you.',
  },
  {
    id: 'sign-repeat',
    when: (e, s) => !e.lucid && s.topSign && e.signs.includes(s.topSign.name) && s.topSign.count >= 3,
    title: (e, s) => `"${s.topSign.name}" keeps coming back`,
    body: (e, s) =>
      `That is now in ${s.topSign.count} of your dreams. It is a dream sign — the kind of thing that can tip you off from inside. Picture it before you sleep tonight and tell yourself that when you see it, you will realise you are dreaming.`,
  },
  {
    id: 'no-signs',
    when: (e) => !e.lucid && e.signs.length === 0 && (e.body || '').length > 40,
    title: 'Anything in there that could not happen awake?',
    body: 'Tagging the odd parts is what builds your list of dream signs. It is worth ten seconds — those tags are what you will eventually learn to notice from inside a dream.',
  },
  {
    id: 'vivid-not-lucid',
    when: (e) => !e.lucid && e.vividness >= 4,
    title: 'Vivid dreams are the ones worth reality-checking in',
    body: 'You recall this one sharply, which means your dream recall is working. Try a reality check the moment you wake — look at your hands, check a clock twice. The habit carries into the dream over time.',
  },
  {
    id: 'streak',
    when: (e, s) => s.streak >= 5,
    title: (e, s) => `${s.streak} nights in a row`,
    body: 'Recall and lucidity climb together — people who write every morning get lucid far more often than people who write occasionally. The streak is doing real work.',
  },
  {
    id: 'friends-house',
    when: (e) => e.env.place === "A friend's",
    title: 'Sleeping somewhere unfamiliar helps',
    body: 'A strange bed keeps part of your brain lightly alert, which raises your odds. Worth noting whether that holds for you — the calendar will show it after a few.',
  },
  {
    id: 'woke-in-night',
    when: (e) => e.env.wokeInNight && !e.lucid,
    title: 'You were most of the way to the best technique',
    body: 'Waking in the night is the setup for wake-back-to-bed: get up for 15–20 minutes, stay dim and calm, then go back with the intention of noticing. Late-cycle REM is where most lucid dreams happen.',
  },
  {
    id: 'default',
    when: () => true,
    title: 'Write it down before you move',
    body: 'Dreams fade in about ninety seconds, and moving speeds it up. Staying still with your eyes shut for a moment, replaying the last scene, usually pulls back more than you expect.',
  },
];

/**
 * @returns {{title: string, body: string}} the single most relevant tip.
 */
export function tipFor(entry, stats) {
  const e = normalise(entry);
  const match = TIPS.find((t) => {
    try {
      return t.when(e, stats);
    } catch {
      return false;
    }
  });
  const resolve = (v) => (typeof v === 'function' ? v(e, stats) : v);
  return { title: resolve(match.title), body: resolve(match.body) };
}

/* ------------------------------------------------------------- statistics */

const DAY = 86_400_000;

/** The night a dream belongs to — before noon files under the previous evening. */
export function nightKey(ts) {
  const d = new Date(ts);
  if (d.getHours() < 12) d.setDate(d.getDate() - 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Streak counts *nights recorded*, not calendar days, and today only breaks it
 * once it is over — so an unwritten tonight doesn't punish you at 6pm.
 */
export function computeStats(entries, now = Date.now()) {
  const nights = new Map(); // nightKey -> { logged, lucid }
  let lucidCount = 0;
  const signTally = new Map();

  for (const entry of entries) {
    const key = nightKey(entry.dreamedAt);
    const night = nights.get(key) || { logged: 0, lucid: false };
    night.logged += 1;
    if (entry.lucid) {
      night.lucid = true;
      lucidCount += 1;
    }
    nights.set(key, night);
    for (const sign of entry.signs || []) {
      signTally.set(sign, (signTally.get(sign) || 0) + 1);
    }
  }

  const today = nightKey(now);
  let streak = 0;
  // Tonight not being written yet is not a break — start from last night.
  let cursor = nights.has(today) ? today : today - DAY;
  while (nights.has(cursor)) {
    streak += 1;
    cursor -= DAY;
  }

  let longest = 0;
  let run = 0;
  const ordered = [...nights.keys()].sort((a, b) => a - b);
  for (let i = 0; i < ordered.length; i++) {
    run = i > 0 && ordered[i] - ordered[i - 1] === DAY ? run + 1 : 1;
    longest = Math.max(longest, run);
  }

  const topSign = [...signTally.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)[0];

  const lucidNights = [...nights.values()].filter((n) => n.lucid).length;

  return {
    nights,
    total: entries.length,
    lucidCount,
    lucidRate: entries.length ? Math.round((lucidCount / entries.length) * 100) : 0,
    nightsLogged: nights.size,
    lucidNights,
    streak,
    longest,
    topSign,
    signTally,
  };
}

/** Which environment factors show up disproportionately on lucid nights. */
export function environmentInsights(entries) {
  const buckets = new Map(); // label -> { total, lucid }
  const add = (label, isLucid) => {
    if (!label) return;
    const b = buckets.get(label) || { total: 0, lucid: 0 };
    b.total += 1;
    if (isLucid) b.lucid += 1;
    buckets.set(label, b);
  };

  for (const e of entries) {
    add(e.env?.place, e.lucid);
    if (e.env?.wokeInNight) add('Woke during the night', e.lucid);
    for (const s of e.env?.substances || []) add(s, e.lucid);
  }

  // Three nights is not proof of anything, but it's enough to be worth showing.
  return [...buckets.entries()]
    .filter(([, b]) => b.total >= 3)
    .map(([label, b]) => ({ label, ...b, rate: Math.round((b.lucid / b.total) * 100) }))
    .sort((a, b) => b.rate - a.rate);
}
