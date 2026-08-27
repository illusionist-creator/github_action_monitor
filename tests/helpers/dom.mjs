// Boot the built dashboard inside jsdom so the smoke tests exercise the real
// artifact — the same index.html that ships — rather than a mock of it.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * @param {object} [options]
 * @param {boolean} [options.withChart]  expose a stub Chart constructor
 * @returns {Promise<{window: Window, document: Document, errors: string[], close(): void}>}
 */
export async function bootDashboard({ withChart = true } = {}) {
  const source = await readFile(join(ROOT, 'index.html'), 'utf8');
  // The CDN <script> cannot resolve offline; drop it and inject a stub instead,
  // which is also the code path exercised when SRI or the network fails.
  const html = source.replace(/<script src="https:\/\/cdnjs[\s\S]*?<\/script>/, '');

  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err) => errors.push(err.message));
  virtualConsole.on('error', (...args) => errors.push(args.join(' ')));

  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'https://example.test/',
    virtualConsole,
  });

  const { window } = dom;
  installShims(window, { withChart });

  // Run the bundle after the shims are in place.
  const script = /<script>\n([\s\S]*?)\n<\/script>/.exec(html);
  if (!script) throw new Error('No inline bundle found in index.html');
  window.eval(script[1]);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await tick(window);

  return {
    window,
    document: window.document,
    errors,
    close: () => dom.window.close(),
  };
}

function installShims(window, { withChart }) {
  // jsdom has no layout engine, so ResizeObserver never fires and canvases have
  // no box. Report a size immediately so charts take the synchronous path.
  window.ResizeObserver = class {
    observe() {}

    disconnect() {}
  };
  Object.defineProperty(window.HTMLCanvasElement.prototype, 'clientWidth', { value: 400 });
  Object.defineProperty(window.HTMLCanvasElement.prototype, 'clientHeight', { value: 200 });

  window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {} }));
  window.requestAnimationFrame = (fn) => window.setTimeout(() => fn(Date.now()), 0);
  window.cancelAnimationFrame = (id) => window.clearTimeout(id);

  if (withChart) {
    const created = [];
    const live = new Map();
    // `window.__chartFail = true` makes every construction throw, standing in
    // for a transient Chart.js failure such as "Canvas is already in use".
    window.Chart = class {
      constructor(canvas, config) {
        if (window.__chartFail) throw new Error('Canvas is already in use.');
        this.canvas = canvas;
        this.config = config;
        created.push({ id: canvas.id, config });
        live.set(canvas, this);
      }

      destroy() {
        live.delete(this.canvas);
      }
    };
    window.Chart.getChart = (canvas) => live.get(canvas) || null;
    window.__liveCharts = live;
    window.Chart.defaults = {
      color: '',
      borderColor: '',
      font: {},
      animation: null,
      plugins: { tooltip: {}, legend: {} },
    };
    window.__charts = created;
  }
}

/** Let the store's rAF-batched render flush. */
export function tick(window, times = 3) {
  return new Promise((resolve) => {
    let n = 0;
    const step = () => {
      n += 1;
      if (n >= times) resolve();
      else window.setTimeout(step, 0);
    };
    window.setTimeout(step, 0);
  });
}

export { ROOT };
