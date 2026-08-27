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
  registry.delete(id);
  if (existing) {
    // A chart torn down mid-animation can throw from inside Chart.js. That is
    // not a reason to abandon the render that is replacing it.
    try {
      existing.destroy();
    } catch (err) {
      console.warn(`[charts] destroying ${id} threw`, err);
    }
  }
  const observer = observers.get(id);
  if (observer) {
    observer.disconnect();
    observers.delete(id);
  }
}

/** Tear down every chart. Only for a full teardown, such as disconnecting. */
export function destroyAll() {
  Array.from(registry.keys()).forEach(destroy);
}

/**
 * Create or replace a chart.
 *
 * @param {string} id      canvas element id
 * @param {object} config  Chart.js config
 * @param {object} [fallback]  { columns, rows, caption } rendered instead of the
 *                             chart when it cannot be drawn — also the table
 *                             view that keeps the data accessible
 */
export function chart(id, config, fallback) {
  destroy(id);
  const canvas = document.getElementById(id);
  if (!canvas) return null;

  // Restore the canvas before measuring it. A canvas left hidden behind an
  // earlier fallback reports zero size, which would send every future render
  // down the ResizeObserver path on an element that can never be resized —
  // making one failure permanent by a second route.
  clearFallback(canvas);

  if (!chartsAvailable()) {
    showFallback(canvas, fallback, 'Charts are unavailable — the Chart.js bundle did not load.');
    return null;
  }

  const create = () => {
    if (registry.has(id) || !document.getElementById(id)) return;
    try {
      // Chart.js keys instances by canvas and throws "Canvas is already in use"
      // if one is still attached. Our registry can miss an instance — a render
      // that was interrupted, a chart adopted from a previous config — so ask
      // Chart.js itself rather than trusting only our own bookkeeping.
      const orphan = globalThis.Chart.getChart ? globalThis.Chart.getChart(canvas) : null;
      if (orphan) orphan.destroy();

      registry.set(id, new globalThis.Chart(canvas, config));
      clearFallback(canvas);
    } catch (err) {
      console.warn(`[charts] ${id} could not be drawn`, err);
      showFallback(canvas, fallback, `This chart could not be drawn: ${err.message}`);
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

/**
 * Put a message where a chart would go, without removing the canvas.
 *
 * Views that have nothing to plot must use this rather than overwriting the
 * chart wrapper: doing that deletes the <canvas>, and the chart can never come
 * back once the data does.
 */
export function chartMessage(id, message) {
  destroy(id);
  const canvas = document.getElementById(id);
  if (!canvas) return;
  showFallback(canvas, null, message);
}

/**
 * Show the table view beside the canvas — never in place of it.
 *
 * Replacing the holder's contents used to remove the <canvas> from the DOM, so
 * a single transient failure was permanent: every later render found no canvas
 * and gave up, and no refresh or tab switch could bring the charts back.
 */
function showFallback(canvas, fallback, message) {
  const holder = canvas.parentElement;
  if (!holder) return;
  canvas.style.display = 'none';

  let node = holder.querySelector(':scope > .chart-fallback');
  if (!node) {
    node = document.createElement('div');
    node.className = 'chart-fallback';
    holder.appendChild(node);
  }
  setHtml(
    node,
    fallback && fallback.rows && fallback.rows.length
      ? dataTable(fallback, message)
      : html`<div class="empty-state">${message}</div>`,
  );
}

function clearFallback(canvas) {
  const holder = canvas.parentElement;
  canvas.style.display = '';
  const node = holder && holder.querySelector(':scope > .chart-fallback');
  if (node) node.remove();
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
