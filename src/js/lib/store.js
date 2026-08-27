// Application state.
//
// The legacy app kept state in a bare object and read the *current DOM value* of
// a `<select>` inside every renderer, so a view could not be rendered without
// the whole page being present, filters could not be deep-linked, and a stale
// dropdown silently changed what a chart meant. State lives here, views
// subscribe, and the shareable parts round-trip through the URL hash.

const URL_KEYS = ['tab', 'repo', 'days', 'status', 'workflow', 'group', 'scope', 'metric', 'sort'];

export const DEFAULT_STATE = {
  // view
  tab: 'overview',
  repo: 'all',
  days: 7,
  status: 'all',
  workflow: 'all',
  group: 'workflow',
  scope: 'all',
  metric: 'success',
  sort: 'health',
  heatRepo: 'all',
  heatMetric: 'runs',
  runPick: 'latest',
  // connection
  connected: false,
  owner: '',
  fetching: false,
  lastFetch: null,
  error: null,
  // data
  repos: [],
  runs: [],
  activeRuns: [],
  index: null,
  rateLimit: null,
  demo: true,
};

export class Store {
  constructor(initial = {}) {
    this.state = { ...DEFAULT_STATE, ...initial };
    this.listeners = new Set();
    this.pendingKeys = new Set();
    this.frame = null;
  }

  get(key) {
    return key === undefined ? this.state : this.state[key];
  }

  /**
   * Merge a patch. Listeners are notified once per animation frame with the set
   * of keys that actually changed, so a burst of updates repaints once.
   */
  set(patch) {
    let changed = false;
    Object.entries(patch).forEach(([key, value]) => {
      if (!Object.is(this.state[key], value)) {
        this.state[key] = value;
        this.pendingKeys.add(key);
        changed = true;
      }
    });
    if (changed) this.schedule();
    return changed;
  }

  schedule() {
    if (this.frame !== null) return;
    const flush = () => {
      this.frame = null;
      const keys = this.pendingKeys;
      this.pendingKeys = new Set();
      this.listeners.forEach((fn) => {
        try {
          fn(this.state, keys);
        } catch (err) {
          // One broken subscriber must not stop the others from repainting.
          console.error('[store] subscriber failed', err);
        }
      });
    };
    this.frame = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(flush)
      : setTimeout(flush, 0);
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/** Serialise the shareable slice of state into a URL hash. */
export function stateToHash(state) {
  const params = new URLSearchParams();
  URL_KEYS.forEach((key) => {
    const value = state[key];
    if (value !== undefined && value !== null && value !== DEFAULT_STATE[key]) {
      params.set(key, String(value));
    }
  });
  const query = params.toString();
  return query ? `#${query}` : '';
}

/** Read the shareable slice back out of a hash, ignoring anything unexpected. */
export function hashToState(hash) {
  const out = {};
  const raw = String(hash || '').replace(/^#/, '');
  if (!raw) return out;
  const params = new URLSearchParams(raw);
  URL_KEYS.forEach((key) => {
    if (!params.has(key)) return;
    const value = params.get(key);
    out[key] = key === 'days' ? clampDays(value) : value;
  });
  return out;
}

function clampDays(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_STATE.days;
  return [1, 7, 14, 30, 90].reduce((best, allowed) => (
    Math.abs(allowed - n) < Math.abs(best - n) ? allowed : best
  ), DEFAULT_STATE.days);
}

/**
 * Filter runs by the current window and repository scope. Pure, so views and
 * tests can call it without a DOM.
 */
export function selectRuns(runs, { days, repo }, now = Date.now()) {
  const cutoff = now - days * 86400000;
  return runs.filter((run) => run.ts >= cutoff && (repo === 'all' || run.repo === repo));
}
