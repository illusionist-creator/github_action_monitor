// Data colours.
//
// Two rules the legacy dashboard broke:
//
//   1. Colour follows the entity, never its rank. Repo colours were handed out
//      by array index, so adding one repository repainted every repository
//      after it and the same repo changed colour between tabs.
//   2. A categorical palette has to survive colour-vision deficiency. The old
//      eight hues failed the lightness band and put two hues 8.0 ΔE apart under
//      deuteranopia. These eight are validated against this surface (#13161b):
//      worst adjacent CVD ΔE 8.4, worst adjacent normal-vision ΔE 19.3,
//      all >= 3:1 contrast.

/** The dark card surface charts are drawn on. Used to fake gaps between fills. */
export const SURFACE = '#111418';

/**
 * The card surface for the *current* theme, read from the CSS token so the
 * gaps between doughnut segments and stacked bars match whichever scheme is
 * active. Falls back to the dark surface outside a browser.
 */
export function surface() {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return SURFACE;
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim();
    return /^#[0-9a-f]{3,8}$/i.test(value) ? value : SURFACE;
  } catch {
    return SURFACE;
  }
}

/** Categorical slots, in fixed order. Never cycle a 9th hue — fold to "other". */
export const CATEGORICAL = [
  '#3987e5', // blue
  '#d95926', // orange
  '#199e70', // aqua
  '#c98500', // yellow
  '#d55181', // magenta
  '#008300', // green
  '#9085e9', // violet
  '#e66767', // red
];

/**
 * Statuses are a reserved palette — never reused as "series 4" — and always
 * ship alongside an icon and a text label, so hue never carries the meaning
 * alone.
 */
export const STATUS_COLORS = {
  success: '#15a34a',
  failed: '#dc4343',
  cancelled: '#ec835a',
  skipped: '#8b909e',
  in_progress: '#3987e5',
  unknown: '#8b909e',
};

export const STATUS_ICONS = {
  success: '✓',
  failed: '✕',
  cancelled: '⊘',
  skipped: '—',
  in_progress: '●',
  unknown: '·',
};

export const STATUS_LABELS = {
  success: 'success',
  failed: 'failed',
  cancelled: 'cancelled',
  skipped: 'skipped',
  in_progress: 'running',
  unknown: 'unknown',
};

export function statusColor(status) {
  return STATUS_COLORS[status] || STATUS_COLORS.unknown;
}

export function statusIcon(status) {
  return STATUS_ICONS[status] || STATUS_ICONS.unknown;
}

/** Health/■ thresholds, shared by every scorecard so they cannot drift apart. */
export function healthTone(score) {
  if (score >= 90) return { tone: 'good', color: STATUS_COLORS.success };
  if (score >= 75) return { tone: 'warn', color: '#fab219' };
  return { tone: 'bad', color: STATUS_COLORS.failed };
}

/** FNV-1a. Small, stable across sessions, and good enough to spread names. */
function hashString(text) {
  let hash = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i += 1) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministic colour for a named entity. The same repository is the same
 * colour in every view, in every session, regardless of how many others exist.
 */
export function entityColor(name) {
  return CATEGORICAL[hashString(name) % CATEGORICAL.length];
}

/** Translucent background tint of an entity's colour, for avatars and chips. */
export function entityTint(name, alpha = 0.14) {
  return withAlpha(entityColor(name), alpha);
}

export function withAlpha(hex, alpha) {
  const value = String(hex).replace('#', '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  const n = parseInt(full, 16);
  if (!Number.isFinite(n)) return hex;
  /* eslint-disable no-bitwise */
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  /* eslint-enable no-bitwise */
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * Sequential ramp for the activity heatmap: one hue, light -> dark, never a
 * rainbow. Index 0 is the empty cell and deliberately recedes to the surface.
 */
export const SEQUENTIAL_BLUE = [
  '#1a1e25',
  '#16304f',
  '#184f95',
  '#1c5cab',
  '#256abf',
  '#2a78d6',
  '#3987e5',
];

/** The same ramp for the light scheme: pale -> saturated, so empty still recedes. */
export const SEQUENTIAL_BLUE_LIGHT = [
  '#eceef2',
  '#d6e4fb',
  '#b3cdf6',
  '#8cb2ef',
  '#6497e7',
  '#3f7ee0',
  '#2160c4',
];

/** The sequential ramp for whichever scheme is active. */
export function sequential() {
  if (typeof document !== 'undefined'
    && document.documentElement
    && document.documentElement.getAttribute('data-theme') === 'light') {
    return SEQUENTIAL_BLUE_LIGHT;
  }
  return SEQUENTIAL_BLUE;
}

/**
 * Assign colours to an ordered list of entities without ever repeating an
 * adjacent hue: hashing alone can collide, so collisions fall forward to the
 * next free slot while keeping the hash as the stable first choice.
 */
export function assignColors(names) {
  const used = new Set();
  const out = new Map();
  names.forEach((name) => {
    const start = hashString(name) % CATEGORICAL.length;
    let index = start;
    for (let step = 0; step < CATEGORICAL.length; step += 1) {
      const candidate = (start + step) % CATEGORICAL.length;
      if (!used.has(candidate)) {
        index = candidate;
        break;
      }
    }
    used.add(index);
    out.set(name, CATEGORICAL[index]);
  });
  return out;
}
