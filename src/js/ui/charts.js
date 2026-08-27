// Chart.js wrapper.
//
// Three things the legacy chart code got wrong, all fixed here:
//
//   * the "scatter" on the Timeline tab was `type: 'line'` without
//     `showLine: false`, so Chart.js joined every point — a tangle of lines
//     across the whole window, presented as a scatter plot;
//   * charts were created against canvases inside a `display:none` tab, so
//     Chart.js measured 0x0 and silently drew nothing until a resize;
//   * if the CDN was unreachable, `new Chart(...)` threw and the whole render
//     aborted, leaving the tab blank.
//
// Every chart here degrades to an accessible data table when Chart.js is
// missing, which doubles as the table view the charts need anyway.

import { esc, html, raw, setHtml } from '../lib/dom.js';

const registry = new Map();
const observers = new Map();

export function chartsAvailable() {
  return typeof globalThis.Chart !== 'undefined';
}

const reduceMotion = () => typeof matchMedia === 'function'
  && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Shared axis / grid / font defaults, applied once. */
export function initChartDefaults() {
  if (!chartsAvailable()) return;
  const { Chart } = globalThis;
  Chart.defaults.color = '#8b909e';
  Chart.defaults.borderColor = 'rgba(255,255,255,0.06)';
  Chart.defaults.font.family = "'JetBrains Mono', ui-monospace, monospace";
  Chart.defaults.font.size = 11;
  Chart.defaults.animation = reduceMotion() ? false : { duration: 400 };
  Chart.defaults.plugins.tooltip.backgroundColor = '#1a1e25';
  Chart.defaults.plugins.tooltip.borderColor = 'rgba(255,255,255,0.12)';
  Chart.defaults.plugins.tooltip.borderWidth = 1;
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.plugins.tooltip.titleColor = '#e8eaf0';
  Chart.defaults.plugins.tooltip.bodyColor = '#c9ccd6';
  // Legends are rendered as real DOM next to each chart, so identity survives
  // a screenshot, a screen reader and a printed page.
  Chart.defaults.plugins.legend.display = false;
}

/** Recessive axis styling — the data should be the loudest thing on the card. */
export function axis({ callback, stacked = false, beginAtZero = true, grid = true, title, ticks } = {}) {
  // `callback` must be omitted rather than set to undefined: Chart.js treats the
  // key's presence as an override and stops falling back to its own formatter,
  // which renders every category tick as its numeric index.
  const tickOptions = { color: '#767c8b', font: { size: 10 }, maxRotation: 0, autoSkipPadding: 12, ...ticks };
  if (callback) tickOptions.callback = callback;

  return {
    stacked,
    beginAtZero,
    border: { display: false },
    ticks: tickOptions,
    grid: { color: grid ? 'rgba(255,255,255,0.05)' : 'transparent', drawTicks: false },
    title: title
      ? { display: true, text: title, color: '#767c8b', font: { size: 10 } }
      : { display: false },
  };
}

function destroy(id) {
  const existing = registry.get(id);
  if (existing) {
    existing.destroy();
    registry.delete(id);
  }
  const observer = observers.get(id);
  if (observer) {
    observer.disconnect();
    observers.delete(id);
  }
}

/** Tear down every chart — called when the dataset is replaced wholesale. */
export function destroyAll() {
  Array.from(registry.keys()).forEach(destroy);
}

/**
 * Create or replace a chart.
 *
 * @param {string} id      canvas element id
 * @param {object} config  Chart.js config
 * @param {object} [fallback]  { columns, rows, caption } rendered when Chart.js
 *                             is unavailable, and used as the canvas's
 *                             accessible description either way
 */
export function chart(id, config, fallback) {
  destroy(id);
  const canvas = document.getElementById(id);
  if (!canvas) return null;

  if (!chartsAvailable()) {
    renderFallback(canvas, fallback, 'Charts are unavailable — the Chart.js bundle did not load.');
    return null;
  }

  const create = () => {
    if (registry.has(id) || !document.getElementById(id)) return;
    try {
      registry.set(id, new globalThis.Chart(canvas, config));
    } catch (err) {
      renderFallback(canvas, fallback, `This chart could not be drawn: ${err.message}`);
    }
  };

  if (canvas.clientWidth > 0 && canvas.clientHeight > 0) {
    create();
    return registry.get(id) || null;
  }

  // The canvas is inside a hidden tab. Wait for it to gain a box rather than
  // guessing with a rAF, which loses the race against style recalculation.
  const observer = new ResizeObserver((entries) => {
    if (entries.some((entry) => entry.contentRect.width > 0 && entry.contentRect.height > 0)) {
      observer.disconnect();
      observers.delete(id);
      create();
    }
  });
  observer.observe(canvas);
  observers.set(id, observer);
  return null;
}

function renderFallback(canvas, fallback, message) {
  const holder = canvas.parentElement;
  if (!holder) return;
  if (!fallback || !fallback.rows || !fallback.rows.length) {
    setHtml(holder, html`<div class="empty-state">${message}</div>`);
    return;
  }
  setHtml(holder, dataTable(fallback, message));
}

/** The table view. Also reachable on purpose, not only as an error path. */
export function dataTable({ columns, rows, caption }, note) {
  return html`
    <div class="runs-table-wrap" style="max-height:100%;">
      <table class="runs-table">
        <caption class="sr-only">${caption || 'Chart data'}</caption>
        <thead>
          <tr>${columns.map((col) => html`<th scope="col">${col}</th>`)}</tr>
        </thead>
        <tbody>
          ${rows.map((row) => html`<tr>${row.map((cell) => html`<td>${cell}</td>`)}</tr>`)}
        </tbody>
      </table>
      ${note ? html`<div class="section-sub" style="margin-top:8px;">${note}</div>` : ''}
    </div>
  `;
}

/**
 * A DOM legend. Present whenever there are two or more series — identity is
 * never carried by colour alone.
 */
export function legend(items, { shape = 'swatch' } = {}) {
  if (!items.length) return raw('');
  return html`${items.map((item) => html`
    <span class="legend-item">
      <span class="legend-swatch ${shape === 'line' ? 'line' : ''}"
        style="background:${cssColor(item.color)}"></span>
      ${item.label}${item.value !== undefined ? html` <span class="legend-value">${item.value}</span>` : ''}
    </span>
  `)}`;
}

/** Only allow colour literals we generated, never a value from the API. */
function cssColor(value) {
  const text = String(value || '');
  return /^(#[0-9a-f]{3,8}|rgba?\([\d.,\s]+\)|var\(--[\w-]+\))$/i.test(text) ? text : '#767c8b';
}
