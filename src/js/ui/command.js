// Command palette (Ctrl/⌘ K).
//
// One place to jump to a view, focus a repository, change the window or run an
// action, from the keyboard. The app supplies the items; this module owns the
// filtering, the list and the keyboard handling. It reuses the dialog module,
// so focus is trapped and Escape closes it like every other dialog.

import { $$, byId, delegate, html, setHtml } from '../lib/dom.js';
import { icon } from './icons.js';
import { closeModal, openModal } from './modal.js';

let provider = () => [];
let items = [];
let visible = [];
let active = 0;
let wired = false;

/**
 * @param {() => Array<{group: string, label: string, hint?: string, icon?: string, keywords?: string, run: () => void}>} getItems
 */
export function initPalette(getItems) {
  provider = getItems;
  wire();
}

export function openPalette(initialQuery = '') {
  const input = byId('cmdkInput');
  if (!input) return;
  items = provider();
  input.value = initialQuery;
  active = 0;
  renderList(initialQuery);
  openModal('cmdk', { initialFocus: '#cmdkInput' });
}

function wire() {
  if (wired) return;
  const input = byId('cmdkInput');
  if (!input) return;
  wired = true;

  input.addEventListener('input', () => {
    active = 0;
    renderList(input.value);
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || (event.key === 'n' && event.ctrlKey)) {
      event.preventDefault();
      if (visible.length) active = (active + 1) % visible.length;
      paint();
    } else if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) {
      event.preventDefault();
      if (visible.length) active = (active - 1 + visible.length) % visible.length;
      paint();
    } else if (event.key === 'Home') {
      event.preventDefault();
      active = 0;
      paint();
    } else if (event.key === 'End') {
      event.preventDefault();
      active = Math.max(0, visible.length - 1);
      paint();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(active);
    }
  });

  delegate('cmdkList', 'click', '[data-cmd]', (_event, el) => run(Number(el.getAttribute('data-cmd'))));
  delegate('cmdkList', 'mousemove', '[data-cmd]', (_event, el) => {
    const i = Number(el.getAttribute('data-cmd'));
    if (i !== active) {
      active = i;
      paint();
    }
  });
}

/**
 * Rank by where the query lands: a prefix beats a word start beats anywhere.
 * Simple, predictable, and fast enough for a few hundred items.
 */
export function rankItems(all, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return all.slice();
  const scored = [];
  all.forEach((item, order) => {
    const label = String(item.label).toLowerCase();
    const hay = `${label} ${String(item.keywords || '').toLowerCase()} ${String(item.group || '').toLowerCase()}`;
    let score = -1;
    if (label.startsWith(needle)) score = 0;
    else if (label.split(/[\s/_-]+/).some((word) => word.startsWith(needle))) score = 1;
    else if (label.includes(needle)) score = 2;
    else if (hay.includes(needle)) score = 3;
    if (score >= 0) scored.push({ item, score, order });
  });
  return scored.sort((a, b) => a.score - b.score || a.order - b.order).map((s) => s.item);
}

function renderList(query) {
  visible = rankItems(items, query);
  if (!visible.length) {
    setHtml('cmdkList', html`<div class="cmdk-empty">Nothing matches “${query}”.</div>`);
    return;
  }
  let lastGroup = null;
  setHtml('cmdkList', html`${visible.map((item, i) => {
    const header = item.group !== lastGroup ? html`<div class="cmdk-group" role="presentation">${item.group}</div>` : '';
    lastGroup = item.group;
    return html`
      ${header}
      <div class="cmdk-item" role="option" id="cmdk-opt-${i}" data-cmd="${i}" aria-selected="${i === active ? 'true' : 'false'}">
        ${icon(item.icon || 'chevron-right', 15)}
        <span class="cmdk-label">${item.label}</span>
        ${item.hint ? html`<span class="cmdk-hint">${item.hint}</span>` : ''}
      </div>
    `;
  })}`);
  paint();
}

function paint() {
  const rows = $$('#cmdkList [data-cmd]');
  rows.forEach((row) => {
    const selected = Number(row.getAttribute('data-cmd')) === active;
    row.setAttribute('aria-selected', selected ? 'true' : 'false');
    if (selected && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
  });
  const input = byId('cmdkInput');
  if (input) input.setAttribute('aria-activedescendant', visible.length ? `cmdk-opt-${active}` : '');
}

function run(i) {
  const item = visible[i];
  if (!item) return;
  closeModal();
  try {
    item.run();
  } catch (err) {
    console.error('[palette] command failed', err);
  }
}
