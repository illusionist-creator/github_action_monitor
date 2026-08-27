// The live sync path: what happens when the API refuses, stalls, or half-works.
//
// Everything here was untested until a refresh in live mode wiped the
// dashboard. `syncAll` used to return `[]` for any repository it could not
// read, so a token that had lost access — or a rate limit, or a 500 — looked
// exactly like an account with no CI, and the caller replaced good data with it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GitHubClient, GitHubError } from '../src/js/data/github.js';
import { syncAll } from '../src/js/data/api.js';

const REPOS = [
  { full_name: 'acme/a', name: 'a', owner: { login: 'acme' } },
  { full_name: 'acme/b', name: 'b', owner: { login: 'acme' } },
  { full_name: 'acme/c', name: 'c', owner: { login: 'acme' } },
];

function headers(extra = {}) {
  const map = new Map(Object.entries({
    'x-ratelimit-limit': '5000',
    'x-ratelimit-remaining': '4900',
    'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
    ...extra,
  }));
  return { get: (k) => (map.has(k.toLowerCase()) ? map.get(k.toLowerCase()) : null) };
}

function runFor(repo, i) {
  const start = Date.now() - i * 3600_000;
  return {
    id: `${repo}-${i}`,
    name: 'CI',
    status: 'completed',
    conclusion: 'success',
    created_at: new Date(start).toISOString(),
    run_started_at: new Date(start + 20_000).toISOString(),
    updated_at: new Date(start + 320_000).toISOString(),
    head_branch: 'main',
    head_sha: `${i}`.padStart(7, '0'),
  };
}

/** @param {(url: string) => object} respond */
function clientWith(respond, options = {}) {
  return new GitHubClient({
    token: 't',
    maxRetries: 0,
    ...options,
    fetchImpl: async (url) => {
      const spec = respond(String(url));
      if (spec.throw) throw spec.throw;
      return {
        status: spec.status,
        ok: spec.status >= 200 && spec.status < 300,
        headers: headers(spec.headers),
        json: async () => spec.body,
      };
    },
  });
}

/** Runs are keyed by the repository in the URL, or dedupeRuns collapses them all. */
function runsBodyFor(url) {
  const match = /\/repos\/([^/]+\/[^/]+)\//.exec(url);
  const repo = match ? match[1] : 'unknown';
  return { workflow_runs: [0, 1, 2].map((i) => runFor(repo, i)) };
}

describe('syncAll outcome reporting', () => {
  it('reports a clean sync as complete and usable', async () => {
    const client = clientWith((url) => (url.includes('/user/repos')
      ? { status: 200, body: REPOS }
      : { status: 200, body: runsBodyFor(url) }));

    const result = await syncAll(client, {});
    assert.equal(result.runs.length, 9);
    assert.equal(result.ok.length, 3);
    assert.equal(result.failed.length, 0);
    assert.equal(result.complete, true);
    assert.equal(result.usable, true);
  });

  it('marks a total 403 as unusable rather than as an empty account', async () => {
    const client = clientWith((url) => (url.includes('/user/repos')
      ? { status: 200, body: REPOS }
      : { status: 403, body: { message: 'Resource not accessible by personal access token' } }));

    const result = await syncAll(client, {});
    assert.equal(result.runs.length, 0);
    assert.equal(result.failed.length, 3);
    // The whole point: an empty result that came from failures is NOT usable,
    // so the caller keeps whatever it already had on screen.
    assert.equal(result.usable, false);
    assert.match(result.failed[0].reason, /Forbidden/);
  });

  it('marks a total 500 as unusable', async () => {
    const client = clientWith((url) => (url.includes('/user/repos')
      ? { status: 200, body: REPOS }
      : { status: 500, body: { message: 'Server Error' } }));

    const result = await syncAll(client, {});
    assert.equal(result.usable, false);
    assert.equal(result.failed.length, 3);
  });

  it('treats a 404 as "no Actions here", which is a real zero', async () => {
    const client = clientWith((url) => (url.includes('/user/repos')
      ? { status: 200, body: REPOS }
      : { status: 404, body: { message: 'Not Found' } }));

    const result = await syncAll(client, {});
    assert.equal(result.runs.length, 0);
    assert.equal(result.failed.length, 0);
    assert.equal(result.withoutActions.length, 3);
    assert.equal(result.usable, true, 'no Actions anywhere is a legitimate empty result');
  });

  it('keeps a partial sync usable and still names what failed', async () => {
    const client = clientWith((url) => {
      if (url.includes('/user/repos')) return { status: 200, body: REPOS };
      if (url.includes('/acme/b/')) return { status: 403, body: { message: 'nope' } };
      return { status: 200, body: runsBodyFor(url) };
    });

    const result = await syncAll(client, {});
    assert.equal(result.usable, true);
    assert.equal(result.complete, false);
    assert.equal(result.ok.length, 2);
    assert.deepEqual(result.failed.map((f) => f.repo), ['acme/b']);
    assert.equal(result.runs.length, 6);
  });

  it('surfaces a rate limit as a failure, not as an absence of runs', async () => {
    const client = clientWith((url) => (url.includes('/user/repos')
      ? { status: 200, body: REPOS }
      : {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0' },
        body: { message: 'API rate limit exceeded' },
      }));

    const result = await syncAll(client, {});
    assert.equal(result.usable, false);
    assert.match(result.failed[0].reason, /rate limit/i);
  });
});

describe('request deadlines', () => {
  it('gives up on a stalled request instead of waiting forever', async () => {
    // No timeout at all is what left the refresh button disabled with no error:
    // fetch() never settles on a black-holed connection.
    const client = new GitHubClient({
      token: 't',
      timeout: 60,
      maxRetries: 1,
      fetchImpl: (url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    });

    const started = Date.now();
    await assert.rejects(
      () => client.get('/user'),
      (err) => err instanceof GitHubError && /timed out/i.test(err.message),
    );
    assert.ok(Date.now() - started < 5000, 'should fail fast, not hang');
  });

  it('retries a timeout at most once, so the UI is never held for minutes', async () => {
    let attempts = 0;
    const client = new GitHubClient({
      token: 't',
      timeout: 40,
      maxRetries: 5,
      fetchImpl: (url, { signal }) => {
        attempts += 1;
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    });

    await assert.rejects(() => client.get('/user'), /timed out/i);
    assert.equal(attempts, 2, 'one attempt plus one retry');
  });

  it('still propagates a deliberate cancellation', async () => {
    const client = new GitHubClient({
      token: 't',
      timeout: 5000,
      fetchImpl: (url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        }, { once: true });
      }),
    });

    const pending = client.get('/user');
    client.abortAll();
    await assert.rejects(() => pending, (err) => err.name === 'AbortError');
  });
});
