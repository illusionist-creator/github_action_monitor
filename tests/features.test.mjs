// Pure logic behind the redesigned chrome: period-over-period deltas, the
// all-runs search/sort/export, and command-palette ranking.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { previousWindow } from '../src/js/lib/store.js';
import { rankItems } from '../src/js/ui/command.js';
import { absDelta, pctDelta } from '../src/js/views/overview.js';
import { matchesQuery, sortRuns, toCsv } from '../src/js/views/runs.js';

const T0 = Date.UTC(2026, 7, 27, 12, 0, 0);
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

describe('period-over-period deltas', () => {
  it('reports the direction and whether that direction is good', () => {
    assert.deepEqual(pctDelta(120, 100, { better: 'down', title: 'x' }), { text: '+20%', dir: 'up', good: false, title: 'x' });
    assert.deepEqual(absDelta(93, 90, { unit: ' pts', better: 'up' }), { text: '+3 pts', dir: 'up', good: true, title: '' });
    assert.equal(absDelta(4, 4).dir, 'flat');
    assert.equal(pctDelta(50, 100, { better: 'none' }).good, null);
  });

  it('refuses to divide by an empty previous window', () => {
    assert.equal(pctDelta(5, 0), null);
    assert.equal(pctDelta(5, NaN), null);
  });

  it('selects the window immediately before the current one', () => {
    const runs = [
      { id: 'now', ts: T0 - 2 * HOUR, repo: 'a/x' },
      { id: 'prev', ts: T0 - 8 * DAY, repo: 'a/x' },
      { id: 'prev-other', ts: T0 - 9 * DAY, repo: 'a/y' },
      { id: 'old', ts: T0 - 20 * DAY, repo: 'a/x' },
    ];
    assert.deepEqual(previousWindow(runs, { days: 7, repo: 'all' }, T0).map((r) => r.id), ['prev', 'prev-other']);
    assert.deepEqual(previousWindow(runs, { days: 7, repo: 'a/y' }, T0).map((r) => r.id), ['prev-other']);
  });
});

describe('all runs: search, sort, export', () => {
  const runs = [
    { id: 1, wf: 'CI / test', repo: 'acme/api', branch: 'main', actor: 'ada', sha: 'abc1234', event: 'push', title: null, status: 'success', dur: 120, queue: 10, ts: 3000, htmlUrl: null },
    { id: 2, wf: 'Deploy', repo: 'acme/web', branch: '=cmd', actor: 'grace', sha: 'def5678', event: 'pull_request', title: null, status: 'failed', dur: 300, queue: 5, ts: 2000, htmlUrl: null },
    { id: 3, wf: 'Lint', repo: 'acme/api', branch: 'feature/x', actor: 'ada', sha: '0001111', event: 'push', title: null, status: 'in_progress', dur: 30, queue: 50, ts: 1000, htmlUrl: null },
  ];

  it('matches every term, case-insensitively, across the useful fields', () => {
    assert.equal(matchesQuery(runs[0], 'ADA api'), true);
    assert.equal(matchesQuery(runs[0], 'ada web'), false);
    assert.equal(matchesQuery(runs[1], 'def56'), true);
    assert.equal(matchesQuery(runs[2], 'feature/x'), true);
    assert.equal(matchesQuery(runs[0], ''), true);
  });

  it('sorts by any column and falls back to recency', () => {
    assert.deepEqual(sortRuns(runs, { key: 'dur', dir: 'desc' }).map((r) => r.id), [2, 1, 3]);
    assert.deepEqual(sortRuns(runs, { key: 'status', dir: 'asc' }).map((r) => r.id), [2, 3, 1]);
    assert.deepEqual(sortRuns(runs, { key: 'wf', dir: 'asc' }).map((r) => r.id), [1, 2, 3]);
    assert.deepEqual(sortRuns(runs, {}).map((r) => r.id), [1, 2, 3]);
  });

  it('writes CSV that a spreadsheet cannot execute', () => {
    const lines = toCsv([runs[1]]).split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^status,workflow,repository,branch/);
    // A branch called "=cmd" must not become a formula when the file is opened.
    assert.match(lines[1], /,'=cmd,/);
    assert.match(toCsv([{ ...runs[0], wf: 'a,"b"' }]), /"a,""b"""/);
  });
});

describe('command palette ranking', () => {
  it('prefers prefix matches, then word starts, then substrings', () => {
    const items = [{ label: 'Timeline' }, { label: 'All runs' }, { label: 'acme/runner' }, { label: 'Run logs' }];
    const out = rankItems(items, 'run').map((i) => i.label);
    assert.equal(out[0], 'Run logs');
    assert.ok(out.includes('All runs'));
    assert.ok(out.includes('acme/runner'));
    assert.equal(out.includes('Timeline'), false);
    assert.equal(rankItems(items, '').length, 4);
  });
});
