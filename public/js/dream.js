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
    // null = not asked yet, which is a different thing from answering "no".
    // Everything that reads this only tests truthiness, so null behaves as no.
    lucid: null,
    mood: 0, // 1–5, how it felt. 0 = unanswered
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

/*
 * The app used to be in English, and the answers you tapped were stored as the
 * English sentence itself — inside the encrypted payload, on the server, where
 * nothing can rewrite them. So they are translated on the way out instead.
 *
 * Without this, every dream written before the app was Slovak would open with
 * its chips unselected, its dream signs counted as separate things from the
 * identical Slovak ones, and its tips silently never firing. It looks exactly
 * like data loss, and there is no way to tell the difference from inside.
 */
const LEGACY = {
  'Something impossible felt normal': 'Niečo nemožné mi prišlo úplne normálne',
  'A place that was two places at once': 'Miesto, ktoré bolo dvoma miestami naraz',
  'Someone who should not have been there': 'Niekto, kto tam nemal čo robiť',
  'Text or numbers that would not hold still': 'Text alebo čísla, ktoré neostávali rovnaké',
  'Flying, floating, or falling': 'Lietanie, vznášanie sa alebo pád',
  'Teeth, hair, or my body changing': 'Zuby, vlasy alebo moje telo sa menili',
  'Being chased or watched': 'Niekto ma naháňal alebo sledoval',
  'Back at school or an old job': 'Späť v škole alebo v starej robote',
  'A house with a room that should not exist': 'Dom s miestnosťou, ktorá tam nemá byť',
  'Losing something I could not find': 'Stratil som niečo, čo som nevedel nájsť',
  'Technology behaving strangely': 'Technika sa správala čudne',
  'Water — swimming, flooding, drowning': 'Voda — plávanie, záplava, topenie',

  'Something did not make logical sense': 'Niečo nedávalo logický zmysel',
  'I did a reality check out of habit': 'Zo zvyku som si spravil test reality',
  'I recognised a recurring dream sign': 'Spoznal som opakujúci sa znak sna',
  'The dream got unusually vivid': 'Sen bol nezvyčajne živý',
  'I nearly woke up and slipped back in': 'Skoro som sa zobudil a skĺzol späť dnu',
  'Someone in the dream told me': 'Niekto v sne mi to povedal',
  'I just knew, with no reason': 'Jednoducho som to vedel, bez dôvodu',

  Seconds: 'Sekundy',
  'Under a minute': 'Menej ako minútu',
  'A few minutes': 'Pár minút',
  'Long — 10 min or more': 'Dlho — 10 minút a viac',

  'I woke straight up': 'Hneď som sa zobudil',
  'It faded and I lost awareness': 'Vyblednul a stratil som uvedomenie',
  'I stayed in but stopped being lucid': 'Ostal som v ňom, ale prestal som byť lucidný',
  'I chose to wake up': 'Rozhodol som sa zobudiť',

  Home: 'Doma',
  "A friend's": 'U kamaráta',
  'Somewhere new': 'Niekde nové',
  Travelling: 'Na cestách',

  Caffeine: 'Kofeín',
  Alcohol: 'Alkohol',
  'Late meal': 'Neskoré jedlo',
  'Screen right before bed': 'Obrazovka tesne pred spaním',
  None: 'Nič',
};

const sk = (v) => (typeof v === 'string' && LEGACY[v]) || v;

/** Fills in anything missing so v1 entries and partial saves render safely. */
export function normalise(payload) {
  const base = emptyEntry();
  if (!payload || typeof payload !== 'object') return base;
  const env = { ...base.env, ...(payload.env || {}) };
  return {
    ...base,
    ...payload,
    trigger: sk(payload.trigger),
    duration: sk(payload.duration),
    ending: sk(payload.ending),
    signs: Array.isArray(payload.signs) ? payload.signs.map(sk) : [],
    env: {
      ...env,
      place: sk(env.place),
      substances: Array.isArray(env.substances) ? env.substances.map(sk) : [],
    },
  };
}

/* ------------------------------------------------------- common dream signs */

/**
 * The recurring oddities most people's dreams reuse. Tapping them is faster
 * than typing at 3am, and the tally across entries is what eventually becomes
 * a personal dream sign worth reality-checking against.
 */
export const DREAM_SIGNS = [
  'Niečo nemožné mi prišlo úplne normálne',
  'Miesto, ktoré bolo dvoma miestami naraz',
  'Niekto, kto tam nemal čo robiť',
  'Text alebo čísla, ktoré neostávali rovnaké',
  'Lietanie, vznášanie sa alebo pád',
  'Zuby, vlasy alebo moje telo sa menili',
  'Niekto ma naháňal alebo sledoval',
  'Späť v škole alebo v starej robote',
  'Dom s miestnosťou, ktorá tam nemá byť',
  'Stratil som niečo, čo som nevedel nájsť',
  'Technika sa správala čudne',
  'Voda — plávanie, záplava, topenie',
];

export const LUCID_TRIGGERS = [
  'Niečo nedávalo logický zmysel',
  'Zo zvyku som si spravil test reality',
  'Spoznal som opakujúci sa znak sna',
  'Sen bol nezvyčajne živý',
  'Skoro som sa zobudil a skĺzol späť dnu',
  'Niekto v sne mi to povedal',
  'Jednoducho som to vedel, bez dôvodu',
];

export const DURATIONS = ['Sekundy', 'Menej ako minútu', 'Pár minút', 'Dlho — 10 minút a viac'];

export const ENDINGS = [
  'Hneď som sa zobudil',
  'Vyblednul a stratil som uvedomenie',
  'Ostal som v ňom, ale prestal som byť lucidný',
  'Rozhodol som sa zobudiť',
];

export const PLACES = ['Doma', 'U kamaráta', 'Niekde nové', 'Na cestách'];

export const SUBSTANCES = ['Kofeín', 'Alkohol', 'Neskoré jedlo', 'Obrazovka tesne pred spaním', 'Nič'];

/*
 * Tips test these by identity rather than by repeating the sentence. A literal
 * copy of an answer inside a condition is a silent failure waiting to happen:
 * reword the chip and the tip simply stops firing, with nothing to notice.
 */
export const WOKE_STRAIGHT_UP = ENDINGS[0];
export const FADED_OUT = ENDINGS[1];
export const SECONDS = DURATIONS[0];
export const UNDER_A_MINUTE = DURATIONS[1];
export const ILLOGICAL = LUCID_TRIGGERS[0];
export const AT_A_FRIENDS = PLACES[1];
export const WOKE_IN_NIGHT = 'Zobudil som sa v noci';

/* ------------------------------------------------------------------- tips */

/**
 * Advice keyed to what actually happened, not generic technique dumps. Each
 * tip fires on a specific condition so what you read is about the dream you
 * just wrote down.
 */
/*
 * Order is priority — the first match wins. Tips that change what happens next
 * time are deliberately above tips that only comment on what happened, so a
 * first lucid dream that ended too early gets the stabilising advice rather
 * than congratulations.
 */
const TIPS = [
  {
    id: 'woke-immediately',
    when: (e) => e.lucid && e.ending === WOKE_STRAIGHT_UP,
    title: 'Nabudúce ostaň bez pohybu a pošúchaj si dlane',
    body: 'Okamžité prebudenie je takmer vždy vzrušenie — ten nával ťa vytiahne von. Dve veci sen spoľahlivo udržia: pomaly sa toč na mieste, alebo si šúchaj dlane a pozeraj sa na ne. Obe dajú tvojim zmyslom niečo, čoho sa chytia namiesto spálne.',
  },
  {
    id: 'faded',
    when: (e) => e.lucid && e.ending === FADED_OUT,
    title: 'Povedz to nahlas priamo v sne',
    body: 'Uvedomenie potichu vyprcháva. Keď každých pár sekúnd nahlas zopakuješ „toto je sen“, ukotvíš ho. Pomáha aj dotýkať sa vecí — steny, zeme.',
  },
  {
    id: 'first-lucid',
    when: (e, s) => e.lucid && s.lucidCount <= 1,
    title: 'To bol tvoj prvý zapísaný',
    body: 'Čokoľvek si robil v hodinách predtým, napíš to dole do poznámok. Prvých pár lucidných snov sú najlacnejšie dáta o tom, čo funguje práve tebe.',
  },
  {
    id: 'high-excitement',
    when: (e) => e.lucid && e.excitement >= 4 && e.ending !== WOKE_STRAIGHT_UP,
    title: 'Udržal si ho aj napriek adrenalínu',
    body: 'Byť nadšený a nezobudiť sa je tá ťažká časť, a ty si to dal. Čokoľvek si spravil v tých prvých sekundách, je odteraz tvoja technika — máš to napísané vyššie, tak si to dnes pred spaním prečítaj.',
  },
  {
    id: 'short',
    when: (e) => e.lucid && (e.duration === SECONDS || e.duration === UNDER_A_MINUTE),
    title: 'Dĺžka je o stabilizácii, nie o šťastí',
    body: 'Krátke lucidné sny sú na začiatku normálne. Skôr než sa pustíš do čohokoľvek, venuj prvých pár sekúnd stabilizácii: pozri sa na ruky, dotkni sa nejakého povrchu, popíš nahlas, čo vidíš. Konanie počká.',
  },
  {
    id: 'logic-trigger',
    when: (e) => e.lucid && e.trigger === ILLOGICAL,
    title: 'To je tvoj spúšťač — kŕm ho',
    body: 'Uvedomíš si to, keď niečo poruší logiku. Tak si to všímanie trénuj aj v bdení: niekoľkokrát denne, keď je niečo mierne čudné alebo prekvapivé, naozaj zastav a opýtaj sa, či nesnívaš. Posilňuješ presne ten reflex, ktorý ti už funguje.',
  },
  {
    id: 'sign-repeat',
    when: (e, s) => !e.lucid && s.topSign && e.signs.includes(s.topSign.name) && s.topSign.count >= 3,
    title: (e, s) => `„${s.topSign.name}“ sa stále vracia`,
    body: (e, s) =>
      `To máš už v ${s.topSign.count} snoch. Je to znak sna — presne tá vec, ktorá ťa môže upozorniť zvnútra. Dnes pred spaním si to predstav a povedz si, že keď to uvidíš, uvedomíš si, že snívaš.`,
  },
  {
    id: 'no-signs',
    when: (e) => !e.lucid && e.signs.length === 0 && (e.body || '').length > 40,
    title: 'Bolo tam niečo, čo by sa v bdení stať nemohlo?',
    body: 'Označovanie tých čudných častí ti buduje zoznam znakov sna. Stojí to za desať sekúnd — práve tieto značky sa raz naučíš všímať si zvnútra sna.',
  },
  {
    id: 'vivid-not-lucid',
    when: (e) => !e.lucid && e.vividness >= 4,
    title: 'Práve v živých snoch sa oplatí robiť testy reality',
    body: 'Tento si pamätáš ostro, čo znamená, že ti vybavovanie snov funguje. Skús si spraviť test reality hneď po prebudení — pozri sa na ruky, dvakrát skontroluj hodiny. Ten zvyk sa časom prenesie aj do sna.',
  },
  {
    id: 'streak',
    when: (e, s) => s.streak >= 5,
    title: (e, s) => `${s.streak} nocí v rade`,
    body: 'Vybavovanie a lucidita rastú spolu — ľudia, čo píšu každé ráno, zlucidnejú oveľa častejšie než tí, čo píšu občas. Tá séria robí skutočnú prácu.',
  },
  {
    id: 'friends-house',
    when: (e) => e.env.place === AT_A_FRIENDS,
    title: 'Spánok na neznámom mieste pomáha',
    body: 'Cudzia posteľ drží časť mozgu zľahka v strehu, čo ti zvyšuje šance. Oplatí sa sledovať, či to platí aj u teba — kalendár to po pár nociach ukáže.',
  },
  {
    id: 'woke-in-night',
    when: (e) => e.env.wokeInNight && !e.lucid,
    title: 'Bol si takmer pri najlepšej technike',
    body: 'Prebudenie v noci je príprava na prebudenie a späť do postele: vstaň na 15 – 20 minút, drž tlmené svetlo a pokoj, potom si ľahni späť s úmyslom všimnúť si to. Väčšina lucidných snov sa deje v neskorom REM.',
  },
  {
    id: 'default',
    when: () => true,
    title: 'Zapíš si to skôr, než sa pohneš',
    body: 'Sny vyblednú asi za deväťdesiat sekúnd a pohyb to ešte zrýchli. Keď chvíľu ostaneš bez pohybu so zavretými očami a prehráš si poslednú scénu, väčšinou sa ti vráti viac, než čakáš.',
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
    if (e.env?.wokeInNight) add(WOKE_IN_NIGHT, e.lucid);
    for (const s of e.env?.substances || []) add(s, e.lucid);
  }

  // Three nights is not proof of anything, but it's enough to be worth showing.
  return [...buckets.entries()]
    .filter(([, b]) => b.total >= 3)
    .map(([label, b]) => ({ label, ...b, rate: Math.round((b.lucid / b.total) * 100) }))
    .sort((a, b) => b.rate - a.rate);
}
