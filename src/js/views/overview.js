import {
  activityMatrix,
  dailyBuckets,
  sparkline,
  topBy,
  weeklyQueueSplit,
} from '../data/analytics.js';
import { html, raw, setHtml } from '../lib/dom.js';
import { fitWindow } from '../lib/store.js';
import {
  fmtComputeMinutes,
  fmtDuration,
  fmtNumber,
  percentile,
  repoShortName,
  timeAgo,
  toMinutes,
  truncate,
  windowLabel,
} from '../lib/format.js';
import {
  STATUS_COLORS,
  assignColors,
  entityColor,
  sequential,
  surface,
  withAlpha,
} from '../lib/palette.js';
import { axis, chart, chartMessage, legend } from '../ui/charts.js';
import { emptyState, eventRow, metricCard, repoCard } from '../ui/components.js';
import { icon } from '../ui/icons.js';
import { progressFor } from './live.js';

const OUTCOMES = [
  { key: 'success', label: 'success' },
  { key: 'failed', label: 'failed' },
  { key: 'cancelled', label: 'cancelled' },
  { key: 'skipped', label: 'skipped' },
];

export function renderOverview(ctx) {
  const { index, state } = ctx;
  renderVerdict(ctx);
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
  renderQueueSplit(ctx.historyRuns || index.runs);
  renderP95(index);
}

/* ------------------------------------------------------------------ verdict */

/**
 * The one-line answer to "is CI OK?", with the reasons as chips you can act
 * on. Everything below it is detail; this is what the reader came for.
 */
function renderVerdict(ctx) {
  const { index, activeRuns, state } = ctx;
  const o = index.overall;
  const now = Date.now();
  const graded = o.success + o.failed;

  const repos = Array.from(index.repoStats.values());
  const unhealthy = repos.filter((r) => r.health.score < 75).sort((a, b) => a.health.score - b.health.score);
  const critical = unhealthy.filter((r) => r.health.score < 60);
  const failed24 = index.runs.filter((r) => r.status === 'failed' && r.ts >= now - 86400000).length;
  const overrun = activeRuns.filter((run) => progressFor(run, index, now).overrun).length;

  let tone;
  let title;
  if (!o.total) {
    tone = 'quiet';
    title = 'Nothing in this window';
  } else if (!graded) {
    tone = 'quiet';
    title = 'Nothing to grade yet';
  } else if (critical.length || o.successRate < 75) {
    tone = 'bad';
    title = critical.length
      ? `${critical.length} ${critical.length === 1 ? 'repository needs' : 'repositories need'} attention`
      : 'CI is struggling';
  } else if (unhealthy.length || failed24 || overrun) {
    tone = 'warn';
    title = 'Mostly healthy';
  } else {
    tone = 'good';
    title = 'All systems green';
  }

  const scope = state.repo === 'all' ? '' : `In ${repoShortName(state.repo)}, `;
  const parts = [];
  if (graded) {
    parts.push(`${o.successRate}% of ${fmtNumber(graded)} graded runs passed in the last ${windowLabel(state.days)}`);
    if (o.failed) parts.push(`${fmtNumber(o.failed)} failed`);
  } else if (o.total) {
    parts.push(`${fmtNumber(o.total)} runs in the last ${windowLabel(state.days)}, none completed with a pass or a fail`);
  } else {
    parts.push('No runs in the selected window — widen it, or connect a token');
  }
  if (o.running) parts.push(`${fmtNumber(o.running)} running now`);
  const summary = `${scope}${parts.join(' · ')}.`;

  const chips = [];
  unhealthy.slice(0, 4).forEach((r) => {
    chips.push(html`<button class="chip ${r.health.score < 60 ? 'chip-bad' : 'chip-warn'}" type="button"
      data-repo-filter="${r.repo}" title="Focus on ${r.repo}">${repoShortName(r.repo)} <span class="mono">${r.health.score}</span></button>`);
  });
  if (unhealthy.length > 4) chips.push(html`<span class="chip">+${unhealthy.length - 4} more</span>`);
  if (failed24) {
    chips.push(html`<button class="chip chip-bad" type="button" data-jump="failures">${icon('x', 12)} ${failed24} failed in 24h</button>`);
  }
  if (overrun) {
    chips.push(html`<button class="chip chip-warn" type="button" data-jump="live">${icon('clock', 12)} ${overrun} running over median</button>`);
  }
  if (!chips.length && graded) {
    chips.push(html`<span class="chip chip-good">${icon('check', 12)} No failures in the last 24 hours</span>`);
  }

  const glyph = tone === 'good' ? 'check' : tone === 'quiet' ? 'clock' : 'alert';
  setHtml('verdictBar', html`
    <div class="verdict verdict-${tone}" role="status">
      <div class="verdict-icon" aria-hidden="true">${icon(glyph, 20)}</div>
      <div class="verdict-body">
        <h2 class="verdict-title">${title}</h2>
        <p class="verdict-sub">${summary}</p>
      </div>
      ${chips.length ? html`<div class="verdict-chips">${chips}</div>` : ''}
    </div>
  `);
}

/* ------------------------------------------------------------------ metrics */

/** Relative change, for measures where the ratio is what matters. */
export function pctDelta(current, previous, { better = 'up', title = '' } = {}) {
  const cur = Number(current);
  const prev = Number(previous);
  if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev === 0) return null;
  const change = Math.round(((cur - prev) / prev) * 100);
  return describeDelta(change, `${change > 0 ? '+' : ''}${change}%`, better, title);
}

/** Absolute change, for percentages-as-points and plain counts. */
export function absDelta(current, previous, { better = 'up', unit = '', title = '' } = {}) {
  const cur = Number(current);
  const prev = Number(previous);
  if (!Number.isFinite(cur) || !Number.isFinite(prev)) return null;
  const change = Math.round(cur - prev);
  return describeDelta(change, `${change > 0 ? '+' : ''}${change}${unit}`, better, title);
}

function describeDelta(change, text, better, title) {
  if (!change) return { text: 'no change', dir: 'flat', good: null, title };
  const dir = change > 0 ? 'up' : 'down';
  const good = better === 'none' ? null : dir === better;
  return { text, dir, good, title };
}

function renderMetrics({ index, prevIndex, state, loadedRuns, newestRunTs }) {
  const o = index.overall;
  if (!o.total) {
    // "no data" on its own reads as "your CI is empty" or "this is broken". If
    // runs were loaded and the window simply excludes them, say exactly that —
    // and offer the fix, rather than leaving the reader to guess.
    const hasOlder = Boolean(loadedRuns) && Boolean(newestRunTs);
    const wider = hasOlder ? fitWindow([{ ts: newestRunTs }], state.days) : null;

    setHtml('metricsRow', html`
      <div class="metric-card span-all">
        <div class="metric-label">No runs in the last ${windowLabel(state.days)}</div>
        ${hasOlder
          ? html`
            <div class="metric-sub">
              ${fmtNumber(loadedRuns)} run${loadedRuns === 1 ? '' : 's'} loaded${state.repo === 'all' ? '' : ` (filtered to ${state.repo})`} ·
              most recent was ${timeAgo(newestRunTs)}
            </div>
            ${wider && wider !== state.days
              ? html`<div><button class="btn btn-sm" type="button" data-action="widen-window" data-days="${wider}">Show the last ${windowLabel(wider)}</button></div>`
              : ''}
          `
          : html`<div class="metric-sub">Nothing has been loaded yet. Connect a token, or widen the time range.</div>`}
      </div>
    `);
    return;
  }

  const p = prevIndex && prevIndex.overall.total ? prevIndex.overall : null;
  const prevLabel = `vs the previous ${windowLabel(state.days)}`;

  // Per-day series behind each tile. They show shape, not value: the number
  // above them is the value.
  const buckets = dailyBuckets(index.runs, state.days);
  const perDay = (fn) => buckets.map((b) => fn(b.runs));
  let lastRate = 100;
  const spark = {
    total: perDay((rs) => rs.length),
    rate: perDay((rs) => {
      const g = rs.filter((r) => r.status === 'success' || r.status === 'failed');
      if (g.length) lastRate = Math.round((g.filter((r) => r.status === 'success').length / g.length) * 100);
      return lastRate;
    }),
    failures: perDay((rs) => rs.filter((r) => r.status === 'failed').length),
    duration: perDay((rs) => percentile(rs.filter((r) => r.status !== 'in_progress').map((r) => r.dur), 50)),
    queue: perDay((rs) => percentile(rs.map((r) => r.queue), 50)),
    compute: perDay((rs) => Math.round(rs.reduce((a, r) => a + r.dur, 0) / 60)),
  };

  const rateTone = o.successRate >= 90 ? 'good' : o.successRate >= 75 ? 'warn' : 'bad';

  setHtml('metricsRow', html`
    ${metricCard({
      label: 'Total runs',
      value: fmtNumber(o.total),
      sub: o.running ? `${fmtNumber(o.running)} running now` : `${fmtNumber(o.completed)} completed`,
      delta: p ? pctDelta(o.total, p.total, { better: 'none', title: prevLabel }) : null,
      spark: spark.total,
    })}
    ${metricCard({
      label: 'Success rate',
      value: `${o.successRate}%`,
      sub: `${fmtNumber(o.success)} of ${fmtNumber(o.success + o.failed)} graded`,
      tone: rateTone,
      delta: p && p.success + p.failed ? absDelta(o.successRate, p.successRate, { unit: ' pts', better: 'up', title: prevLabel }) : null,
      spark: spark.rate,
      hint: 'Successes over successes plus failures. Cancelled and skipped runs are not graded.',
    })}
    ${metricCard({
      label: 'Failures',
      value: fmtNumber(o.failed),
      sub: `${o.failureRate}% of graded runs`,
      tone: o.failed ? 'bad' : 'good',
      delta: p ? absDelta(o.failed, p.failed, { better: 'down', title: prevLabel }) : null,
      spark: spark.failures,
    })}
    ${metricCard({
      label: 'Median duration',
      value: fmtDuration(o.p50Duration),
      sub: `p95 ${fmtDuration(o.p95Duration)}`,
      delta: p ? pctDelta(o.p50Duration, p.p50Duration, { better: 'down', title: prevLabel }) : null,
      spark: spark.duration,
    })}
    ${metricCard({
      label: 'Avg queue wait',
      value: fmtDuration(o.avgQueue),
      sub: `p95 ${fmtDuration(o.p95Queue)}`,
      tone: o.p95Queue > 300 ? 'warn' : null,
      delta: p ? pctDelta(o.avgQueue, p.avgQueue, { better: 'down', title: prevLabel }) : null,
      spark: spark.queue,
    })}
    ${metricCard({
      label: 'Compute',
      value: fmtComputeMinutes(o.computeMinutes),
      sub: `${fmtNumber(o.computeMinutes)} minutes`,
      delta: p ? pctDelta(o.computeMinutes, p.computeMinutes, { better: 'none', title: prevLabel }) : null,
      spark: spark.compute,
    })}
  `);
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
          borderColor: surface(),
          borderWidth: 2,
          hoverOffset: 4,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '70%',
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
  const bar = (label, data, color) => ({
    label, data, backgroundColor: color, stack: 'runs', borderRadius: 3, borderSkipped: false, borderColor: surface(), borderWidth: 2, maxBarThickness: 36,
  });

  chart(
    'volumeChart',
    {
      type: 'bar',
      data: {
        labels: buckets.map((b) => b.label),
        datasets: [
          bar('success', success, STATUS_COLORS.success),
          bar('failed', failed, STATUS_COLORS.failed),
          bar('other', other, STATUS_COLORS.skipped),
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: { x: axis({ grid: false, stacked: true }), y: axis({ stacked: true, ticks: { precision: 0 } }) },
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
    pointRadius: 3,
    pointHoverRadius: 6,
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
          maxBarThickness: 22,
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
          pointRadius: 2.5,
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
    ${burnStat('Total', fmtComputeMinutes(total), `${fmtNumber(total)} minutes`)}
    ${burnStat('Daily average', `${avg}m`, 'across the window')}
    ${burnStat('Trend', `${arrow} ${Math.abs(trendPct)}%`,
      rising ? 'rising, second half vs first' : falling ? 'falling, second half vs first' : 'steady',
      rising ? 'bad' : falling ? 'good' : null)}
  `);
}

function burnStat(label, value, sub, tone) {
  return html`
    <div class="burn-stat">
      <div class="metric-label">${label}</div>
      <div class="burn-val ${tone ? `tone-${tone}` : ''}">${value}</div>
      <div class="metric-sub">${sub}</div>
    </div>
  `;
}

/**
 * Weekly comparison, from everything loaded rather than the active window: a
 * 7-day window would otherwise show one bar and three empty weeks.
 */
function renderQueueSplit(runs) {
  const weeks = weeklyQueueSplit(runs);
  chart(
    'queueChart',
    {
      type: 'bar',
      data: {
        labels: weeks.map((w) => w.label),
        datasets: [
          { label: 'queue wait', data: weeks.map((w) => w.queue), backgroundColor: '#c98500', stack: 'a', borderRadius: 3, borderSkipped: false, borderColor: surface(), borderWidth: 2, maxBarThickness: 48 },
          { label: 'execution', data: weeks.map((w) => w.exec), backgroundColor: '#3987e5', stack: 'a', borderRadius: 3, borderSkipped: false, borderColor: surface(), borderWidth: 2, maxBarThickness: 48 },
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
          maxBarThickness: 22,
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

  const meta = new Map((state.repos || []).map((repo) => [repo.fullName, repo]));

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
        const info = meta.get(stats.repo);
        // Only ever link to github.com, whatever the API said.
        const url = info && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(String(info.htmlUrl || ''))
          ? info.htmlUrl
          : null;
        return repoCard(withSpark, { open, container: containerId, workflows, url, focused: state.repo === stats.repo });
      })}`
    : emptyState('No repositories with runs', 'Nothing matched the current filters.', { icon: 'folder' }));
}

/* ----------------------------------------------------------------- matrix */

function renderMatrix({ index, state }) {
  const repos = index.repos.slice(0, 14);
  const workflows = topBy(index.workflowStats, (s) => s.total, 10).map((e) => e.key);
  const metric = state.metric;
  const ramp = sequential();

  if (!repos.length || !workflows.length) {
    setHtml('matrixWrap', emptyState('Nothing to compare yet', 'The matrix needs at least one repository with a workflow run.'));
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
      ramp.length - 1,
      Math.max(1, Math.ceil((max ? value / max : 0) * (ramp.length - 1))),
    );
    return ramp[step];
  };
  // Dark ramp steps need light text; the pale end of the light ramp does not.
  const ink = (value) => {
    if (value === null || metric === 'success') return '';
    const step = Math.ceil((max ? value / max : 0) * (ramp.length - 1));
    return ramp === sequential() && step >= 3 ? 'color:#fff;' : '';
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
                style="${bg ? `background:${bg};` : ''}${ink(value)}"
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
    : legend(ramp.slice(1).map((color, i, arr) => ({
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
      kind: 'failed',
      text: `${run.wf} failed`,
      sub: repoShortName(run.repo),
      tag: run.flaky ? 'flaky' : null,
      run,
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
        kind: 'slow',
        text: `${run.wf} took ${fmtDuration(run.dur)} (p95 ${fmtDuration(stats.p95Duration)})`,
        sub: repoShortName(run.repo),
        run,
      });
    }
  });

  const top = events.sort((a, b) => b.ts - a.ts).slice(0, 10);
  setHtml('ciPulseFeed', top.length
    ? html`${top.map(eventRow)}`
    : emptyState('All quiet', 'No failures or outliers in this window.', { icon: 'check' }));
}

function renderStreaks(index) {
  const rows = Array.from(index.repoStats.values())
    .sort((a, b) => b.streak - a.streak)
    .slice(0, 6);

  setHtml('streakGrid', rows.length ? html`${rows.map((stats) => {
    const tone = stats.streak >= 10 ? 'tone-good' : stats.streak >= 5 ? 'tone-warn' : stats.streak > 0 ? 'muted' : 'tone-bad';
    const pips = Math.min(stats.streak, 10);
    return html`
      <div class="streak-row ${tone}">
        <span class="streak-num">${stats.streak}</span>
        <div class="grow">
          <div class="pulse-text">${repoShortName(stats.repo)}</div>
          <div class="pulse-sub">${stats.streak === 0 ? 'last run was red' : 'consecutive green runs'} · ${stats.successRate}% overall</div>
        </div>
        <div class="streak-pips" aria-hidden="true">
          ${Array.from({ length: Math.max(pips, 1) }, () => html`<span class="streak-pip"></span>`)}
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
      <div class="sink-row">
        <div class="sink-head">
          <span class="sink-name" title="${entry.key}">${entry.key}</span>
          <span class="sink-val">${fmtComputeMinutes(minutes)}</span>
        </div>
        <div class="sink-track">
          <div class="sink-fill" style="width:${Math.round((entry.value / max) * 100)}%;background:${colors.get(entry.key)};"></div>
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
  const ramp = sequential();

  const unit = state.heatMetric === 'duration' || state.heatMetric === 'queue' ? 'm' : '';
  const color = (value) => (value === 0
    ? 'var(--surface-3)'
    : ramp[Math.min(ramp.length - 1, Math.max(1, Math.ceil((value / max) * (ramp.length - 1))))]);

  const hourTicks = [0, 3, 6, 9, 12, 15, 18, 21];
  setHtml('heatmapArea', html`
    <div class="heatmap">
      <div class="heatmap-days" aria-hidden="true">
        ${DAY_LABELS.map((day) => html`<div class="hday">${day}</div>`)}
      </div>
      <div class="heatmap-body">
        <div class="heatmap-hours" aria-hidden="true">
          ${Array.from({ length: 24 }, (_, h) => html`<div class="hhour">${hourTicks.includes(h) ? `${h}h` : ''}</div>`)}
        </div>
        <div class="heatmap-rows">
          ${DAY_LABELS.map((day, d) => html`
            <div class="heatmap-row">
              ${Array.from({ length: 24 }, (_, h) => html`<div class="hcell" role="img"
                style="background:${color(matrix[d][h])}"
                aria-label="${day} ${h}:00 — ${matrix[d][h]}${unit} (${counts[d][h]} runs)"
                data-tip="${day} ${h}:00 — ${matrix[d][h]}${unit} (${counts[d][h]} runs)"></div>`)}
            </div>
          `)}
        </div>
      </div>
    </div>
  `);

  setHtml('heatLegend', html`
    <span class="heat-leg-label">less</span>
    <div class="heat-leg-cell" style="background:var(--surface-3);"></div>
    ${ramp.slice(1).map((c) => html`<div class="heat-leg-cell" style="background:${c};"></div>`)}
    <span class="heat-leg-label">more</span>
  `);
}
