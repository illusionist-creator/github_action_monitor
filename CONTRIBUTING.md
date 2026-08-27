# Contributing

## Setup

```bash
npm install
npm run build     # src/ -> index.html
npm test
```

Open `index.html` directly from disk — there is no dev server, and there does
not need to be. After editing anything in `src/`, run `npm run build` and
refresh.

## Before opening a pull request

```bash
npm run verify    # build --check, then the full test suite
```

`index.html` is generated **and committed**, because the project's whole promise
is that one file works with no toolchain. CI fails if it has drifted from
`src/`, so always commit the rebuilt file alongside your source change.

## Rules that CI enforces

These are not style preferences — each one corresponds to a bug this codebase
has already had.

1. **No `innerHTML` outside `src/js/lib/dom.js`.** Workflow names, branch names
   and repo descriptions are attacker-controlled. Build markup with the `html`
   tagged template; use `raw()` only for markup you constructed yourself.
2. **No inline `on*=` handlers in the HTML.** They are a second injection sink
   and require globals. Use `delegate()` with `data-*` attributes.
3. **No `localStorage` / `sessionStorage` / cookies / IndexedDB.** The page
   holds a personal access token; it must not survive the tab.
4. **No `fetch()` to a host other than `api.github.com`.**

## Where things go

| If you are changing… | Edit |
|---|---|
| A metric or aggregate | `src/js/data/analytics.js` — add a test in `tests/units.test.mjs` |
| How the API is called | `src/js/data/api.js` (endpoints) or `data/github.js` (transport, retries, rate limits) |
| A chart | the relevant `src/js/views/*.js`; keep the `dataTable` fallback in step |
| A colour | `src/js/lib/palette.js`, never a raw hex in a view |
| Layout or component styling | `src/styles/` — add new files to the order list in `build.mjs` |

## Adding a chart

Every `chart(id, config, fallback)` call takes a third argument describing the
same data as `{ columns, rows, caption }`. It is not optional busywork: it is
what renders when Chart.js is unavailable, and it is the table view that keeps
the chart accessible. A chart without it will render an empty card offline.

## The bundler

`build.mjs` understands a deliberately small subset of ES module syntax:

- `import { a, b } from './rel/path.js';` — named imports only, no defaults, no
  namespace imports
- `export function` / `export const` / `export class` at top level, one
  declarator per statement
- `export { a, b };`

Anything else throws at build time. If you need a form it does not support,
extend the transform *and* add a case to the tests rather than working around
it.

## Tests

- `tests/units.test.mjs` — pure logic: formatting, analytics, normalisation,
  the rate-limit policy, the store.
- `tests/security.test.mjs` — escaping regressions. Add a payload here whenever
  you touch a render path.
- `tests/smoke.test.mjs` — boots the built `index.html` in jsdom and drives it.

Run one file with `node --test tests/units.test.mjs`.
