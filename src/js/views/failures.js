import { FAILURE_CATEGORY_LABELS, categorizeFailure } from '../data/analytics.js';
import { html, setHtml, setText } from '../lib/dom.js';
import { fmtDuration, fmtNumber, timeAgo, truncate } from '../lib/format.js';
import { STATUS_COLORS, SURFACE, entityColor } from '../lib/palette.js';
import { axis, chart, legend } from '../ui/charts.js';
import { emptyState } from '../ui/components.js';

export function renderFailures(ctx) {
  const { index } = ctx;
  const failures = index.runs.filter((run) => run.status === 'failed');

  setText('failuresCount', `${fmtNumber(failures.length)} in this window`);
  renderCategories(failures);
  renderFlaky(failures);
  renderCards(failures, index);
}

function renderCategories(failures) {
  const counts = new Map(FAILURE_CATEGORY_LABELS.map((label) => [label, 0]));
  failures.forEach((run) => {
    const label = categorizeFailure(run.wf);
    counts.set(label, (counts.get(label) || 0) + 1);
  });
  const entries = Array.from(counts.entries()).filter(([, value]) => value > 0);

  chart(
    'failCatChart',
    {
      type: 'bar',
      data: {
        labels: entries.map(([label]) => label),
        datasets: [{
          data: entries.map(([, value]) => value),
          // One measure, one hue — the old version painted each bar a different
          // colour, implying seven categories that colour did not actually encode.
          backgroundColor: STATUS_COLORS.failed,
          borderRadius: 4,
          borderSkipped: false,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        scales: { x: axis({ ticks: { precision: 0 } }), y: axis({ grid: false }) },
      },
    },
    {
      caption: 'Failures by workflow category',
      columns: ['category', 'failures'],
      rows: entries.map(([label, value]) => [label, value]),
    },
  );
}

function renderFlaky(failures) {
  const flaky = failures.filter((run) => run.flaky).length;
  const sticky = failures.length - flaky;

  chart(
    'flakyChart',
    {
      type: 'doughnut',
      data: {
        labels: ['sticky', 'flaky'],
        datasets: [{
          data: [sticky, flaky],
          backgroundColor: [STATUS_COLORS.failed, '#fab219'],
          borderColor: SURFACE,
          borderWidth: 2,
        }],
      },
      options: { responsive: true, maintainAspectRatio: false, cutout: '65%' },
    },
    {
      caption: 'Flaky versus sticky failures',
      columns: ['kind', 'failures'],
      rows: [['sticky', sticky], ['flaky', flaky]],
    },
  );

  setHtml('flakyLegend', legend([
    { label: 'sticky', color: STATUS_COLORS.failed, value: fmtNumber(sticky) },
    { label: 'flaky', color: '#fab219', value: fmtNumber(flaky) },
  ]));
}

function renderCards(failures, index) {
  const recent = [...failures].sort((a, b) => b.ts - a.ts).slice(0, 12);

  setHtml('failureCards', recent.length ? html`${recent.map((run) => {
    const stats = index.workflowStats.get(run.wf);
    const slow = stats && stats.p95Duration && run.dur > stats.p95Duration;
    return html`
      <div class="fail-card">
        <div class="fail-card-top">
          <div style="min-width:0;">
            <div class="fail-card-name">${run.wf}</div>
            <div class="fail-card-meta">
              <span style="color:${entityColor(run.repo)}">${run.repo}</span>
              <span style="color:var(--text3)"> · ${truncate(run.branch, 28)} · ${fmtDuration(run.dur)}</span>
              ${run.flaky ? html`<span class="badge badge-amber" style="margin-left:6px;">flaky</span>` : ''}
            </div>
          </div>
          <div class="fail-card-time">${timeAgo(run.ts)}</div>
        </div>
        <div class="causes-header">run details</div>
        <div class="fail-causes">
          ${detail('trigger', `${run.event || 'unknown'}${run.actor ? ` by ${run.actor}` : ''}`, 'var(--text2)')}
          ${detail('commit', run.sha || '—', 'var(--text2)')}
          ${detail('attempt', String(run.attempt), run.attempt > 1 ? 'var(--amber)' : 'var(--text2)')}
          ${slow ? detail('duration', `above p95 (${fmtDuration(stats.p95Duration)})`, 'var(--amber)') : ''}
        </div>
        <div style="margin-top:10px;">
          <button class="logs-mini" type="button" data-run-repo="${run.repo}" data-run-id="${run.id}">
            open job &amp; step log
          </button>
        </div>
      </div>
    `;
  })}` : emptyState('No failures 🎉', 'Nothing failed in the selected window.'));
}

function detail(label, value, color) {
  return html`
    <div class="fc-item">
      <div class="fc-dot" style="background:${color}"></div>
      <span class="fc-label"><b>${label}</b> ${value}</span>
    </div>
  `;
}
