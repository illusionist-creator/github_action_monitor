import { html, setHtml, setText } from '../lib/dom.js';
import { fmtDuration, fmtNumber, fmtTime, repoShortName, timeAgo } from '../lib/format.js';
import { STATUS_COLORS, entityColor } from '../lib/palette.js';
import { emptyState, metricCard, repoAvatar, statusBadge } from '../ui/components.js';

/**
 * Expected duration for a run in flight.
 *
 * The old code used `Math.max(r.dur, 60)` — but for an in-progress run `dur` IS
 * the elapsed time, so the progress bar was pinned at 100% for every active run
 * and "overrun" could never be true. The workflow's own median is the honest
 * baseline, and where there is no history we say so rather than inventing one.
 */
export function expectedDuration(run, index) {
  const stats = index.workflowStats.get(run.wf);
  if (stats && stats.p50Duration > 0 && stats.completed >= 3) return stats.p50Duration;
  return null;
}

export function progressFor(run, index, now = Date.now()) {
  const elapsed = Math.max(0, Math.round((now - (run.startedAt || run.ts)) / 1000));
  const expected = expectedDuration(run, index);
  if (!expected) return { elapsed, expected: null, pct: null, overrun: false, color: '#3987e5' };
  const pct = Math.min(100, Math.round((elapsed / expected) * 100));
  const overrun = elapsed > expected;
  return {
    elapsed,
    expected,
    pct,
    overrun,
    color: overrun ? STATUS_COLORS.failed : pct > 80 ? '#fab219' : STATUS_COLORS.success,
  };
}

export function renderLive(ctx) {
  const { index, activeRuns, state, demo } = ctx;
  const now = Date.now();

  const filter = state.liveRepo || 'all';
  const visible = filter === 'all' ? activeRuns : activeRuns.filter((r) => r.repo === filter);

  setText('nav-live-count', String(activeRuns.length));
  setText(
    'livePollNote',
    demo
      ? 'sample data — connect a token to watch real runs'
      : 'progress compares elapsed time against each workflow’s own median',
  );

  const overrunning = activeRuns.filter((run) => progressFor(run, index, now).overrun).length;
  const reposActive = new Set(activeRuns.map((r) => r.repo)).size;
  const elapsedValues = activeRuns.map((run) => progressFor(run, index, now).elapsed);
  const avgElapsed = elapsedValues.length
    ? Math.round(elapsedValues.reduce((a, v) => a + v, 0) / elapsedValues.length)
    : 0;

  setHtml('liveMetrics', html`
    ${metricCard({ label: 'running now', value: fmtNumber(activeRuns.length), sub: 'active workflow runs', color: activeRuns.length ? 'var(--blue)' : 'var(--text)' })}
    ${metricCard({ label: 'over median', value: fmtNumber(overrunning), sub: 'past the usual duration', color: overrunning ? 'var(--red)' : 'var(--green)' })}
    ${metricCard({ label: 'repos active', value: fmtNumber(reposActive), sub: 'with something in flight' })}
    ${metricCard({ label: 'average elapsed', value: fmtDuration(avgElapsed), sub: 'time so far', color: 'var(--amber)' })}
  `);

  setText('liveRunCount', visible.length ? `${visible.length} shown` : '');
  setHtml('liveRunsList', visible.length
    ? html`${visible
        .slice()
        .sort((a, b) => (a.startedAt || a.ts) - (b.startedAt || b.ts))
        .map((run) => liveCard(run, index, now))}`
    : emptyState('Nothing running', 'No workflow is queued or in progress right now.'));

  renderRecentlyFinished(ctx, now);
}

function liveCard(run, index, now) {
  const p = progressFor(run, index, now);
  return html`
    <div class="live-card ${p.overrun ? 'overrun' : ''}">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
        ${repoAvatar(run.repo)}
        <div style="flex:1;min-width:0;">
          <div style="font-family:var(--mono);font-size:13px;color:var(--text);">${run.wf}</div>
          <div class="pulse-sub" style="font-family:var(--mono);">
            <span style="color:${entityColor(run.repo)}">${run.repo}</span>
            <span> · ${run.branch}</span>
          </div>
        </div>
        <div style="text-align:right;flex-shrink:0;">
          <div style="display:flex;align-items:center;gap:5px;justify-content:flex-end;">
            <div class="live-dot" style="background:${p.color};" aria-hidden="true"></div>
            <span style="font-family:var(--mono);font-size:12px;color:${p.overrun ? 'var(--red)' : 'var(--text)'};">${fmtDuration(p.elapsed)}</span>
          </div>
          <div class="pulse-sub">
            ${p.expected === null
              ? 'no baseline yet'
              : p.overrun
                ? `${fmtDuration(p.elapsed - p.expected)} over median`
                : `~${fmtDuration(p.expected - p.elapsed)} left`}
          </div>
        </div>
        <button class="logs-mini" type="button" data-run-repo="${run.repo}" data-run-id="${run.id}">logs</button>
      </div>
      ${p.pct === null
        ? html`<div class="pulse-sub">Progress needs at least three completed runs of this workflow to estimate.</div>`
        : html`
          <div class="live-track" role="progressbar" aria-valuenow="${p.pct}" aria-valuemin="0" aria-valuemax="100"
            aria-label="Estimated progress of ${run.wf}">
            <div class="live-fill" style="width:${p.pct}%;background:${p.color};"></div>
          </div>
          <div style="display:flex;justify-content:space-between;margin-top:6px;">
            <span class="pulse-sub">started ${fmtTime(run.startedAt || run.ts)}</span>
            <span class="pulse-sub" style="color:${p.overrun ? 'var(--red)' : 'var(--text3)'}">${p.pct}% · median ${fmtDuration(p.expected)}</span>
          </div>
        `}
    </div>
  `;
}

function renderRecentlyFinished({ index }, now) {
  const cutoff = now - 15 * 60 * 1000;
  const recent = index.runs
    .filter((run) => run.status !== 'in_progress' && run.completedAt && run.completedAt >= cutoff)
    .sort((a, b) => b.completedAt - a.completedAt)
    .slice(0, 10);

  setHtml('liveRecentList', recent.length ? html`${recent.map((run) => html`
    <div class="finished-row">
      <div style="flex:1;min-width:0;">
        <span style="font-family:var(--mono);font-size:12px;color:var(--text);">${run.wf}</span>
        <span style="font-family:var(--mono);font-size:11px;color:${entityColor(run.repo)};margin-left:8px;">${repoShortName(run.repo)}</span>
      </div>
      <div style="display:flex;align-items:center;gap:12px;flex-shrink:0;">
        <span class="pulse-sub">${fmtDuration(run.dur)}</span>
        <span class="pulse-sub">${timeAgo(run.completedAt)}</span>
        ${statusBadge(run.status)}
        <button class="logs-mini" type="button" data-run-repo="${run.repo}" data-run-id="${run.id}">logs</button>
      </div>
    </div>
  `)}` : emptyState('Nothing finished recently', 'No run completed in the last fifteen minutes.'));
}
