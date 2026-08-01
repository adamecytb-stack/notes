/**
 * Preferences. Deliberately device-local: they never touch the server, so
 * there's nothing here to leak and nothing to sync.
 */

const KEY = 'nocturne.prefs';

const DEFAULTS = {
  theme: 'nocturne',
  textScale: 100,
  autoLock: false,
  privacyScreen: true,
  notify: false,
  notifyTime: '07:15',
  // Off until explicitly granted. Nothing reaches Gemini before this is true.
  aiConsent: false,
  aiAfterEntry: false,
  // Reality-check times, local. Spread out so they stay surprising.
  checkTimes: ['10:30', '13:00', '16:00', '19:30'],
  // Lucid dreams are the ones worth comparing, so they share by default.
  shareLucid: true,

  // When you mean to be asleep. Everything at night is worked out from this.
  bedtime: '23:00',
  // The intention nudge, twenty minutes before bedtime.
  bedtimeNudge: false,
  // Wake-back-to-bed: off by default, because being woken at 4am is something
  // you should have to ask for. '' means "five hours after bedtime".
  wbtb: false,
  wbtbTime: '',
  // Reality checks actually performed, { 'YYYY-MM-DD': count }. Local only.
  checkLog: {},
};

export const prefs = load();

function load() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setPref(key, value) {
  prefs[key] = value;
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* storage full or blocked; the setting still applies for this session */
  }
  applyPrefs();
}

const THEME_COLOR = { nocturne: '#0c0a09', daybreak: '#f4eee3' };

export function applyPrefs() {
  const root = document.documentElement;
  root.dataset.theme = prefs.theme;
  root.style.setProperty('--text-scale', String(prefs.textScale / 100));

  // Keep the iOS status bar in step with the theme.
  const resolved =
    prefs.theme === 'auto'
      ? window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'daybreak'
        : 'nocturne'
      : prefs.theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[resolved]);
}

// Auto mode has to react when the system flips at sunset.
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (prefs.theme === 'auto') applyPrefs();
});
