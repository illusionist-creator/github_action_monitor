// The redesigned chrome, driven in a real DOM: the verdict strip, KPI deltas,
// the theme toggle, the command palette, free-text run search and the
// connect dialog.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bootDashboard, tick } from './helpers/dom.mjs';

describe('chrome: verdict, deltas, theme, palette, search, connect', () => {
  let app;

  before(async () => {
    app = await bootDashboard();
  });

  after(() => app && app.close());

  it('answers "is CI OK?" above the fold', () => {
    const verdict = app.document.querySelector('#verdictBar .verdict');
    assert.ok(verdict, 'verdict strip missing');
    assert.match(verdict.className, /verdict-(good|warn|bad|quiet)/);
    assert.ok(verdict.querySelector('.verdict-title').textContent.length > 0);
  });

  it('shows period-over-period deltas and trends on the KPI tiles', () => {
    assert.ok(app.document.querySelectorAll('#metricsRow .delta').length >= 3, 'deltas missing');
    assert.ok(app.document.querySelectorAll('#metricsRow .spark').length >= 3, 'sparklines missing');
  });

  it('toggles the colour scheme with the t key and keeps every chart', async () => {
    const before_ = app.document.documentElement.getAttribute('data-theme');
    app.document.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 't', bubbles: true }));
    await tick(app.window, 3);
    const after_ = app.document.documentElement.getAttribute('data-theme');
    assert.notEqual(before_, after_);
    assert.ok(['light', 'dark'].includes(after_));
    assert.equal(app.document.querySelectorAll('.view-error').length, 0);
    assert.deepEqual(app.errors, []);
  });

  it('opens the command palette with Ctrl+K, filters, and runs a command', async () => {
    app.document.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    await tick(app.window);
    const dialog = app.document.getElementById('cmdk');
    assert.ok(dialog.classList.contains('open'), 'palette did not open');

    const input = app.document.getElementById('cmdkInput');
    input.value = 'fail';
    input.dispatchEvent(new app.window.Event('input'));
    await tick(app.window);
    const labels = Array.from(app.document.querySelectorAll('#cmdkList .cmdk-label')).map((el) => el.textContent);
    assert.equal(labels[0], 'Failures', `expected Failures first in ${labels.join(', ')}`);

    input.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick(app.window, 3);
    assert.equal(dialog.classList.contains('open'), false, 'palette stayed open');
    assert.equal(app.document.getElementById('nav-failures').getAttribute('aria-selected'), 'true');
  });

  it('filters the runs table by free text', async () => {
    app.document.getElementById('nav-runs').click();
    await tick(app.window);
    const before_ = app.document.querySelectorAll('#runsTableBody tr.run-row').length;
    const search = app.document.getElementById('runsSearch');
    search.value = 'ml-pipeline';
    search.dispatchEvent(new app.window.Event('input'));
    await new Promise((resolve) => app.window.setTimeout(resolve, 250));
    const rows = app.document.querySelectorAll('#runsTableBody tr.run-row');
    assert.ok(rows.length > 0 && rows.length < before_, `expected a narrower list, saw ${rows.length} of ${before_}`);
    rows.forEach((row) => assert.equal(row.getAttribute('data-run-repo'), 'acme/ml-pipeline'));
  });

  it('opens the connect dialog from the sample banner and focuses the token field', async () => {
    app.document.querySelector('#mainOverlay [data-action="open-connect"]').click();
    await tick(app.window);
    assert.ok(app.document.getElementById('connectModal').classList.contains('open'));
    assert.equal(app.document.activeElement, app.document.getElementById('tokenInput'));
  });
});
