// Colour scheme.
//
// The scheme follows the operating system until the reader toggles it, and
// the toggle lasts for the tab. It is deliberately not persisted: this page
// promises that nothing survives the tab — CI fails the build if any browser
// storage API appears in the source — and a remembered theme is not worth
// weakening that promise for.

const listeners = new Set();
let chosen = null;

function system() {
  if (typeof matchMedia !== 'function') return 'dark';
  try {
    return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function apply(theme) {
  const root = document.documentElement;
  if (root.getAttribute('data-theme') === theme) return;
  root.setAttribute('data-theme', theme);
  listeners.forEach((fn) => {
    try {
      fn(theme);
    } catch (err) {
      console.error('[theme] listener failed', err);
    }
  });
}

export function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

export function initTheme() {
  // index.html resolves the scheme before first paint; this only makes sure
  // the attribute exists when that bootstrap did not run (tests, old browsers).
  if (!document.documentElement.hasAttribute('data-theme')) apply(system());

  if (typeof matchMedia === 'function') {
    try {
      const query = matchMedia('(prefers-color-scheme: light)');
      const follow = () => {
        if (chosen === null) apply(query.matches ? 'light' : 'dark');
      };
      if (typeof query.addEventListener === 'function') query.addEventListener('change', follow);
    } catch {
      /* no media query support */
    }
  }
}

export function setTheme(theme) {
  chosen = theme === 'light' ? 'light' : 'dark';
  apply(chosen);
}

export function toggleTheme() {
  setTheme(currentTheme() === 'light' ? 'dark' : 'light');
  return currentTheme();
}

/** Called with the new scheme after it has been applied. */
export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
