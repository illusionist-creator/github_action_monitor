import { html, setHtml, setText } from '../lib/dom.js';
import { fmtNumber } from '../lib/format.js';
import { emptyState, runRow } from '../ui/components.js';

// Rendering thousands of <tr> at once is what made the old "all runs" tab feel
// broken on a busy org; it also capped the list at 80 rows with no indication
// that anything had been dropped. This pages instead, and says how many are left.
const PAGE_SIZE = 100;

export function renderRuns(ctx) {
  const { index, state, runsShown } = ctx;

  const filtered = index.runs
    .filter((run) => (state.status === 'all' || run.status === state.status)
      && (state.workflow === 'all' || run.wf === state.workflow))
    .sort((a, b) => b.ts - a.ts);

  const limit = Math.min(runsShown || PAGE_SIZE, filtered.length);
  const page = filtered.slice(0, limit);

  setText('runsCount', `${fmtNumber(filtered.length)} run${filtered.length === 1 ? '' : 's'}`);

  setHtml('runsTableBody', page.length
    ? html`${page.map(runRow)}`
    : html`<tr><td colspan="8">${emptyState('No runs match these filters')}</td></tr>`);

  const remaining = filtered.length - limit;
  setHtml('runsMore', remaining > 0
    ? html`<button class="logs-btn" type="button" data-action="show-more-runs">
        show ${fmtNumber(Math.min(remaining, PAGE_SIZE))} more · ${fmtNumber(remaining)} hidden
      </button>`
    : html``);
}

export { PAGE_SIZE };
