// Regressions from reported breakage. Each test names the symptom it prevents.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bootDashboard, tick } from './helpers/dom.mjs';

const OVERVIEW_CANVASES = [
  'outcomeChart', 'volumeChart', 'durationChart',
  'mttrChart', 'burnRateChart', 'queueChart', 'p95Chart',
];

function canvasCount(doc) {
  return doc.querySelectorAll('#tab-overview canvas').length;
}

function liveCharts(win, doc) {
  return [...doc.querySelectorAll('#tab-overview canvas')]
    .filter((c) => win.Chart.getChart(c)).length;
}

describe('"charts vanish after clicking refresh"', () => {
  let app;

  before(async () => {
    app = await bootDashboard();
  });

  after(() => app && app.close());

  it('keeps every Overview chart when refreshing from another tab', async () => {
    const before_ = liveCharts(app.window, app.document);
    assert.ok(before_ > 0, 'charts should exist to begin with');

    app.document.getElementById('nav-timeline').click();
    await tick(app.window);
    app.document.getElementById('refreshBtn').click();
    await tick(app.window, 5);

    // A blanket destroyAll() on every data change used to tear these down
    // without rebuilding them, because only the active tab is re-rendered.
    assert.equal(liveCharts(app.window, app.document), before_);
  });

  it('keeps the canvases when a chart cannot be drawn, and recovers after', async () => {
    app.document.getElementById('nav-overview').click();
    await tick(app.window, 4);
    assert.equal(canvasCount(app.document), OVERVIEW_CANVASES.length);

    app.window.__chartFail = true;
    app.document.getElementById('refreshBtn').click();
    await tick(app.window, 5);

    // The fallback used to replace the wrapper's contents, deleting the
    // <canvas> for good: nothing could ever rebuild a chart with no canvas.
    assert.equal(canvasCount(app.document), OVERVIEW_CANVASES.length, 'canvases were destroyed');
    assert.ok(
      app.document.querySelectorAll('#tab-overview .chart-fallback').length > 0,
      'a table view should stand in while charts are broken',
    );

    app.window.__chartFail = false;
    app.document.getElementById('refreshBtn').click();
    await tick(app.window, 5);

    assert.equal(liveCharts(app.window, app.document), OVERVIEW_CANVASES.length, 'charts did not recover');
    assert.equal(app.document.querySelectorAll('#tab-overview .chart-fallback').length, 0);
  });

  it('renders an empty window without leaving the tab blank', async () => {
    // An early return here used to skip chart rendering entirely.
    const select = app.document.getElementById('timeFilter');
    select.value = '1';
    select.dispatchEvent(new app.window.Event('change'));
    await tick(app.window, 5);

    assert.equal(canvasCount(app.document), OVERVIEW_CANVASES.length);
    assert.equal(app.document.querySelectorAll('.view-error').length, 0);

    select.value = '7';
    select.dispatchEvent(new app.window.Event('change'));
    await tick(app.window, 5);
    assert.equal(liveCharts(app.window, app.document), OVERVIEW_CANVASES.length);
  });
});

describe('"Script Error" toast', () => {
  let app;

  before(async () => {
    app = await bootDashboard();
  });

  after(() => app && app.close());

  const toasts = () => app.document.querySelectorAll('#toastStack .toast').length;

  it('does not raise a toast for an opaque cross-origin error', async () => {
    // What a browser reports for an exception in a cross-origin script — and
    // for everything when the page is opened over file://. It carries no file,
    // line or stack, so the toast told the reader nothing they could act on.
    const before_ = toasts();
    app.window.dispatchEvent(new app.window.ErrorEvent('error', { message: 'Script error.' }));
    await tick(app.window);
    assert.equal(toasts(), before_);
  });

  it('still raises a toast for an error with real detail', async () => {
    const before_ = toasts();
    app.window.dispatchEvent(new app.window.ErrorEvent('error', {
      message: 'x is not a function',
      filename: 'https://example.test/index.html',
      lineno: 42,
    }));
    await tick(app.window);
    assert.equal(toasts(), before_ + 1);
  });

  it('ignores AbortError rejections, which are how cancellation works', async () => {
    const before_ = toasts();
    const event = new app.window.Event('unhandledrejection');
    event.reason = Object.assign(new Error('aborted'), { name: 'AbortError' });
    app.window.dispatchEvent(event);
    await tick(app.window);
    assert.equal(toasts(), before_);
  });
});

describe('filter dropdowns', () => {
  let app;

  before(async () => {
    app = await bootDashboard();
  });

  after(() => app && app.close());

  it('keeps every repository listed after one is selected', async () => {
    const select = app.document.getElementById('repoFilter');
    const total = select.options.length;
    assert.ok(total > 2, 'sample data should offer several repositories');

    select.value = 'acme/web-app';
    select.dispatchEvent(new app.window.Event('change'));
    await tick(app.window, 4);

    // Options came from the filtered index, so picking a repo dropped all the
    // others and you could not switch straight to another one.
    assert.equal(select.options.length, total, 'other repositories disappeared');
    assert.equal(select.value, 'acme/web-app');
  });

  it('keeps every workflow listed after the window narrows', async () => {
    const runsFilter = app.document.getElementById('runsWfFilter');
    const before_ = runsFilter.options.length;

    const time = app.document.getElementById('timeFilter');
    time.value = '1';
    time.dispatchEvent(new app.window.Event('change'));
    await tick(app.window, 4);

    assert.equal(runsFilter.options.length, before_);
  });
});

describe('keyboard shortcuts', () => {
  let app;

  before(async () => {
    app = await bootDashboard();
  });

  after(() => app && app.close());

  it('does not throw when the key event targets the document', async () => {
    // event.target is not always an Element; document has no .matches().
    app.document.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'r', bubbles: true }));
    await tick(app.window, 3);
    assert.deepEqual(app.errors, []);
  });
});
