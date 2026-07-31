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
import { prefs, setPref } from './settings.js';

/** Spread through the day rather than clustered, so they stay surprising. */
export const DEFAULT_CHECKS = ['10:30', '13:00', '16:00', '19:30'];

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

  await api.pushSubscribe({
    endpoint: sub.endpoint,
    // The server matches on local wall-clock time, so it needs the zone, not
    // an offset — that way the times hold across daylight saving.
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    morningTime: prefs.notify ? prefs.notifyTime : '',
    checkTimes: (prefs.checkTimes || DEFAULT_CHECKS).join(','),
  });

  setPref('notify', true);
  push.subscribed = true;
}

export async function updateSchedule() {
  const sub = await currentSubscription();
  if (!sub) return;
  await api.pushSubscribe({
    endpoint: sub.endpoint,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    morningTime: prefs.notify ? prefs.notifyTime : '',
    checkTimes: (prefs.checkTimes || DEFAULT_CHECKS).join(','),
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
