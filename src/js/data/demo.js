// Sample data, so the dashboard is explorable before a token is entered.
//
// Every generated run carries `demo: true`. Views must not fall back to demo
// data once a token is connected: the legacy code chose between `liveRuns` and
// `ALL_RUNS` in a dozen separate places, and the "running now" strip fabricated
// five active workflows even in live mode when the real answer was zero.

import { computeFlaky } from './normalize.js';

const REPOS = [
  { fullName: 'acme/api-service', description: 'Core REST & GraphQL API', failRate: 0.09 },
  { fullName: 'acme/web-app', description: 'React frontend + SSR', failRate: 0.15 },
  { fullName: 'acme/ml-pipeline', description: 'Model training & evaluation', failRate: 0.1 },
  { fullName: 'acme/infra-deploy', description: 'Terraform & Kubernetes', failRate: 0.19 },
  { fullName: 'acme/sdk-core', description: 'Client SDK — JS, Python, Go', failRate: 0.03 },
];

const WORKFLOWS = {
  'acme/api-service': ['CI / test', 'Build & deploy', 'Security scan', 'Lint & format'],
  'acme/web-app': ['Build & deploy', 'E2E tests', 'Lighthouse CI', 'Lint & format'],
  'acme/ml-pipeline': ['Train model', 'Eval & benchmark', 'Data validation', 'Publish artifact'],
  'acme/infra-deploy': ['Plan & apply', 'Drift check', 'Secret rotation'],
  'acme/sdk-core': ['Unit tests (JS)', 'Unit tests (Py)', 'Unit tests (Go)', 'Publish SDK'],
};

const BASE_MINUTES = {
  'CI / test': 4.1,
  'Build & deploy': 7.5,
  'Security scan': 2.3,
  'Lint & format': 1.2,
  'E2E tests': 12.4,
  'Lighthouse CI': 3.1,
  'Train model': 32,
  'Eval & benchmark': 19,
  'Data validation': 4.3,
  'Publish artifact': 2.1,
  'Plan & apply': 3.8,
  'Drift check': 2.1,
  'Secret rotation': 1.2,
  'Unit tests (JS)': 2.1,
  'Unit tests (Py)': 1.8,
  'Unit tests (Go)': 1.4,
  'Publish SDK': 3.2,
};

const BRANCHES = ['main', 'develop', 'feature/auth', 'fix/perf', 'release/2.1', 'hotfix/null-check'];
const ACTORS = ['dependabot[bot]', 'ada', 'grace', 'linus', 'margaret'];

/** Deterministic LCG so screenshots and tests are reproducible. */
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function demoRepos() {
  return REPOS.map((repo) => ({
    fullName: repo.fullName,
    name: repo.fullName.split('/')[1],
    owner: repo.fullName.split('/')[0],
    description: repo.description,
    private: false,
    archived: false,
    disabled: false,
    pushedAt: null,
    htmlUrl: null,
    demo: true,
  }));
}

/**
 * @param {number} [now]   pinned in tests
 * @param {number} [seed]
 */
export function demoRuns(now = Date.now(), seed = 42) {
  const rand = rng(seed);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const runs = [];

  REPOS.forEach((repo) => {
    const workflows = WORKFLOWS[repo.fullName];
    for (let i = 0; i < 220; i += 1) {
      const started = now - Math.floor(rand() * 30 * 86400000);
      const wf = pick(workflows);
      const failed = rand() < repo.failRate;
      let status = 'success';
      if (failed) status = 'failed';
      else if (rand() < 0.04) status = 'cancelled';
      else if (rand() < 0.03) status = 'skipped';

      const baseSeconds = (BASE_MINUTES[wf] || 3) * 60;
      const dur = Math.max(20, Math.round(baseSeconds * (0.7 + rand() * 0.7)));
      const queue = 5 + Math.floor(rand() * 175);

      runs.push({
        id: `demo-${repo.fullName}-${i}`,
        repo: repo.fullName,
        wf,
        workflowId: null,
        status,
        conclusion: status === 'success' ? 'success' : status,
        ts: started,
        startedAt: started + queue * 1000,
        completedAt: started + (queue + dur) * 1000,
        dur,
        queue,
        branch: pick(BRANCHES),
        event: rand() < 0.5 ? 'push' : 'pull_request',
        actor: pick(ACTORS),
        attempt: 1,
        runNumber: 200 - i,
        sha: Math.floor(rand() * 0xfffffff).toString(16).padStart(7, '0'),
        title: `${wf} on ${pick(BRANCHES)}`,
        htmlUrl: null,
        flaky: false,
        demo: true,
      });
    }
  });

  // A handful of genuinely active runs, so the Live view has something to show.
  const active = [
    { repo: 'acme/api-service', wf: 'CI / test', branch: 'main', elapsed: 142 },
    { repo: 'acme/web-app', wf: 'E2E tests', branch: 'feature/auth', elapsed: 381 },
    { repo: 'acme/ml-pipeline', wf: 'Train model', branch: 'develop', elapsed: 870 },
    { repo: 'acme/infra-deploy', wf: 'Plan & apply', branch: 'hotfix/null-check', elapsed: 196 },
  ].map((spec, i) => ({
    id: `demo-active-${i}`,
    repo: spec.repo,
    wf: spec.wf,
    workflowId: null,
    status: 'in_progress',
    conclusion: null,
    ts: now - (spec.elapsed + 30) * 1000,
    startedAt: now - spec.elapsed * 1000,
    completedAt: null,
    dur: spec.elapsed,
    queue: 30,
    branch: spec.branch,
    event: 'push',
    actor: 'ada',
    attempt: 1,
    runNumber: 999,
    sha: 'demo000',
    title: `${spec.wf} on ${spec.branch}`,
    htmlUrl: null,
    flaky: false,
    demo: true,
  }));

  const all = [...runs, ...active];
  computeFlaky(all);
  return all;
}
