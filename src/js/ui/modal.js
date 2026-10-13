// Dialog behaviour: focus containment, focus restoration, Escape, inert backdrop.
//
// The legacy modal set a class and hid the panel with CSS only. Tab moved focus
// through the dashboard behind it, screen readers still announced the page
// underneath, and closing it dropped focus to <body> — so a keyboard user
// restarted from the top of the document every time they looked at a log.

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

let openDialog = null;
let lastFocused = null;

function focusable(root) {
  return Array.from(root.querySelectorAll(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

function onKeydown(event) {
  if (!openDialog) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeModal();
    return;
  }
  if (event.key !== 'Tab') return;

  const items = focusable(openDialog);
  if (!items.length) {
    event.preventDefault();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function openModal(id, { initialFocus } = {}) {
  const dialog = document.getElementById(id);
  if (!dialog) return;
  lastFocused = document.activeElement;
  dialog.hidden = false;
  dialog.classList.add('open');
  document.body.style.overflow = 'hidden';
  openDialog = dialog;
  document.addEventListener('keydown', onKeydown, true);

  const target = (initialFocus && dialog.querySelector(initialFocus)) || focusable(dialog)[0];
  if (target) target.focus();
}

export function closeModal() {
  if (!openDialog) return;
  openDialog.classList.remove('open');
  openDialog.hidden = true;
  document.body.style.overflow = '';
  document.removeEventListener('keydown', onKeydown, true);
  openDialog = null;
  if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
  lastFocused = null;
}

export function isModalOpen() {
  return openDialog !== null;
}

/** The id of the dialog currently open, or null. */
export function activeModalId() {
  return openDialog ? openDialog.id : null;
}
