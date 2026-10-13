// End-to-end smoke tests against the built index.html, in a real DOM.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bootDashboard, tick } from './helpers/dom.mjs';

describe('dashboard boot', () => {
  let app;

  before(async () => {
    app = await bootDashboard();
  });

  after(() => app && app.close());

  it('boots without throwing', () => {
    assert.deepEqual(app.errors, []);
  });

  it('renders the headline metrics from sample data', () => {
    const cards = app.document.querySelectorAll('#metricsRow .metric-card');
    assert.ok(cards.length >= 6, `expected 6 metric cards, saw ${cards.length}`);
    const labels = Array.from(cards).map((c) => c.querySelector('.metric-label').textContent.trim());
    assert.ok(labels.includes('Success rate'), `labels: ${labels.join(' | ')}`);
    assert.ok(labels.includes('Median duration'), `labels: ${labels.join(' | ')}`);
  });

  it('lists repositories in the sidebar', () => {
    const items = app.document.querySelectorAll('#sidebar-repo-list .nav-item');
    assert.equal(items.length, 5);
  });

  it('creates every overview chart', () => {
    const ids = app.window.__charts.map((c) => c.id);
    ['outcomeChart', 'volumeChart', 'durationChart', 'burnRateChart', 'queueChart', 'p95Chart']
      .forEach((id) => assert.ok(ids.includes(id), `missing chart ${id}`));
  });

  it('renders the heatmap as 7 x 24 cells', () => {
    const rows = app.document.querySelectorAll('#heatmapArea .heatmap-row');
    assert.equal(rows.length, 7);
    assert.equal(rows[0].querySelectorAll('.hcell').length, 24);
  });

  it('starts in sample mode and says so', () => {
    assert.equal(app.document.getElementById('logoSub').textContent, 'sample data');
    assert.equal(app.document.getElementById('liveBadgeText').textContent, 'sample');
  });
});

describe('navigation', () => {
  let app;

  before(async () => {
    app = await bootDashboard();
  });

  after(() => app && app.close());

  it('switches panels and updates aria-selected', async () => {
    app.document.getElementById('nav-runs').click();
    await tick(app.window);

    assert.equal(app.document.getElementById('nav-runs').getAttribute('aria-selected'), 'true');
    assert.equal(app.document.getElementById('nav-overview').getAttribute('aria-selected'), 'false');
    assert.ok(app.document.getElementById('tab-runs').classList.contains('active'));
    assert.ok(app.document.querySelectorAll('#runsTableBody tr').length > 0);
  });

  it('writes the active tab into the URL so a view can be shared', async () => {
    app.document.getElementById('nav-failures').click();
    await tick(app.window);
    assert.match(app.window.location.hash, /tab=failures/);
  });

  it('renders every tab without error', async () => {
    for (const tab of ['live', 'repos', 'runs', 'failures', 'logs', 'timeline', 'overview']) {
      app.document.getElementById(`nav-${tab}`).click();
      await tick(app.window);
      const panel = app.document.getElementById(`tab-${tab}`);
      assert.equal(panel.querySelectorAll('.view-error').length, 0, `${tab} rendered an error`);
    }
    assert.deepEqual(app.errors, []);
  });
});

describe('filters', () => {
  let app;

  before(async () => {
    app = await bootDashboard();
  });

  after(() => app && app.close());

  it('narrows the dataset when a repository is selected', async () => {
    const before = app.document.querySelector('#metricsRow .metric-value').textContent;
    const select = app.document.getElementById('repoFilter');
    select.value = 'acme/ml-pipeline';
    select.dispatchEvent(new app.window.Event('change'));
    await tick(app.window);

    const after = app.document.querySelector('#metricsRow .metric-value').textContent;
    assert.notEqual(before, after);

    // Every repository stays listed so you can move straight to another one;
    // the one in focus is marked, not isolated.
    const items = app.document.querySelectorAll('#sidebar-repo-list .nav-item');
    assert.equal(items.length, 5);
    const pressed = app.document.querySelectorAll('#sidebar-repo-list .nav-item[aria-pressed="true"]');
    assert.equal(pressed.length, 1);
    assert.equal(pressed[0].getAttribute('data-repo-filter'), 'acme/ml-pipeline');
  });
});

describe('graceful degradation without Chart.js', () => {
  let app;

  before(async () => {
    app = await bootDashboard({ withChart: false });
  });

  after(() => app && app.close());

  it('renders data tables in place of every chart', () => {
    assert.deepEqual(app.errors, []);
    const wrap = app.document.getElementById('outcomeChart')
      || app.document.querySelector('.chart-wrap table.runs-table');
    assert.ok(wrap, 'expected a fallback table where the chart would be');
    const tables = app.document.querySelectorAll('#tab-overview .chart-wrap table');
    assert.ok(tables.length >= 4, `expected fallback tables, saw ${tables.length}`);
  });
});
