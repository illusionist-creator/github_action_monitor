// Job / step breakdown, shown both in the slide-over and the Run Logs tab.

import { attachAnnotations, fetchJobLog, fetchRunDetail, fetchRunJobs } from '../data/api.js';
import { html, setHtml } from '../lib/dom.js';
import { fmtDateTime, fmtDuration, timeAgo, truncate } from '../lib/format.js';
import { emptyState, repoAvatar, repoName, statusBadge } from '../ui/components.js';
import { icon } from '../ui/icons.js';
import { closeModal, openModal } from '../ui/modal.js';

const JOB_STATE_COLORS = {
  success: 'var(--green)',
  failure: 'var(--red)',
  timed_out: 'var(--red)',
  cancelled: 'var(--amber)',
  skipped: 'var(--text-3)',
  in_progress: 'var(--blue)',
  queued: 'var(--text-3)',
};

const STEP_ICONS = {
  success: '✓',
  failure: '✕',
  skipped: '—',
  cancelled: '⊘',
  in_progress: '●',
  queued: '○',
};

/** Cache of per-run job data, so reopening a modal costs nothing. */
export const logCache = new Map();

export function runKey(run) {
  return `${run.repo}::${run.id}`;
}

export function isRealRun(run) {
  return Boolean(run) && !run.demo && /^\d+$/.test(String(run.id)) && String(run.repo).includes('/');
}

export function runUrl(run) {
  return isRealRun(run) ? `https://github.com/${run.repo}/actions/runs/${run.id}` : null;
}

function elapsedSeconds(a, b) {
  if (!a) return null;
  const start = Date.parse(a);
  const end = b ? Date.parse(b) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.round((end - start) / 1000);
}

/* ------------------------------------------------------------------- modal */

let modalToken = 0;

export async function openRunLogs(run, ctx) {
  if (!run) return;
  const token = (modalToken += 1);
  openModal('logModal', { initialFocus: '#logClose' });

  setHtml('logTitle', html`<span class="truncate">${run.wf}</span>${statusBadge(run.status)}`);
  setHtml('logMeta', metaRow(run, null));
  setHtml('logFoot', html``);
  setHtml('logBody', html`<div class="log-note"><span class="log-spin"></span>&nbsp; Loading the job breakdown…</div>`);

  if (!isRealRun(run)) {
    setHtml('logBody', html`
      <div class="log-banner demo">
        This is sample data, so there is no real run behind it. Connect a token
        and the job and step breakdown here will come straight from the Actions API.
      </div>
    `);
    return;
  }

  try {
    const cached = logCache.get(runKey(run));
    const [detail, jobs] = cached
      ? [cached.detail, cached.jobs]
      : await Promise.all([
          fetchRunDetail(ctx.client, run.repo, run.id).catch(() => null),
          fetchRunJobs(ctx.client, run.repo, run.id),
        ]);
    if (token !== modalToken) return;

    logCache.set(runKey(run), { detail, jobs });
    setHtml('logMeta', metaRow(run, detail));
    setHtml('logBody', jobsMarkup(run, jobs, 'modal'));
    setHtml('logFoot', footer(run));

    if (!cached) {
      await attachAnnotations(ctx.client, run.repo, jobs);
      if (token === modalToken) setHtml('logBody', jobsMarkup(run, jobs, 'modal'));
    }
  } catch (err) {
    if (token !== modalToken) return;
    const url = runUrl(run);
    setHtml('logBody', html`
      <div class="log-banner err">Could not load jobs for this run.</div>
      <div class="log-note">
        ${err.message}
        <br /><br />
        Usually this means the token lacks <b>actions:read</b> on this repository,
        the run was deleted, or its logs are past the retention window.
        ${url ? html`<br /><br /><a href="${url}" target="_blank" rel="noopener noreferrer">Open this run on GitHub ${icon('external', 12)}</a>` : ''}
      </div>
    `);
  }
}

export function closeRunLogs() {
  modalToken += 1;
  closeModal();
}

function metaRow(run, detail) {
  const bits = [
    ['repo', run.repo],
    ['branch', run.branch || '—'],
    [run.status === 'in_progress' ? 'elapsed' : 'duration', fmtDuration(run.dur)],
    ['queued', fmtDuration(run.queue)],
    ['started', fmtDateTime(run.startedAt || run.ts)],
  ];
  if (isRealRun(run)) bits.push(['run', `#${run.runNumber || run.id}`]);
  if (detail) {
    if (detail.run_attempt) bits.push(['attempt', String(detail.run_attempt)]);
    if (detail.event) bits.push(['event', detail.event]);
    if (detail.triggering_actor && detail.triggering_actor.login) {
      bits.push(['actor', detail.triggering_actor.login]);
    }
  }
  return html`${bits.map(([label, value]) => html`<span><b>${label}</b> <span class="mono">${value}</span></span>`)}`;
}

function footer(run) {
  const url = runUrl(run);
  if (!url) return html``;
  return html`
    <a href="${url}" target="_blank" rel="noopener noreferrer">Open the full run on GitHub ${icon('external', 12)}</a>
    <span style="opacity:.4">|</span>
    <span>Step timings come from the Actions API</span>
  `;
}

/* -------------------------------------------------------------- job markup */

export function jobsMarkup(run, jobs, idPrefix) {
  if (!jobs || !jobs.length) {
    return html`<div class="log-note">
      GitHub returned no jobs for this run — it was skipped or deleted, or the
      logs have aged past your retention window.
    </div>`;
  }

  return html`${jobs.map((job, i) => {
    const state = job.conclusion || job.status || 'unknown';
    const steps = job.steps || [];
    const failedSteps = steps.filter((s) => s.conclusion === 'failure').length;
    const duration = elapsedSeconds(job.started_at, job.completed_at);
    const open = state === 'failure' || state === 'in_progress' || jobs.length === 1;
    const id = `logjob-${idPrefix}-${i}`;

    return html`
      <div class="log-job ${open ? 'open' : ''}" id="${id}">
        <button class="log-job-head" type="button" data-job-toggle="${id}" aria-expanded="${open ? 'true' : 'false'}">
          <span class="log-caret" aria-hidden="true">${icon('chevron-right', 14)}</span>
          <span class="status-dot" style="background:${JOB_STATE_COLORS[state] || 'var(--text-3)'};"></span>
          <div class="grow">
            <div class="log-job-name">${job.name || 'job'}</div>
            <div class="log-job-sub">
              ${state}${steps.length ? ` · ${steps.length} step${steps.length === 1 ? '' : 's'}` : ''}${failedSteps ? html` · <span class="text-bad">${failedSteps} failed</span>` : ''}${duration !== null ? ` · ${fmtDuration(duration)}` : ''}${job.runner_name ? ` · ${job.runner_name}` : ''}
            </div>
          </div>
        </button>
        <div class="log-job-body">
          ${steps.length
            ? html`${steps.map((step) => stepRow(step))}`
            : html`<div class="log-note" style="margin:10px 14px;">No step detail was returned for this job.</div>`}
          ${(job.annotations || []).map((a) => annotationRow(a))}
          ${job.id ? rawLogControl(run, job, `rawlog-${idPrefix}-${i}`) : ''}
        </div>
      </div>
    `;
  })}`;
}

function stepRow(step) {
  const state = step.conclusion || step.status || '';
  const cls = state === 'failure'
    ? 's-failure'
    : state === 'skipped' ? 's-skipped' : (state === 'in_progress' || state === 'queued') ? 's-running' : '';
  const duration = elapsedSeconds(step.started_at, step.completed_at);
  return html`
    <div class="log-step ${cls}">
      <span class="log-step-num">${step.number ?? ''}</span>
      <span class="log-step-icon" aria-hidden="true">${STEP_ICONS[state] || '·'}</span>
      <span class="log-step-name">${step.name || ''}</span>
      <span class="log-step-dur">${duration === null ? '' : fmtDuration(duration)}</span>
    </div>
  `;
}

function annotationRow(a) {
  const level = String(a.annotation_level || 'failure').toLowerCase();
  const where = a.path ? `${a.path}${a.start_line ? `:${a.start_line}` : ''}` : '';
  return html`
    <div class="log-anno ${level === 'warning' ? 'warning' : level === 'notice' ? 'notice' : ''}">
      <div class="log-anno-title">${level}${where ? ` · ${where}` : ''}${a.title ? ` · ${a.title}` : ''}</div>
      <div class="log-anno-msg">${a.message || ''}</div>
    </div>
  `;
}

function rawLogControl(run, job, targetId) {
  return html`
    <div class="log-raw-wrap">
      <button class="btn btn-xs" type="button" data-raw-log="${targetId}"
        data-repo="${run.repo}" data-job="${job.id}">${icon('download', 12)} Load raw log text</button>
      <div id="${targetId}" style="margin-top:8px;"></div>
    </div>
  `;
}

/* ------------------------------------------------------------- raw log text */

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/;
const MAX_LINES = 800;

/** Strip ANSI colour codes and the per-line ISO timestamp GitHub prefixes. */
export function cleanLogLine(line) {
  return line.replace(ANSI, '').replace(TIMESTAMP, '');
}

export function renderRawLog(target, text) {
  const all = text.split('\n');
  const lines = all.length > MAX_LINES ? all.slice(-MAX_LINES) : all;

  const body = html`${lines.map((original) => {
    const line = cleanLogLine(original);
    let cls = '';
    if (/##\[error\]|^Error:|\bFAILED\b/i.test(line)) cls = 'l-err';
    else if (/##\[warning\]/i.test(line)) cls = 'l-warn';
    else if (/##\[(group|endgroup|section)\]/i.test(line)) cls = 'l-grp';
    else if (/^\s*[+$]\s/.test(line)) cls = 'l-cmd';
    return cls ? html`<span class="${cls}">${line}</span>\n` : html`${line}\n`;
  })}`;

  setHtml(target, html`
    ${all.length > MAX_LINES
      ? html`<div class="log-note" style="margin-bottom:6px;">Showing the last ${MAX_LINES} of ${all.length} lines</div>`
      : ''}
    <div class="log-raw">${body}</div>
  `);
}

export async function loadRawLog(target, ctx, repo, jobId) {
  setHtml(target, html`<div class="log-note"><span class="log-spin"></span>&nbsp; Requesting the raw log…</div>`);
  try {
    const text = await fetchJobLog(ctx.client, repo, jobId);
    renderRawLog(target, text);
  } catch (err) {
    // This is expected in a browser and worth explaining precisely rather than
    // reporting as a generic failure: the endpoint redirects to blob storage,
    // which sends no CORS headers, so the response is unreadable by design.
    setHtml(target, html`
      <div class="log-note warn">
        Raw log text cannot be read from a browser. The Actions log endpoint
        redirects to GitHub's blob storage, and that host sends no
        <code>Access-Control-Allow-Origin</code> header, so the response is
        blocked before this page ever sees it. The job and step breakdown above
        comes from the JSON API and is unaffected.
        <br /><br />
        <b>From a terminal:</b>
        <code class="log-raw">gh run view --repo ${repo} --job ${jobId} --log</code>
        <br />
        <b>Reported:</b> ${err.message}
      </div>
    `);
  }
}

/* ----------------------------------------------------------- run logs tab */

export function latestRunPerRepo(index, activeRuns, pick) {
  const pool = [...activeRuns, ...index.runs];
  const filtered = pick === 'completed' ? pool.filter((r) => r.status !== 'in_progress') : pool;
  const best = new Map();
  filtered.forEach((run) => {
    const current = best.get(run.repo);
    if (!current || (run.startedAt || run.ts) > (current.startedAt || current.ts)) {
      best.set(run.repo, run);
    }
  });
  return Array.from(best.values()).sort((a, b) => (b.startedAt || b.ts) - (a.startedAt || a.ts));
}

export function renderLogsTab(ctx) {
  const { index, activeRuns, state } = ctx;
  const all = latestRunPerRepo(index, activeRuns, state.runPick);
  const rows = state.scope === 'failed'
    ? all.filter((run) => run.status === 'failed')
    : state.scope === 'attention'
      ? all.filter((run) => run.status === 'failed' || run.status === 'in_progress')
      : all;

  ctx.logRows = rows;

  if (!rows.length) {
    setHtml('logsRepoList', emptyState('Nothing to show', 'No repository matched this filter.', { icon: 'filter' }));
    setHtml('logsProgress', html``);
    return;
  }

  setHtml('logsRepoList', html`${rows.map((run, i) => {
    const cached = logCache.get(runKey(run));
    const open = Boolean(ctx.expandedLogs[runKey(run)]);
    return html`
      <div class="rlog-card st-${run.status} ${open ? 'open' : ''}" id="rlog-${i}">
        <button class="rlog-head" type="button" data-log-toggle="${i}" aria-expanded="${open ? 'true' : 'false'}">
          <span class="log-caret" aria-hidden="true">${icon('chevron-right', 14)}</span>
          ${repoAvatar(run.repo, { size: 30 })}
          <div class="rlog-main">
            <div class="rlog-repo">${repoName(run.repo)}</div>
            <div class="rlog-sub">
              <span class="wf">${run.wf}</span>
              <span class="mono">${truncate(run.branch, 22)}</span>
              <span>${fmtDuration(run.dur)}${run.status === 'in_progress' ? ' elapsed' : ''}</span>
              <span>${timeAgo(run.startedAt || run.ts)}</span>
            </div>
          </div>
          <div class="rlog-right">${statusBadge(run.status)}</div>
        </button>
        <div class="rlog-body" id="rlogbody-${i}">
          ${open && cached ? jobsMarkup(run, cached.jobs, `tab${i}`) : html`<div class="log-note">Not loaded yet — expand to fetch.</div>`}
        </div>
      </div>
    `;
  })}`);

  const loaded = rows.filter((run) => logCache.has(runKey(run))).length;
  const failing = rows.filter((run) => run.status === 'failed').length;
  setHtml('logsProgress', html`
    ${loaded}/${rows.length} loaded${failing ? html` · <span class="text-bad">${failing} last run${failing === 1 ? '' : 's'} failed</span>` : ''}
  `);
}

/** Fetch one repo's job breakdown for the tab, with the modal's cache shared. */
export async function loadLogsFor(run, ctx, targetId) {
  const key = runKey(run);
  if (logCache.has(key)) {
    setHtml(targetId, jobsMarkup(run, logCache.get(key).jobs, key));
    return;
  }
  if (!isRealRun(run)) {
    setHtml(targetId, html`<div class="log-banner demo">Sample data — there is no real run behind this row.</div>`);
    return;
  }
  setHtml(targetId, html`<div class="log-note"><span class="log-spin"></span>&nbsp; Fetching…</div>`);
  try {
    const jobs = await fetchRunJobs(ctx.client, run.repo, run.id);
    logCache.set(key, { detail: null, jobs });
    setHtml(targetId, jobsMarkup(run, jobs, key));
    await attachAnnotations(ctx.client, run.repo, jobs);
    setHtml(targetId, jobsMarkup(run, jobs, key));
  } catch (err) {
    setHtml(targetId, html`<div class="log-banner err">${err.message}</div>`);
  }
}
