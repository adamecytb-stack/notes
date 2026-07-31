/** Small DOM helpers, formatting, toast and modal. */

export const $ = (sel) => document.querySelector(sel);
export const $$ = (sel) => [...document.querySelectorAll(sel)];

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function icon(id, size = 14) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.appendChild(use);
  return svg;
}

/* ------------------------------------------------------------------ time  */

const DAY = 86_400_000;

/**
 * Which night a dream belongs to. Anything before noon is filed under the
 * previous evening, because a dream at 3am on Tuesday was Monday night's.
 */
export function nightOf(ts) {
  const d = new Date(ts);
  if (d.getHours() < 12) d.setDate(d.getDate() - 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function nightLabel(nightKey, now = Date.now()) {
  const today = nightOf(now);
  const beforeNoon = new Date(now).getHours() < 12;

  if (nightKey === today) return beforeNoon ? 'Last night' : 'Tonight';
  if (nightKey === today - DAY) return beforeNoon ? 'The night before' : 'Last night';

  const d = new Date(nightKey);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** { hour: "3·14", meridiem: "am" } */
export function clockParts(ts) {
  const d = new Date(ts);
  let h = d.getHours();
  const meridiem = h < 12 ? 'am' : 'pm';
  h = h % 12 || 12;
  return { hour: String(h), minute: String(d.getMinutes()).padStart(2, '0'), meridiem };
}

export function greeting(now = Date.now()) {
  const h = new Date(now).getHours();
  if (h < 5) return 'The small hours';
  if (h < 8) return 'First light';
  if (h < 12) return 'Morning';
  if (h < 17) return 'Afternoon';
  if (h < 21) return 'Evening';
  return 'Good night';
}

export function fullStamp(ts) {
  return new Date(ts).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Value for <input type="datetime-local">, in local time. */
export function toLocalInputValue(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

export function bytesLabel(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/* ----------------------------------------------------------------- toast  */

let toastTimer;

export function toast(message, ms = 2600) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('is-visible'), ms);
}

/* ----------------------------------------------------------------- modal  */

let modalCleanup = null;

export function closeModal() {
  $('#modal').classList.remove('is-open');
  modalCleanup?.();
  modalCleanup = null;
}

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} [opts.body]
 * @param {HTMLElement} [opts.slot]      extra content (e.g. a form)
 * @param {Array} opts.actions           [{ label, kind, onClick }]
 * @param {boolean} [opts.dismissable]
 */
export function openModal({ title, body, slot, actions = [], dismissable = true }) {
  const modal = $('#modal');
  $('#modal-title').textContent = title;

  const bodyNode = $('#modal-body');
  bodyNode.textContent = body || '';
  bodyNode.classList.toggle('hidden', !body);

  const slotNode = $('#modal-slot');
  slotNode.replaceChildren();
  if (slot) slotNode.appendChild(slot);

  const actionsNode = $('#modal-actions');
  actionsNode.replaceChildren();
  for (const action of actions) {
    const btn = el('button', `btn ${action.kind || 'btn--ghost'} btn--block`, action.label);
    btn.type = 'button';
    btn.addEventListener('click', () => action.onClick?.(btn));
    actionsNode.appendChild(btn);
  }

  const onScrim = () => dismissable && closeModal();
  const onKey = (e) => {
    if (e.key === 'Escape' && dismissable) closeModal();
  };
  $('#modal-scrim').addEventListener('click', onScrim);
  document.addEventListener('keydown', onKey);
  modalCleanup = () => {
    $('#modal-scrim').removeEventListener('click', onScrim);
    document.removeEventListener('keydown', onKey);
  };

  modal.classList.add('is-open');
  return { close: closeModal };
}

export function confirm({ title, body, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    openModal({
      title,
      body,
      actions: [
        {
          label: confirmLabel,
          kind: danger ? 'btn--danger' : 'btn--primary',
          onClick: () => {
            closeModal();
            resolve(true);
          },
        },
        {
          label: 'Cancel',
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

/* -------------------------------------------------------------- download  */

export function download(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = el('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
