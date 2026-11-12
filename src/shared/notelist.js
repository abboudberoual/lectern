// Time notes list shared by the side panel and the library's video page.
// Each note reads as plain text with its time in small grey brackets at the end;
// clicking the text edits it in place, clicking the time jumps the video there.
import { debounce, formatTime, h } from './util.js';
import { autosize, icon, openMenu } from './ui.js';

/**
 * @param {object} o
 * @param {(t:number)=>void} o.onTime     jump to a time
 * @param {(id:string, text:string)=>any} o.onSave   persist edited text
 * @param {(note:object, api:{edit:Function})=>Array} o.menuFor  items for the note's ⋯ menu
 */
export function createNoteList({ onTime, onSave, menuFor, label = 'Time notes' }) {
  const el = h('ol', { class: 'notes', 'aria-label': label });
  const savers = new Map();
  const saverFor = (id) => {
    if (!savers.has(id)) savers.set(id, debounce((text) => onSave(id, text), 400));
    return savers.get(id);
  };

  function fill(li) {
    const n = li._n;
    const text = (n.text || '').trim();
    li._txt.textContent = text ? n.text : 'Marked moment';
    li._txt.classList.toggle('empty', !text);
    li._txt.setAttribute('aria-label', text ? `Edit note: ${text.slice(0, 60)}` : 'Add text to this marked moment');
    li._ts.textContent = `(${formatTime(n.t)})`;
    li._ts.setAttribute('aria-label', `Jump to ${formatTime(n.t)}`);
  }

  function row(n) {
    const txt = h('span', { class: 'note-txt', role: 'button', tabindex: 0 });
    const ts = h('button', { class: 'ts', type: 'button', title: 'Jump to this moment' });
    const view = h('p', { class: 'note-view' }, txt, ' ', ts);
    const more = h('button', { class: 'icon-btn note-more', type: 'button', title: 'Note options', 'aria-label': 'Note options' }, icon('more'));
    const li = h('li', { class: 'note', dataset: { id: n.id } }, view, more);
    Object.assign(li, { _n: n, _txt: txt, _ts: ts, _view: view, _editing: false });

    function edit() {
      if (li._editing) return;
      li._editing = true;
      const ta = h('textarea', { class: 'note-edit', rows: 1, 'aria-label': `Note at ${formatTime(li._n.t)}` });
      ta.value = li._n.text || '';
      view.replaceWith(ta);
      autosize(ta);
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      const save = saverFor(li._n.id);
      ta.addEventListener('input', () => save(ta.value));
      ta.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' && !e.shiftKey && !e.isComposing) || e.key === 'Escape') {
          e.preventDefault();
          ta.blur();
        }
      });
      ta.addEventListener(
        'blur',
        () => {
          save.flush();
          li._editing = false;
          li._n = { ...li._n, text: ta.value };
          fill(li);
          ta.replaceWith(view);
        },
        { once: true }
      );
    }
    li._edit = edit;

    ts.addEventListener('click', () => onTime(li._n.t));
    txt.addEventListener('click', () => {
      if (!String(window.getSelection() || '').trim()) edit();
    });
    txt.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        edit();
      }
    });
    more.addEventListener('click', () => openMenu(more, menuFor(li._n, { edit })));
    fill(li);
    return li;
  }

  /** Keyed render: rows are reused, so a note being edited keeps its caret. */
  function render(notes) {
    const existing = new Map([...el.children].map((li) => [li.dataset.id, li]));
    const rows = notes.map((n) => {
      let li = existing.get(n.id);
      if (!li) li = row(n);
      existing.delete(n.id);
      if (!li._editing) {
        li._n = n;
        fill(li);
      } else li._n = { ...n, text: li._n.text };
      return li;
    });
    for (const li of existing.values()) li.remove();
    rows.forEach((li, i) => {
      if (el.children[i] !== li) el.insertBefore(li, el.children[i] || null);
    });
  }

  function setCurrent(index) {
    [...el.children].forEach((li, i) => {
      li.classList.toggle('is-current', i === index);
      li._ts.classList.toggle('is-now', i === index);
    });
  }

  function edit(noteId) {
    const li = el.querySelector(`[data-id="${noteId}"]`);
    if (li) {
      li.scrollIntoView({ block: 'nearest' });
      li._edit();
    }
  }

  function flash(noteId) {
    const li = el.querySelector(`[data-id="${noteId}"]`);
    if (!li) return;
    li.scrollIntoView({ block: 'nearest' });
    li.classList.add('just-added');
    setTimeout(() => li.classList.remove('just-added'), 1200);
  }

  function flush() {
    for (const s of savers.values()) s.flush();
  }

  function reset() {
    flush();
    savers.clear();
    el.replaceChildren();
  }

  return { el, render, setCurrent, edit, flash, flush, reset };
}
