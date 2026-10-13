// Shared render fragments. Every one returns TrustedHtml built with `html`,
// so no view has to remember to escape anything.

import { html } from '../lib/dom.js';
import {
  fmtComputeMinutes,
  fmtDateTime,
  fmtDuration,
  fmtNumber,
  repoInitials,
  timeAgo,
  truncate,
} from '../lib/format.js';
import { STATUS_LABELS, entityColor, entityTint, healthTone, statusIcon } from '../lib/palette.js';
import { icon } from './icons.js';

const STATUS_CLASS = {
  success: 'badge-success',
  failed: 'badge-failed',
  cancelled: 'badge-cancelled',
  skipped: 'badge-skipped',
  in_progress: 'badge-running',
};

const TONE_WORD = { good: 'Healthy', warn: 'Watch', bad: 'At risk' };

/**
 * Status pill. Colour, an icon and the word — three channels, so it reads for
 * colourblind users, in greyscale print and to a screen reader.
 */
export function statusBadge(status, { label } = {}) {
  const cls = STATUS_CLASS[status] || 'badge-skipped';
  return html`<span class="badge ${cls}"><span class="badge-icon" aria-hidden="true">${statusIcon(status)}</span>${label || STATUS_LABELS[status] || status}</span>`;
}

/**
 * KPI tile.
 *
 * @param {object} o
 * @param {string} o.label
 * @param {string|number} o.value
 * @param {string} [o.sub]          one line under the value
 * @param {'good'|'warn'|'bad'|'info'} [o.tone]  colours the value
 * @param {object} [o.delta]        { text, dir, good, title } from deltaChip
 * @param {number[]} [o.spark]      per-day series; drawn when 3+ points
 * @param {string} [o.hint]         methodology note, shown on hover/focus
 * @param {boolean} [o.small]       text value rather than a big number
 */
export function metricCard({ label, value, sub, tone, delta, spark, hint, small }) {
  return html`
    <div class="metric-card ${small ? 'metric-small' : ''}">
      <div class="metric-head">
        <span class="metric-label">${label}${hint
          ? html` <span class="hint" tabindex="0" role="img" title="${hint}" aria-label="${hint}">${icon('info', 12)}</span>`
          : ''}</span>
        ${delta ? deltaChip(delta) : ''}
      </div>
      <div class="metric-value ${tone ? `tone-${tone}` : ''}" title="${small ? value : ''}">${value}</div>
      <div class="metric-foot">
        ${sub ? html`<span class="metric-sub">${sub}</span>` : html`<span></span>`}
        ${spark && spark.length >= 3 ? sparkLine(spark, { tone }) : ''}
      </div>
    </div>
  `;
}

/** Period-over-period change. `good` is null for a neutral measure. */
export function deltaChip({ text, dir, good, title }) {
  const cls = dir === 'flat' ? 'delta-flat' : good === null || good === undefined ? '' : good ? 'delta-good' : 'delta-bad';
  const arrow = dir === 'up' ? 'arrow-up' : dir === 'down' ? 'arrow-down' : 'minus';
  return html`<span class="delta ${cls}" title="${title || ''}">${icon(arrow, 11)}${text}</span>`;
}

/** Tiny inline trend line. Scales to its own min/max; it shows shape, not value. */
export function sparkLine(values, { tone } = {}) {
  const nums = values.map((v) => (Number.isFinite(Number(v)) ? Number(v) : 0));
  if (nums.length < 2) return html``;
  const max = Math.max(...nums);
  const min = Math.min(...nums);
  const range = max - min || 1;
  const n = nums.length;
  const points = nums.map((v, i) => [
    ((i / (n - 1)) * 100).toFixed(1),
    (25 - ((v - min) / range) * 22).toFixed(1),
  ]);
  const line = points.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ');
  const area = `${line} L100 28 L0 28 Z`;
  return html`<svg class="spark ${tone ? `tone-${tone}` : ''}" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true"><path class="spark-area" d="${area}"></path><path class="spark-line" d="${line}"></path></svg>`;
}

/** Health score as a ring with the number inside. */
export function healthRing(score, { size = 36 } = {}) {
  const value = Math.max(0, Math.min(100, Math.round(Number(score) || 0)));
  const r = 15.5;
  const circumference = 2 * Math.PI * r;
  const tone = healthTone(value).tone;
  return html`<svg class="ring tone-${tone}" width="${size}" height="${size}" viewBox="0 0 36 36" role="img" aria-label="Health ${value} out of 100">
    <circle class="ring-track" cx="18" cy="18" r="${r}"></circle>
    <circle class="ring-fill" cx="18" cy="18" r="${r}" stroke-dasharray="${((circumference * value) / 100).toFixed(2)} ${circumference.toFixed(2)}" transform="rotate(-90 18 18)"></circle>
    <text class="ring-text" x="18" y="18.5" text-anchor="middle" dominant-baseline="central">${value}</text>
  </svg>`;
}

/** Repo avatar whose colour is derived from the name, so it never shifts. */
export function repoAvatar(fullName, { size = 32 } = {}) {
  return html`<div class="repo-avatar" aria-hidden="true"
    style="width:${size}px;height:${size}px;background:${entityTint(fullName)};color:${entityColor(fullName)};">${repoInitials(fullName)}</div>`;
}

/** "owner/" dimmed, "name" strong. */
export function repoName(fullName) {
  const text = String(fullName || '');
  const slash = text.lastIndexOf('/');
  if (slash === -1) return html`${text}`;
  return html`<span class="repo-owner">${text.slice(0, slash + 1)}</span>${text.slice(slash + 1)}`;
}

/** Repo identity chip: colour dot plus name. */
export function repoChip(fullName) {
  return html`<span class="repo-chip" title="${fullName}"><span class="repo-dot" style="background:${entityColor(fullName)}" aria-hidden="true"></span><span class="truncate">${repoName(fullName)}</span></span>`;
}

export function sparkBars(days) {
  if (!days.length) return html``;
  const max = Math.max(...days.map((d) => d.count), 1);
  return html`<div class="spark-bars" role="img"
    aria-label="Runs per day over the last week: ${days.map((d) => d.count).join(', ')}">${days.map((day) => {
    const height = Math.max(3, Math.round((day.count / max) * 26));
    const color = day.failed > 0 ? 'var(--red)' : day.count ? 'var(--green)' : 'var(--surface-3)';
    return html`<div class="spark-bar" style="height:${height}px;background:${color};opacity:0.85;"></div>`;
  })}</div>`;
}

export function emptyState(title, body, { icon: name = 'inbox', action } = {}) {
  return html`<div class="empty-state">${icon(name, 28)}<strong>${title}</strong>${body || ''}${action || ''}</div>`;
}

export function viewError(where, error) {
  return html`
    <div class="view-error">
      Could not render ${where}.
      <code>${error && error.message ? error.message : String(error)}</code>
    </div>
  `;
}

/**
 * One line in the CI pulse feed. With a `run`, the row is a button that opens
 * that run's job breakdown.
 */
export function eventRow({ kind, text, sub, ts, tag, run }) {
  const glyph = kind === 'failed' ? 'x' : kind === 'slow' ? 'clock' : 'check';
  const body = html`
    <span class="pulse-icon ${kind}" aria-hidden="true">${icon(glyph, 13)}</span>
    <div class="pulse-body">
      <div class="pulse-text">${text}${tag ? html` <span class="badge badge-flaky">${tag}</span>` : ''}</div>
      <div class="pulse-sub">${sub} · ${timeAgo(ts)}</div>
    </div>
  `;
  return run
    ? html`<button class="pulse-row" type="button" data-run-repo="${run.repo}" data-run-id="${run.id}"
        aria-label="Open logs for ${run.wf} in ${run.repo}">${body}</button>`
    : html`<div class="pulse-row">${body}</div>`;
}

/** A run row for the "all runs" table. */
export function runRow(run) {
  return html`
    <tr class="run-row" tabindex="0" role="button"
      data-run-repo="${run.repo}" data-run-id="${run.id}"
      aria-label="Open logs for ${run.wf} in ${run.repo}">
      <td>${statusBadge(run.status)}</td>
      <td class="run-name"><span class="truncate" title="${run.wf}">${run.wf}</span>${run.flaky ? html` <span class="badge badge-flaky">flaky</span>` : ''}</td>
      <td>${repoChip(run.repo)}</td>
      <td class="run-branch mono" title="${run.branch}">${truncate(run.branch, 28)}</td>
      <td class="tnum">${fmtDuration(run.dur)}</td>
      <td class="tnum faint">${fmtDuration(run.queue)}</td>
      <td class="faint" title="${fmtDateTime(run.ts)}">${timeAgo(run.ts)}</td>
      <td class="td-right"><span class="row-cue">Logs ${icon('chevron-right', 12)}</span></td>
    </tr>
  `;
}

/**
 * Repository scorecard. The health number is decomposed in the expanded panel,
 * because one opaque score is not actionable.
 */
export function repoCard(stats, { open, container, workflows, url, focused }) {
  const { repo, health } = stats;
  const tone = healthTone(health.score).tone;
  const failRate = stats.failureRate;
  const failTone = failRate > 15 ? 'tone-bad' : failRate > 8 ? 'tone-warn' : '';

  return html`
    <div class="repo-row ${open ? 'open' : ''}">
      <button class="repo-summary" type="button" data-repo-toggle="${repo}"
        data-container="${container}" aria-expanded="${open ? 'true' : 'false'}">
        ${repoAvatar(repo, { size: 36 })}
        <div class="repo-info">
          <div class="repo-name">${repoName(repo)}</div>
          <div class="repo-meta">${fmtNumber(stats.total)} runs · last ${timeAgo(stats.lastTs)}${stats.failed
            ? html` · <span class="text-bad">${fmtNumber(stats.failed)} failed</span>` : ''}${stats.running
            ? html` · <span class="text-info">${stats.running} running</span>` : ''}</div>
        </div>
        <div class="repo-stats">
          <div class="repo-stat repo-stat-health">
            ${healthRing(health.score)}
            <div>
              <div class="repo-stat-val tone-${tone}">${TONE_WORD[tone]}</div>
              <div class="repo-stat-label">health</div>
            </div>
          </div>
          <div class="repo-stat">
            <div class="repo-stat-val ${failTone}">${failRate}%</div>
            <div class="repo-stat-label">fail rate</div>
          </div>
          <div class="repo-stat">
            <div class="repo-stat-val">${fmtDuration(stats.p95Duration)}</div>
            <div class="repo-stat-label">p95</div>
          </div>
          <div class="repo-stat">
            <div class="repo-stat-val">${fmtComputeMinutes(stats.computeMinutes)}</div>
            <div class="repo-stat-label">compute</div>
          </div>
          ${sparkBars(stats.spark || [])}
        </div>
        <span class="chevron" aria-hidden="true">${icon('chevron-down', 16)}</span>
      </button>
      ${open ? repoDetail(stats, workflows, url, focused) : ''}
    </div>
  `;
}

function repoDetail(stats, workflows, url, focused) {
  const { health } = stats;
  const graded = stats.success + stats.failed;
  const maxWfSeconds = Math.max(...workflows.map((wf) => wf.avgDuration), 1);
  const outages = stats.mttr.samples;

  return html`
    <div class="repo-detail">
      <div class="score-bars">
        ${scoreBar('Reliability', '60%', health.reliability,
          `${fmtNumber(stats.success)} of ${fmtNumber(graded)} graded runs passed`)}
        ${scoreBar('Speed', '20%', health.speed,
          `p95 ${fmtDuration(stats.p95Duration)} · median ${fmtDuration(stats.p50Duration)} · under 5 min scores 100`)}
        ${scoreBar('Recovery', '20%', health.recovery, outages
          ? `${stats.mttr.meanMinutes}m mean across ${outages} outage${outages === 1 ? '' : 's'} · within 30 min scores 100`
          : 'Never broken in this window')}
      </div>
      <div class="detail-metrics">
        ${detailMetric('Queue wait', fmtDuration(stats.avgQueue), `p95 ${fmtDuration(stats.p95Queue)}`)}
        ${detailMetric('Compute', fmtComputeMinutes(stats.computeMinutes), `${fmtNumber(stats.computeMinutes)} minutes`)}
        ${detailMetric('Flaky failures', fmtNumber(stats.flaky), stats.failed
          ? `${Math.round((stats.flaky / stats.failed) * 100)}% of failures` : 'no failures')}
        ${detailMetric('Green streak', fmtNumber(stats.streak), stats.streak ? 'consecutive passing runs' : 'last run was red')}
      </div>
      <div class="detail-title">Workflows</div>
      <table class="wf-table">
        <thead>
          <tr><th scope="col"></th><th scope="col">Workflow</th><th scope="col">Avg duration</th><th scope="col">Outcome</th></tr>
        </thead>
        <tbody>
          ${workflows.map((wf) => {
            const dotColor = wf.failed > 3 ? 'var(--red)' : wf.failed > 0 ? 'var(--amber)' : 'var(--green)';
            const width = Math.round((wf.avgDuration / maxWfSeconds) * 100);
            return html`
              <tr>
                <td><span class="status-dot" style="background:${dotColor};"></span></td>
                <td class="wf-name">${wf.wf}</td>
                <td>
                  <div class="dur-bar-wrap">
                    <div class="dur-track"><div class="dur-fill" style="width:${width}%;"></div></div>
                    <span class="dur-val">${fmtDuration(wf.avgDuration)}</span>
                  </div>
                </td>
                <td><span class="badge ${wf.failed > 3 ? 'badge-failed' : wf.failed > 0 ? 'badge-cancelled' : 'badge-success'}">${wf.failed} failed / ${wf.total}</span></td>
              </tr>
            `;
          })}
        </tbody>
      </table>
      <div class="detail-actions">
        <button class="btn btn-sm" type="button" data-repo-filter="${stats.repo}">
          ${icon(focused ? 'x' : 'filter', 14)} ${focused ? 'Show all repositories' : 'Focus the dashboard on this repository'}
        </button>
        ${url
          ? html`<a class="btn btn-sm btn-ghost" href="${url}/actions" target="_blank" rel="noopener noreferrer">${icon('external', 14)} Open Actions on GitHub</a>`
          : ''}
      </div>
    </div>
  `;
}

function scoreBar(name, weight, value, sub) {
  const v = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  const tone = healthTone(v).tone;
  return html`
    <div class="score-bar tone-${tone}">
      <div class="score-bar-head">
        <span class="score-bar-name">${name}<span class="score-bar-weight">${weight} weight</span></span>
        <span class="score-bar-val">${v}</span>
      </div>
      <div class="score-track" role="img" aria-label="${name} ${v} out of 100"><div class="score-fill" style="width:${v}%;"></div></div>
      <div class="score-bar-sub">${sub}</div>
    </div>
  `;
}

function detailMetric(label, value, sub) {
  return html`
    <div class="d-metric">
      <div class="d-metric-label">${label}</div>
      <div class="d-metric-val">${value}</div>
      <div class="d-metric-sub">${sub}</div>
    </div>
  `;
}
