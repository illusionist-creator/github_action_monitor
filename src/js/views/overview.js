import {
  activityMatrix,
  categorizeFailure,
  dailyBuckets,
  sparkline,
  topBy,
  weeklyQueueSplit,
} from '../data/analytics.js';
import { html, raw, setHtml, setText } from '../lib/dom.js';
import { fitWindow } from '../lib/store.js';
import {
  fmtComputeMinutes,
  fmtDuration,
  fmtNumber,
  repoShortName,
  timeAgo,
  toMinutes,
  truncate,
} from '../lib/format.js';
import {
  SEQUENTIAL_BLUE,
  STATUS_COLORS,
  SURFACE,
  assignColors,
  entityColor,
  healthTone,
  withAlpha,
} from '../lib/palette.js';
import { axis, chart, chartMessage, dataTable, legend } from '../ui/charts.js';
import { emptyState, eventRow, metricCard, repoCard } from '../ui/components.js';

const OUTCOMES = [
  { key: 'success', label: 'success' },
  { key: 'failed', label: 'failed' },
  { key: 'cancelled', label: 'cancelled' },
  { key: 'skipped', label: 'skipped' },
];

export function renderOverview(ctx) {
  const { index, state } = ctx;
  renderMetrics(ctx);

  // No early return when the window is empty. Bailing out here left whatever
  // charts had just been torn down in a destroyed state with nothing to rebuild
  // them, so an empty filter emptied the whole tab until a reload. Every
  // renderer below copes with an empty set and draws its own empty state.
  const buckets = dailyBuckets(index.runs, state.days);
  renderOutcomes(index);
  renderVolume(buckets);
  renderDurationTrend(index, buckets);
  renderRepoGrid(ctx, 'overviewRepoGrid');
  renderMatrix(ctx);
  renderPulse(index);
  renderStreaks(index);
  renderTimeSinks(index);
  renderRecovery(index);
  renderBurnRate(buckets);
  renderHeatmap(ctx);
  renderQueueSplit(index);
  renderP95(index);
}

/* ------------------------------------------------------------------ metrics */

function renderMetrics({ index, state, loadedRuns, newestRunTs }) {
  const o = index.overall;
  if (!o.total) {
    // "no data" on its own reads as "your CI is empty" or "this is broken". If
    // runs were loaded and the window simply excludes them, say exactly that —
    // and offer the fix, rather than leaving the reader to guess.
    const hasOlder = Boolean(loadedRuns) && Boolean(newestRunTs);
    const wider = hasOlder ? fitWindow([{ ts: newestRunTs }], state.days) : null;

    setHtml('metricsRow', html`
      <div class="metric-card" style="grid-column:1/-1;">
        <div class="metric-label">no runs in the last ${state.days} day${state.days === 1 ? '' : 's'}</div>
        ${hasOlder
          ? html`
            <div class="metric-sub" style="margin-top:6px;">
              ${fmtNumber(loadedRuns)} run${loadedRuns === 1 ? '' : 's'} loaded${state.repo === 'all' ? '' : ` (filtered to ${state.repo})`} ·
              most recent was ${timeAgo(newestRunTs)}
            </div>
            ${wider && wider !== state.days
              ? html`<button class="logs-btn" type="button" data-action="widen-window" data-days="${wider}"
                  style="margin-top:10px;">Show the last ${wider} days</button>`
              : ''}
          `
          : html`<div class="metric-sub" style="margin-top:6px;">
              Nothing has been loaded yet. Connect a token, or widen the time range.
            </div>`}
      </div>
    `);
    setText('nav-fail-count', '0');
    return;
  }

  const rateColor = o.successRate >= 90
    ? 'var(--green)'
    : o.successRate >= 75 ? 'var(--amber)' : 'var(--red)';

  setHtml('metricsRow', html`
    ${metricCard({ label: 'total runs', value: fmtNumber(o.total), sub: `${fmtNumber(o.running)} running now` })}
    ${metricCard({ label: 'success rate', value: `${o.successRate}%`, sub: `${fmtNumber(o.success)} of ${fmtNumber(o.success + o.failed)} graded`, color: rateColor })}
    ${metricCard({ label: 'failures', value: fmtNumber(o.failed), sub: `${o.failureRate}% of graded runs`, color: o.failed ? 'var(--red)' : 'var(--text)' })}
    ${metricCard({ label: 'median duration', value: fmtDuration(o.p50Duration), sub: `p95 ${fmtDuration(o.p95Duration)}` })}
    ${metricCard({ label: 'median queue wait', value: fmtDuration(o.avgQueue), sub: `p95 ${fmtDuration(o.p95Queue)}`, color: o.p95Queue > 300 ? 'var(--amber)' : 'var(--text)' })}
    ${metricCard({ label: 'compute', value: fmtComputeMinutes(o.computeMinutes), sub: `${fmtNumber(o.computeMinutes)} minutes` })}
  `);
  setText('nav-fail-count', String(o.failed));
}

/* ------------------------------------------------------------------- charts */

function renderOutcomes(index) {
  const counts = OUTCOMES.map((o) => ({ ...o, value: index.overall[o.key] || 0 }));
  const total = counts.reduce((a, c) => a + c.value, 0) || 1;

  chart(
    'outcomeChart',
    {
      type: 'doughnut',
      data: {
        labels: counts.map((c) => c.label),
        datasets: [{
          data: counts.map((c) => c.value),
          backgroundColor: counts.map((c) => STATUS_COLORS[c.key]),
          // A 2px surface gap keeps adjacent segments legible without a stroke.
          borderColor: SURFACE,
          borderWidth: 2,
          hoverOffset: 4,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '68%',
        plugins: {
          tooltip: {
            callbacks: {
              label: (c) => `${c.label}: ${c.parsed} (${Math.round((c.parsed / total) * 100)}%)`,
            },
          },
        },
      },
    },
    {
      caption: 'Runs by outcome',
      columns: ['outcome', 'runs', 'share'],
      rows: counts.map((c) => [c.label, c.value, `${Math.round((c.value / total) * 100)}%`]),
    },
  );

  setHtml('outcomeLegend', legend(counts.map((c) => ({
    label: c.label,
    color: STATUS_COLORS[c.key],
    value: fmtNumber(c.value),
  }))));
}

function renderVolume(buckets) {
  const success = buckets.map((b) => b.runs.filter((r) => r.status === 'success').length);
  const failed = buckets.map((b) => b.runs.filter((r) => r.status === 'failed').length);
  const other = buckets.map((b, i) => b.runs.length - success[i] - failed[i]);

  chart(
    'volumeChart',
    {
      type: 'bar',
      data: {
        labels: buckets.map((b) => b.label),
        datasets: [
          { label: 'success', data: success, backgroundColor: STATUS_COLORS.success, stack: 'runs', borderRadius: 3, borderSkipped: false, borderColor: SURFACE, borderWidth: 2 },
          { label: 'failed', data: failed, backgroundColor: STATUS_COLORS.failed, stack: 'runs', borderRadius: 3, borderSkipped: false, borderColor: SURFACE, borderWidth: 2 },
          { label: 'other', data: other, backgroundColor: STATUS_COLORS.skipped, stack: 'runs', borderRadius: 3, borderSkipped: false, borderColor: SURFACE, borderWidth: 2 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: { x: axis({ grid: false, stacked: true }), y: axis({ stacked: true }) },
      },
    },
    {
      caption: 'Runs per day by outcome',
      columns: ['day', 'success', 'failed', 'other'],
      rows: buckets.map((b, i) => [b.label, success[i], failed[i], other[i]]),
    },
  );

  setHtml('volumeLegend', legend([
    { label: 'success', color: STATUS_COLORS.success },
    { label: 'failed', color: STATUS_COLORS.failed },
    { label: 'cancelled / skipped', color: STATUS_COLORS.skipped },
  ]));
}

function renderDurationTrend(index, buckets) {
  // Rank workflows by compute, not by first appearance, so the lines shown are
  // the ones that matter.
  const names = topBy(index.workflowStats, (s) => s.computeSeconds, 5).map((e) => e.key);
  const colors = assignColors(names);

  const datasets = names.map((name) => ({
    label: name,
    data: buckets.map((bucket) => {
      const runs = bucket.runs.filter((r) => r.wf === name && r.status === 'success');
      return runs.length ? toMinutes(runs.reduce((a, r) => a + r.dur, 0) / runs.length) : null;
    }),
    borderColor: colors.get(name),
    backgroundColor: 'transparent',
    tension: 0.35,
    pointRadius: 4,
    pointHoverRadius: 7,
    borderWidth: 2,
    spanGaps: true,
  }));

  chart(
    'durationChart',
    {
      type: 'line',
      data: { labels: buckets.map((b) => b.label), datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y}m` } } },
        scales: { x: axis({ grid: false }), y: axis({ callback: (v) => `${v}m` }) },
      },
    },
    {
      caption: 'Average successful run duration per day, in minutes',
      columns: ['day', ...names.map((n) => truncate(n, 18))],
      rows: buckets.map((b, i) => [b.label, ...datasets.map((d) => (d.data[i] === null ? '—' : `${d.data[i]}m`))]),
    },
  );

  setHtml('durationLegend', legend(
    names.map((name) => ({ label: truncate(name, 26), color: colors.get(name) })),
    { shape: 'line' },
  ));
}

function renderRecovery(index) {
  const entries = Array.from(index.repoStats.values())
    .filter((s) => s.mttr.samples > 0)
    .sort((a, b) => b.mttr.meanMinutes - a.mttr.meanMinutes)
    .slice(0, 8);

  if (!entries.length) {
    // Never overwrite the chart wrapper — that deletes the canvas, and the
    // chart cannot come back when the data does.
    chartMessage('mttrChart', 'Nothing has broken — no failure was followed by a recovery in this window.');
    return;
  }

  chart(
    'mttrChart',
    {
      type: 'bar',
      data: {
        labels: entries.map((e) => truncate(repoShortName(e.repo), 16)),
        datasets: [{
          data: entries.map((e) => e.mttr.meanMinutes),
          backgroundColor: entries.map((e) => entityColor(e.repo)),
          borderRadius: 4,
          borderSkipped: false,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          tooltip: {
            callbacks: {
              label: (c) => {
                const entry = entries[c.dataIndex];
                return `${entry.mttr.meanMinutes}m mean · ${entry.mttr.p95Minutes}m p95 · ${entry.mttr.samples} outages`;
              },
            },
          },
        },
        scales: { x: axis({ callback: (v) => `${v}m` }), y: axis({ grid: false }) },
      },
    },
    {
      caption: 'Mean time to recovery per repository',
      columns: ['repository', 'mean', 'p95', 'outages'],
      rows: entries.map((e) => [e.repo, `${e.mttr.meanMinutes}m`, `${e.mttr.p95Minutes}m`, e.mttr.samples]),
    },
  );
}

function renderBurnRate(buckets) {
  const minutes = buckets.map((b) => Math.round(b.runs.reduce((a, r) => a + r.dur, 0) / 60));
  const total = minutes.reduce((a, v) => a + v, 0);
  const avg = minutes.length ? Math.round(total / minutes.length) : 0;

  // Compare the two halves of the window rather than first-day vs last-day: a
  // single quiet Sunday used to read as a 90% drop in compute spend.
  const half = Math.max(1, Math.floor(minutes.length / 2));
  const older = minutes.slice(0, half);
  const newer = minutes.slice(-half);
  const olderAvg = older.reduce((a, v) => a + v, 0) / older.length || 0;
  const newerAvg = newer.reduce((a, v) => a + v, 0) / newer.length || 0;
  const trendPct = olderAvg ? Math.round(((newerAvg - olderAvg) / olderAvg) * 100) : 0;

  const rising = trendPct > 10;
  const falling = trendPct < -10;
  const lineColor = rising ? STATUS_COLORS.failed : falling ? STATUS_COLORS.success : '#3987e5';

  chart(
    'burnRateChart',
    {
      type: 'line',
      data: {
        labels: buckets.map((b) => b.label),
        datasets: [{
          data: minutes,
          borderColor: lineColor,
          backgroundColor: withAlpha(lineColor, 0.14),
          fill: true,
          tension: 0.35,
          pointRadius: 3,
          borderWidth: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { tooltip: { callbacks: { label: (c) => `${c.parsed.y} minutes` } } },
        scales: { x: axis({ grid: false }), y: axis({ callback: (v) => `${v}m` }) },
      },
    },
    {
      caption: 'Compute minutes per day',
      columns: ['day', 'minutes'],
      rows: buckets.map((b, i) => [b.label, minutes[i]]),
    },
  );

  const arrow = rising ? '↑' : falling ? '↓' : '→';
  setHtml('burnRateStats', html`
    ${burnStat('total', fmtComputeMinutes(total), `${fmtNumber(total)} minutes`)}
    ${burnStat('daily average', `${avg}m`, 'across the window')}
    ${burnStat('trend', `${arrow} ${Math.abs(trendPct)}%`,
      rising ? 'rising' : falling ? 'falling' : 'steady',
      rising ? 'var(--red)' : falling ? 'var(--green)' : 'var(--text)')}
  `);
}

function burnStat(label, value, sub, color) {
  return html`
    <div style="background:var(--bg3);border-radius:var(--radius);padding:10px 12px;">
      <div class="metric-label">${label}</div>
      <div style="font-size:18px;font-family:var(--mono);color:${color || 'var(--text)'};">${value}</div>
      <div class="metric-sub">${sub}</div>
    </div>
  `;
}

function renderQueueSplit(index) {
  const weeks = weeklyQueueSplit(index.runs);
  chart(
    'queueChart',
    {
      type: 'bar',
      data: {
        labels: weeks.map((w) => w.label),
        datasets: [
          { label: 'queue wait', data: weeks.map((w) => w.queue), backgroundColor: '#c98500', stack: 'a', borderRadius: 3, borderSkipped: false, borderColor: SURFACE, borderWidth: 2 },
          { label: 'execution', data: weeks.map((w) => w.exec), backgroundColor: '#3987e5', stack: 'a', borderRadius: 3, borderSkipped: false, borderColor: SURFACE, borderWidth: 2 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmtDuration(c.parsed.y)}` } } },
        scales: {
          x: axis({ grid: false, stacked: true }),
          y: axis({ stacked: true, callback: (v) => fmtDuration(v) }),
        },
      },
    },
    {
      caption: 'Average queue wait and execution time per week',
      columns: ['week', 'queue wait', 'execution', 'runs'],
      rows: weeks.map((w) => [w.label, fmtDuration(w.queue), fmtDuration(w.exec), w.runs]),
    },
  );

  setHtml('queueLegend', legend([
    { label: 'queue wait', color: '#c98500' },
    { label: 'execution', color: '#3987e5' },
  ]));
}

function renderP95(index) {
  const entries = topBy(index.workflowStats, (s) => s.p95Duration, 7);
  chart(
    'p95Chart',
    {
      type: 'bar',
      data: {
        labels: entries.map((e) => truncate(e.key, 22)),
        datasets: [{
          data: entries.map((e) => Math.round(e.value / 60)),
          backgroundColor: '#9085e9',
          borderRadius: 4,
          borderSkipped: false,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          tooltip: {
            callbacks: {
              title: (c) => entries[c[0].dataIndex].key,
              label: (c) => `p95 ${fmtDuration(entries[c.dataIndex].value)}`,
            },
          },
        },
        scales: { x: axis({ callback: (v) => `${v}m` }), y: axis({ grid: false }) },
      },
    },
    {
      caption: '95th percentile duration by workflow',
      columns: ['workflow', 'p95'],
      rows: entries.map((e) => [e.key, fmtDuration(e.value)]),
    },
  );
}

/* -------------------------------------------------------------- repo grid */

export function renderRepoGrid(ctx, containerId) {
  const { index, state, expanded } = ctx;
  const sort = containerId === 'overviewRepoGrid' ? 'health' : state.sort;

  const rows = Array.from(index.repoStats.values());
  const comparators = {
    health: (a, b) => a.health.score - b.health.score,
    runs: (a, b) => b.total - a.total,
    compute: (a, b) => b.computeSeconds - a.computeSeconds,
    failures: (a, b) => b.failed - a.failed,
    duration: (a, b) => b.p95Duration - a.p95Duration,
    queue: (a, b) => b.p95Queue - a.p95Queue,
  };
  rows.sort(comparators[sort] || comparators.health);

  setHtml(containerId, rows.length
    ? html`${rows.map((stats) => {
        const key = `${containerId}:${stats.repo}`;
        const open = Boolean(expanded[key]);
        const withSpark = { ...stats, spark: sparkline(index.byRepo.get(stats.repo) || []) };
        const workflows = open
          ? Array.from(index.byWorkflow.keys())
              .map((wf) => ({ wf, ...(index.cell(stats.repo, wf) || {}) }))
              .filter((wf) => wf.total)
              .sort((a, b) => b.computeSeconds - a.computeSeconds)
          : [];
        return repoCard(withSpark, { open, container: containerId, workflows });
      })}`
    : emptyState('No repositories with runs', 'Nothing matched the current filters.'));
}

/* ----------------------------------------------------------------- matrix */

function renderMatrix({ index, state }) {
  const repos = index.repos.slice(0, 14);
  const workflows = topBy(index.workflowStats, (s) => s.total, 10).map((e) => e.key);
  const metric = state.metric;

  if (!repos.length || !workflows.length) {
    setHtml('matrixWrap', emptyState('Nothing to compare yet'));
    setHtml('matrixLegend', raw(''));
    return;
  }

  const valueOf = (cell) => {
    if (!cell || !cell.total) return null;
    if (metric === 'success') return cell.successRate;
    if (metric === 'duration') return cell.avgDuration;
    if (metric === 'queue') return cell.avgQueue;
    return cell.total;
  };
  const format = (value) => {
    if (value === null) return '—';
    if (metric === 'success') return `${value}%`;
    if (metric === 'duration' || metric === 'queue') return fmtDuration(value);
    return String(value);
  };

  const cells = new Map();
  let max = 0;
  repos.forEach((repo) => workflows.forEach((wf) => {
    const value = valueOf(index.cell(repo, wf));
    cells.set(`${repo} ${wf}`, value);
    if (value !== null && value > max) max = value;
  }));

  // Success rate is a diverging measure around "acceptable"; everything else is
  // a plain magnitude and gets the one-hue sequential ramp.
  const background = (value) => {
    if (value === null) return null;
    if (metric === 'success') {
      const t = value / 100;
      return withAlpha(t >= 0.9 ? STATUS_COLORS.success : t >= 0.75 ? '#fab219' : STATUS_COLORS.failed, 0.22);
    }
    const step = Math.min(
      SEQUENTIAL_BLUE.length - 1,
      Math.floor((max ? value / max : 0) * (SEQUENTIAL_BLUE.length - 1)),
    );
    return SEQUENTIAL_BLUE[step];
  };

  setHtml('matrixWrap', html`
    <table class="matrix">
      <caption class="sr-only">Repository by workflow, showing ${metric}</caption>
      <thead>
        <tr>
          <td></td>
          ${workflows.map((wf) => html`<th scope="col" title="${wf}">${truncate(wf, 14)}</th>`)}
        </tr>
      </thead>
      <tbody>
        ${repos.map((repo) => html`
          <tr>
            <th scope="row" title="${repo}">${truncate(repoShortName(repo), 16)}</th>
            ${workflows.map((wf) => {
              const value = cells.get(`${repo} ${wf}`);
              const bg = background(value);
              return html`<td class="${value === null ? 'empty' : ''}"
                style="${bg ? `background:${bg};` : ''}"
                title="${repo} · ${wf}: ${format(value)}">${format(value)}</td>`;
            })}
          </tr>
        `)}
      </tbody>
    </table>
  `);

  setHtml('matrixLegend', metric === 'success'
    ? legend([
        { label: '90%+', color: withAlpha(STATUS_COLORS.success, 0.5) },
        { label: '75–89%', color: withAlpha('#fab219', 0.5) },
        { label: 'below 75%', color: withAlpha(STATUS_COLORS.failed, 0.5) },
      ])
    : legend(SEQUENTIAL_BLUE.slice(1).map((color, i, arr) => ({
        label: i === 0 ? 'low' : i === arr.length - 1 ? 'high' : '',
        color,
      }))));
}

/* ------------------------------------------------------------- side panels */

function renderPulse(index) {
  const byRecency = [...index.runs].sort((a, b) => b.ts - a.ts);
  const events = [];

  byRecency.filter((r) => r.status === 'failed').slice(0, 6).forEach((run) => {
    events.push({
      ts: run.ts,
      icon: '✕',
      color: 'var(--red)',
      text: `${run.wf} failed`,
      sub: repoShortName(run.repo),
      tag: run.flaky ? 'flaky' : null,
    });
  });

  // "Slow" is measured against the workflow's own p95, not the global average:
  // comparing a two-minute lint job to a thirty-minute training run is noise.
  byRecency.forEach((run) => {
    if (events.length > 12 || run.status !== 'success') return;
    const stats = index.workflowStats.get(run.wf);
    if (stats && stats.p95Duration && run.dur > stats.p95Duration && stats.total > 5) {
      events.push({
        ts: run.ts,
        icon: '⚠',
        color: 'var(--amber)',
        text: `${run.wf} took ${fmtDuration(run.dur)} (p95 ${fmtDuration(stats.p95Duration)})`,
        sub: repoShortName(run.repo),
      });
    }
  });

  const top = events.sort((a, b) => b.ts - a.ts).slice(0, 10);
  setHtml('ciPulseFeed', top.length
    ? html`${top.map(eventRow)}`
    : emptyState('All quiet', 'No failures or outliers in this window.'));
}

function renderStreaks(index) {
  const rows = Array.from(index.repoStats.values())
    .sort((a, b) => b.streak - a.streak)
    .slice(0, 6);

  setHtml('streakGrid', rows.length ? html`${rows.map((stats) => {
    const color = stats.streak >= 10
      ? 'var(--green)'
      : stats.streak >= 5 ? 'var(--amber)' : stats.streak > 0 ? 'var(--text2)' : 'var(--red)';
    const pips = Math.min(stats.streak, 10);
    return html`
      <div style="display:flex;align-items:center;gap:10px;">
        <span style="font-size:18px;font-family:var(--mono);color:${color};min-width:32px;text-align:right;">${stats.streak}</span>
        <div style="flex:1;min-width:0;">
          <div class="pulse-text">${repoShortName(stats.repo)}</div>
          <div class="pulse-sub">${stats.streak === 0 ? 'last run was red' : 'consecutive green runs'} · ${stats.successRate}% overall</div>
        </div>
        <div style="display:flex;gap:2px;" aria-hidden="true">
          ${Array.from({ length: Math.max(pips, 1) }, () => html`<div style="width:6px;height:16px;border-radius:2px;background:${pips ? color : 'var(--red)'};opacity:0.75;"></div>`)}
        </div>
      </div>
    `;
  })}` : emptyState('No repositories'));
}

function renderTimeSinks(index) {
  const entries = topBy(index.workflowStats, (s) => s.computeSeconds, 6);
  const max = entries.length ? entries[0].value : 1;
  const colors = assignColors(entries.map((e) => e.key));

  setHtml('timeSinks', entries.length ? html`${entries.map((entry) => {
    const minutes = Math.round(entry.value / 60);
    return html`
      <div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <span class="pulse-text" style="font-size:11px;">${truncate(entry.key, 24)}</span>
          <span class="section-sub">${fmtComputeMinutes(minutes)}</span>
        </div>
        <div style="height:4px;background:var(--bg4);border-radius:2px;overflow:hidden;">
          <div style="height:100%;width:${Math.round((entry.value / max) * 100)}%;background:${colors.get(entry.key)};border-radius:2px;"></div>
        </div>
      </div>
    `;
  })}` : emptyState('No compute recorded'));
}

/* ---------------------------------------------------------------- heatmap */

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function renderHeatmap({ index, state }) {
  const scoped = state.heatRepo === 'all'
    ? index.runs
    : index.runs.filter((r) => r.repo === state.heatRepo);
  const { matrix, counts, max } = activityMatrix(scoped, state.heatMetric);

  const unit = state.heatMetric === 'duration' || state.heatMetric === 'queue' ? 'm' : '';
  const color = (value) => SEQUENTIAL_BLUE[
    Math.min(SEQUENTIAL_BLUE.length - 1, Math.floor((value / max) * (SEQUENTIAL_BLUE.length - 1)))
  ];

  const hourTicks = [0, 3, 6, 9, 12, 15, 18, 21];
  setHtml('heatmapArea', html`
    <div style="display:flex;">
      <div style="display:flex;flex-direction:column;gap:2px;padding-top:20px;margin-right:6px;">
        ${DAY_LABELS.map((day) => html`<div style="font-size:10px;font-family:var(--mono);color:var(--text3);height:14px;display:flex;align-items:center;">${day}</div>`)}
      </div>
      <div style="flex:1;overflow-x:auto;">
        <div class="heatmap-hours">
          ${Array.from({ length: 24 }, (_, h) => html`<div class="hhour">${hourTicks.includes(h) ? `${h}h` : ''}</div>`)}
        </div>
        <div style="display:flex;flex-direction:column;gap:2px;">
          ${DAY_LABELS.map((day, d) => html`
            <div class="heatmap-row">
              ${Array.from({ length: 24 }, (_, h) => html`<div class="hcell"
                style="background:${color(matrix[d][h])}"
                data-tip="${day} ${h}:00 — ${matrix[d][h]}${unit} (${counts[d][h]} runs)"></div>`)}
            </div>
          `)}
        </div>
      </div>
    </div>
  `);

  setHtml('heatLegend', html`
    <span class="heat-leg-label">less</span>
    ${SEQUENTIAL_BLUE.map((c) => html`<div class="heat-leg-cell" style="background:${c};"></div>`)}
    <span class="heat-leg-label" style="margin-left:4px;">more</span>
  `);
}
