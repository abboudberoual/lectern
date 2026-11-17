// Small UI kit shared by the side panel and the library.
import { h } from './util.js';

const P = (d) => `<path d="${d}"/>`;
const ICON_PATHS = {
  plus: P('M8 3v10M3 8h10'),
  folder: P('M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z'),
  inbox: P('M2 9h3.5l1 1.5h3l1-1.5H14M3.5 3.5h9L14 9v3.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V9z'),
  stack: P('M2.5 3h11v3h-11zM2.5 8.5h11M2.5 12h11'),
  books: P('M3 2.5h3v11H3zM7 2.5h3v11H7zM11 3.2l2.4-.6 2 10.4-2.4.5z'),
  trash: P('M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5'),
  more: '<circle cx="3.5" cy="8" r="1.1" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none"/><circle cx="12.5" cy="8" r="1.1" fill="currentColor" stroke="none"/>',
  play: '<path d="M5 3.2v9.6L12.5 8z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M4.5 3h2.2v10H4.5zM9.3 3h2.2v10H9.3z" fill="currentColor" stroke="none"/>',
  back5: P('M3 8a5 5 0 1 0 1.5-3.6M3 2.5v2.5h2.5') + '<text x="8" y="10.4" font-size="5.4" text-anchor="middle" fill="currentColor" stroke="none" font-family="sans-serif" font-weight="700">5</text>',
  fwd5: P('M13 8a5 5 0 1 1-1.5-3.6M13 2.5V5h-2.5') + '<text x="8" y="10.4" font-size="5.4" text-anchor="middle" fill="currentColor" stroke="none" font-family="sans-serif" font-weight="700">5</text>',
  external: P('M9 3h4v4M13 3 7.5 8.5M11.5 9.5V13H3V4.5h3.5'),
  search: '<circle cx="7" cy="7" r="4.2"/>' + P('m10.2 10.2 3.3 3.3'),
  copy: P('M5.5 5.5h7v7.5h-7zM3 10.5V3h7'),
  download: P('M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10'),
  upload: P('M8 10.5v-8M4.5 6 8 2.5 11.5 6M3 13.5h10'),
  check: P('m3 8.5 3.2 3L13 4.5'),
  edit: P('M10.5 2.8 13.2 5.5 6 12.7l-3.3.6.6-3.3z'),
  lines: P('M2.5 4h2M6.5 4h7M2.5 8h2M6.5 8h7M2.5 12h2M6.5 12h5'),
  note: P('M3 2.5h7.5L13 5v8.5H3zM5.5 6.5h5M5.5 9h5M5.5 11.5h3'),
  close: P('M4 4l8 8M12 4l-8 8'),
  chevron: P('m6 4 4 4-4 4'),
  chevronDown: P('m4 6 4 4 4-4'),
  chevronUp: P('m4 10 4-4 4 4'),
  chevronLeft: P('m10 4-4 4 4 4'),
  grip: '<g fill="currentColor" stroke="none"><circle cx="6" cy="4" r="1"/><circle cx="10" cy="4" r="1"/><circle cx="6" cy="8" r="1"/><circle cx="10" cy="8" r="1"/><circle cx="6" cy="12" r="1"/><circle cx="10" cy="12" r="1"/></g>',
  flag: P('M3.5 14V2.5M3.5 3h8l-1.6 2.7 1.6 2.8h-8'),
  gear: '<circle cx="8" cy="8" r="2.2"/>' + P('M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1'),
  quote: P('M3 6.5h3.5V10C6.5 11.5 5.5 12.5 4 12.8M9.5 6.5H13V10c0 1.5-1 2.5-2.5 2.8'),
  move: P('M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5zM6 8.8h4.5M8.8 7 10.5 8.8 8.8 10.5'),
  refresh: P('M13 8a5 5 0 1 1-1.5-3.6M13 2.5V5h-2.5'),
  bookmark: P('M4 2.5h8v11L8 10.5l-4 3z'),
  sparkle: P('M8 1.8c.4 2.9 1.4 4 4.2 4.4-2.8.4-3.8 1.5-4.2 4.4-.4-2.9-1.4-4-4.2-4.4 2.8-.4 3.8-1.5 4.2-4.4ZM12.6 10.2c.2 1.3.7 1.8 1.9 2-1.2.2-1.7.7-1.9 2-.2-1.3-.7-1.8-1.9-2 1.2-.2 1.7-.7 1.9-2Z'),
  send: P('M8 13V3.5M3.8 7.6 8 3.4l4.2 4.2'),
  stop: '<rect x="4.5" y="4.5" width="7" height="7" rx="1.2" fill="currentColor" stroke="none"/>',
  film: P('M2.5 3.5h11v9h-11zM5 3.5v9M11 3.5v9M2.5 8h2.5M11 8h2.5'),
  target: '<circle cx="8" cy="8" r="5"/><circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none"/>',
};

export function icon(name, label) {
  const span = document.createElement('span');
  span.className = 'ic';
  span.style.display = 'inline-flex';
  span.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ${
    label ? `role="img" aria-label="${label}"` : 'aria-hidden="true"'
  }>${ICON_PATHS[name] || ''}</svg>`;
  return span;
}

// ---------- toast ----------

let toastEl = null;
let toastTimer = null;
export function showToast(message, { action, onAction, ms = 3200 } = {}) {
  if (!toastEl) {
    toastEl = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastEl);
  }
  toastEl.replaceChildren(message);
  if (action) {
    toastEl.append(
      h('button', {
        type: 'button',
        onclick: () => {
          hideToast();
          onAction && onAction();
        },
      }, action)
    );
  }
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? Math.max(ms, 5000) : ms);
}
function hideToast() {
  toastEl && toastEl.classList.remove('show');
}

// ---------- popover menu ----------

let openMenuEl = null;
export function closeMenu() {
  if (openMenuEl) {
    openMenuEl.remove();
    openMenuEl = null;
  }
}
/** items: [{label, icon, onClick, danger, checked}] | {heading} | 'sep' */
export function openMenu(anchor, items) {
  closeMenu();
  const menu = h(
    'div',
    { class: 'menu', role: 'menu' },
    items.map((it) =>
      it === 'sep'
        ? h('hr')
        : it.heading
        ? h('p', { class: 'menu-heading' }, it.heading)
        : h(
            'button',
            {
              type: 'button',
              role: 'checked' in it ? 'menuitemcheckbox' : 'menuitem',
              'aria-checked': 'checked' in it ? String(!!it.checked) : null,
              class: it.danger ? 'danger' : null,
              onclick: (e) => {
                e.stopPropagation();
                closeMenu();
                it.onClick && it.onClick();
              },
            },
            'checked' in it ? (it.checked ? icon('check') : h('span', { class: 'ic-space' })) : it.icon ? icon(it.icon) : null,
            it.label
          )
    )
  );
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = Math.min(r.right - mw, window.innerWidth - mw - 8);
  left = Math.max(8, left);
  let top = r.bottom + 4;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  openMenuEl = menu;
  menu.querySelector('button')?.focus();
  menu.addEventListener('keydown', (e) => {
    const btns = [...menu.querySelectorAll('button')];
    const i = btns.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      btns[(i + 1) % btns.length].focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      btns[(i - 1 + btns.length) % btns.length].focus();
    } else if (e.key === 'Escape') {
      closeMenu();
      anchor.focus();
    }
  });
  return menu;
}
document.addEventListener('pointerdown', (e) => {
  if (openMenuEl && !openMenuEl.contains(e.target)) closeMenu();
});
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);

// ---------- dialogs ----------

export function dialogShell(title, body, actions) {
  const dlg = h('dialog', { class: 'dlg' }, h('h2', null, title), body, h('div', { class: 'dlg-actions' }, actions));
  document.body.append(dlg);
  dlg.addEventListener('close', () => setTimeout(() => dlg.remove(), 0));
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close('cancel');
  });
  dlg.showModal();
  return dlg;
}

export function askText(title, { value = '', confirm = 'Save' } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { class: 'field', value, 'aria-label': title });
    const form = h('form', { method: 'dialog' }, input);
    const ok = h('button', { class: 'btn primary', type: 'submit', value: 'ok' }, confirm);
    const cancel = h('button', { class: 'btn', type: 'button', onclick: () => dlg.close('cancel') }, 'Cancel');
    const dlg = dialogShell(title, form, [cancel, ok]);
    ok.addEventListener('click', (e) => {
      e.preventDefault();
      dlg.close('ok');
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      dlg.close('ok');
    });
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' && input.value.trim() ? input.value.trim() : null));
    input.select();
  });
}

export function askConfirm(title, message, { confirm = 'Delete', danger = true } = {}) {
  return new Promise((resolve) => {
    const ok = h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, type: 'button', onclick: () => dlg.close('ok') }, confirm);
    const cancel = h('button', { class: 'btn', type: 'button', onclick: () => dlg.close('cancel') }, 'Cancel');
    const dlg = dialogShell(title, h('p', null, message), [cancel, ok]);
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'));
    cancel.focus();
  });
}

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
}

/** Autosize a textarea to its content. */
export function autosize(ta, min = 0) {
  const fit = () => {
    ta.style.height = 'auto';
    ta.style.height = `${Math.max(min, ta.scrollHeight)}px`;
  };
  ta.addEventListener('input', fit);
  requestAnimationFrame(fit);
  return fit;
}

// ---------- writing areas ----------
// Text areas carry no placeholder. Instead the field is a shade off the page
// and shows a blinking caret. Exactly one caret is visible: the real one in a
// focused field, or a drawn one in the field you last wrote in (or the
// primary field) while focus is elsewhere, e.g. on the video.

const writers = new Set();
let caretTarget = null;

function setCaretTarget(w) {
  caretTarget = w;
  for (const x of writers) x.classList.toggle('is-target', x === w);
}

function syncDocFocus() {
  document.documentElement.classList.toggle('doc-blur', !document.hasFocus());
}
window.addEventListener('focus', syncDocFocus);
window.addEventListener('blur', syncDocFocus);
document.addEventListener('visibilitychange', syncDocFocus);
setInterval(syncDocFocus, 1000);
syncDocFocus();

/**
 * Wrap a textarea as a writing area. Returns the wrapper element.
 * `primary` makes it the field that shows the caret until another is used.
 */
export function writeField(ta, { primary = false, className = '' } = {}) {
  ta.removeAttribute('placeholder');
  const w = h('div', { class: `write ${className}`.trim() });
  w.append(ta);
  const sync = () => w.classList.toggle('is-empty', !ta.value);
  ta.addEventListener('input', sync);
  ta.addEventListener('focus', () => setCaretTarget(w));
  w._sync = sync;
  w.addEventListener('click', (e) => {
    if (e.target === w) ta.focus();
  });
  writers.add(w);
  sync();
  if (primary) w.dataset.primary = '1';
  if (primary || !caretTarget || !caretTarget.isConnected) setCaretTarget(w);
  return w;
}

/** Call after setting a wrapped textarea's value from code. */
export function syncWriteField(ta) {
  const w = ta.closest('.write');
  if (w && w._sync) w._sync();
}

/** Forget a writing area that has been removed from the page. */
export function dropWriteField(w) {
  writers.delete(w);
  if (caretTarget === w) {
    const next = [...writers].find((x) => x.isConnected && x.dataset.primary);
    setCaretTarget(next || [...writers].find((x) => x.isConnected) || null);
  }
}
