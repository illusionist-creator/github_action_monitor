// Application shell: state, routing, event wiring, and the polling schedule.

import { syncActive, syncAll } from './data/api.js';
import { buildIndex } from './data/analytics.js';
import { demoRepos, demoRuns } from './data/demo.js';
import { GitHubClient, GitHubError, RateLimitError } from './data/github.js';
import { $$, byId, delegate, html, setHtml, setText } from './lib/dom.js';
import { fmtNumber, repoShortName, timeAgo } from './lib/format.js';
import { entityColor, healthTone } from './lib/palette.js';
import { Store, fitWindow, hashToState, newestTimestamp, selectRuns, stateToHash } from './lib/store.js';
import { destroyAll, initChartDefaults } from './ui/charts.js';
import { viewError } from './ui/components.js';
import { closeModal } from './ui/modal.js';
import { announce, toast } from './ui/toast.js';
import { renderFailures } from './views/failures.js';
import { renderLive } from './views/live.js';
import {
  closeRunLogs,
  loadLogsFor,
  loadRawLog,
  logCache,
  openRunLogs,
  renderLogsTab,
  runKey,
} from './views/logs.js';
import { renderOverview, renderRepoGrid } from './views/overview.js';
import { PAGE_SIZE, renderRuns } from './views/runs.js';
import { renderTimeline } from './views/timeline.js';

const TAB_TITLES = {
  overview: 'Overview',
  live: 'Live now',
  repos: 'Repositories',
  runs: 'All runs',
  failures: 'Failure analysis',
  logs: 'Run logs',
  timeline: 'Timeline & runtimes',
};

// Active runs are polled; history is not. The legacy 30s timer refetched
// everything for every repository forever — this asks only for what changes,
// backs off when the tab is hidden, and stops entirely near the rate limit.
const POLL_VISIBLE_MS = 45_000;
const POLL_HIDDEN_MS = 5 * 60_000;

// Backstop for a whole sync. Even with per-request timeouts, a large enough
// account could keep the UI waiting; this guarantees the refresh button always
// comes back and always says why.
const SYNC_DEADLINE_MS = 90_000;

/**
 * Reject if `work` has not settled by the deadline, aborting whatever is still
 * in flight so the connection does not keep running in the background.
 */
function withDeadline(work, ms, onTimeout) {
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      if (onTimeout) onTimeout();
      reject(new Error(`The sync did not finish within ${Math.round(ms / 1000)}s and was cancelled.`));
    }, ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

const store = new Store();
const ctx = {
  client: null,
  index: buildIndex([]),
  activeRuns: [],
  state: store.state,
  expanded: {},
  expandedLogs: {},
  logRows: [],
  runsShown: PAGE_SIZE,
  demo: true,
};

let pollTimer = null;

/* ------------------------------------------------------------------ render */

function currentRuns() {
  const state = store.state;
  return selectRuns(state.runs, { days: state.days, repo: state.repo });
}

function rebuildIndex() {
  const scoped = currentRuns();
  ctx.index = buildIndex(scoped);
  ctx.state = store.state;
  ctx.demo = store.state.demo;
  ctx.activeRuns = (store.state.demo ? store.state.runs : store.state.activeRuns)
    .filter((run) => run.status === 'in_progress')
    .filter((run) => store.state.repo === 'all' || run.repo === store.state.repo);
  ctx.catalogue = buildCatalogue(store.state.runs);
  ctx.loadedRuns = store.state.runs.length;
  ctx.newestRunTs = newestTimestamp(store.state.runs);
}

/**
 * The full list of repositories and workflows, from the UNFILTERED runs.
 *
 * Filling the dropdowns from the filtered index meant that choosing a
 * repository removed every other repository from the list, so you could never
 * switch from one repo straight to another — and narrowing the time window
 * silently dropped any repo that happened to be quiet.
 */
let catalogueCache = { source: null, value: { repos: [], workflows: [] } };

function buildCatalogue(runs) {
  if (catalogueCache.source === runs) return catalogueCache.value;
  const repos = new Set();
  const workflows = new Set();
  runs.forEach((run) => {
    repos.add(run.repo);
    workflows.add(run.wf);
  });
  const value = {
    repos: Array.from(repos).sort(),
    workflows: Array.from(workflows).sort(),
  };
  catalogueCache = { source: runs, value };
  return value;
}

/** Render one view, containing any failure to that view's own panel. */
function safely(where, panelId, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`[${where}]`, err);
    const panel = byId(panelId);
    if (panel) setHtml(panel, viewError(where, err));
  }
}

function renderActiveTab() {
  const tab = store.state.tab;
  const renderers = {
    overview: () => renderOverview(ctx),
    live: () => renderLive(ctx),
    repos: () => renderRepoGrid(ctx, 'reposTabGrid'),
    runs: () => renderRuns(ctx),
    failures: () => renderFailures(ctx),
    timeline: () => renderTimeline(ctx),
    logs: () => renderLogsTab(ctx),
  };
  safely(TAB_TITLES[tab] || tab, `tab-${tab}`, renderers[tab] || renderers.overview);
}

function renderChrome() {
  const state = store.state;

  setText('topbar-title', TAB_TITLES[state.tab] || 'Overview');
  setText('logoSub', state.demo ? 'sample data' : 'live');
  setText('liveBadgeText', state.demo ? 'sample' : 'live');
  const badge = byId('liveBadge');
  if (badge) badge.classList.toggle('demo-mode', state.demo);

  setText('nav-repo-count', String(ctx.index.repos.length || '—'));
  setText('nav-live-count', String(ctx.activeRuns.length));
  setText('nav-logs-count', String(ctx.index.repos.length || '—'));

  renderSidebarRepos();
  syncSelects();
}

function renderSidebarRepos() {
  const rows = Array.from(ctx.index.repoStats.values())
    .sort((a, b) => a.health.score - b.health.score)
    .slice(0, 24);

  setHtml('sidebar-repo-list', rows.length
    ? html`${rows.map((stats) => html`
      <button class="nav-item" type="button" data-repo-filter="${stats.repo}"
        aria-pressed="${store.state.repo === stats.repo ? 'true' : 'false'}">
        <span style="width:8px;height:8px;border-radius:50%;flex-shrink:0;display:inline-block;background:${entityColor(stats.repo)};"></span>
        <span style="font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${repoShortName(stats.repo)}</span>
        <span style="margin-left:auto;font-size:10px;font-family:var(--mono);color:${healthTone(stats.health.score).color};">${stats.health.score}</span>
      </button>
    `)}`
    : html`<div class="nav-empty">no repositories yet</div>`);
}

/** Keep the repo / workflow dropdowns in step with the data without clobbering
 *  a selection the user has made that is still valid. */
function syncSelects() {
  const state = store.state;
  const { repos: allRepos, workflows: allWorkflows } = ctx.catalogue;

  const repoOptions = [{ value: 'all', label: 'All repos' }].concat(
    allRepos.map((repo) => ({ value: repo, label: repo })),
  );
  fillSelect('repoFilter', repoOptions, state.repo);
  fillSelect('heatRepo', repoOptions, state.heatRepo);

  fillSelect('liveRepoFilter', [{ value: 'all', label: 'all repos' }].concat(
    Array.from(new Set(ctx.activeRuns.map((r) => r.repo))).sort().map((repo) => ({ value: repo, label: repo })),
  ), state.liveRepo || 'all');

  const workflows = [{ value: 'all', label: 'all workflows' }].concat(
    allWorkflows.map((wf) => ({ value: wf, label: wf })),
  );
  fillSelect('runsWfFilter', workflows, state.workflow);
  fillSelect('tlWfFilter', workflows, state.workflow);

  ['timeFilter', 'runsStatusFilter', 'tlStatusFilter', 'tlGroup', 'repoSort',
    'matrixMetric', 'heatMetric', 'logsRunPick', 'logsScopeFilter'].forEach((id) => {
    const el = byId(id);
    if (!el) return;
    const key = el.getAttribute('data-state');
    if (key && String(state[key]) !== el.value) el.value = String(state[key]);
  });
}

function fillSelect(id, options, selected) {
  const el = byId(id);
  if (!el) return;
  const wanted = options.map((o) => o.value).join(' ');
  if (el.dataset.signature === wanted) {
    if (el.value !== selected) el.value = options.some((o) => o.value === selected) ? selected : 'all';
    return;
  }
  el.dataset.signature = wanted;
  el.replaceChildren(...options.map((option) => {
    const node = document.createElement('option');
    node.value = option.value;
    node.textContent = option.label;
    return node;
  }));
  el.value = options.some((o) => o.value === selected) ? selected : 'all';
}

function render() {
  rebuildIndex();
  renderChrome();
  renderActiveTab();
}

/* ------------------------------------------------------------------ routing */

function showTab(tab) {
  $$('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.id === `tab-${tab}`));
  $$('#viewTabs [role="tab"]').forEach((el) => {
    el.setAttribute('aria-selected', el.dataset.tab === tab ? 'true' : 'false');
  });
}

function applyHash() {
  const patch = hashToState(window.location.hash);
  if (Object.keys(patch).length) store.set(patch);
}

function writeHash() {
  const hash = stateToHash(store.state);
  const url = `${window.location.pathname}${window.location.search}${hash}`;
  window.history.replaceState(null, '', url);
}

/* ---------------------------------------------------------------- polling */

function schedulePoll() {
  clearTimeout(pollTimer);
  if (store.state.demo || !ctx.client) return;
  const delay = document.hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS;
  pollTimer = setTimeout(pollActive, delay);
}

async function pollActive() {
  if (store.state.demo || !ctx.client || store.state.fetching) {
    schedulePoll();
    return;
  }
  if (ctx.client.exhausted) {
    toast({
      kind: 'warn',
      dedupe: 'rate',
      title: 'Polling paused',
      body: 'The API budget is nearly spent. Refreshes resume after the limit resets.',
    });
    schedulePoll();
    return;
  }
  try {
    const names = store.state.repos.map((repo) => repo.fullName);
    const active = await syncActive(ctx.client, names);
    store.set({ activeRuns: active, lastFetch: Date.now() });
  } catch (err) {
    if (!(err instanceof RateLimitError)) console.warn('[poll]', err.message);
  } finally {
    schedulePoll();
  }
}

/* -------------------------------------------------------------- connection */

function showSyncProgress(done, total, label) {
  const bar = byId('syncBar');
  const fill = byId('syncFill');
  if (bar) bar.hidden = false;
  if (fill) fill.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
  setText('connectStatus', total > 1 ? `${done}/${total} · ${repoShortName(label)}` : label);
}

async function connect(token, owner) {
  const button = byId('connectBtn');
  button.disabled = true;
  button.textContent = 'Connecting…';
  store.set({ fetching: true, error: null });

  const client = new GitHubClient({
    token,
    onRateLimit: renderRateMeter,
  });

  try {
    const result = await withDeadline(
      syncAll(client, {
        owner,
        days: 90,
        pages: 2,
        onProgress: showSyncProgress,
      }),
      SYNC_DEADLINE_MS,
      () => client.abortAll(),
    );
    const { repos, runs } = result;

    // If not one repository could be read, this is a failed connection, not an
    // empty account — say so instead of presenting a blank dashboard as fact.
    if (!result.usable) {
      const reason = result.failed[0] ? result.failed[0].reason : 'unknown error';
      throw new GitHubError(
        `Connected, but none of the ${result.total} repositories could be read. ${reason}`,
        { status: result.failed[0] ? result.failed[0].status : 0, kind: 'scope' },
      );
    }

    ctx.client = client;
    logCache.clear();
    destroyAll();
    store.set({
      connected: true,
      demo: false,
      owner,
      repos,
      runs,
      activeRuns: runs.filter((r) => r.status === 'in_progress'),
      lastFetch: Date.now(),
      fetching: false,
      repo: 'all',
    });

    byId('mainOverlay').hidden = true;
    byId('tokenInput').value = '';
    byId('tokenInput').disabled = true;
    byId('orgInput').disabled = true;
    byId('disconnectBtn').classList.add('visible');
    byId('refreshBtn').disabled = false;
    button.textContent = 'Connected';

    setText('connectStatus', `${repos.length} repos · ${fmtNumber(runs.length)} runs`);

    const requested = store.state.days;
    const fitted = fitWindow(runs, requested);
    if (fitted !== requested) {
      store.set({ days: fitted });
      toast({
        kind: 'info',
        title: `Widened the window to ${fitted} days`,
        body: `Nothing ran in the last ${requested} days. Your most recent run was ${timeAgo(newestTimestamp(runs))}.`,
        timeout: 12_000,
      });
    }

    toast({
      kind: 'success',
      title: 'Connected',
      body: `${fmtNumber(runs.length)} runs across ${repos.length} repositories.`,
    });
    if (result.failed.length) {
      toast({
        kind: 'warn',
        title: `${result.failed.length} of ${result.total} repositories could not be read`,
        body: `${result.failed.slice(0, 3).map((f) => `${f.repo}: ${f.reason}`).join(' · ')}`,
        timeout: 12_000,
      });
    }
    if (result.withoutActions.length) {
      console.info(`[sync] ${result.withoutActions.length} repositories have no Actions workflows`);
    }
    announce(`Connected. ${runs.length} runs loaded.`);
    schedulePoll();
  } catch (err) {
    store.set({ fetching: false, error: err.message });
    button.disabled = false;
    button.textContent = 'Retry connection';
    setText('connectStatus', err.message);
    toast({ kind: 'error', title: 'Could not connect', body: err.message, timeout: 0 });
  } finally {
    byId('syncBar').hidden = true;
  }
}

function disconnect() {
  clearTimeout(pollTimer);
  if (ctx.client) ctx.client.abortAll();
  // Drop the credential and everything derived from it.
  ctx.client = null;
  logCache.clear();
  destroyAll();

  store.set({
    connected: false,
    demo: true,
    owner: '',
    repos: demoRepos(),
    runs: demoRuns(),
    activeRuns: [],
    repo: 'all',
    rateLimit: null,
  });

  byId('mainOverlay').hidden = false;
  byId('tokenInput').disabled = false;
  byId('tokenInput').value = '';
  byId('orgInput').disabled = false;
  byId('disconnectBtn').classList.remove('visible');
  const button = byId('connectBtn');
  button.disabled = false;
  button.textContent = 'Connect live data';
  byId('rateMeter').hidden = true;
  setText('connectStatus', '');
  toast({ kind: 'info', title: 'Disconnected', body: 'The token was discarded and sample data restored.' });
}

async function refreshAll() {
  if (store.state.demo) {
    store.set({ runs: demoRuns() });
    return;
  }
  if (!ctx.client || store.state.fetching) return;
  store.set({ fetching: true });
  byId('refreshBtn').disabled = true;
  try {
    const result = await withDeadline(
      syncAll(ctx.client, {
        owner: store.state.owner,
        days: 90,
        pages: 2,
        onProgress: showSyncProgress,
      }),
      SYNC_DEADLINE_MS,
      () => ctx.client.abortAll(),
    );

    // A refresh that could not read anything must not overwrite what is already
    // on screen. Replacing good data with an empty result was indistinguishable
    // from the dashboard breaking: every chart and every number went blank, and
    // because per-repo failures were swallowed, nothing said why.
    if (!result.usable) {
      const reason = result.failed[0] ? result.failed[0].reason : 'every repository failed to load';
      toast({
        kind: 'error',
        title: 'Refresh failed — keeping the data you had',
        body: `Could not read any of ${result.total} repositories. ${reason}`,
        timeout: 0,
        dedupe: 'refresh',
      });
      setText('connectStatus', 'refresh failed · showing last good data');
      return;
    }

    store.set({
      repos: result.repos,
      runs: result.runs,
      activeRuns: result.runs.filter((r) => r.status === 'in_progress'),
      lastFetch: Date.now(),
    });

    if (result.failed.length) {
      toast({
        kind: 'warn',
        title: `${result.failed.length} of ${result.total} repositories could not be read`,
        body: `${result.failed.slice(0, 3).map((f) => f.repo).join(', ')}${result.failed.length > 3 ? '…' : ''} — ${result.failed[0].reason}`,
        timeout: 12_000,
        dedupe: 'partial',
      });
    }
    announce('Data refreshed.');
  } catch (err) {
    toast({ kind: 'error', title: 'Refresh failed', body: err.message, timeout: 0, dedupe: 'refresh' });
    setText('connectStatus', 'refresh failed · showing last good data');
  } finally {
    store.set({ fetching: false });
    byId('refreshBtn').disabled = false;
    byId('syncBar').hidden = true;
    if (!String(byId('connectStatus').textContent).startsWith('refresh failed')) {
      setText('connectStatus', `updated ${timeAgo(Date.now())}`);
    }
  }
}

function renderRateMeter(rate) {
  const meter = byId('rateMeter');
  if (!meter || rate.limit === null) return;
  meter.hidden = false;
  const share = rate.remaining / rate.limit;
  const fill = byId('rateFill');
  fill.style.width = `${Math.max(2, Math.round(share * 100))}%`;
  fill.classList.toggle('warn', share <= 0.35 && share > 0.12);
  fill.classList.toggle('low', share <= 0.12);
  setText('rateLabel', `${fmtNumber(rate.remaining)}/${fmtNumber(rate.limit)}`);
  meter.title = `${rate.revalidated} responses served from cache without spending quota`;
}

/* ------------------------------------------------------------------ events */

function findRun(repo, id) {
  const pool = [...store.state.runs, ...store.state.activeRuns];
  return pool.find((run) => run.repo === repo && String(run.id) === String(id)) || null;
}

function wire() {
  delegate(document, 'click', '#viewTabs [role="tab"]', (_event, el) => {
    store.set({ tab: el.dataset.tab });
  });

  // Roving focus across the tablist, as the WAI-ARIA tabs pattern expects.
  delegate('viewTabs', 'keydown', '[role="tab"]', (event, el) => {
    const tabs = $$('#viewTabs [role="tab"]');
    const i = tabs.indexOf(el);
    const next = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: tabs.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const target = tabs[(next + tabs.length) % tabs.length];
    target.focus();
    store.set({ tab: target.dataset.tab });
  });

  $$('[data-state]').forEach((el) => {
    el.addEventListener('change', () => {
      const key = el.getAttribute('data-state');
      const value = key === 'days' ? Number(el.value) : el.value;
      store.set({ [key]: value, ...(key === 'repo' || key === 'days' ? { runsShown: PAGE_SIZE } : {}) });
    });
  });

  byId('liveRepoFilter').addEventListener('change', (event) => {
    store.set({ liveRepo: event.target.value });
  });

  byId('connectForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const token = byId('tokenInput').value.trim();
    const owner = byId('orgInput').value.trim();
    if (!token) {
      setText('connectStatus', 'Enter a token first.');
      return;
    }
    connect(token, owner);
  });

  byId('disconnectBtn').addEventListener('click', disconnect);
  byId('refreshBtn').addEventListener('click', refreshAll);
  byId('liveRefreshBtn').addEventListener('click', () => (store.state.demo ? render() : pollActive()));
  byId('dismissOverlay').addEventListener('click', () => { byId('mainOverlay').hidden = true; });
  byId('logClose').addEventListener('click', closeRunLogs);
  byId('logBackdrop').addEventListener('click', closeRunLogs);
  byId('logsReloadBtn').addEventListener('click', () => {
    logCache.clear();
    ctx.expandedLogs = {};
    render();
  });

  delegate(document, 'click', '[data-repo-filter]', (_event, el) => {
    const repo = el.getAttribute('data-repo-filter');
    store.set({ repo: store.state.repo === repo ? 'all' : repo });
  });

  delegate(document, 'click', '[data-repo-toggle]', (_event, el) => {
    const key = `${el.getAttribute('data-container')}:${el.getAttribute('data-repo-toggle')}`;
    ctx.expanded[key] = !ctx.expanded[key];
    render();
  });

  delegate(document, 'click', '[data-action="widen-window"]', (_event, el) => {
    store.set({ days: Number(el.getAttribute('data-days')) });
  });

  delegate(document, 'click', '[data-action="show-more-runs"]', () => {
    ctx.runsShown += PAGE_SIZE;
    renderRuns(ctx);
  });

  delegate(document, 'click', '[data-job-toggle]', (_event, el) => {
    const target = byId(el.getAttribute('data-job-toggle'));
    if (!target) return;
    const open = target.classList.toggle('open');
    el.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  delegate(document, 'click', '[data-log-toggle]', (_event, el) => {
    const i = Number(el.getAttribute('data-log-toggle'));
    const run = ctx.logRows[i];
    if (!run) return;
    const key = runKey(run);
    ctx.expandedLogs[key] = !ctx.expandedLogs[key];
    const card = byId(`rlog-${i}`);
    if (card) card.classList.toggle('open', ctx.expandedLogs[key]);
    el.setAttribute('aria-expanded', ctx.expandedLogs[key] ? 'true' : 'false');
    if (ctx.expandedLogs[key]) loadLogsFor(run, ctx, `rlogbody-${i}`);
  });

  delegate(document, 'click', '[data-raw-log]', (_event, el) => {
    loadRawLog(el.getAttribute('data-raw-log'), ctx, el.getAttribute('data-repo'), el.getAttribute('data-job'));
  });

  const openLogs = (_event, el) => {
    const run = findRun(el.getAttribute('data-run-repo'), el.getAttribute('data-run-id'));
    if (run) openRunLogs(run, ctx);
  };
  delegate(document, 'click', '[data-run-id]', openLogs);
  delegate(document, 'keydown', '[data-run-id][role="button"]', (event, el) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openLogs(event, el);
    }
  });

  document.addEventListener('keydown', (event) => {
    // event.target is not always an Element — a keypress with nothing focused
    // can target the document, which has no .matches and threw here.
    const target = event.target;
    if (target && typeof target.matches === 'function'
      && target.matches('input, select, textarea, [contenteditable]')) return;
    if (event.key === 'r' && !event.metaKey && !event.ctrlKey && !event.altKey) refreshAll();
    if (event.key === '/') {
      event.preventDefault();
      byId('repoFilter').focus();
    }
  });

  document.addEventListener('visibilitychange', schedulePoll);
  window.addEventListener('hashchange', applyHash);

  // A thrown error must not leave the page silently broken — but it must not
  // raise an alarm the reader cannot act on either. A cross-origin script (the
  // Chart.js CDN, or anything at all when the page is opened over file://)
  // reports only the string "Script error." with no file, line or stack. That
  // told the user nothing except that something was wrong.
  window.addEventListener('error', (event) => {
    const opaque = !event.filename && (!event.message || /^script error/i.test(event.message));
    if (opaque) {
      console.warn('[app] opaque cross-origin error suppressed', event);
      return;
    }
    toast({
      kind: 'error',
      title: 'Unexpected error',
      body: String(event.message || 'Something failed while rendering.'),
      timeout: 10_000,
      dedupe: `err:${event.message}`,
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    if (event.reason && event.reason.name === 'AbortError') return;
    const reason = event.reason && event.reason.message ? event.reason.message : String(event.reason);
    toast({ kind: 'error', title: 'Request failed', body: reason, timeout: 10_000, dedupe: `rej:${reason}` });
  });
}

/* -------------------------------------------------------------------- boot */

function boot() {
  initChartDefaults();
  wire();

  store.subscribe((state, keys) => {
    if (keys.has('tab')) showTab(state.tab);
    // Charts are NOT torn down here. `chart()` already destroys and rebuilds
    // each canvas it touches, so a blanket destroyAll() only managed to kill
    // the charts on tabs this render was not going to redraw, and to destroy
    // charts mid-animation — which is one way Chart.js throws.
    if (keys.has('demo')) closeModal();
    writeHash();
    render();
  });

  store.set({ repos: demoRepos(), runs: demoRuns(), demo: true });
  applyHash();
  showTab(store.state.tab);
  render();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
