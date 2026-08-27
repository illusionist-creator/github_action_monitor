import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  activityMatrix,
  buildIndex,
  categorizeFailure,
  dailyBuckets,
  healthScore,
  meanTimeToRecovery,
  successStreak,
} from '../src/js/data/analytics.js';
import {
  GitHubClient,
  TaskQueue,
  classifyResponse,
  parseLinkHeader,
} from '../src/js/data/github.js';
import { computeFlaky, dedupeRuns, normalizeRun } from '../src/js/data/normalize.js';
import { demoRuns } from '../src/js/data/demo.js';
import {
  fmtDuration,
  percentile,
  repoInitials,
  timeAgo,
  truncate,
} from '../src/js/lib/format.js';
import { assignColors, entityColor, withAlpha } from '../src/js/lib/palette.js';
import { Store, hashToState, selectRuns, stateToHash } from '../src/js/lib/store.js';
import { cleanLogLine, latestRunPerRepo } from '../src/js/views/logs.js';
import { expectedDuration, progressFor } from '../src/js/views/live.js';

const T0 = Date.UTC(2026, 7, 27, 12, 0, 0);
const HOUR = 3600000;

function run(spec) {
  return normalizeRun(
    {
      id: spec.id,
      name: spec.wf || 'ci',
      status: spec.running ? 'in_progress' : 'completed',
      conclusion: spec.running ? null : spec.conclusion,
      created_at: new Date(spec.at).toISOString(),
      run_started_at: new Date(spec.at + (spec.queue ?? 30) * 1000).toISOString(),
      updated_at: new Date(spec.at + (spec.queue ?? 30) * 1000 + (spec.dur ?? 60) * 1000).toISOString(),
      head_branch: spec.branch || 'main',
      head_sha: spec.sha || `sha${spec.id}`,
    },
    spec.repo || 'a/x',
    T0,
  );
}

/* ------------------------------------------------------------------ format */

describe('format', () => {
  it('renders hours, which the legacy formatter never did', () => {
    assert.equal(fmtDuration(5400), '1h 30m');
    assert.equal(fmtDuration(95), '1m 35s');
    assert.equal(fmtDuration(42), '42s');
    assert.equal(fmtDuration(0), '0s');
    assert.equal(fmtDuration(null), '—');
    assert.equal(fmtDuration(-5), '—');
    assert.equal(fmtDuration('nope'), '—');
  });

  it('never reports a sub-minute gap as "0m ago"', () => {
    assert.equal(timeAgo(T0 - 3000, T0), 'just now');
    assert.equal(timeAgo(T0 - 42000, T0), '42s ago');
    assert.equal(timeAgo(T0 - 90 * 60000, T0), '1h ago');
    assert.equal(timeAgo(T0 + 60000, T0), 'in 1m');
  });

  it('uses nearest-rank percentiles, which stay in range', () => {
    const values = Array.from({ length: 20 }, (_, i) => i + 1);
    assert.equal(percentile(values, 95), 19);
    assert.equal(percentile(values, 50), 10);
    assert.equal(percentile(values, 100), 20);
    assert.equal(percentile([], 95), 0);
    // The legacy `sorted[Math.floor(n * 0.95)]` indexed past the end here.
    assert.notEqual(percentile(values, 95), undefined);
  });

  it('derives repo initials from the name', () => {
    assert.equal(repoInitials('octocat/hello-world'), 'HW');
    assert.equal(repoInitials('acme/api'), 'AP');
    assert.equal(truncate('averylongworkflowname', 8), 'averylo…');
  });
});

/* ----------------------------------------------------------------- palette */

describe('palette', () => {
  it('gives an entity the same colour every time', () => {
    assert.equal(entityColor('acme/api'), entityColor('acme/api'));
  });

  it('does not repaint existing entities when another is added', () => {
    const two = assignColors(['a/one', 'a/two']);
    const three = assignColors(['a/one', 'a/two', 'a/three']);
    assert.equal(two.get('a/one'), three.get('a/one'));
    assert.equal(two.get('a/two'), three.get('a/two'));
  });

  it('does not hand two entities the same slot', () => {
    const colors = [...assignColors(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']).values()];
    assert.equal(new Set(colors).size, 8);
  });

  it('converts hex to rgba', () => {
    assert.equal(withAlpha('#3987e5', 0.2), 'rgba(57,135,229,0.2)');
  });
});

/* --------------------------------------------------------------- normalize */

describe('normalizeRun', () => {
  it('separates queue wait from execution time', () => {
    const r = run({ id: 1, at: T0 - HOUR, queue: 45, dur: 300, conclusion: 'success' });
    assert.equal(r.queue, 45);
    assert.equal(r.dur, 300);
  });

  it('measures an in-progress run from its start, not its creation', () => {
    const r = normalizeRun(
      {
        id: 9,
        status: 'in_progress',
        created_at: new Date(T0 - 600000).toISOString(),
        run_started_at: new Date(T0 - 300000).toISOString(),
        updated_at: new Date(T0 - 300000).toISOString(),
      },
      'a/x',
      T0,
    );
    assert.equal(r.status, 'in_progress');
    assert.equal(r.dur, 300);
    assert.equal(r.queue, 300);
    assert.equal(r.completedAt, null);
  });

  it('maps every terminal conclusion', () => {
    const cases = {
      success: 'success',
      failure: 'failed',
      timed_out: 'failed',
      startup_failure: 'failed',
      cancelled: 'cancelled',
      skipped: 'skipped',
    };
    Object.entries(cases).forEach(([conclusion, expected]) => {
      assert.equal(run({ id: 1, at: T0, conclusion }).status, expected, conclusion);
    });
  });

  it('deduplicates by id, keeping the newest', () => {
    const a = run({ id: 5, at: T0 - HOUR, conclusion: 'failure' });
    const b = run({ id: 5, at: T0, conclusion: 'success' });
    const out = dedupeRuns([a, b]);
    assert.equal(out.length, 1);
    assert.equal(out[0].status, 'success');
  });
});

describe('computeFlaky', () => {
  it('flags a retry that passed on the same commit', () => {
    const runs = [
      run({ id: 1, at: T0 - 3 * HOUR, conclusion: 'failure', sha: 'abc' }),
      run({ id: 2, at: T0 - 2 * HOUR, conclusion: 'success', sha: 'abc' }),
    ];
    computeFlaky(runs);
    assert.equal(runs[0].flaky, true);
  });

  it('does not flag a genuine outage that was later fixed', () => {
    const runs = [
      run({ id: 1, at: T0 - 5 * HOUR, conclusion: 'success', sha: 'aaa' }),
      run({ id: 2, at: T0 - 4 * HOUR, conclusion: 'failure', sha: 'bbb' }),
      run({ id: 3, at: T0 - 3 * HOUR, conclusion: 'failure', sha: 'bbb' }),
      run({ id: 4, at: T0 - 2 * HOUR, conclusion: 'success', sha: 'ccc' }),
    ];
    computeFlaky(runs);
    // The legacy rule flagged both failures simply because the group contained
    // a success somewhere. Neither is bracketed by green, so neither is flaky.
    assert.equal(runs[1].flaky, false);
    assert.equal(runs[2].flaky, false);
  });

  it('flags an isolated red between two greens', () => {
    const runs = [
      run({ id: 1, at: T0 - 3 * HOUR, conclusion: 'success', sha: 'aaa' }),
      run({ id: 2, at: T0 - 2 * HOUR, conclusion: 'failure', sha: 'bbb' }),
      run({ id: 3, at: T0 - HOUR, conclusion: 'success', sha: 'ccc' }),
    ];
    computeFlaky(runs);
    assert.equal(runs[1].flaky, true);
  });
});

/* --------------------------------------------------------------- analytics */

describe('analytics', () => {
  it('excludes cancelled and skipped runs from the success rate', () => {
    const index = buildIndex([
      run({ id: 1, at: T0, conclusion: 'success' }),
      run({ id: 2, at: T0, conclusion: 'failure' }),
      run({ id: 3, at: T0, conclusion: 'cancelled' }),
      run({ id: 4, at: T0, conclusion: 'skipped' }),
    ]);
    // 1 of 2 graded, not 1 of 4.
    assert.equal(index.overall.successRate, 50);
    assert.equal(index.overall.total, 4);
  });

  it('counts one outage once, however many times it failed', () => {
    const runs = [
      run({ id: 1, at: T0 - 5 * HOUR, conclusion: 'failure' }),
      run({ id: 2, at: T0 - 4 * HOUR, conclusion: 'failure' }),
      run({ id: 3, at: T0 - 3 * HOUR, conclusion: 'failure' }),
      run({ id: 4, at: T0 - 2 * HOUR, conclusion: 'success' }),
    ];
    const mttr = meanTimeToRecovery(runs);
    assert.equal(mttr.samples, 1);
    assert.equal(mttr.meanMinutes, 180);
  });

  it('treats each workflow and branch as its own recovery series', () => {
    const runs = [
      run({ id: 1, at: T0 - 4 * HOUR, wf: 'ci', conclusion: 'failure' }),
      run({ id: 2, at: T0 - 3 * HOUR, wf: 'deploy', conclusion: 'success' }),
      run({ id: 3, at: T0 - 2 * HOUR, wf: 'ci', conclusion: 'success' }),
    ];
    assert.equal(meanTimeToRecovery(runs).samples, 1);
    assert.equal(meanTimeToRecovery(runs).meanMinutes, 120);
  });

  it('counts a streak back from the newest run', () => {
    const newestFirst = [
      run({ id: 4, at: T0, conclusion: 'success' }),
      run({ id: 3, at: T0 - HOUR, conclusion: 'success' }),
      run({ id: 2, at: T0 - 2 * HOUR, conclusion: 'failure' }),
      run({ id: 1, at: T0 - 3 * HOUR, conclusion: 'success' }),
    ];
    assert.equal(successStreak(newestFirst), 2);
  });

  it('does not let one slow green build outrank a flaky one', () => {
    const slowButGreen = healthScore(
      { total: 50, successRate: 100, p95Duration: 3600, success: 50, failed: 0 },
      0,
    );
    const fastButBroken = healthScore(
      { total: 50, successRate: 60, p95Duration: 60, success: 30, failed: 20 },
      120,
    );
    assert.ok(slowButGreen.score > fastButBroken.score);
    assert.ok(slowButGreen.score >= 75);
  });

  it('buckets days inclusively and keeps empty days', () => {
    const buckets = dailyBuckets([run({ id: 1, at: T0 - 2 * 86400000, conclusion: 'success' })], 7, T0);
    assert.equal(buckets.length, 7);
    assert.equal(buckets.reduce((a, b) => a + b.runs.length, 0), 1);
  });

  it('builds a 7 x 24 activity matrix', () => {
    const { matrix, max } = activityMatrix([run({ id: 1, at: T0, conclusion: 'success' })]);
    assert.equal(matrix.length, 7);
    assert.equal(matrix[0].length, 24);
    assert.equal(max, 1);
  });

  it('categorises failures from the workflow name', () => {
    assert.equal(categorizeFailure('CI / test'), 'Tests');
    assert.equal(categorizeFailure('Build & deploy'), 'Build');
    assert.equal(categorizeFailure('Something else'), 'Other');
  });
});

/* ------------------------------------------------------------------ client */

describe('GitHubClient policy', () => {
  const headers = (obj) => ({ get: (k) => (k.toLowerCase() in obj ? obj[k.toLowerCase()] : null) });

  it('parses all Link relations', () => {
    const links = parseLinkHeader('<https://a/?p=2>; rel="next", <https://a/?p=9>; rel="last"');
    assert.equal(links.next, 'https://a/?p=2');
    assert.equal(links.last, 'https://a/?p=9');
    assert.deepEqual(parseLinkHeader(null), {});
  });

  it('does not retry a spent primary rate limit', () => {
    const verdict = classifyResponse({
      status: 403,
      headers: headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' }),
      attempt: 0,
      maxRetries: 3,
    });
    assert.equal(verdict.action, 'rate-limited');
    assert.equal(verdict.secondary, false);
  });

  it('honours Retry-After on a secondary limit', () => {
    const verdict = classifyResponse({
      status: 403,
      headers: headers({ 'retry-after': '30' }),
      attempt: 0,
      maxRetries: 3,
    });
    assert.equal(verdict.action, 'retry');
    assert.equal(verdict.waitMs, 30000);
  });

  it('backs off exponentially on 5xx and gives up at the limit', () => {
    const at = (attempt) => classifyResponse({
      status: 502, headers: headers({}), attempt, maxRetries: 3, jitter: () => 0,
    });
    assert.equal(at(0).waitMs, 500);
    assert.equal(at(1).waitMs, 1000);
    assert.equal(at(2).waitMs, 2000);
    assert.equal(at(3).action, 'fail');
  });

  it('reuses the cached body on 304', () => {
    assert.equal(classifyResponse({ status: 304, headers: headers({}), attempt: 0, maxRetries: 3 }).action, 'use-cache');
  });

  it('never exposes the token through serialisation', () => {
    const client = new GitHubClient({ token: 'ghp_supersecret' });
    assert.equal(JSON.stringify(client).includes('supersecret'), false);
    assert.equal(Object.keys(client).includes('token'), false);
    assert.equal(String(client.buildHeaders().Authorization), 'Bearer ghp_supersecret');
  });

  it('drops empty query parameters instead of sending them', () => {
    const client = new GitHubClient({ token: 't' });
    const url = client.resolveUrl('/repos/a/b/actions/runs', { per_page: 100, status: '' });
    assert.equal(url, 'https://api.github.com/repos/a/b/actions/runs?per_page=100');
  });

  it('caps concurrency so a large org cannot self-DoS', async () => {
    const queue = new TaskQueue(3);
    let active = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 20 }, () => queue.run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 1));
      active -= 1;
    })));
    assert.equal(peak, 3);
  });

  it('collapses duplicate concurrent GETs into one request', async () => {
    let calls = 0;
    const client = new GitHubClient({
      token: 't',
      fetchImpl: async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 5));
        return {
          status: 200,
          ok: true,
          headers: headers({ 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999' }),
          json: async () => ({ ok: true }),
        };
      },
    });
    await Promise.all([client.get('/user'), client.get('/user'), client.get('/user')]);
    assert.equal(calls, 1);
  });

  it('stops issuing background requests once the reserve is reached', async () => {
    const client = new GitHubClient({ token: 't', reserve: 100 });
    client.rateLimit.remaining = 50;
    client.rateLimit.limit = 5000;
    await assert.rejects(() => client.get('/user'), /reserve/i);
    // Essential calls still go through.
    client.rateLimit.remaining = 50;
    assert.equal(client.exhausted, true);
  });
});

/* ------------------------------------------------------------------- store */

describe('store', () => {
  it('round-trips shareable filters through the URL hash', () => {
    const hash = stateToHash({ tab: 'failures', repo: 'a/b', days: 30, status: 'failed' });
    assert.match(hash, /tab=failures/);
    const back = hashToState(hash);
    assert.equal(back.tab, 'failures');
    assert.equal(back.repo, 'a/b');
    assert.equal(back.days, 30);
  });

  it('omits defaults from the hash so shared links stay short', () => {
    assert.equal(stateToHash({ tab: 'overview', days: 7, repo: 'all' }), '');
  });

  it('ignores unknown or malformed hash keys', () => {
    const back = hashToState('#tab=runs&evil=<script>&days=notanumber');
    assert.equal(back.tab, 'runs');
    assert.equal(back.evil, undefined);
    assert.equal(back.days, 7);
  });

  it('notifies subscribers once per batch with the changed keys', async () => {
    const store = new Store();
    const seen = [];
    store.subscribe((_state, keys) => seen.push([...keys].sort()));
    store.set({ tab: 'runs' });
    store.set({ repo: 'a/b' });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], ['repo', 'tab']);
  });

  it('filters by window and repository', () => {
    const runs = [
      run({ id: 1, at: T0 - 2 * 86400000, repo: 'a/x', conclusion: 'success' }),
      run({ id: 2, at: T0 - 20 * 86400000, repo: 'a/x', conclusion: 'success' }),
      run({ id: 3, at: T0, repo: 'a/y', conclusion: 'success' }),
    ];
    assert.equal(selectRuns(runs, { days: 7, repo: 'all' }, T0).length, 2);
    assert.equal(selectRuns(runs, { days: 7, repo: 'a/y' }, T0).length, 1);
  });
});

/* -------------------------------------------------------------- live view */

describe('live progress', () => {
  const history = [
    run({ id: 1, at: T0 - 5 * HOUR, wf: 'ci', dur: 100, conclusion: 'success' }),
    run({ id: 2, at: T0 - 4 * HOUR, wf: 'ci', dur: 120, conclusion: 'success' }),
    run({ id: 3, at: T0 - 3 * HOUR, wf: 'ci', dur: 110, conclusion: 'success' }),
  ];
  const index = buildIndex(history);
  const active = normalizeRun(
    {
      id: 99,
      name: 'ci',
      status: 'in_progress',
      created_at: new Date(T0 - 200000).toISOString(),
      run_started_at: new Date(T0 - 180000).toISOString(),
      updated_at: new Date(T0 - 180000).toISOString(),
    },
    'a/x',
    T0,
  );

  it('uses the workflow median as the baseline', () => {
    assert.equal(expectedDuration(active, index), 110);
  });

  it('detects an overrun — impossible in the legacy formula', () => {
    const p = progressFor(active, index, T0);
    assert.equal(p.elapsed, 180);
    assert.equal(p.overrun, true);
    assert.equal(p.pct, 100);
  });

  it('reports no baseline rather than inventing one', () => {
    const lonely = buildIndex([]);
    assert.equal(progressFor(active, lonely, T0).expected, null);
    assert.equal(progressFor(active, lonely, T0).pct, null);
  });
});

/* -------------------------------------------------------------- logs view */

describe('logs helpers', () => {
  it('strips ANSI codes and the per-line ISO timestamp', () => {
    const line = '2026-08-27T10:00:00.1234567Z [31mError:[0m boom';
    assert.equal(cleanLogLine(line), 'Error: boom');
  });

  it('picks the newest run per repository', () => {
    const index = buildIndex([
      run({ id: 1, at: T0 - 2 * HOUR, repo: 'a/x', conclusion: 'success' }),
      run({ id: 2, at: T0 - HOUR, repo: 'a/x', conclusion: 'failure' }),
      run({ id: 3, at: T0 - 3 * HOUR, repo: 'a/y', conclusion: 'success' }),
    ]);
    const rows = latestRunPerRepo(index, [], 'latest');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, 2);
  });
});

/* -------------------------------------------------------------------- demo */

describe('sample data', () => {
  it('is deterministic for a given seed', () => {
    const a = demoRuns(T0, 42);
    const b = demoRuns(T0, 42);
    assert.equal(a.length, b.length);
    assert.equal(a[0].wf, b[0].wf);
    assert.equal(a[100].dur, b[100].dur);
  });

  it('marks every generated run so it can never be mistaken for live data', () => {
    assert.ok(demoRuns(T0).every((r) => r.demo === true));
  });
});
