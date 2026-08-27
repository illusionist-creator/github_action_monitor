// The build must be reproducible, or `--check` fails on whichever platform did
// not produce the committed file.
//
// This is not hypothetical: the first CI run failed exactly here. Git's
// autocrlf hands a Windows checkout CRLF and CI's Linux checkout LF, the build
// stamp hashes the source text, and the two therefore disagreed about a file
// whose content was identical.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = join(ROOT, 'index.html');

function sourceFiles(dir = join(ROOT, 'src'), acc = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (/\.(js|css|html)$/.test(name)) acc.push(full);
  }
  return acc;
}

const build = () => execFileSync(process.execPath, [join(ROOT, 'build.mjs')], { cwd: ROOT });

describe('build', () => {
  const originals = new Map();

  after(() => {
    originals.forEach((text, file) => writeFileSync(file, text, 'utf8'));
    build();
  });

  it('produces the same bytes from CRLF and LF checkouts', () => {
    build();
    const fromWorkingCopy = readFileSync(OUTPUT, 'utf8');

    sourceFiles().forEach((file) => {
      const text = readFileSync(file, 'utf8');
      originals.set(file, text);
      writeFileSync(file, text.replace(/\r\n/g, '\n'), 'utf8');
    });
    build();
    const fromLf = readFileSync(OUTPUT, 'utf8');

    assert.equal(fromWorkingCopy, fromLf, 'build output depends on source line endings');
  });

  it('emits a bundle with no stray carriage returns', () => {
    assert.equal(/\r/.test(readFileSync(OUTPUT, 'utf8')), false);
  });

  it('is deterministic across repeated runs', () => {
    build();
    const first = readFileSync(OUTPUT, 'utf8');
    build();
    assert.equal(first, readFileSync(OUTPUT, 'utf8'));
  });

  it('inlines everything — the page loads no local assets', () => {
    const html = readFileSync(OUTPUT, 'utf8');
    assert.equal(html.includes('<!--@styles-->'), false, 'style marker not replaced');
    assert.equal(html.includes('<!--@script-->'), false, 'script marker not replaced');

    // Look at the markup only: the inlined bundle is full of template literals
    // like href="${url}" that are not asset references.
    const markup = html
      .replace(/<script>[\s\S]*?<\/script>/g, '')
      .replace(/<style>[\s\S]*?<\/style>/g, '');
    const externals = markup.match(/(?:src|href)="(?!https:|data:|#)[^"]+"/g) || [];
    assert.deepEqual(externals, [], `unexpected local asset reference: ${externals.join(', ')}`);
  });

  it('rejects a module form the transform cannot handle', () => {
    const scratch = join(ROOT, 'src', 'js', 'lib', '__transform_probe.js');
    originals.set(scratch, '');
    writeFileSync(scratch, 'export default function nope() {}\n', 'utf8');
    assert.throws(() => build(), /Unsupported export form/);
    // Remove rather than restore: this file must not survive the test run.
    originals.delete(scratch);
    writeFileSync(scratch, '', 'utf8');
    execFileSync(process.execPath, ['-e', `require('fs').unlinkSync(${JSON.stringify(scratch)})`]);
  });
});
