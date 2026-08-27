// GitHub REST client.
//
// The legacy dashboard fired `Promise.all` over every repository with no
// concurrency cap, no retry, no conditional requests and a 30-second timer that
// issued three requests per repository forever. Fifty repositories meant ~360
// requests a minute against a 5,000/hour budget: the quota was gone inside
// twenty minutes, and secondary rate limiting kicked in long before that.
//
// This client fixes the four things that matter:
//   * a bounded work queue, so a large org cannot self-DoS;
//   * ETag revalidation — a 304 costs no rate-limit quota at all;
//   * backoff that honours `retry-after` and `x-ratelimit-reset`;
//   * a reserve, below which non-essential polling stops on its own.

export const DEFAULT_API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(message, { status = 0, url = '', kind = 'http' } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.url = url;
    this.kind = kind;
  }
}

export class RateLimitError extends GitHubError {
  constructor(message, { status, url, resetAt, secondary = false }) {
    super(message, { status, url, kind: 'rate-limit' });
    this.name = 'RateLimitError';
    this.resetAt = resetAt;
    this.secondary = secondary;
  }
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** Parse an RFC 5988 Link header into { rel: url }. */
export function parseLinkHeader(header) {
  const out = {};
  if (!header) return out;
  header.split(',').forEach((part) => {
    const match = part.match(/<([^>]+)>\s*;\s*rel="([^"]+)"/);
    if (match) out[match[2]] = match[1];
  });
  return out;
}

/**
 * Decide what to do with a response. Split out from the transport so the policy
 * is unit-testable without a network.
 */
export function classifyResponse({ status, headers, attempt, maxRetries, jitter = Math.random }) {
  const remaining = headers.get('x-ratelimit-remaining');
  const retryAfter = headers.get('retry-after');
  const reset = headers.get('x-ratelimit-reset');

  if (status === 304) return { action: 'use-cache' };
  if (status >= 200 && status < 300) return { action: 'ok' };

  // Primary rate limit: quota exhausted, retrying before the reset is pointless.
  if ((status === 403 || status === 429) && remaining === '0') {
    return {
      action: 'rate-limited',
      secondary: false,
      resetAt: reset ? Number(reset) * 1000 : Date.now() + 60000,
    };
  }

  // Secondary (abuse) limit: GitHub asks for a specific pause.
  if ((status === 403 || status === 429) && retryAfter) {
    const waitMs = Number(retryAfter) * 1000;
    if (attempt < maxRetries) return { action: 'retry', waitMs };
    return { action: 'rate-limited', secondary: true, resetAt: Date.now() + waitMs };
  }

  if (RETRYABLE_STATUS.has(status) && attempt < maxRetries) {
    // Full jitter: retries from many parallel requests must not resynchronise.
    const base = Math.min(1000 * 2 ** attempt, 15000);
    return { action: 'retry', waitMs: Math.round(base * (0.5 + jitter() / 2)) };
  }

  return { action: 'fail' };
}

/** Bounded-concurrency task queue. */
export class TaskQueue {
  constructor(limit) {
    this.limit = Math.max(1, limit);
    this.active = 0;
    this.peak = 0;
    this.pending = [];
  }

  run(task) {
    return new Promise((resolve, reject) => {
      this.pending.push({ task, resolve, reject });
      this.drain();
    });
  }

  drain() {
    while (this.active < this.limit && this.pending.length) {
      const { task, resolve, reject } = this.pending.shift();
      this.active += 1;
      this.peak = Math.max(this.peak, this.active);
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class GitHubClient {
  /**
   * @param {object}   options
   * @param {string}   options.token           personal access token
   * @param {string}   [options.baseUrl]       GitHub Enterprise API root
   * @param {number}   [options.concurrency]   simultaneous in-flight requests
   * @param {number}   [options.maxRetries]
   * @param {number}   [options.reserve]       stop polling below this many calls
   * @param {Function} [options.fetchImpl]     injected for tests
   * @param {Function} [options.onRateLimit]   called with the live budget
   */
  constructor({
    token = '',
    baseUrl = DEFAULT_API,
    concurrency = 6,
    maxRetries = 3,
    reserve = 100,
    fetchImpl,
    onRateLimit,
  } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.maxRetries = maxRetries;
    this.reserve = reserve;
    this.queue = new TaskQueue(concurrency);
    this.cache = new Map();
    this.inflight = new Map();
    this.onRateLimit = onRateLimit || (() => {});
    this.rateLimit = { limit: null, remaining: null, resetAt: null, revalidated: 0 };
    this.controller = null;
    // Non-enumerable so the credential never lands in console.log or JSON.stringify.
    Object.defineProperty(this, 'token', {
      value: String(token),
      writable: true,
      enumerable: false,
    });
    Object.defineProperty(this, 'fetchImpl', {
      value: fetchImpl || ((...args) => fetch(...args)),
      enumerable: false,
    });
  }

  /** Keep the credential out of any accidental serialisation. */
  toJSON() {
    return { baseUrl: this.baseUrl, rateLimit: this.rateLimit };
  }

  setToken(token) {
    this.token = String(token || '');
    this.cache.clear();
  }

  /** Abort everything in flight — used when the user switches scope or disconnects. */
  abortAll() {
    if (this.controller) this.controller.abort();
    this.controller = null;
    this.inflight.clear();
  }

  signal() {
    if (!this.controller || this.controller.signal.aborted) {
      this.controller = new AbortController();
    }
    return this.controller.signal;
  }

  buildHeaders(extra) {
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...extra,
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }

  trackRate(headers, { revalidated = false } = {}) {
    const limit = headers.get('x-ratelimit-limit');
    const remaining = headers.get('x-ratelimit-remaining');
    const reset = headers.get('x-ratelimit-reset');
    if (limit !== null) this.rateLimit.limit = Number(limit);
    if (remaining !== null) this.rateLimit.remaining = Number(remaining);
    if (reset !== null) this.rateLimit.resetAt = Number(reset) * 1000;
    if (revalidated) this.rateLimit.revalidated += 1;
    this.onRateLimit(this.rateLimit);
  }

  /** True when the remaining budget is down to the reserve. */
  get exhausted() {
    return this.rateLimit.remaining !== null && this.rateLimit.remaining <= this.reserve;
  }

  resolveUrl(path, params) {
    const url = /^https?:/i.test(path) ? new URL(path) : new URL(this.baseUrl + path);
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    });
    return url.toString();
  }

  /**
   * GET a JSON document.
   *
   * @param {string} path         `/repos/{owner}/{repo}/actions/runs`, or an absolute URL
   * @param {object} [options]
   * @param {object} [options.params]
   * @param {boolean} [options.essential]   bypass the reserve check
   * @param {boolean} [options.revalidate]  send If-None-Match when an ETag is known
   */
  async get(path, { params, essential = false, revalidate = true } = {}) {
    const url = this.resolveUrl(path, params);
    if (!essential && this.exhausted) {
      throw new RateLimitError('Rate-limit reserve reached — background refreshes paused.', {
        status: 403,
        url,
        resetAt: this.rateLimit.resetAt,
        secondary: false,
      });
    }

    // Collapse duplicate concurrent GETs of the same URL into one request.
    const existing = this.inflight.get(url);
    if (existing) return existing;

    const work = this.queue
      .run(() => this.fetchWithRetry(url, { revalidate }))
      .finally(() => this.inflight.delete(url));
    this.inflight.set(url, work);
    return work;
  }

  async fetchWithRetry(url, { revalidate }) {
    const cached = this.cache.get(url);
    for (let attempt = 0; ; attempt += 1) {
      const headers = this.buildHeaders(
        revalidate && cached && cached.etag ? { 'If-None-Match': cached.etag } : undefined,
      );

      let response;
      try {
        response = await this.fetchImpl(url, { headers, signal: this.signal() });
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        if (attempt < this.maxRetries) {
          await sleep(Math.round(500 * 2 ** attempt * (0.5 + Math.random() / 2)));
          continue;
        }
        throw new GitHubError(
          'Network request failed. Check your connection, or whether a proxy is blocking api.github.com.',
          { url, kind: 'network' },
        );
      }

      const verdict = classifyResponse({
        status: response.status,
        headers: response.headers,
        attempt,
        maxRetries: this.maxRetries,
      });

      if (verdict.action === 'use-cache') {
        this.trackRate(response.headers, { revalidated: true });
        return { data: cached.data, url, fromCache: true, link: cached.link };
      }

      if (verdict.action === 'ok') {
        this.trackRate(response.headers);
        const data = await response.json();
        const link = parseLinkHeader(response.headers.get('link'));
        const etag = response.headers.get('etag');
        if (etag) this.cache.set(url, { etag, data, link });
        return { data, url, fromCache: false, link };
      }

      if (verdict.action === 'retry') {
        await sleep(verdict.waitMs);
        continue;
      }

      this.trackRate(response.headers);

      if (verdict.action === 'rate-limited') {
        throw new RateLimitError(
          verdict.secondary
            ? 'GitHub applied a secondary rate limit (too many requests too quickly). Backing off.'
            : `GitHub API rate limit exhausted. Resets ${describeReset(verdict.resetAt)}.`,
          {
            status: response.status,
            url,
            resetAt: verdict.resetAt,
            secondary: verdict.secondary,
          },
        );
      }

      throw await toError(response, url);
    }
  }

  /**
   * Follow `rel="next"` up to `maxPages`, or until `max` items are collected.
   * The legacy version silently `break`ed on any non-403 error, so one 404 read
   * as "this repository has no runs".
   */
  async paginate(path, { params, maxPages = 3, max = Infinity, pick } = {}) {
    const items = [];
    let url = this.resolveUrl(path, params);
    for (let page = 0; page < maxPages && url; page += 1) {
      const { data, link } = await this.get(url);
      const batch = pick ? pick(data) : data;
      if (!Array.isArray(batch)) break;
      items.push(...batch);
      if (items.length >= max) return items.slice(0, max);
      if (batch.length === 0) break;
      url = link.next || null;
    }
    return items;
  }
}

function describeReset(resetAt) {
  if (!resetAt) return 'shortly';
  const minutes = Math.max(1, Math.round((resetAt - Date.now()) / 60000));
  return `in about ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

async function toError(response, url) {
  let message = `HTTP ${response.status}`;
  try {
    const body = await response.json();
    if (body && body.message) message = body.message;
  } catch {
    /* the response carried no JSON body */
  }
  if (response.status === 401) {
    return new GitHubError(`Token rejected: ${message}. Check that it has not expired.`, {
      status: 401,
      url,
      kind: 'auth',
    });
  }
  if (response.status === 403) {
    return new GitHubError(
      `Forbidden: ${message}. The token likely lacks actions:read (or repo) for this resource.`,
      { status: 403, url, kind: 'scope' },
    );
  }
  if (response.status === 404) {
    return new GitHubError(`Not found: ${message}.`, { status: 404, url, kind: 'missing' });
  }
  return new GitHubError(`GitHub API error (${response.status}): ${message}`, {
    status: response.status,
    url,
  });
}
