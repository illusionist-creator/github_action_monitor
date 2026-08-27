// Non-blocking notifications.
//
// The legacy app reported every failure by writing into one `connectStatus`
// span, so the second error erased the first and anything that failed while the
// user was on another tab was never seen at all.

import { byId, delegate, html, setHtml } from '../lib/dom.js';

const MAX_VISIBLE = 4;
const shown = new Map();
let counter = 0;
let wired = false;

function stack() {
  return byId('toastStack');
}

function wire() {
  if (wired || !stack()) return;
  wired = true;
  delegate('toastStack', 'click', '[data-dismiss]', (_event, el) => {
    dismiss(el.getAttribute('data-dismiss'));
  });
}

export function dismiss(id) {
  const node = shown.get(id);
  if (node) {
    node.remove();
    shown.delete(id);
  }
}

/**
 * @param {object} options
 * @param {'info'|'success'|'warn'|'error'} [options.kind]
 * @param {string} options.title
 * @param {string} [options.body]
 * @param {number} [options.timeout]  ms; 0 keeps it until dismissed
 * @param {string} [options.dedupe]   replace any toast with the same key
 */
export function toast({ kind = 'info', title, body = '', timeout = 6000, dedupe }) {
  const host = stack();
  if (!host) return null;
  wire();

  if (dedupe && shown.has(dedupe)) dismiss(dedupe);
  const id = dedupe || `toast-${(counter += 1)}`;

  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  setHtml(
    node,
    html`
      <div style="min-width:0;">
        <div class="toast-title">${title}</div>
        ${body ? html`<div class="toast-body">${body}</div>` : ''}
      </div>
      <button class="toast-close" type="button" data-dismiss="${id}" aria-label="Dismiss">✕</button>
    `,
  );

  host.appendChild(node);
  shown.set(id, node);

  while (shown.size > MAX_VISIBLE) {
    dismiss(shown.keys().next().value);
  }

  if (timeout > 0) setTimeout(() => dismiss(id), timeout);
  return id;
}

/** Announce a change to assistive technology without stealing focus. */
export function announce(message) {
  const el = byId('liveAnnouncer');
  if (el) el.textContent = message;
}
