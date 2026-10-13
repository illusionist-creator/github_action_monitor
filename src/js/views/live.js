import { $$, html, setHtml, setText } from '../lib/dom.js';
import { fmtDuration, fmtNumber, fmtTime, timeAgo, truncate } from '../lib/format.js';
import { STATUS_COLORS } from '../lib/palette.js';
import { emptyState, metricCard, repoAvatar, repoChip, statusBadge } from '../ui/components.js';
import { icon } from '../ui/icons.js';

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

/** Progress from a start timestamp and an expected length, both optional-safe. */
export function progressFromTimes(start, expected, now = Date.now()) {
  const elapsed = Math.max(0, Math.round((now - start) / 1000));
  if (!expected) return { elapsed, expected: null, pct: null, overrun: false, color: STATUS_COLORS.in_progress };
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

export function progressFor(run, index, now = Date.now()) {
  return progressFromTimes(run.startedAt || run.ts, expectedDuration(run, index), now);
}

function remainingText(p) {
  if (p.expected === null) return 'no baseline yet';
  if (p.overrun) return `${fmtDuration(p.elapsed - p.expected)} over the median`;
  return `about ${fmtDuration(p.expected - p.elapsed)} left`;
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
      ? 'Sample data — connect a token to watch real runs. Progress is measured against each workflow’s own median.'
      : 'Polled every 45 seconds while this tab is visible. Progress compares elapsed time with each workflow’s own median.',
  );

  const overrunning = activeRuns.filter((run) => progressFor(run, index, now).overrun).length;
  const reposActive = new Set(activeRuns.map((r) => r.repo)).size;
  const elapsedValues = activeRuns.map((run) => progressFor(run, index, now).elapsed);
  const avgElapsed = elapsedValues.length
    ? Math.round(elapsedValues.reduce((a, v) => a + v, 0) / elapsedValues.length)
    : 0;

  setHtml('liveMetrics', html`
    ${metricCard({ label: 'Running now', value: fmtNumber(activeRuns.length), sub: 'active workflow runs', tone: activeRuns.length ? 'info' : null })}
    ${metricCard({ label: 'Over median', value: fmtNumber(overrunning), sub: 'past the usual duration', tone: overrunning ? 'bad' : 'good' })}
    ${metricCard({ label: 'Repositories active', value: fmtNumber(reposActive), sub: 'with something in flight' })}
    ${metricCard({ label: 'Average elapsed', value: fmtDuration(avgElapsed), sub: 'time so far', tone: 'warn' })}
  `);

  setText('liveRunCount', visible.length
    ? `${visible.length} in flight${filter === 'all' ? '' : ` in ${filter}`}`
    : 'Nothing in flight');
  setHtml('liveRunsList', visible.length
    ? html`${visible
        .slice()
        .sort((a, b) => (a.startedAt || a.ts) - (b.startedAt || b.ts))
        .map((run) => liveCard(run, index, now))}`
    : emptyState('Nothing running', 'No workflow is queued or in progress right now.', { icon: 'play' }));

  renderRecentlyFinished(ctx, now);
}

function liveCard(run, index, now) {
  const p = progressFor(run, index, now);
  const start = run.startedAt || run.ts;
  return html`
    <div class="live-card ${p.overrun ? 'overrun' : ''}" data-live-start="${start}" data-live-expected="${p.expected || ''}">
      <div class="live-head">
        ${repoAvatar(run.repo, { size: 34 })}
        <div class="live-info">
          <div class="live-name" title="${run.wf}">${run.wf}</div>
          <div class="live-meta">
            ${repoChip(run.repo)}
            <span class="mono" title="${run.branch}">${truncate(run.branch, 28)}</span>
            ${run.actor ? html`<span>${run.actor}</span>` : ''}
          </div>
        </div>
        <div class="live-time">
          <div class="live-elapsed">
            <span class="live-dot" style="background:${p.color};" aria-hidden="true"></span>
            <span class="live-elapsed-text">${fmtDuration(p.elapsed)}</span>
          </div>
          <div class="live-remaining">${remainingText(p)}</div>
        </div>
        <button class="btn btn-sm btn-ghost" type="button" data-run-repo="${run.repo}" data-run-id="${run.id}">
          ${icon('terminal', 14)} Logs
        </button>
      </div>
      ${p.pct === null
        ? html`<div class="pulse-sub">Progress needs at least three completed runs of this workflow to estimate.</div>`
        : html`
          <div class="live-track" role="progressbar" aria-valuenow="${p.pct}" aria-valuemin="0" aria-valuemax="100"
            aria-label="Estimated progress of ${run.wf}">
            <div class="live-fill" style="width:${p.pct}%;background:${p.color};"></div>
          </div>
          <div class="live-foot">
            <span>Started ${fmtTime(start)}</span>
            <span class="live-pct ${p.overrun ? 'overrun-text' : ''}">${p.pct}% of the ${fmtDuration(p.expected)} median</span>
          </div>
        `}
    </div>
  `;
}

/**
 * Advance every visible live card by one second without re-rendering the
 * list. Called by a timer while the Live tab is open, so elapsed times and
 * progress bars move on their own between polls.
 */
export function tickLive(ctx, now = Date.now()) {
  $$('.live-card[data-live-start]').forEach((card) => {
    const start = Number(card.getAttribute('data-live-start'));
    if (!Number.isFinite(start)) return;
    const expected = Number(card.getAttribute('data-live-expected')) || null;
    const p = progressFromTimes(start, expected, now);

    setText(card.querySelector('.live-elapsed-text'), fmtDuration(p.elapsed));
    setText(card.querySelector('.live-remaining'), remainingText(p));
    const dot = card.querySelector('.live-dot');
    if (dot) dot.style.background = p.color;
    if (p.pct === null) return;

    card.classList.toggle('overrun', p.overrun);
    const fill = card.querySelector('.live-fill');
    if (fill) {
      fill.style.width = `${p.pct}%`;
      fill.style.background = p.color;
    }
    const track = card.querySelector('.live-track');
    if (track) track.setAttribute('aria-valuenow', String(p.pct));
    const pct = card.querySelector('.live-pct');
    if (pct) {
      setText(pct, `${p.pct}% of the ${fmtDuration(p.expected)} median`);
      pct.classList.toggle('overrun-text', p.overrun);
    }
  });
}

function renderRecentlyFinished({ index }, now) {
  const cutoff = now - 15 * 60 * 1000;
  const recent = index.runs
    .filter((run) => run.status !== 'in_progress' && run.completedAt && run.completedAt >= cutoff)
    .sort((a, b) => b.completedAt - a.completedAt)
    .slice(0, 10);

  setHtml('liveRecentList', recent.length ? html`${recent.map((run) => html`
    <div class="finished-row">
      <div class="grow row">
        <span class="live-name" title="${run.wf}">${run.wf}</span>
        ${repoChip(run.repo)}
      </div>
      <div class="finished-right">
        <span class="mono faint-sm">${fmtDuration(run.dur)}</span>
        <span class="faint-sm">${timeAgo(run.completedAt)}</span>
        ${statusBadge(run.status)}
        <button class="btn btn-xs btn-ghost" type="button" data-run-repo="${run.repo}" data-run-id="${run.id}">Logs</button>
      </div>
    </div>
  `)}` : emptyState('Nothing finished recently', 'No run completed in the last fifteen minutes.', { icon: 'clock' }));
}
