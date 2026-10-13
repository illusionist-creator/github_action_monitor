// Application shell: state, routing, event wiring, and the polling schedule.

import { syncActive, syncAll } from './data/api.js';
import { buildIndex } from './data/analytics.js';
import { demoRepos, demoRuns } from './data/demo.js';
import { GitHubClient, GitHubError, RateLimitError } from './data/github.js';
import { $$, byId, delegate, html, setHtml, setText } from './lib/dom.js';
import { fmtNumber, repoShortName, timeAgo, windowLabel } from './lib/format.js';
import { entityColor, healthTone } from './lib/palette.js';
import {
  Store,
  WINDOW_PRESETS,
  fitWindow,
  hashToState,
  newestTimestamp,
  previousWindow,
  selectRuns,
  stateToHash,
} from './lib/store.js';
import { destroyAll, initChartDefaults } from './ui/charts.js';
import { initPalette, openPalette } from './ui/command.js';
import { viewError } from './ui/components.js';
import { TAB_ICONS, icon } from './ui/icons.js';
import { activeModalId, closeModal, isModalOpen, openModal } from './ui/modal.js';
import { currentTheme, initTheme, onThemeChange, toggleTheme } from './ui/theme.js';
import { announce, toast } from './ui/toast.js';
import { renderFailures } from './views/failures.js';
import { renderLive, tickLive } from './views/live.js';
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
import { PAGE_SIZE, exportRuns, renderRuns } from './views/runs.js';
import { renderTimeline } from './views/timeline.js';

const TAB_TITLES = {
  overview: 'Overview',
  live: 'Live now',
  repos: 'Repositories',
  runs: 'All runs',
  failures: 'Failures',
  logs: 'Run logs',
  timeline: 'Timeline',
};
const TAB_ORDER = Object.keys(TAB_TITLES);

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
  fullIndex: buildIndex([]),
  prevIndex: buildIndex([]),
  activeRuns: [],
  state: store.state,
  expanded: {},
  expandedLogs: {},
  logRows: [],
  runsShown: PAGE_SIZE,
  runsQuery: '',
  runsSort: { key: 'ts', dir: 'desc' },
  rate: null,
  syncLabel: '',
  bannerDismissed: false,
  demo: true,
};

let pollTimer = null;

/* ------------------------------------------------------------------ render */

function currentRuns() {
  const state = store.state;
  return selectRuns(state.runs, { days: state.days, repo: state.repo });
}

function rebuildIndex() {
  const state = store.state;
  const scoped = currentRuns();
  ctx.index = buildIndex(scoped);
  // The sidebar lists every repository in the window, whichever one is in
  // focus, so you can move straight from one to another.
  ctx.fullIndex = state.repo === 'all'
    ? ctx.index
    : buildIndex(selectRuns(state.runs, { days: state.days, repo: 'all' }));
  ctx.prevIndex = buildIndex(previousWindow(state.runs, { days: state.days, repo: state.repo }));
  // Everything loaded for the repository in focus, whatever the window — for
  // the few panels that compare weeks and would otherwise see one week.
  ctx.historyRuns = state.repo === 'all' ? state.runs : state.runs.filter((run) => run.repo === state.repo);
  ctx.state = state;
  ctx.demo = state.demo;
  ctx.activeRuns = (state.demo ? state.runs : state.activeRuns)
    .filter((run) => run.status === 'in_progress')
    .filter((run) => state.repo === 'all' || run.repo === state.repo);
  ctx.catalogue = buildCatalogue(state.runs);
  ctx.loadedRuns = state.runs.length;
  ctx.newestRunTs = newestTimestamp(state.runs);
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
    repos: () => {
      const n = ctx.index.repos.length;
      setText('reposSub', n
        ? `${fmtNumber(n)} ${n === 1 ? 'repository' : 'repositories'} with runs in the last ${windowLabel(store.state.days)} — expand one for its score breakdown and workflows`
        : 'No repository has runs in this window');
      renderRepoGrid(ctx, 'reposTabGrid');
    },
    runs: () => renderRuns(ctx),
    failures: () => renderFailures(ctx),
    timeline: () => renderTimeline(ctx),
    logs: () => renderLogsTab(ctx),
  };
  safely(TAB_TITLES[tab] || tab, `tab-${tab}`, renderers[tab] || renderers.overview);
}

function subtitle() {
  const state = store.state;
  const repos = ctx.fullIndex.repos.length;
  const bits = [
    `${fmtNumber(repos)} ${repos === 1 ? 'repository' : 'repositories'}`,
    `${fmtNumber(ctx.index.runs.length)} runs`,
    `last ${windowLabel(state.days)}`,
  ];
  if (state.repo !== 'all') bits.push(state.repo);
  if (!state.demo && state.lastFetch) bits.push(`updated ${timeAgo(state.lastFetch)}`);
  return bits.join(' · ');
}

function setCount(id, n, flagClass) {
  const el = byId(id);
  if (!el) return;
  el.textContent = String(n);
  el.classList.toggle(flagClass, n > 0);
}

function renderChrome() {
  const state = store.state;
  const title = TAB_TITLES[state.tab] || 'Overview';

  setText('topbar-title', title);
  setText('topbar-sub', subtitle());
  document.title = `${title} · Actions Monitor`;
  setText('logoSub', state.demo ? 'sample data' : (state.owner || 'live · all repositories'));
  setText('liveBadgeText', state.demo ? 'sample' : 'live');
  const badge = byId('liveBadge');
  if (badge) badge.classList.toggle('demo-mode', state.demo);

  const repoCount = ctx.fullIndex.repos.length;
  setText('nav-repo-count', repoCount ? String(repoCount) : '—');
  setText('nav-logs-count', repoCount ? String(repoCount) : '—');
  setCount('nav-live-count', ctx.activeRuns.length, 'is-live');
  setCount('nav-fail-count', ctx.index.overall.failed, 'is-bad');

  const banner = byId('mainOverlay');
  if (banner) banner.hidden = !state.demo || ctx.bannerDismissed;

  renderSidebarRepos();
  renderConnection();
  syncSelects();
  syncSegment();
  syncThemeButton();
}

function renderSidebarRepos() {
  const rows = Array.from(ctx.fullIndex.repoStats.values())
    .sort((a, b) => a.health.score - b.health.score)
    .slice(0, 40);

  setHtml('sidebar-repo-list', rows.length
    ? html`${rows.map((stats) => html`
      <button class="nav-item repo-item" type="button" data-repo-filter="${stats.repo}" title="${stats.repo}"
        aria-pressed="${store.state.repo === stats.repo ? 'true' : 'false'}">
        <span class="repo-dot" style="background:${entityColor(stats.repo)};" aria-hidden="true"></span>
        <span class="nav-text">${repoShortName(stats.repo)}</span>
        <span class="repo-score tone-${healthTone(stats.health.score).tone}">${stats.health.score}</span>
      </button>
    `)}`
    : html`<div class="nav-empty">No repositories in this window</div>`);
}

function rateMeter(rate) {
  if (!rate || rate.limit === null) return '';
  const share = rate.remaining / rate.limit;
  const cls = share <= 0.12 ? 'low' : share <= 0.35 ? 'warn' : '';
  return html`
    <div class="rate-meter" id="rateMeter" title="${rate.revalidated} responses served from cache without spending quota">
      <span>API</span>
      <div class="rate-track"><div class="rate-fill ${cls}" id="rateFill" style="width:${Math.max(2, Math.round(share * 100))}%"></div></div>
      <span id="rateLabel">${fmtNumber(rate.remaining)}/${fmtNumber(rate.limit)}</span>
    </div>
  `;
}

/** The connection card at the foot of the sidebar: state, budget, actions. */
function renderConnection() {
  const state = store.state;
  if (state.demo) {
    setHtml('connCard', html`
      <div class="conn-card">
        <div class="conn-row">
          <span class="conn-dot" aria-hidden="true"></span>
          <div class="grow">
            <div class="conn-title">Sample data</div>
            <div class="conn-sub">Generated locally, nothing fetched</div>
          </div>
        </div>
        <button class="btn btn-primary btn-block" type="button" data-action="open-connect">
          ${icon('github', 14)} Connect GitHub
        </button>
        <div class="conn-foot">Your token stays in this tab — never stored, never sent anywhere but api.github.com.</div>
      </div>
    `);
    return;
  }

  setHtml('connCard', html`
    <div class="conn-card">
      <div class="conn-row">
        <span class="conn-dot live" aria-hidden="true"></span>
        <div class="grow">
          <div class="conn-title">${state.owner || 'All repositories'}</div>
          <div class="conn-sub">${fmtNumber(state.repos.length)} repos · ${fmtNumber(state.runs.length)} runs · updated ${timeAgo(state.lastFetch)}</div>
        </div>
      </div>
      ${rateMeter(ctx.rate)}
      <div class="conn-status" id="connStatus">${state.fetching ? ctx.syncLabel : ''}</div>
      <div class="conn-actions">
        <button class="btn btn-sm" type="button" data-action="refresh" ${state.fetching ? 'disabled' : ''}>
          ${icon('refresh', 13)} Refresh
        </button>
        <button class="btn btn-sm btn-danger" type="button" data-action="disconnect" id="disconnectBtn">
          ${icon('power', 13)} Disconnect
        </button>
      </div>
    </div>
  `);
}

/** Keep the repo / workflow dropdowns in step with the data without clobbering
 *  a selection the user has made that is still valid. */
function syncSelects() {
  const state = store.state;
  const { repos: allRepos, workflows: allWorkflows } = ctx.catalogue;

  const repoOptions = [{ value: 'all', label: 'All repositories' }].concat(
    allRepos.map((repo) => ({ value: repo, label: repo })),
  );
  fillSelect('repoFilter', repoOptions, state.repo);
  fillSelect('heatRepo', repoOptions, state.heatRepo);

  fillSelect('liveRepoFilter', [{ value: 'all', label: 'All repositories' }].concat(
    Array.from(new Set(ctx.activeRuns.map((r) => r.repo))).sort().map((repo) => ({ value: repo, label: repo })),
  ), state.liveRepo || 'all');

  const workflows = [{ value: 'all', label: 'Any workflow' }].concat(
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
  const wanted = options.map((o) => o.value).join(' ');
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

function syncSegment() {
  $$('#timeSegment [data-days]').forEach((button) => {
    button.setAttribute('aria-pressed', Number(button.getAttribute('data-days')) === store.state.days ? 'true' : 'false');
  });
}

function syncThemeButton() {
  const button = byId('themeBtn');
  if (!button) return;
  const light = currentTheme() === 'light';
  setHtml(button, icon(light ? 'moon' : 'sun', 16));
  button.setAttribute('aria-label', light ? 'Switch to dark theme' : 'Switch to light theme');
  button.title = `${light ? 'Dark' : 'Light'} theme (t)`;
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

/* ----------------------------------------------------------------- drawer */

const narrow = () => typeof matchMedia === 'function' && matchMedia('(max-width: 1024px)').matches;

function setSidebar(open) {
  const app = byId('app');
  if (!app) return;
  app.classList.toggle('sidebar-open', open);
  const button = byId('menuBtn');
  if (button) button.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) {
    const active = byId(`nav-${store.state.tab}`);
    if (active) active.focus();
  } else if (button && narrow() && document.activeElement && byId('sidebar').contains(document.activeElement)) {
    button.focus();
  }
}

const sidebarOpen = () => Boolean(byId('app') && byId('app').classList.contains('sidebar-open'));

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
  ctx.syncLabel = total > 1 ? `${done}/${total} · ${repoShortName(label)}` : String(label || '');
  setText('connStatus', ctx.syncLabel);
  const dialogStatus = byId('connectStatus');
  if (dialogStatus && activeModalId() === 'connectModal') {
    dialogStatus.classList.add('ok');
    setText(dialogStatus, `Syncing · ${ctx.syncLabel}`);
  }
}

function openConnect() {
  const status = byId('connectStatus');
  if (status) {
    status.classList.remove('ok');
    setText(status, '');
  }
  openModal('connectModal', { initialFocus: '#tokenInput' });
}

async function connect(token, owner) {
  const button = byId('connectBtn');
  const status = byId('connectStatus');
  button.disabled = true;
  button.textContent = 'Connecting…';
  status.classList.add('ok');
  setText(status, 'Checking the token…');
  store.set({ fetching: true, error: null });

  const client = new GitHubClient({
    token,
    onRateLimit: (rate) => {
      ctx.rate = rate;
      if (!store.state.demo) renderConnection();
    },
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

    // A second connection replaces the first: drop its client and its cache.
    if (ctx.client) ctx.client.abortAll();
    clearTimeout(pollTimer);
    ctx.client = client;
    ctx.bannerDismissed = false;
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

    byId('tokenInput').value = '';
    setText(status, '');
    if (activeModalId() === 'connectModal') closeModal();

    const requested = store.state.days;
    const fitted = fitWindow(runs, requested);
    if (fitted !== requested) {
      store.set({ days: fitted });
      toast({
        kind: 'info',
        title: `Widened the window to ${windowLabel(fitted)}`,
        body: `Nothing ran in the last ${windowLabel(requested)}. Your most recent run was ${timeAgo(newestTimestamp(runs))}.`,
        timeout: 12_000,
      });
    }

    toast({
      kind: 'success',
      title: 'Connected',
      body: `${fmtNumber(runs.length)} runs across ${repos.length} ${repos.length === 1 ? 'repository' : 'repositories'}.`,
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
    status.classList.remove('ok');
    setText(status, err.message);
    toast({ kind: 'error', title: 'Could not connect', body: err.message, timeout: 0 });
  } finally {
    button.disabled = false;
    button.textContent = 'Connect';
    byId('syncBar').hidden = true;
    ctx.syncLabel = '';
  }
}

function disconnect() {
  clearTimeout(pollTimer);
  if (ctx.client) ctx.client.abortAll();
  // Drop the credential and everything derived from it.
  ctx.client = null;
  ctx.rate = null;
  ctx.bannerDismissed = false;
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

  byId('tokenInput').value = '';
  byId('orgInput').value = '';
  toast({ kind: 'info', title: 'Disconnected', body: 'The token was discarded and sample data restored.' });
}

async function refreshAll() {
  if (store.state.demo) {
    store.set({ runs: demoRuns() });
    announce('Sample data regenerated.');
    return;
  }
  if (!ctx.client || store.state.fetching) return;
  store.set({ fetching: true });
  const refreshBtn = byId('refreshBtn');
  refreshBtn.disabled = true;
  refreshBtn.classList.add('is-busy');
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
    toast({ kind: 'error', title: 'Refresh failed — keeping the data you had', body: err.message, timeout: 0, dedupe: 'refresh' });
  } finally {
    store.set({ fetching: false });
    refreshBtn.disabled = false;
    refreshBtn.classList.remove('is-busy');
    byId('syncBar').hidden = true;
    ctx.syncLabel = '';
  }
}

/* -------------------------------------------------------- command palette */

function paletteItems() {
  const state = store.state;
  const items = [];

  TAB_ORDER.forEach((tab, i) => {
    items.push({
      group: 'Views',
      icon: TAB_ICONS[tab],
      label: TAB_TITLES[tab],
      hint: String(i + 1),
      keywords: 'go to view tab',
      run: () => store.set({ tab }),
    });
  });

  if (state.repo !== 'all') {
    items.push({
      group: 'Repositories',
      icon: 'x',
      label: 'Show all repositories',
      hint: 'clear filter',
      run: () => store.set({ repo: 'all' }),
    });
  }
  ctx.catalogue.repos.forEach((repo) => {
    items.push({
      group: 'Repositories',
      icon: 'folder',
      label: repo,
      hint: state.repo === repo ? 'in focus' : 'focus',
      keywords: 'repository filter focus',
      run: () => store.set({ repo, runsShown: PAGE_SIZE }),
    });
  });

  WINDOW_PRESETS.forEach((days) => {
    items.push({
      group: 'Time range',
      icon: 'clock',
      label: `Last ${windowLabel(days)}`,
      hint: state.days === days ? 'current' : '',
      keywords: 'window range days',
      run: () => store.set({ days, runsShown: PAGE_SIZE }),
    });
  });

  items.push({ group: 'Actions', icon: 'refresh', label: 'Refresh data', hint: 'r', run: refreshAll });
  items.push({
    group: 'Actions',
    icon: currentTheme() === 'light' ? 'moon' : 'sun',
    label: currentTheme() === 'light' ? 'Switch to dark theme' : 'Switch to light theme',
    hint: 't',
    keywords: 'theme colour scheme',
    run: toggleTheme,
  });
  if (state.demo) {
    items.push({ group: 'Actions', icon: 'github', label: 'Connect GitHub', hint: 'c', keywords: 'token login', run: openConnect });
  } else {
    items.push({ group: 'Actions', icon: 'power', label: 'Disconnect and discard the token', keywords: 'logout', run: disconnect });
  }
  items.push({
    group: 'Actions',
    icon: 'keyboard',
    label: 'Keyboard shortcuts',
    hint: '?',
    run: () => openModal('shortcutsModal'),
  });
  return items;
}

/* ------------------------------------------------------------------ ticker */

let ticks = 0;

/** Once a second: advance live timers; every 30s, refresh "updated x ago". */
function startTicker() {
  setInterval(() => {
    ticks += 1;
    if (store.state.tab === 'live' && ctx.activeRuns.length) tickLive(ctx);
    if (ticks % 30 === 0 && !store.state.demo) {
      setText('topbar-sub', subtitle());
      if (!store.state.fetching) renderConnection();
    }
  }, 1000);
}

/* ------------------------------------------------------------------ events */

function findRun(repo, id) {
  const pool = [...store.state.runs, ...store.state.activeRuns];
  return pool.find((run) => run.repo === repo && String(run.id) === String(id)) || null;
}

let searchTimer = null;

function wire() {
  delegate(document, 'click', '#viewTabs [role="tab"]', (_event, el) => {
    store.set({ tab: el.dataset.tab });
    if (narrow()) setSidebar(false);
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

  delegate('timeSegment', 'click', '[data-days]', (_event, el) => {
    store.set({ days: Number(el.getAttribute('data-days')), runsShown: PAGE_SIZE });
  });

  byId('liveRepoFilter').addEventListener('change', (event) => {
    store.set({ liveRepo: event.target.value });
  });

  byId('connectForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const token = byId('tokenInput').value.trim();
    const owner = byId('orgInput').value.trim();
    if (!token) {
      const status = byId('connectStatus');
      status.classList.remove('ok');
      setText(status, 'Paste a token first.');
      byId('tokenInput').focus();
      return;
    }
    connect(token, owner);
  });

  byId('tokenReveal').addEventListener('click', () => {
    const input = byId('tokenInput');
    const button = byId('tokenReveal');
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    button.setAttribute('aria-pressed', reveal ? 'true' : 'false');
    button.setAttribute('aria-label', reveal ? 'Hide token' : 'Show token');
    setHtml(button, icon(reveal ? 'eye-off' : 'eye', 16));
    input.focus();
  });

  byId('refreshBtn').addEventListener('click', refreshAll);
  byId('liveRefreshBtn').addEventListener('click', () => (store.state.demo ? render() : pollActive()));
  byId('dismissOverlay').addEventListener('click', () => {
    ctx.bannerDismissed = true;
    byId('mainOverlay').hidden = true;
  });
  byId('logClose').addEventListener('click', closeRunLogs);
  byId('logBackdrop').addEventListener('click', closeRunLogs);
  byId('logsReloadBtn').addEventListener('click', () => {
    logCache.clear();
    ctx.expandedLogs = {};
    render();
  });

  byId('cmdkBtn').addEventListener('click', () => openPalette());
  byId('themeBtn').addEventListener('click', () => toggleTheme());
  byId('menuBtn').addEventListener('click', () => setSidebar(!sidebarOpen()));
  byId('sidebarClose').addEventListener('click', () => setSidebar(false));
  byId('sidebarScrim').addEventListener('click', () => setSidebar(false));

  onThemeChange(() => {
    initChartDefaults();
    syncThemeButton();
    renderActiveTab();
  });

  delegate(document, 'click', '[data-close]', () => closeModal());

  delegate(document, 'click', '[data-action]', (_event, el) => {
    const action = el.getAttribute('data-action');
    if (action === 'open-connect') openConnect();
    else if (action === 'disconnect') disconnect();
    else if (action === 'refresh') refreshAll();
    else if (action === 'export-runs') exportRuns(ctx);
    else if (action === 'widen-window') store.set({ days: Number(el.getAttribute('data-days')) });
    else if (action === 'show-more-runs') {
      ctx.runsShown += PAGE_SIZE;
      renderRuns(ctx);
    }
  });

  delegate(document, 'click', '[data-jump]', (_event, el) => {
    store.set({ tab: el.getAttribute('data-jump') });
  });

  delegate(document, 'click', '[data-repo-filter]', (_event, el) => {
    const repo = el.getAttribute('data-repo-filter');
    store.set({ repo: store.state.repo === repo ? 'all' : repo, runsShown: PAGE_SIZE });
    if (narrow() && byId('sidebar').contains(el)) setSidebar(false);
  });

  delegate(document, 'click', '[data-repo-toggle]', (_event, el) => {
    const key = `${el.getAttribute('data-container')}:${el.getAttribute('data-repo-toggle')}`;
    ctx.expanded[key] = !ctx.expanded[key];
    render();
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

  // All-runs search and column sorting.
  byId('runsSearch').addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    const value = event.target.value;
    searchTimer = setTimeout(() => {
      ctx.runsQuery = value;
      ctx.runsShown = PAGE_SIZE;
      renderRuns(ctx);
    }, 120);
  });
  delegate('tab-runs', 'click', 'th[data-sort]', (_event, th) => {
    const key = th.getAttribute('data-sort');
    const same = ctx.runsSort.key === key;
    const defaultDir = key === 'ts' || key === 'dur' || key === 'queue' ? 'desc' : 'asc';
    ctx.runsSort = { key, dir: same ? (ctx.runsSort.dir === 'asc' ? 'desc' : 'asc') : defaultDir };
    renderRuns(ctx);
  });

  document.addEventListener('keydown', (event) => {
    // event.target is not always an Element — a keypress with nothing focused
    // can target the document, which has no .matches and threw here.
    const target = event.target;
    const typing = target && typeof target.matches === 'function'
      && target.matches('input, select, textarea, [contenteditable]');
    const mod = event.metaKey || event.ctrlKey;

    if (mod && !event.altKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openPalette();
      return;
    }
    if (typing || mod || event.altKey) return;
    if (isModalOpen()) return;

    if (event.key === 'Escape' && sidebarOpen()) {
      setSidebar(false);
      return;
    }
    if (/^[1-7]$/.test(event.key)) {
      store.set({ tab: TAB_ORDER[Number(event.key) - 1] });
      return;
    }
    switch (event.key) {
      case 'r':
        refreshAll();
        break;
      case 't':
        toggleTheme();
        break;
      case 'k':
      case '/':
        event.preventDefault();
        openPalette();
        break;
      case 'c':
        if (store.state.demo) openConnect();
        break;
      case '?':
        openModal('shortcutsModal');
        break;
      default:
        break;
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
    // Name the source. "Unexpected error: this._fn is not a function" is not
    // something a reader can act on, or report usefully; knowing it came from
    // the charting library rather than this page is the difference between a
    // dead end and a diagnosis.
    const file = String(event.filename || '').split('/').pop();
    const fromChart = /^chart[.-]/i.test(file);
    if (fromChart) {
      console.warn('[charts] error inside Chart.js', event.message, event.error);
      toast({
        kind: 'warn',
        title: 'A chart failed to draw',
        body: `${event.message} — the underlying data is unaffected. Reload if a chart looks stuck.`,
        timeout: 12_000,
        dedupe: 'chartjs',
      });
      return;
    }
    toast({
      kind: 'error',
      title: 'Unexpected error',
      body: `${event.message || 'Something failed while rendering.'}${file ? ` (${file}:${event.lineno || 0})` : ''}`,
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

// Boot exactly once. A second DOMContentLoaded (jsdom fires its own after a
// test dispatches one by hand) would wire every handler twice, and a toggle
// wired twice is a no-op.
let booted = false;

function boot() {
  if (booted) return;
  booted = true;
  initTheme();
  initChartDefaults();
  wire();
  initPalette(paletteItems);

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
  startTicker();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
