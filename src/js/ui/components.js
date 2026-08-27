// Shared render fragments. Every one returns TrustedHtml built with `html`,
// so no view has to remember to escape anything.

import { html } from '../lib/dom.js';
import {
  fmtComputeMinutes,
  fmtDuration,
  fmtNumber,
  repoInitials,
  repoShortName,
  timeAgo,
  truncate,
} from '../lib/format.js';
import { entityColor, entityTint, healthTone, statusIcon } from '../lib/palette.js';

/**
 * Status pill. Colour, an icon and the word — three channels, so it reads for
 * colourblind users, in greyscale print and to a screen reader.
 */
export function statusBadge(status, { label } = {}) {
  const cls = {
    success: 'badge-green',
    failed: 'badge-red',
    cancelled: 'badge-amber',
    skipped: 'badge-gray',
    in_progress: 'badge-blue',
  }[status] || 'badge-gray';
  return html`<span class="badge ${cls}"><span aria-hidden="true">${statusIcon(status)}</span> ${label || status.replace('_', ' ')}</span>`;
}

export function metricCard({ label, value, sub, color }) {
  return html`
    <div class="metric-card">
      <div class="metric-label">${label}</div>
      <div class="metric-value" style="color:${color || 'var(--text)'}">${value}</div>
      ${sub ? html`<div class="metric-sub">${sub}</div>` : ''}
    </div>
  `;
}

/** Repo avatar whose colour is derived from the name, so it never shifts. */
export function repoAvatar(fullName, { size = 32 } = {}) {
  return html`<div class="repo-avatar"
    style="width:${size}px;height:${size}px;background:${entityTint(fullName)};color:${entityColor(fullName)};">${repoInitials(fullName)}</div>`;
}

export function sparkBars(days) {
  const max = Math.max(...days.map((d) => d.count), 1);
  return html`<div class="sparkline" role="img"
    aria-label="Runs per day over the last week: ${days.map((d) => d.count).join(', ')}">${days.map((day) => {
    const height = Math.max(3, Math.round((day.count / max) * 24));
    const color = day.failed > 0 ? 'var(--red)' : 'var(--green)';
    return html`<div class="spark-bar" style="height:${height}px;background:${color};opacity:0.8;"></div>`;
  })}</div>`;
}

export function emptyState(title, body) {
  return html`<div class="empty-state"><strong>${title}</strong>${body || ''}</div>`;
}

export function viewError(where, error) {
  return html`
    <div class="view-error">
      Could not render ${where}.
      <code>${error && error.message ? error.message : String(error)}</code>
    </div>
  `;
}

/** One line in the CI pulse / recent-activity feeds. */
export function eventRow({ icon, color, text, sub, ts, tag }) {
  return html`
    <div class="pulse-row">
      <span class="pulse-icon" style="color:${color}" aria-hidden="true">${icon}</span>
      <div style="min-width:0;">
        <div class="pulse-text">${text}${tag ? html` <span class="badge badge-amber">${tag}</span>` : ''}</div>
        <div class="pulse-sub">${sub} · ${timeAgo(ts)}</div>
      </div>
    </div>
  `;
}

/** A run row for the "all runs" and "longest runs" tables. */
export function runRow(run) {
  return html`
    <tr class="run-row" tabindex="0" role="button"
      data-run-repo="${run.repo}" data-run-id="${run.id}"
      aria-label="Open logs for ${run.wf} in ${run.repo}">
      <td>${statusBadge(run.status)}</td>
      <td class="run-name">${run.wf}</td>
      <td><span style="color:${entityColor(run.repo)}">${run.repo}</span></td>
      <td class="run-branch">${truncate(run.branch, 24)}</td>
      <td>${fmtDuration(run.dur)}</td>
      <td style="color:var(--text3)">${fmtDuration(run.queue)}</td>
      <td style="color:var(--text3)">${timeAgo(run.ts)}</td>
      <td style="text-align:right;"><span class="logs-cue">logs ›</span></td>
    </tr>
  `;
}

/**
 * Repository scorecard. The health number is decomposed on hover and in the
 * expanded panel, because one opaque score is not actionable.
 */
export function repoCard(stats, { open, container, workflows }) {
  const { repo, health } = stats;
  const tone = healthTone(health.score);
  const failRate = stats.failureRate;

  return html`
    <div class="repo-row ${open ? 'open' : ''}">
      <button class="repo-summary" type="button" data-repo-toggle="${repo}"
        data-container="${container}" aria-expanded="${open ? 'true' : 'false'}">
        ${repoAvatar(repo)}
        <div class="repo-info">
          <div class="repo-name">${repo}</div>
          <div class="repo-desc">${stats.total} runs · last ${timeAgo(stats.lastTs)}</div>
        </div>
        <div class="repo-stats">
          <div class="repo-stat">
            <div class="repo-stat-val" style="color:${tone.color}">${health.score}</div>
            <div class="repo-stat-label">health</div>
          </div>
          <div class="repo-stat">
            <div class="repo-stat-val" style="color:${failRate > 15 ? 'var(--red)' : failRate > 8 ? 'var(--amber)' : 'var(--text)'}">${failRate}%</div>
            <div class="repo-stat-label">fail rate</div>
          </div>
          <div class="repo-stat">
            <div class="repo-stat-val">${fmtDuration(stats.p95Duration)}</div>
            <div class="repo-stat-label">p95</div>
          </div>
          <div class="repo-stat" style="min-width:52px;">
            <div class="repo-stat-val">${fmtComputeMinutes(stats.computeMinutes)}</div>
            <div class="repo-stat-label">compute</div>
          </div>
          ${sparkBars(stats.spark || [])}
        </div>
        <svg class="chevron-icon" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"
          stroke-linecap="round" aria-hidden="true">
          <path d="M2.5 5l4.5 4 4.5-4" />
        </svg>
      </button>
      ${open ? repoDetail(stats, workflows) : html`<div class="repo-detail"></div>`}
    </div>
  `;
}

function repoDetail(stats, workflows) {
  const { health } = stats;
  const maxWfSeconds = Math.max(...workflows.map((wf) => wf.avgDuration), 1);

  return html`
    <div class="repo-detail" style="display:block;">
      <div class="detail-metrics">
        ${detailMetric('reliability', `${health.reliability}%`, `${stats.success} of ${stats.success + stats.failed} graded runs`)}
        ${detailMetric('speed', `${health.speed}/100`, `p95 ${fmtDuration(stats.p95Duration)} · median ${fmtDuration(stats.p50Duration)}`)}
        ${detailMetric('recovery', stats.mttr.samples ? `${stats.mttr.meanMinutes}m` : '—', stats.mttr.samples ? `${stats.mttr.samples} outage${stats.mttr.samples === 1 ? '' : 's'}` : 'never broken')}
        ${detailMetric('queue wait', fmtDuration(stats.avgQueue), `p95 ${fmtDuration(stats.p95Queue)}`)}
      </div>
      <div style="margin-bottom:10px;">
        <div class="card-title" style="margin-bottom:10px;">workflows</div>
        <table class="wf-table">
          <thead>
            <tr><th scope="col"></th><th scope="col">workflow</th><th scope="col">avg duration</th><th scope="col">outcome</th></tr>
          </thead>
          <tbody>
            ${workflows.map((wf) => {
              const dotColor = wf.failed > 3 ? 'var(--red)' : wf.failed > 0 ? 'var(--amber)' : 'var(--green)';
              const width = Math.round((wf.avgDuration / maxWfSeconds) * 100);
              return html`
                <tr>
                  <td><span class="status-dot" style="background:${dotColor};display:inline-block;"></span></td>
                  <td style="color:var(--text);">${wf.wf}</td>
                  <td>
                    <div class="dur-bar-wrap">
                      <div class="dur-track"><div class="dur-fill" style="width:${width}%;"></div></div>
                      <span class="dur-val">${fmtDuration(wf.avgDuration)}</span>
                    </div>
                  </td>
                  <td><span class="badge ${wf.failed > 3 ? 'badge-red' : wf.failed > 0 ? 'badge-amber' : 'badge-green'}">${wf.failed} failed / ${wf.total}</span></td>
                </tr>
              `;
            })}
          </tbody>
        </table>
      </div>
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
