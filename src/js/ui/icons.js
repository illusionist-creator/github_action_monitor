// Inline icons.
//
// Every icon is a <use> of a <symbol> in the sprite at the top of index.html,
// so a view can drop one in for a few bytes and it recolours with
// `currentColor`. The markup here is static and the name is checked against a
// fixed list, so this is one of the very few places `raw()` is justified.

import { raw } from '../lib/dom.js';

const NAMES = new Set([
  'dashboard', 'activity', 'folder', 'list', 'alert', 'terminal', 'chart',
  'search', 'refresh', 'sun', 'moon', 'menu', 'x', 'check', 'chevron-down',
  'chevron-right', 'external', 'lock', 'eye', 'eye-off', 'keyboard',
  'download', 'clock', 'info', 'zap', 'arrow-up', 'arrow-down', 'minus',
  'plug', 'power', 'github', 'play', 'inbox', 'filter', 'sparkles',
]);

/**
 * @param {string} name   one of the sprite symbols
 * @param {number} [size] rendered size in CSS pixels
 */
export function icon(name, size = 16) {
  const id = NAMES.has(name) ? name : 'info';
  const px = Number.isFinite(Number(size)) ? Number(size) : 16;
  return raw(`<svg class="ic" width="${px}" height="${px}" aria-hidden="true" focusable="false"><use href="#i-${id}"></use></svg>`);
}

/** Icon for a view tab, shared by the sidebar sprite and the command palette. */
export const TAB_ICONS = {
  overview: 'dashboard',
  live: 'play',
  repos: 'folder',
  runs: 'list',
  failures: 'alert',
  logs: 'terminal',
  timeline: 'chart',
};
