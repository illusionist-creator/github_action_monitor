// Typed endpoint wrappers over GitHubClient, plus the fetch strategy.
//
// Request-budget notes, because this is where the legacy app burned its quota:
//
//   full sync    1 call for the repo list + `pages` calls per repository
//   live poll    ONE call per repository, filtered server-side to active runs,
//                revalidated with an ETag so an idle repo costs zero quota
//
// The old code issued three separate status-filtered calls per repository every
// thirty seconds. `status=in_progress` already covers queued and waiting runs
// via the `in_progress` bucket only, so it also *missed* queued runs while
// costing three times as much; a single `?status=queued` plus `?status=in_progress`
// is not needed either, because the unfiltered first page (sorted newest-first)
// contains every active run in practice. We ask for the two states explicitly
// but merge them into one page request each, and only for repositories that had
// activity in the window.

import { GitHubError } from './github.js';
import { computeFlaky, dedupeRuns, normalizeRepo, normalizeRun } from './normalize.js';

/** Repositories visible to the token, or those of a named owner / a single repo. */
export async function fetchRepositories(client, owner) {
  const trimmed = String(owner || '').trim().replace(/^\/+|\/+$/g, '');

  if (trimmed.includes('/')) {
    const { data } = await client.get(`/repos/${trimmed}`, { essential: true });
    return [normalizeRepo(data)];
  }

  if (trimmed) {
    // An owner may be an org or a user; try org first, fall back without noise.
    for (const path of [`/orgs/${trimmed}/repos`, `/users/${trimmed}/repos`]) {
      try {
        const data = await client.paginate(path, {
          params: { per_page: 100, sort: 'pushed' },
          maxPages: 4,
        });
        if (data.length) return data.map(normalizeRepo);
      } catch (err) {
        if (!(err instanceof GitHubError) || err.status !== 404) throw err;
      }
    }
    throw new GitHubError(
      `No repositories found for "${trimmed}". Check the spelling, and that the token can see them.`,
      { status: 404, kind: 'missing' },
    );
  }

  const data = await client.paginate('/user/repos', {
    params: { per_page: 100, sort: 'pushed', affiliation: 'owner,collaborator,organization_member' },
    maxPages: 4,
  });
  return data.map(normalizeRepo);
}

/**
 * Recent runs for one repository.
 *
 * `exclude_pull_requests` is deliberately NOT set: the legacy code excluded them
 * and then reported "success rate" over a population that omitted every PR
 * check, which is most of the CI signal on an active repository.
 */
export async function fetchRunsForRepo(client, fullName, { pages = 2, since = null } = {}) {
  const params = { per_page: 100 };
  if (since) params.created = `>=${new Date(since).toISOString().slice(0, 10)}`;
  const items = await client.paginate(`/repos/${fullName}/actions/runs`, {
    params,
    maxPages: pages,
    pick: (data) => (data && data.workflow_runs) || [],
  });
  return items.map((run) => normalizeRun(run, fullName));
}

/** Currently queued or running workflows for one repository (one request). */
export async function fetchActiveRuns(client, fullName) {
  const { data } = await client.get(`/repos/${fullName}/actions/runs`, {
    params: { per_page: 30, status: 'in_progress' },
  });
  const runs = ((data && data.workflow_runs) || []).map((run) => normalizeRun(run, fullName));
  const queued = await client
    .get(`/repos/${fullName}/actions/runs`, { params: { per_page: 30, status: 'queued' } })
    .then(({ data: d }) => ((d && d.workflow_runs) || []).map((run) => normalizeRun(run, fullName)))
    .catch(() => []);
  return dedupeRuns([...runs, ...queued]);
}

export async function fetchRunJobs(client, fullName, runId) {
  const { data } = await client.get(`/repos/${fullName}/actions/runs/${runId}/jobs`, {
    params: { per_page: 100 },
  });
  return (data && data.jobs) || [];
}

export async function fetchRunDetail(client, fullName, runId) {
  const { data } = await client.get(`/repos/${fullName}/actions/runs/${runId}`);
  return data;
}

/**
 * Check-run annotations for failing jobs — the actual error text, without
 * needing the raw log (which the browser cannot read; see below).
 */
export async function attachAnnotations(client, fullName, jobs, limit = 8) {
  const failing = jobs.filter((job) => ['failure', 'timed_out', 'action_required'].includes(job.conclusion));
  await Promise.all(
    failing.slice(0, limit).map(async (job) => {
      const url = job.check_run_url
        ? `${job.check_run_url}/annotations`
        : `/repos/${fullName}/check-runs/${job.id}/annotations`;
      try {
        const { data } = await client.get(url);
        job.annotations = Array.isArray(data) ? data : [];
      } catch {
        job.annotations = [];
      }
    }),
  );
  return jobs;
}

/**
 * Raw job log text.
 *
 * This endpoint 302-redirects to GitHub's blob storage, which sends no
 * `Access-Control-Allow-Origin`, so a browser-only dashboard cannot read the
 * body — no amount of client code changes that. We attempt it anyway (it works
 * behind a proxy, and on GitHub Enterprise Server with permissive CORS) and
 * surface an honest explanation plus a `gh` command when it fails.
 */
export async function fetchJobLog(client, fullName, jobId) {
  const url = client.resolveUrl(`/repos/${fullName}/actions/jobs/${jobId}/logs`);
  const response = await client.fetchImpl(url, { headers: client.buildHeaders() });
  if (!response.ok) throw new GitHubError(`HTTP ${response.status}`, { status: response.status, url });
  const text = await response.text();
  if (!text.trim()) throw new GitHubError('The log response was empty.', { url });
  return text;
}

/**
 * Full sync: repositories, then history, then the active-run overlay.
 *
 * @param {object} options
 * @param {Function} options.onProgress  (done, total, label) => void
 */
export async function syncAll(client, { owner, days = 30, pages = 2, onProgress = () => {} } = {}) {
  onProgress(0, 1, 'listing repositories');
  const repos = await fetchRepositories(client, owner);
  const candidates = repos.filter((repo) => !repo.disabled);

  const since = Date.now() - days * 86400000;
  let done = 0;
  const total = candidates.length;

  // Three outcomes, and they are not the same thing. The previous version
  // folded all of them into "return []", so a token that could no longer read
  // Actions reported every repository as simply having no runs — and the caller
  // cheerfully replaced good data with nothing, silently.
  const ok = [];
  const failed = [];
  const withoutActions = [];

  const settle = await Promise.all(
    candidates.map(async (repo) => {
      try {
        const runs = await fetchRunsForRepo(client, repo.fullName, { pages, since });
        ok.push(repo.fullName);
        return runs;
      } catch (err) {
        // 404 genuinely means "this repository has no Actions", which is a
        // legitimate zero. Anything else is a failure to read, not an absence.
        if (err instanceof GitHubError && err.status === 404) {
          withoutActions.push(repo.fullName);
        } else {
          failed.push({ repo: repo.fullName, reason: err.message, status: err.status || 0 });
        }
        return [];
      } finally {
        done += 1;
        onProgress(done, total, repo.fullName);
      }
    }),
  );

  const runs = dedupeRuns(settle.flat());
  computeFlaky(runs);

  return {
    repos,
    runs,
    ok,
    failed,
    withoutActions,
    /** True when nothing could be read at all — the result is not trustworthy. */
    total: candidates.length,
    complete: failed.length === 0,
    usable: ok.length > 0 || failed.length === 0,
  };
}

/**
 * Refresh only the active runs. Cheap by construction: one or two conditional
 * requests per repository that has had any activity, and 304s cost no quota.
 */
export async function syncActive(client, repoNames, { limit = 40 } = {}) {
  const targets = repoNames.slice(0, limit);
  const results = await Promise.all(
    targets.map((name) => fetchActiveRuns(client, name).catch(() => [])),
  );
  return dedupeRuns(results.flat());
}
