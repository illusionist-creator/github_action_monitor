#!/usr/bin/env node
// Zero-dependency bundler: src/ -> index.html
//
// The dashboard's defining property is that it is ONE file you can open from
// disk, host on GitHub Pages, or email to a colleague — no server, no install.
// The source is split into ES modules so it can be read, reviewed and unit
// tested; this script inlines them back into that single artifact.
//
//   node build.mjs           write index.html
//   node build.mjs --check   fail if index.html is stale (used by CI)
//
// The module transform is intentionally narrow. It supports exactly the import
// and export forms used in src/js, and throws on anything else rather than
// silently emitting broken output.

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, 'src');
const JS_ROOT = join(SRC, 'js');
const ENTRY = join(JS_ROOT, 'app.js');
const TEMPLATE = join(SRC, 'index.html');
const OUTPUT = join(ROOT, 'index.html');

/**
 * Read a source file with line endings normalised.
 *
 * Without this, a Windows checkout (git's autocrlf gives CRLF) and CI's Linux
 * checkout (LF) produce byte-different bundles and different build stamps, so
 * `--check` fails on one platform or the other no matter which is correct.
 * Normalising here makes index.html reproducible everywhere.
 */
async function read(path) {
  return (await readFile(path, 'utf8')).replace(/\r\n/g, '\n');
}

const IMPORT_RE = /^import\s*\{([^}]+)\}\s*from\s*'([^']+)';?\s*$/;
const BARE_IMPORT_RE = /^import\s+'([^']+)';?\s*$/;
const EXPORT_DECL_RE = /^export\s+(async\s+function|function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/;
const EXPORT_LIST_RE = /^export\s*\{([^}]+)\};?\s*$/;

function moduleId(absPath) {
  return relative(JS_ROOT, absPath).split('\\').join('/').replace(/\.js$/, '');
}

/**
 * Fold a multi-line `import { a, b } from './x.js'` onto one line, and pad the
 * gap with blanks so reported line numbers still match the source file.
 */
function collapseImports(source) {
  return source.replace(
    /^import\s*\{([\s\S]*?)\}\s*from\s*'([^']+)';?/gm,
    (match, names, target) => {
      const flat = names.split(',').map((n) => n.trim()).filter(Boolean).join(', ');
      const consumed = match.split('\n').length - 1;
      return `import { ${flat} } from '${target}';${'\n'.repeat(consumed)}`;
    },
  );
}

/** Rewrite one ES module into a registry factory body. */
function transform(source, absPath) {
  const id = moduleId(absPath);
  const dir = dirname(absPath);
  const exported = new Set();
  const lines = collapseImports(source).split('\n');
  const out = [];

  lines.forEach((line, i) => {
    const where = `${id}.js:${i + 1}`;

    const named = line.match(IMPORT_RE);
    if (named) {
      const target = moduleId(resolve(dir, named[2]));
      const bindings = named[1]
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const asMatch = part.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
          return asMatch ? `${asMatch[1]}: ${asMatch[2]}` : part;
        })
        .join(', ');
      out.push(`const { ${bindings} } = __req(${JSON.stringify(target)});`);
      return;
    }

    if (BARE_IMPORT_RE.test(line)) {
      const target = moduleId(resolve(dir, line.match(BARE_IMPORT_RE)[1]));
      out.push(`__req(${JSON.stringify(target)});`);
      return;
    }

    const list = line.match(EXPORT_LIST_RE);
    if (list) {
      list[1].split(',').forEach((part) => {
        const name = part.trim().split(/\s+as\s+/).pop().trim();
        if (name) exported.add(name);
      });
      out.push('');
      return;
    }

    const decl = line.match(EXPORT_DECL_RE);
    if (decl) {
      exported.add(decl[2]);
      out.push(line.replace(/^export\s+/, ''));
      return;
    }

    if (/^export\s/.test(line)) {
      throw new Error(`Unsupported export form at ${where}: ${line.trim()}`);
    }
    if (/^import\s/.test(line)) {
      throw new Error(`Unsupported import form at ${where}: ${line.trim()}`);
    }

    out.push(line);
  });

  // Exports are defined as getters at the top of the factory so they behave
  // like ESM live bindings and a cycle between two modules still resolves.
  const names = [...exported];
  const bindings = names.length
    ? `Object.defineProperties(__exports, {\n${names
        .map((n) => `  ${JSON.stringify(n)}: { get: function () { return ${n}; }, enumerable: true }`)
        .join(',\n')}\n});\n`
    : '';

  return `__def(${JSON.stringify(id)}, function (__exports, __req) {\n${bindings}${out.join('\n')}\n});`;
}

async function collectJs(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collectJs(full)));
    else if (entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

const RUNTIME = `
/* Module registry — emitted by build.mjs. Each src/js module becomes one
   factory; __req resolves lazily so import order does not matter. */
var __defs = Object.create(null);
var __cache = Object.create(null);
function __def(id, factory) { __defs[id] = factory; }
function __req(id) {
  if (__cache[id]) return __cache[id];
  var factory = __defs[id];
  if (!factory) throw new Error('Unknown module: ' + id);
  var exports = {};
  __cache[id] = exports;
  factory(exports, __req);
  return exports;
}
`;

async function buildJs() {
  const files = (await collectJs(JS_ROOT)).sort();
  const modules = [];
  for (const file of files) {
    modules.push(transform(await read(file), file));
  }
  return [
    "'use strict';",
    '(function () {',
    RUNTIME,
    modules.join('\n\n'),
    `__req(${JSON.stringify(moduleId(ENTRY))});`,
    '})();',
  ].join('\n');
}

async function buildCss() {
  const dir = join(SRC, 'styles');
  const order = ['tokens.css', 'base.css', 'layout.css', 'components.css', 'views.css'];
  const present = (await readdir(dir)).filter((f) => f.endsWith('.css'));
  const missing = present.filter((f) => !order.includes(f));
  if (missing.length) throw new Error(`Add ${missing.join(', ')} to the CSS order in build.mjs`);
  const chunks = [];
  for (const name of order) {
    chunks.push(`/* ---- ${name} ---- */\n${await read(join(dir, name))}`);
  }
  return chunks.join('\n');
}

async function build() {
  const template = await read(TEMPLATE);
  const css = await buildCss();
  const js = await buildJs();

  if (!template.includes('<!--@styles-->') || !template.includes('<!--@script-->')) {
    throw new Error('src/index.html is missing the <!--@styles--> or <!--@script--> marker');
  }

  return template
    .replace('<!--@styles-->', () => `<style>\n${css}\n</style>`)
    .replace('<!--@script-->', () => `<script>\n${js}\n</script>`)
    .replace(/<!--@buildstamp-->/g, () => `<!-- generated by build.mjs from src/ — do not edit; bundle ${sha(css + js)} -->`);
}

function sha(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

const argv = process.argv.slice(2);
const check = argv.includes('--check');
// `--site <dir>` also stages a deploy directory. Vercel and GitHub Pages both
// insist on serving from a directory rather than a repo root, and serving the
// root would publish src/, tests/ and package.json alongside the page.
const siteFlag = argv.indexOf('--site');
const siteDir = siteFlag === -1 ? null : (argv[siteFlag + 1] || 'public');

const output = await build();

if (check) {
  let current = '';
  try {
    current = await read(OUTPUT);
  } catch {
    /* not built yet */
  }
  if (current !== output) {
    console.error('index.html is out of date. Run `node build.mjs` and commit the result.');
    process.exit(1);
  }
  console.log('index.html is up to date.');
} else {
  await writeFile(OUTPUT, output, 'utf8');
  const kb = (Buffer.byteLength(output) / 1024).toFixed(0);
  console.log(`Wrote index.html (${kb} KB)`);

  if (siteDir) {
    const dir = join(ROOT, siteDir);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'index.html'), output, 'utf8');
    // Same page for any path, so a stale deep link still lands on the dashboard.
    await writeFile(join(dir, '404.html'), output, 'utf8');
    console.log(`Staged ${siteDir}/index.html and ${siteDir}/404.html`);
  }
}
