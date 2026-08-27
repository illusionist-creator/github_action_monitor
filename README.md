# GitHub Actions Monitor

A cross-repository dashboard for GitHub Actions: run health, queue time, flaky
failures, recovery time, compute spend, and the job-and-step breakdown of any
run — in **one static HTML file** with no server, no build step and no install.

Open `index.html` from disk, drop it on GitHub Pages, or email it to a colleague.
It boots into sample data, so you can see exactly what it does before deciding
whether to give it a token.

```
git clone https://github.com/illusionist-creator/github_action_monitor.git
cd github_action_monitor
open index.html          # macOS · `start index.html` on Windows · `xdg-open` on Linux
```

## What it shows

| View | What it answers |
|---|---|
| **Overview** | Is CI healthy? Success rate, median and p95 duration, queue wait, compute spend, per-repo health, a repo × workflow efficiency matrix, activity heatmap. |
| **Live now** | What is running this second, and is it taking longer than usual? Progress is measured against each workflow's own median. |
| **Repositories** | Per-repo scorecard, decomposed into reliability / speed / recovery, with the workflow breakdown behind each one. |
| **All runs** | Every run in the window, filterable and paged. |
| **Failures** | Failure categories, flaky vs sticky failures, and the details of each recent failure. |
| **Run logs** | The newest run in every repository, expanded to jobs, steps and failure annotations. |
| **Timeline** | Start time vs runtime scatter, per-workflow runtime trends, duration histogram, longest runs. |

Any filtered view is shareable: the tab, repository, window and filters live in
the URL hash, so `#tab=failures&repo=acme%2Fapi&days=30` opens exactly what you
were looking at.

## Connecting your own data

Paste a token in the sidebar. Optionally narrow the scope to one owner
(`octocat`) or one repository (`octocat/hello-world`).

**Scopes needed**

- Fine-grained token: *Actions: Read-only* (plus *Metadata: Read-only*, which is
  mandatory anyway).
- Classic token: `repo` for private repositories, or `public_repo` if you only
  need public ones.

**What happens to the token**

- It is held in a JavaScript variable for the life of the tab and nothing else.
  There is no `localStorage`, no `sessionStorage`, no cookie, no IndexedDB — CI
  fails the build if any of those appear in the source.
- It is never written into a cache key, an error message, a log line or a URL.
  `JSON.stringify(client)` cannot reach it.
- The page's Content-Security-Policy restricts `connect-src` to
  `api.github.com`, so injected markup could not exfiltrate it even if it
  existed.
- "Disconnect" clears the token, aborts in-flight requests and drops every
  cached response.

Closing the tab is a complete logout.

## Rate limits

A GitHub token gets 5,000 REST calls an hour. This dashboard is built not to
waste them:

- **Conditional requests.** Every response's `ETag` is remembered and replayed
  as `If-None-Match`. GitHub answers `304 Not Modified` for anything unchanged,
  and **a 304 costs no quota at all**. The meter in the sidebar shows how many
  responses were served that way.
- **Bounded concurrency.** At most six requests are in flight, whatever the size
  of the org.
- **Cheap polling.** Only *active* runs are polled, not history — one filtered
  request per repository, every 45 seconds, dropping to five minutes when the
  tab is in the background.
- **A reserve.** Below 100 remaining calls, background refreshes stop on their
  own and say so, rather than burning the last of your budget.
- **Real backoff.** `Retry-After` is honoured on secondary limits; 5xx retries
  use exponential backoff with full jitter so parallel requests do not
  resynchronise into a thundering herd.

## Development

The single file is generated. Source lives in `src/`:

```
src/index.html          markup + the <!--@styles--> / <!--@script--> markers
src/styles/*.css        tokens · base · layout · components · views
src/js/lib/             dom (escaping), format, palette, store
src/js/data/            github (transport), api (endpoints), normalize, analytics, demo
src/js/ui/              charts, components, modal, toast
src/js/views/           overview, live, repos, runs, failures, timeline, logs
```

```bash
npm install       # jsdom, for the DOM smoke tests — nothing ships to the browser
npm run build     # src/ -> index.html
npm test          # 72 tests: units, security, build, and a real-DOM smoke suite
npm run check     # fail if index.html has drifted from src/
```

### Publishing to GitHub Pages

`.github/workflows/pages.yml` builds and deploys the single file, but it is
`workflow_dispatch` only. Enabling Pages needs repository-admin rights that the
workflow's own token does not have, so flip it once by hand — **Settings →
Pages → Build and deployment → Source: "GitHub Actions"** — then either run the
workflow from the Actions tab or add the `push` trigger back, which the file
documents inline.

`build.mjs` is a ~180-line zero-dependency bundler. It rewrites each ES module
into a tiny registry factory and inlines the CSS, so the shipped file stays
self-contained while the source stays reviewable. It supports exactly the import
and export forms used here and **throws** on anything else rather than emitting
subtly broken output.

### Conventions

- **Never assign `innerHTML` outside `lib/dom.js`.** Build markup with the
  `html` tagged template, which escapes every interpolation; mark deliberate
  markup with `raw()`. CI greps for violations.
- **No inline event handlers.** Use delegated listeners keyed on `data-*`.
- **Data colours come from `lib/palette.js`,** never from a CSS variable. The
  categorical palette is validated for colour-vision deficiency against the card
  surface; status colours are reserved and always ship with an icon and a label.
- **Metrics live in `data/analytics.js`,** computed once into an index. Views
  read from it; they never scan the run list themselves.

## Design notes

A few decisions that are easy to get wrong:

**Success rate excludes cancelled and skipped runs.** A repo with a
concurrency-cancel policy cancels runs constantly; counting those as failures
makes healthy repos look broken. The rate is successes over successes+failures,
and the card says how many runs were graded.

**Health is not just the success rate.** It is 60% reliability, 20% speed (p95
duration), 20% recovery (MTTR), and the expanded card shows all three, because a
single opaque number is not actionable.

**One outage counts once.** MTTR pairs the *first* failure after green with the
next success. Pairing every failure with the next success turns a ten-run outage
into ten samples of the same incident.

**Flaky means flaky.** A failure is flaky when the same commit also passed, or
when it is bracketed by green on both sides — not merely because the workflow
has both outcomes somewhere in its history.

**Raw log text cannot be read in a browser.** The Actions log endpoint
302-redirects to GitHub's blob storage, which sends no CORS headers, so the
response is blocked before the page sees it. No client-side code changes that.
The dashboard therefore leans on the JSON API for jobs, steps and check-run
annotations — which is where the actual error text lives — and hands you a
ready-made `gh run view --log` command for the rest.

**Charts degrade to tables.** If Chart.js fails its integrity check or the CDN
is unreachable, every chart renders as an accessible data table instead of a
blank card.

## Accessibility

Navigation is a real ARIA tablist with roving arrow-key focus; every clickable
card and row is a button reachable by keyboard; the log dialog traps focus and
restores it on close; status is conveyed by colour *and* an icon *and* a word;
charts carry data-table equivalents; `prefers-reduced-motion` disables every
animation and chart transition; and there is a skip link to the content.

## Browser support

Any current Chrome, Firefox, Safari or Edge. Requires `fetch`,
`AbortController`, `ResizeObserver` and CSS custom properties.

## Licence

MIT — see [LICENSE](LICENSE).
