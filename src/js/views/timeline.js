import { dailyBuckets, percentile, topBy } from '../data/analytics.js';
import { html, setHtml } from '../lib/dom.js';
import { fmtDateTime, fmtDuration, repoShortName, toMinutes, truncate } from '../lib/format.js';
import { assignColors, entityColor, statusColor, withAlpha } from '../lib/palette.js';
import { axis, chart, chartMessage, legend } from '../ui/charts.js';
import { emptyState, repoChip, statusBadge } from '../ui/components.js';

const HIST_EDGES = [0, 30, 60, 120, 300, 600, 900, 1800, 3600, Infinity];
const HIST_LABELS = ['<30s', '30–60s', '1–2m', '2–5m', '5–10m', '10–15m', '15–30m', '30–60m', '>60m'];

export function renderTimeline(ctx) {
  const { index, state } = ctx;
  const runs = index.runs.filter((run) => (state.workflow === 'all' || run.wf === state.workflow)
    && (state.status === 'all' || run.status === state.status));

  if (!runs.length) {
    // Never overwrite a chart wrapper: message the canvases instead, so the
    // charts return by themselves when the filters do.
    ['tlScatterChart', 'tlSwimChart', 'tlCumRepoChart', 'tlHistChart']
      .forEach((id) => chartMessage(id, 'No runs match these filters.'));
    setHtml('tlLongestBody', html`<tr><td colspan="8">${emptyState('No runs match these filters', 'Try a wider window, or clear the workflow and status filters.', { icon: 'filter' })}</td></tr>`);
    setHtml('tlScatterLegend', html``);
    setHtml('tlSwimLegend', html``);
    return;
  }

  const groupOf = state.group === 'status'
    ? (run) => run.status
    : state.group === 'repo' ? (run) => run.repo : (run) => run.wf;

  renderScatter(runs, state, groupOf);
  renderSwimlanes(runs, index, state);
  renderCumulative(runs);
  renderHistogram(runs);
  renderLongest(runs);
}

function colorsFor(runs, state, groupOf) {
  const keys = [...new Set(runs.map(groupOf))].sort();
  if (state.group === 'status') {
    return { keys, map: new Map(keys.map((k) => [k, statusColor(k)])) };
  }
  // Beyond eight entities, colour stops carrying identity — fold the tail into
  // one neutral "other" rather than cycling hues back to the start.
  const ranked = [...new Set(runs.map(groupOf))]
    .map((key) => ({ key, count: runs.filter((r) => groupOf(r) === key).length }))
    .sort((a, b) => b.count - a.count);
  const named = ranked.slice(0, 8).map((e) => e.key);
  const map = assignColors(named);
  ranked.slice(8).forEach((e) => map.set(e.key, '#767c8b'));
  return { keys: named.concat(ranked.length > 8 ? ['other'] : []), map, folded: ranked.length > 8 };
}

function renderScatter(runs, state, groupOf) {
  const { keys, map } = colorsFor(runs, state, groupOf);

  // Each series must be sorted by start time before it is joined: a line
  // through unsorted points doubles back across the window and reads as noise,
  // which is how the very first version of this chart shipped.
  const datasets = keys.filter((k) => k !== 'other').map((key) => ({
    label: key,
    data: runs.filter((run) => groupOf(run) === key)
      .map((run) => ({
        x: run.ts,
        y: toMinutes(run.dur),
        run,
      }))
      .sort((a, b) => a.x - b.x),
    backgroundColor: withAlpha(map.get(key) || '#767c8b', 0.85),
    borderColor: map.get(key) || '#767c8b',
    pointRadius: 3,
    pointHoverRadius: 7,
    borderWidth: 1.5,
    tension: 0.3,
    fill: false,
  }));

  chart('tlScatterChart', {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      plugins: {
        tooltip: {
          callbacks: {
            title: (items) => fmtDateTime(items[0].raw.x),
            label: (item) => {
              const { run } = item.raw;
              return [run.wf, run.repo, `${fmtDuration(run.dur)} · queued ${fmtDuration(run.queue)}`, `${run.status} · ${run.branch}`];
            },
          },
        },
      },
      scales: {
        x: {
          // beginAtZero must be off here: the values are epoch milliseconds, so
          // anchoring the axis at zero stretches it back to 1970 and squashes
          // every run into the last pixel column.
          ...axis({
            beginAtZero: false,
            callback: (v) => new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
          }),
          type: 'linear',
          bounds: 'data',
        },
        y: axis({ callback: (v) => `${v}m`, title: 'runtime (min)' }),
      },
    },
  }, {
    caption: 'Runs by start time and duration',
    columns: ['started', 'workflow', 'repository', 'duration', 'status'],
    rows: [...runs].sort((a, b) => b.ts - a.ts).slice(0, 50)
      .map((run) => [fmtDateTime(run.ts), run.wf, run.repo, fmtDuration(run.dur), run.status]),
  });

  setHtml('tlScatterLegend', legend(
    keys.map((key) => ({
      label: state.group === 'repo' ? repoShortName(key) : truncate(key, 24),
      color: map.get(key) || '#767c8b',
    })),
    { shape: 'line' },
  ));
}

function renderSwimlanes(runs, index, state) {
  const names = topBy(index.workflowStats, (s) => s.total, 8)
    .map((e) => e.key)
    .filter((name) => runs.some((run) => run.wf === name));
  const colors = assignColors(names);
  const buckets = dailyBuckets(runs, state.days);

  const datasets = names.map((name) => ({
    label: name,
    data: buckets.map((bucket) => {
      const sub = bucket.runs.filter((r) => r.wf === name && r.status === 'success');
      return sub.length ? toMinutes(sub.reduce((a, r) => a + r.dur, 0) / sub.length) : null;
    }),
    borderColor: colors.get(name),
    backgroundColor: 'transparent',
    tension: 0.35,
    pointRadius: 3,
    pointHoverRadius: 7,
    borderWidth: 2,
    spanGaps: true,
  }));

  chart('tlSwimChart', {
    type: 'line',
    data: { labels: buckets.map((b) => b.label), datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: { x: axis({ grid: false }), y: axis({ callback: (v) => `${v}m` }) },
    },
  }, {
    caption: 'Daily average runtime per workflow',
    columns: ['day', ...names.map((n) => truncate(n, 16))],
    rows: buckets.map((b, i) => [b.label, ...datasets.map((d) => (d.data[i] === null ? '—' : `${d.data[i]}m`))]),
  });

  setHtml('tlSwimLegend', legend(
    names.map((name) => ({ label: truncate(name, 24), color: colors.get(name) })),
    { shape: 'line' },
  ));
}

function renderCumulative(runs) {
  const totals = new Map();
  runs.forEach((run) => totals.set(run.repo, (totals.get(run.repo) || 0) + run.dur));
  const entries = Array.from(totals.entries())
    .map(([repo, seconds]) => ({ repo, minutes: Math.round(seconds / 60) }))
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, 12);

  chart('tlCumRepoChart', {
    type: 'bar',
    data: {
      labels: entries.map((e) => truncate(repoShortName(e.repo), 18)),
      datasets: [{
        data: entries.map((e) => e.minutes),
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
      plugins: { tooltip: { callbacks: { title: (c) => entries[c[0].dataIndex].repo } } },
      scales: { x: axis({ callback: (v) => `${v}m` }), y: axis({ grid: false }) },
    },
  }, {
    caption: 'Total compute minutes per repository',
    columns: ['repository', 'minutes'],
    rows: entries.map((e) => [e.repo, e.minutes]),
  });
}

function renderHistogram(runs) {
  const counts = new Array(HIST_LABELS.length).fill(0);
  runs.forEach((run) => {
    for (let i = 0; i < HIST_EDGES.length - 1; i += 1) {
      if (run.dur >= HIST_EDGES[i] && run.dur < HIST_EDGES[i + 1]) {
        counts[i] += 1;
        break;
      }
    }
  });

  chart('tlHistChart', {
    type: 'bar',
    data: {
      labels: HIST_LABELS,
      // One measure, one hue. The old version coloured bars red/amber/blue by
      // their own height, which encodes nothing the axis does not already say.
      datasets: [{ data: counts, backgroundColor: '#3987e5', borderRadius: 4, borderSkipped: false }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { x: axis({ grid: false }), y: axis({ ticks: { precision: 0 } }) },
    },
  }, {
    caption: 'Distribution of run durations',
    columns: ['duration', 'runs'],
    rows: HIST_LABELS.map((label, i) => [label, counts[i]]),
  });
}

function renderLongest(runs) {
  // Compared against the median, not the mean: one 3-hour outlier used to drag
  // the mean up until every other run looked comfortably "under average".
  const median = percentile(runs.map((r) => r.dur), 50) || 1;
  const longest = [...runs].sort((a, b) => b.dur - a.dur).slice(0, 20);

  setHtml('tlLongestBody', html`${longest.map((run, i) => {
    const ratio = run.dur / median;
    const tone = ratio > 3 ? 'tone-bad' : ratio > 1.5 ? 'tone-warn' : 'tone-good';
    return html`
      <tr class="run-row" tabindex="0" role="button"
        data-run-repo="${run.repo}" data-run-id="${run.id}"
        aria-label="Open logs for ${run.wf} in ${run.repo}">
        <td class="faint tnum">${i + 1}</td>
        <td class="run-name"><span class="truncate" title="${run.wf}">${run.wf}</span></td>
        <td>${repoChip(run.repo)}</td>
        <td class="run-branch mono" title="${run.branch}">${truncate(run.branch, 22)}</td>
        <td>${statusBadge(run.status)}</td>
        <td class="faint">${fmtDateTime(run.ts)}</td>
        <td class="tnum text-warn">${fmtDuration(run.dur)}</td>
        <td class="vs-median ${tone}">${ratio.toFixed(1)}×</td>
      </tr>
    `;
  })}`);
}
