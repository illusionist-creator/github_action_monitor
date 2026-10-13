import { FAILURE_CATEGORY_LABELS, categorizeFailure } from '../data/analytics.js';
import { html, setHtml, setText } from '../lib/dom.js';
import { fmtDuration, fmtNumber, repoShortName, timeAgo, truncate, windowLabel } from '../lib/format.js';
import { STATUS_COLORS, surface } from '../lib/palette.js';
import { axis, chart, legend } from '../ui/charts.js';
import { emptyState, metricCard, repoChip } from '../ui/components.js';
import { icon } from '../ui/icons.js';

export function renderFailures(ctx) {
  const { index, state } = ctx;
  const failures = index.runs.filter((run) => run.status === 'failed');

  setText('failuresCount', failures.length
    ? `${fmtNumber(failures.length)} in the last ${windowLabel(state.days)}, newest first`
    : `Nothing failed in the last ${windowLabel(state.days)}`);
  renderSummary(failures, index);
  renderCategories(failures);
  renderFlaky(failures);
  renderCards(failures, index);
}

function topBy(failures, keyOf) {
  const counts = new Map();
  failures.forEach((run) => counts.set(keyOf(run), (counts.get(keyOf(run)) || 0) + 1));
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0] || null;
}

function renderSummary(failures, index) {
  const o = index.overall;
  const graded = o.success + o.failed;
  const flaky = failures.filter((run) => run.flaky).length;
  const topWf = topBy(failures, (run) => run.wf);
  const topRepo = topBy(failures, (run) => run.repo);
  const plural = (n) => `${n} failure${n === 1 ? '' : 's'}`;

  setHtml('failSummary', html`
    ${metricCard({
      label: 'Failures',
      value: fmtNumber(failures.length),
      sub: graded ? `${o.failureRate}% of ${fmtNumber(graded)} graded runs` : 'no graded runs',
      tone: failures.length ? 'bad' : 'good',
    })}
    ${metricCard({
      label: 'Flaky',
      value: fmtNumber(flaky),
      sub: failures.length ? `${Math.round((flaky / failures.length) * 100)}% of failures` : 'nothing to grade',
      tone: flaky ? 'warn' : null,
      hint: 'A failure is flaky when the same commit also passed, or when it sits between two green runs.',
    })}
    ${metricCard({
      label: 'Most failing workflow',
      value: topWf ? topWf[0] : '—',
      sub: topWf ? plural(topWf[1]) : 'no failures',
      small: true,
    })}
    ${metricCard({
      label: 'Most failing repository',
      value: topRepo ? repoShortName(topRepo[0]) : '—',
      sub: topRepo ? plural(topRepo[1]) : 'no failures',
      small: true,
    })}
  `);
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
          maxBarThickness: 22,
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
          borderColor: surface(),
          borderWidth: 2,
          hoverOffset: 4,
        }],
      },
      options: { responsive: true, maintainAspectRatio: false, cutout: '66%' },
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
    const url = /^https:\/\/github\.com\//.test(String(run.htmlUrl || '')) ? run.htmlUrl : null;
    return html`
      <article class="fail-card ${run.flaky ? 'flaky' : ''}">
        <div class="fail-main">
          <div class="fail-top">
            <div class="fail-name">
              <span class="truncate" title="${run.wf}">${run.wf}</span>
              ${run.flaky ? html`<span class="badge badge-flaky">flaky</span>` : ''}
              ${run.attempt > 1 ? html`<span class="badge badge-neutral">attempt ${run.attempt}</span>` : ''}
            </div>
            <time class="fail-time">${timeAgo(run.ts)}</time>
          </div>
          <div class="fail-meta">
            ${repoChip(run.repo)}
            <span class="mono" title="${run.branch}">${truncate(run.branch, 32)}</span>
            <span>${fmtDuration(run.dur)}${slow ? html` <span class="warn">· above the ${fmtDuration(stats.p95Duration)} p95</span>` : ''}</span>
            <span>${run.event || 'unknown trigger'}${run.actor ? ` by ${run.actor}` : ''}</span>
            ${run.sha ? html`<span class="mono">${run.sha}</span>` : ''}
          </div>
        </div>
        <div class="fail-actions">
          <button class="btn btn-sm" type="button" data-run-repo="${run.repo}" data-run-id="${run.id}">
            ${icon('terminal', 14)} Jobs &amp; steps
          </button>
          ${url
            ? html`<a class="btn btn-sm btn-ghost" href="${url}" target="_blank" rel="noopener noreferrer" aria-label="Open this run on GitHub">${icon('external', 14)}</a>`
            : ''}
        </div>
      </article>
    `;
  })}` : emptyState('No failures', 'Nothing failed in the selected window.', { icon: 'check' }));
}
