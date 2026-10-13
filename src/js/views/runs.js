import { $$, byId, html, setHtml, setText } from '../lib/dom.js';
import { fmtNumber } from '../lib/format.js';
import { emptyState, runRow } from '../ui/components.js';
import { toast } from '../ui/toast.js';

// Rendering thousands of <tr> at once is what made the old "all runs" tab feel
// broken on a busy org; it also capped the list at 80 rows with no indication
// that anything had been dropped. This pages instead, and says how many are left.
const PAGE_SIZE = 100;

const STATUS_ORDER = { failed: 0, in_progress: 1, cancelled: 2, skipped: 3, success: 4 };

/** Free-text filter: every space-separated term must appear somewhere in the run. */
export function matchesQuery(run, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const hay = [run.wf, run.repo, run.branch, run.actor, run.sha, run.event, run.title]
    .map((v) => String(v || '').toLowerCase())
    .join(' ');
  return q.split(/\s+/).every((term) => hay.includes(term));
}

export function sortRuns(runs, { key = 'ts', dir = 'desc' } = {}) {
  const sign = dir === 'asc' ? 1 : -1;
  const valueOf = (run) => (key === 'status' ? (STATUS_ORDER[run.status] ?? 9) : run[key]);
  return runs.slice().sort((a, b) => {
    const va = valueOf(a);
    const vb = valueOf(b);
    if (va === vb) return b.ts - a.ts;
    if (typeof va === 'string' || typeof vb === 'string') {
      return sign * String(va ?? '').localeCompare(String(vb ?? ''));
    }
    return sign * ((Number(va) || 0) - (Number(vb) || 0));
  });
}

/** The runs the table shows, before paging: filters, search, then sort. */
export function filteredRuns(ctx) {
  const { index, state } = ctx;
  const base = index.runs.filter((run) => (state.status === 'all' || run.status === state.status)
    && (state.workflow === 'all' || run.wf === state.workflow)
    && matchesQuery(run, ctx.runsQuery));
  return sortRuns(base, ctx.runsSort);
}

export function renderRuns(ctx) {
  const { index, runsShown } = ctx;
  const filtered = filteredRuns(ctx);
  const limit = Math.min(runsShown || PAGE_SIZE, filtered.length);
  const page = filtered.slice(0, limit);
  const total = index.runs.length;

  setText('runsCount', filtered.length === total
    ? `${fmtNumber(total)} run${total === 1 ? '' : 's'} in this window`
    : `${fmtNumber(filtered.length)} of ${fmtNumber(total)} runs match`);
  paintSortHeaders(ctx.runsSort);

  setHtml('runsTableBody', page.length
    ? html`${page.map(runRow)}`
    : html`<tr><td colspan="8">${emptyState(
        'No runs match',
        ctx.runsQuery ? `Nothing matches “${ctx.runsQuery}” with these filters.` : 'Try a wider window or a different status.',
        { icon: 'search' },
      )}</td></tr>`);

  const remaining = filtered.length - limit;
  setHtml('runsMore', remaining > 0
    ? html`<button class="btn btn-sm" type="button" data-action="show-more-runs">
        Show ${fmtNumber(Math.min(remaining, PAGE_SIZE))} more · ${fmtNumber(remaining)} hidden
      </button>`
    : html``);

  const exportBtn = byId('exportRunsBtn');
  if (exportBtn) exportBtn.disabled = !filtered.length;
}

function paintSortHeaders(sort = { key: 'ts', dir: 'desc' }) {
  $$('#tab-runs th[data-sort]').forEach((th) => {
    const key = th.getAttribute('data-sort');
    th.setAttribute('aria-sort', key === sort.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
  });
}

/** CSV text for a list of runs. Quoted where needed, formula-prefix safe. */
export function toCsv(runs) {
  const header = ['status', 'workflow', 'repository', 'branch', 'event', 'actor', 'commit',
    'duration_seconds', 'queue_seconds', 'started_at', 'url'];
  const cell = (value) => {
    let s = value === null || value === undefined ? '' : String(value);
    // A cell beginning with = + - @ is executed as a formula by spreadsheets.
    // Branch and workflow names are attacker-controlled; neutralise them.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(',')];
  runs.forEach((run) => {
    lines.push([
      run.status, run.wf, run.repo, run.branch, run.event, run.actor, run.sha,
      run.dur, run.queue, new Date(run.ts).toISOString(), run.htmlUrl || '',
    ].map(cell).join(','));
  });
  return lines.join('\n');
}

/** Download the currently filtered runs (every page, not just the visible one). */
export function exportRuns(ctx) {
  const rows = filteredRuns(ctx);
  if (!rows.length) return false;
  if (typeof Blob !== 'function' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    toast({ kind: 'warn', title: 'Export unavailable', body: 'This browser cannot create a download.' });
    return false;
  }
  const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `actions-runs-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast({ kind: 'success', title: 'Exported', body: `${fmtNumber(rows.length)} runs written to ${link.download}.` });
  return true;
}

export { PAGE_SIZE };
