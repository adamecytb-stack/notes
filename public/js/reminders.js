/**
 * Reality-check reminders.
 *
 * The point is not the notification itself — it is the habit. Reality checks
 * done while awake, several times a day, are what eventually get performed
 * inside a dream. So the default is a handful spread across waking hours,
 * plus one nudge in the morning to write down what you remember.
 *
 * Pushes carry no payload; the wording lives in the service worker. Nothing
 * about a dream ever goes near a push service.
 */

import { api } from './api.js';
import { idbPut } from './idb.js';
import { prefs, setPref } from './settings.js';

/** Spread through the day rather than clustered, so they stay surprising. */
export const DEFAULT_CHECKS = ['10:30', '13:00', '16:00', '19:30'];

/** How long before bedtime the intention nudge lands. */
const BEDTIME_LEAD_MIN = 20;

/**
 * Wake-back-to-bed goes five hours in: deep enough to have cleared the
 * slow-wave part of the night and land among the long REM periods, which is
 * where nearly every lucid dream happens.
 */
const WBTB_OFFSET_MIN = 300;

const toMinutes = (t) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

const toClock = (mins) => {
  const w = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(w / 60)).padStart(2, '0')}:${String(w % 60).padStart(2, '0')}`;
};

/** When the "say your intention" nudge should land, or '' if it is off. */
export function bedtimeNudgeAt() {
  const at = toMinutes(prefs.bedtime);
  return prefs.bedtimeNudge && at !== null ? toClock(at - BEDTIME_LEAD_MIN) : '';
}

/** Where wake-back-to-bed lands by default, given a bedtime. */
export function suggestedWbtb(bedtime = prefs.bedtime) {
  const at = toMinutes(bedtime);
  return at === null ? '' : toClock(at + WBTB_OFFSET_MIN);
}

/** The alarm time, or '' if wake-back-to-bed is switched off. */
export function wbtbAt() {
  if (!prefs.wbtb) return '';
  return toMinutes(prefs.wbtbTime) !== null ? prefs.wbtbTime : suggestedWbtb();
}

/**
 * The times the service worker needs to tell one nudge from another. Times
 * only — a push carries no payload, and this is what lets the phone work out
 * what it is for without the push service ever being told.
 */
function scheduleForWorker() {
  return {
    morning: prefs.notify ? prefs.notifyTime : '',
    checks: prefs.checkTimes || DEFAULT_CHECKS,
    bedtime: bedtimeNudgeAt(),
    wbtb: wbtbAt(),
  };
}

export const push = {
  available: false,
  publicKey: null,
  subscribed: false,
};

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent);

export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

/** Why reminders can't be switched on right now, or null if they can. */
export function blockedReason() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return 'This browser cannot do reminders.';
  }
  if (isIOS() && !isStandalone()) {
    return 'On iPhone, add Nocturne to your Home Screen first — iOS only allows notifications for installed apps.';
  }
  if (!push.available) return 'Reminders are not configured on this server yet.';
  if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
    return 'Blocked. Turn notifications back on in your phone settings.';
  }
  return null;
}

function urlBase64ToUint8Array(base64) {
  const padded = base64.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function currentSubscription() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

export async function refreshPushState() {
  try {
    push.subscribed = !!(await currentSubscription());
  } catch {
    push.subscribed = false;
  }
  return push.subscribed;
}

export async function enableReminders() {
  const blocked = blockedReason();
  if (blocked) throw new Error(blocked);

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications were not allowed.');

  const reg = await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ||
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(push.publicKey),
    }));

  setPref('notify', true);
  push.subscribed = true;
  await pushSchedule(sub.endpoint);
}

export async function updateSchedule() {
  const sub = await currentSubscription();
  if (!sub) return;
  await pushSchedule(sub.endpoint);
}

async function pushSchedule(endpoint) {
  const schedule = scheduleForWorker();
  // Written before the network call, so the worker can still name a nudge
  // even if the round trip fails.
  await idbPut('meta', 'schedule', schedule);
  await api.pushSubscribe({
    endpoint,
    // The server matches on local wall-clock time, so it needs the zone, not
    // an offset — that way the times hold across daylight saving.
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    morningTime: schedule.morning,
    checkTimes: schedule.checks.join(','),
    bedtimeTime: schedule.bedtime,
    wbtbTime: schedule.wbtb,
  });
}

export async function disableReminders() {
  const sub = await currentSubscription();
  if (sub) {
    await api.pushUnsubscribe(sub.endpoint).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }
  setPref('notify', false);
  push.subscribed = false;
}

export async function sendTest() {
  const res = await api.pushTest();
  if (!res.ok) throw new Error('The push service did not accept it.');
}
