import {
  addNote,
  addPage,
  createFolder,
  deleteNote,
  deletePage,
  deleteTranscript,
  deleteVideo,
  folderPath,
  getAllVideos,
  getFolders,
  getPositions,
  getSettings,
  getTranscript,
  getVideo,
  nextOrder,
  onStorageChange,
  pagesOf,
  saveTranscript,
  setSettings,
  tKey,
  updateNote,
  updatePage,
  updateVideo,
  vKey,
} from '../shared/db.js';
import {
  copyText,
  debounce,
  downloadText,
  fetchVideoMeta,
  formatTime,
  h,
  indexAtTime,
  issueUrl,
  parsePastedTranscript,
  plural,
  relativeTime,
  safeFilename,
  thumbUrl,
  videoToMarkdown,
  watchUrl,
} from '../shared/util.js';
import { applyTheme, askConfirm, askText, autosize, icon, openMenu, showToast, syncWriteField, writeField } from '../shared/ui.js';
import { createNoteList } from '../shared/notelist.js';
import { createAsk } from './ask.js';

const params = new URLSearchParams(location.search);
const PINNED_TAB = params.get('tab') ? Number(params.get('tab')) : null; // used by tests

/** Thumbnails that fail to load fall back to the plain tile behind them. */
function hideBroken(e) {
  e.target.style.visibility = 'hidden';
}

function readPref(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function writePref(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

// ---------------------------------------------------------------- state

const S = {
  windowId: null,
  tabId: PINNED_TAB,
  page: null, // last getState() from the YouTube tab
  videoId: undefined, // undefined = nothing rendered yet; null = no video in the tab
  video: null, // saved record or null
  transcript: null,
  folders: {},
  settings: null,
  view: 'notes',
  pausedByUs: false,
  capture: { busy: false, error: '', vssId: '' },
  tracks: null,
  trQuery: '',
  pasteMode: false,
  lastUserScroll: 0,
  timedOpen: readPref('lectern.timedOpen', true),
  split: readPref('lectern.split', 0.5), // share of the notes tab given to the notepad
  activePage: readPref('lectern.activePage', {}), // videoId -> notepad page id
};

// ---------------------------------------------------------------- skeleton

const app = document.getElementById('app');

// empty view (no video in the tab)
const emptyView = h('section', { class: 'empty-view' });

// header: title, library, menu, folder
const vTitle = h('h1', { class: 'v-title' });
const libBtn = h('button', { class: 'icon-btn', type: 'button', title: 'Open library', 'aria-label': 'Open library' }, icon('books'));
const vMenuBtn = h('button', { class: 'icon-btn', type: 'button', title: 'More', 'aria-label': 'More actions for this video' }, icon('more'));
const askBtn = h('button', { class: 'icon-btn ask-btn', type: 'button', title: 'Ask about this video', 'aria-label': 'Ask about this video', 'aria-pressed': 'false' }, icon('sparkle'));
const folderSel = h('select', { class: 'folder-sel', 'aria-label': 'Folder' });
const folderPick = h('label', { class: 'folder-pick' }, icon('folder'), folderSel, icon('chevronDown'));
const adNote = h('p', { class: 'ad-note', role: 'status', hidden: true }, 'An ad is playing. Notes wait for the video.');
const vHead = h('header', { class: 'v-head' }, h('div', { class: 'v-title-row' }, vTitle, askBtn, libBtn, vMenuBtn), folderPick, adNote);

const tabNotes = h('button', { role: 'tab', type: 'button', class: 'tab', 'aria-selected': 'true', 'aria-controls': 'notesPane', id: 'tabNotes' }, 'Notes');
const tabTr = h('button', { role: 'tab', type: 'button', class: 'tab', 'aria-selected': 'false', 'aria-controls': 'trPane', id: 'tabTranscript' }, 'Transcript');
const tabs = h('nav', { class: 'tabs', role: 'tablist' }, tabNotes, tabTr);

// --- top half: time notes (collapsible) and the note box
const noteList = createNoteList({
  onTime: (t) => seek(t),
  onSave: (id, text) => updateNote(S.videoId, id, { text }),
  menuFor: (n, { edit }) => [
    { label: 'Edit note', icon: 'edit', onClick: edit },
    { label: 'Ask about this moment', icon: 'sparkle', onClick: () => ask.askAbout(n.t, (n.text || '').trim()) },
    {
      label: 'Set to current video time',
      icon: 'refresh',
      onClick: async () => {
        await updateNote(S.videoId, n.id, { t: nowT() });
        S.video = await getVideo(S.videoId);
        renderNotes();
      },
    },
    {
      label: 'Copy link to this moment',
      icon: 'copy',
      onClick: async () => {
        await copyText(watchUrl(S.videoId, n.t));
        showToast('Link copied');
      },
    },
    'sep',
    { label: 'Delete note', icon: 'trash', danger: true, onClick: () => removeNote(n.id) },
  ],
});
const notesScroll = h('div', { class: 'pane-scroll timed-scroll' }, noteList.el);
const timedCount = h('span', { class: 'timed-count' });
const timedToggle = h(
  'button',
  { class: 'timed-toggle', type: 'button', 'aria-expanded': 'true', 'aria-controls': 'timedList' },
  icon('chevronDown'),
  h('span', { class: 'timed-label' }, 'Time notes'),
  timedCount
);
notesScroll.id = 'timedList';

const cText = h('textarea', {
  class: 'c-text',
  rows: 1,
  'aria-label': 'New note at the current video time',
  title: 'Write a note and press Enter: it’s stamped with the video’s current time. Shift+Enter starts a new line.',
});
const composer = h('div', { class: 'composer' }, writeField(cText, { primary: true, className: 'c-write' }));
const timed = h('section', { class: 'timed', 'aria-label': 'Time notes' }, timedToggle, notesScroll, composer);

// --- bottom half: the notepad, with pages
const npText = h('textarea', { class: 'np-text', 'aria-label': 'Notepad', title: 'Ideas, questions, anything not tied to a moment' });
const npAdd = h('button', { class: 'icon-btn np-add', type: 'button', title: 'Add a page', 'aria-label': 'Add a page' }, icon('plus'));
const npHeading = h('h2', null, 'Notepad');
const pageBar = h('nav', { class: 'page-bar', 'aria-label': 'Notepad pages', hidden: true });
const notepad = h(
  'section',
  { class: 'notepad', 'aria-label': 'Notepad' },
  h('div', { class: 'np-head' }, npHeading, pageBar, npAdd),
  writeField(npText, { className: 'np-write' })
);

// --- the divider between them: drag it, or focus it and use the arrow keys
const splitter = h('div', {
  class: 'splitter',
  role: 'separator',
  tabindex: 0,
  'aria-orientation': 'horizontal',
  'aria-label': 'Resize the notepad and time notes',
  'aria-valuemin': 0,
  'aria-valuemax': 100,
  title: 'Drag to resize. Double-click to split evenly.',
});

const notesPane = h('section', { class: 'pane', id: 'notesPane', role: 'tabpanel', 'aria-labelledby': 'tabNotes' }, notepad, splitter, timed);

// --- transcript pane
const trSearch = h('input', { class: 'field', type: 'search', placeholder: 'Search transcript', 'aria-label': 'Search transcript' });
const trMenuBtn = h('button', { class: 'icon-btn', type: 'button', title: 'Transcript options', 'aria-label': 'Transcript options' }, icon('more'));
const trBar = h('div', { class: 'tr-bar' }, h('label', { class: 'search' }, icon('search'), trSearch), trMenuBtn);
const trStatus = h('div', { class: 'tr-status' });
const segList = h('ol', { class: 'segs', 'aria-label': 'Transcript' });
const trScroll = h('div', { class: 'pane-scroll' }, trStatus, segList);
const trPane = h('section', { class: 'pane', id: 'trPane', role: 'tabpanel', 'aria-labelledby': 'tabTranscript', hidden: true }, trBar, trScroll);

// --- ask pane (opened from the sparkle in the top bar)
const ask = createAsk({
  videoId: () => S.videoId,
  video: () => S.video,
  transcript: () => S.transcript,
  meta: () => ({ title: (S.page && S.page.title) || '', channel: (S.page && S.page.channel) || '', duration: (S.page && S.page.duration) || 0 }),
  now: () => (S.page && Number.isFinite(S.page.currentTime) ? S.page.currentTime : 0),
  duration: () => (S.page && S.page.duration) || (S.video && S.video.duration) || 0,
  seek: (t) => seek(t),
  ensureTranscript: async () => {
    if (!S.transcript) await capture({ auto: true });
    return S.transcript;
  },
  saveToNotepad: (text) => appendToNotepad(text),
  onOpenChange: (open) => {
    askBtn.setAttribute('aria-pressed', String(open));
    tabs.hidden = open;
    notesPane.hidden = open || S.view !== 'notes';
    trPane.hidden = open || S.view !== 'transcript';
    if (!open && S.view === 'notes') cText.focus();
  },
  onProviderChange: (ai) => {
    const label = ai ? `Ask ${ai.name} about this video` : 'Ask about this video';
    askBtn.title = label;
    askBtn.setAttribute('aria-label', label);
  },
});
askBtn.addEventListener('click', () => ask.toggle());

const videoView = h('div', { class: 'video-view', hidden: true }, vHead, tabs, notesPane, trPane, ask.el);
app.append(emptyView, videoView);

// ---------------------------------------------------------------- tab plumbing

async function sendToTab(msg) {
  if (S.tabId == null) return null;
  try {
    return await chrome.tabs.sendMessage(S.tabId, msg);
  } catch {
    return null;
  }
}

const injected = new Set();
async function readPage() {
  if (S.tabId == null) return null;
  let st = await sendToTab({ type: 'getState' });
  if (!st && !injected.has(S.tabId)) {
    injected.add(S.tabId);
    try {
      const tab = await chrome.tabs.get(S.tabId);
      if (tab.url && /^https:\/\/www\.youtube\.com\//.test(tab.url)) {
        await chrome.scripting.insertCSS({ target: { tabId: S.tabId }, files: ['src/content.css'] });
        await chrome.scripting.executeScript({ target: { tabId: S.tabId }, files: ['src/content.js'] });
        st = await sendToTab({ type: 'getState' });
      }
    } catch {}
  }
  return st;
}

let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const st = await readPage();
    S.page = st;
    const vid = st && st.videoId ? st.videoId : null;
    if (vid !== S.videoId) await loadVideo(vid);
    else if (vid) tick();
  } finally {
    polling = false;
  }
}

async function retarget() {
  if (PINNED_TAB != null) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId: S.windowId });
  S.tabId = tab ? tab.id : null;
  await poll();
}

// ---------------------------------------------------------------- loading

async function loadVideo(videoId) {
  flushPendingEdits();
  noteList.reset();
  S.videoId = videoId;
  S.tracks = null;
  S.capture = { busy: false, error: '', vssId: '' };
  S.pasteMode = false;
  S.trQuery = '';
  trSearch.value = '';
  cText.value = '';
  if (!videoId) {
    S.video = null;
    S.transcript = null;
    await renderEmpty();
    emptyView.hidden = false;
    videoView.hidden = true;
    return;
  }
  const [video, transcript] = await Promise.all([getVideo(videoId), getTranscript(videoId)]);
  if (S.videoId !== videoId) return;
  S.video = video;
  S.transcript = transcript;
  emptyView.hidden = true;
  videoView.hidden = false;
  renderHead();
  renderNotes();
  renderNotepad(true);
  renderTranscript();
  ask.videoChanged();
  tick();
  if (S.view === 'transcript') loadTracks();
  if (S.view === 'notes' && !ask.isOpen()) cText.focus();
}

// ---------------------------------------------------------------- empty view

async function renderEmpty() {
  const videos = (await getAllVideos()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 8);
  const positions = await getPositions(videos.map((v) => v.videoId));
  emptyView.replaceChildren(
    h('h1', null, 'Open a YouTube video to take notes'),
    videos.length
      ? h(
          'section',
          { class: 'recent' },
          h('h2', null, 'Recent'),
          h(
            'ul',
            null,
            videos.map((v) => {
              const pos = positions[v.videoId];
              const resumeAt = pos && pos.t > 5 && (!pos.d || pos.t < pos.d - 10) ? pos.t : 0;
              return h(
                'li',
                null,
                h(
                  'button',
                  { type: 'button', class: 'recent-item', onclick: () => openVideoHere(v.videoId, resumeAt) },
                  h('span', { class: 'recent-thumb' }, h('img', { src: thumbUrl(v.videoId), alt: '', loading: 'lazy', onerror: hideBroken })),
                  h(
                    'span',
                    { class: 'recent-text' },
                    h('span', { class: 'recent-title' }, v.title || v.videoId),
                    h(
                      'span',
                      { class: 'recent-meta' },
                      [(v.notes || []).length ? plural(v.notes.length, 'note') : '', relativeTime(v.updatedAt)].filter(Boolean).join(' · ')
                    )
                  )
                )
              );
            })
          )
        )
      : '',
    h('button', { type: 'button', class: 'linkish open-lib', onclick: () => openLibrary() }, 'Open library')
  );
}

async function openVideoHere(videoId, t) {
  const url = watchUrl(videoId, t);
  if (S.page && S.page.ok && S.tabId != null) await chrome.tabs.update(S.tabId, { url });
  else await chrome.tabs.create({ url, windowId: S.windowId ?? undefined });
}

// ---------------------------------------------------------------- header

function folderOptions(selected) {
  const out = [h('option', { value: '' }, S.video ? 'Unfiled' : 'Add to a folder')];
  const byParent = {};
  for (const f of Object.values(S.folders)) (byParent[f.parentId || ''] ||= []).push(f);
  const walk = (pid, depth) => {
    for (const f of (byParent[pid] || []).sort((a, b) => (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name))) {
      out.push(h('option', { value: f.id }, `${' '.repeat(depth)}${f.name}`));
      walk(f.id, depth + 1);
    }
  };
  walk('', 0);
  out.push(h('option', { value: '__new' }, 'New folder…'));
  folderSel.replaceChildren(...out);
  folderSel.value = selected || '';
  sizeFolderSelect();
}

// Size the select to its label so the chevron sits right after the text.
const measureCtx = document.createElement('canvas').getContext('2d');
function sizeFolderSelect() {
  const label = folderSel.selectedOptions[0] ? folderSel.selectedOptions[0].textContent.trim() : '';
  const cs = getComputedStyle(folderSel);
  measureCtx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  folderSel.style.width = `${Math.min(260, Math.ceil(measureCtx.measureText(label).width) + 4)}px`;
}
document.fonts.ready.then(sizeFolderSelect);

function renderHead() {
  const v = S.video;
  const p = S.page || {};
  vTitle.textContent = (v && v.title) || p.title || 'Untitled video';
  vTitle.title = [vTitle.textContent, (v && v.channel) || p.channel].filter(Boolean).join(' · ');
  folderOptions(v ? v.folderId : '');
  folderPick.title = v && v.folderId ? folderPath(S.folders, v.folderId).join(' / ') : v ? 'Unfiled' : 'Saving to a folder adds this video to your library';
  folderPick.classList.toggle('unsaved', !v);
  const n = v ? (v.notes || []).length : 0;
  timedCount.textContent = n ? String(n) : '';
}

async function bestMeta() {
  const p = S.page || {};
  let meta = { title: p.title || '', channel: p.channel || '', duration: p.duration || 0 };
  if (!meta.title || !meta.channel) {
    const m = await fetchVideoMeta(S.videoId);
    if (m) meta = { ...meta, title: m.title || meta.title, channel: m.channel || meta.channel };
  }
  return meta;
}

/** Make sure the current video is in the library. */
async function ensureSaved(patch) {
  const id = S.videoId;
  if (S.video) {
    if (patch) S.video = await updateVideo(id, (v) => Object.assign(v, patch));
    return S.video;
  }
  const meta = await bestMeta();
  const folderId = patch && 'folderId' in patch ? patch.folderId : null;
  S.video = await updateVideo(id, (v) => Object.assign(v, patch || {}), {
    create: true,
    meta: { ...meta, folderId, order: await nextOrder(folderId) },
  });
  renderHead();
  if (S.settings.autoTranscript && !S.transcript) capture({ auto: true });
  return S.video;
}

folderSel.addEventListener('change', async () => {
  let val = folderSel.value;
  if (val === '__new') {
    const name = await askText('New folder', { confirm: 'Create folder' });
    if (!name) {
      folderOptions(S.video ? S.video.folderId : '');
      return;
    }
    const f = await createFolder(name);
    S.folders[f.id] = f;
    val = f.id;
  }
  const folderId = val || null;
  if (S.video && (S.video.folderId || null) === folderId) return;
  const wasSaved = !!S.video;
  const order = await nextOrder(folderId);
  await ensureSaved({ folderId, order });
  renderHead();
  const name = folderId ? S.folders[folderId]?.name || 'folder' : 'Unfiled';
  showToast(wasSaved ? `Moved to ${name}` : `Saved to ${name}`);
});

vMenuBtn.addEventListener('click', () => {
  const v = S.video;
  const items = [];
  if (v) items.push({ label: 'Show in library', icon: 'books', onClick: () => openLibrary(`video=${S.videoId}`) });
  items.push(
    { label: 'Copy notes as Markdown', icon: 'copy', onClick: copyMarkdown },
    { label: 'Download notes (.md)', icon: 'download', onClick: downloadMarkdown }
  );
  if (v) {
    items.push({ label: v.done ? 'Mark as not finished' : 'Mark as finished', icon: 'check', onClick: toggleDone });
    items.push('sep', { label: 'Remove from library', icon: 'trash', danger: true, onClick: removeVideo });
  }
  items.push('sep', {
    label: 'Report a problem',
    icon: 'flag',
    onClick: () => chrome.tabs.create({ url: issueUrl('bug.yml', { fields: { video: S.videoId ? watchUrl(S.videoId) : '' } }) }),
  });
  openMenu(vMenuBtn, items);
});

async function copyMarkdown() {
  flushPendingEdits();
  const md = videoToMarkdown(S.video || { videoId: S.videoId, title: vTitle.textContent, notes: [] }, S.transcript);
  (await copyText(md)) ? showToast('Notes copied as Markdown') : showToast('Couldn’t copy. Try the download instead.');
}

function downloadMarkdown() {
  flushPendingEdits();
  const v = S.video || { videoId: S.videoId, title: vTitle.textContent, notes: [] };
  downloadText(`${safeFilename(v.title || v.videoId)}.md`, videoToMarkdown(v, S.transcript, { includeTranscript: true }), 'text/markdown');
}

async function toggleDone() {
  const done = !S.video.done;
  await ensureSaved({ done });
  showToast(done ? 'Marked as finished' : 'Marked as not finished');
}

async function removeVideo() {
  const ok = await askConfirm('Remove this video?', 'Its notes, notepad and transcript will be deleted from your library.', { confirm: 'Remove' });
  if (!ok) return;
  await deleteVideo(S.videoId);
  S.video = null;
  S.transcript = null;
  renderHead();
  renderNotes();
  renderNotepad(true);
  renderTranscript();
  showToast('Removed from your library');
}

function openLibrary(query) {
  chrome.runtime.sendMessage({ type: 'openLibrary', query: query || '', windowId: S.windowId }).catch(() => {});
}
libBtn.addEventListener('click', () => openLibrary());

// ---------------------------------------------------------------- tabs

function setView(view) {
  S.view = view;
  if (ask.isOpen()) ask.close();
  const notes = view === 'notes';
  tabNotes.setAttribute('aria-selected', String(notes));
  tabTr.setAttribute('aria-selected', String(!notes));
  notesPane.hidden = !notes;
  trPane.hidden = notes;
  if (!notes) {
    loadTracks();
    S.lastSeg = -2;
    tick();
  }
}
tabNotes.addEventListener('click', () => setView('notes'));
tabTr.addEventListener('click', () => setView('transcript'));
tabs.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    const next = S.view === 'notes' ? 'transcript' : 'notes';
    setView(next);
    (next === 'notes' ? tabNotes : tabTr).focus();
  }
});

// ---------------------------------------------------------------- time notes

function setTimedOpen(open) {
  S.timedOpen = open;
  writePref('lectern.timedOpen', open);
  timed.classList.toggle('collapsed', !open);
  timedToggle.setAttribute('aria-expanded', String(open));
  timedToggle.querySelector('.ic').replaceWith(icon(open ? 'chevronDown' : 'chevron'));
  notesScroll.hidden = !open;
  applySplit();
}
timedToggle.addEventListener('click', () => setTimedOpen(!S.timedOpen));

// ---------------------------------------------------------------- notepad / time notes split

const NOTEPAD_MIN = 96;
const timedMin = () => timedToggle.offsetHeight + composer.offsetHeight + 24;

/** The split ratio limits, from the pane's current height. */
function splitBounds() {
  const avail = notesPane.clientHeight;
  if (!avail) return [0.15, 0.85];
  return [Math.min(0.5, NOTEPAD_MIN / avail), Math.max(0.5, 1 - timedMin() / avail)];
}

function applySplit() {
  if (!S.timedOpen) {
    // time notes folded: the notepad takes the rest, nothing to resize
    notepad.style.flex = '';
    timed.style.flex = '';
    splitter.hidden = true;
    return;
  }
  splitter.hidden = false;
  const [lo, hi] = splitBounds();
  const r = Math.min(hi, Math.max(lo, S.split));
  notepad.style.flex = `${r} 1 0px`;
  timed.style.flex = `${1 - r} 1 0px`;
  splitter.setAttribute('aria-valuenow', String(Math.round(r * 100)));
  splitter.setAttribute('aria-valuetext', `Notepad ${Math.round(r * 100)}%, time notes ${100 - Math.round(r * 100)}%`);
}

function setSplit(r, { save = true } = {}) {
  const [lo, hi] = splitBounds();
  S.split = Math.min(hi, Math.max(lo, r));
  applySplit();
  if (save) writePref('lectern.split', S.split);
}

splitter.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  splitter.setPointerCapture(e.pointerId);
  splitter.classList.add('dragging');
  document.body.classList.add('resizing');
  const box = notesPane.getBoundingClientRect();
  const grab = e.clientY - splitter.getBoundingClientRect().top - splitter.offsetHeight / 2;
  const move = (ev) => setSplit((ev.clientY - grab - box.top) / box.height, { save: false });
  const end = () => {
    splitter.releasePointerCapture(e.pointerId);
    splitter.classList.remove('dragging');
    document.body.classList.remove('resizing');
    splitter.removeEventListener('pointermove', move);
    splitter.removeEventListener('pointerup', end);
    splitter.removeEventListener('pointercancel', end);
    writePref('lectern.split', S.split);
  };
  splitter.addEventListener('pointermove', move);
  splitter.addEventListener('pointerup', end);
  splitter.addEventListener('pointercancel', end);
});
splitter.addEventListener('dblclick', () => setSplit(0.5));
splitter.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 0.15 : 0.05;
  const [lo, hi] = splitBounds();
  const map = { ArrowUp: S.split - step, ArrowDown: S.split + step, Home: lo, End: hi, Enter: 0.5 };
  if (!(e.key in map)) return;
  e.preventDefault();
  setSplit(map[e.key]);
});
new ResizeObserver(() => applySplit()).observe(notesPane);

/** The video time a note made right now should carry. */
function nowT() {
  const t = S.page && Number.isFinite(S.page.currentTime) ? S.page.currentTime : 0;
  return Math.max(0, t - (S.settings.leadSeconds || 0));
}

autosize(cText, 40);
cText.addEventListener('input', () => {
  if (cText.value.trim() && S.settings.pauseWhileTyping && S.page && !S.page.paused && !S.pausedByUs) {
    S.pausedByUs = true;
    sendToTab({ type: 'playback', action: 'pause' });
  }
});
cText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submitNote();
  }
});

async function submitNote() {
  const text = cText.value.trim();
  if (!S.videoId || !text) return;
  if (S.page && S.page.ad) {
    showToast('Wait for the ad to finish, then press Enter.');
    return;
  }
  const t = nowT(); // stamped when the note is saved
  cText.value = '';
  cText.dispatchEvent(new Event('input'));
  const wasNew = !S.video;
  const meta = wasNew ? await bestMeta() : undefined;
  const note = await addNote(S.videoId, { t, text }, meta);
  S.video = await getVideo(S.videoId);
  renderHead();
  renderNotes();
  if (S.timedOpen) noteList.flash(note.id);
  else showToast(`Saved at ${formatTime(t)}`);
  if (S.pausedByUs) {
    S.pausedByUs = false;
    sendToTab({ type: 'playback', action: 'play' });
  }
  if (wasNew && S.settings.autoTranscript && !S.transcript) capture({ auto: true });
  cText.focus();
}

// Alt+J / Alt+K / Alt+L control the video while you type, like YouTube's J/K/L.
document.addEventListener('keydown', (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey || !S.videoId) return;
  const map = { KeyJ: ['rewind', 5], KeyK: ['toggle'], KeyL: ['forward', 5] };
  const a = map[e.code];
  if (!a) return;
  e.preventDefault();
  sendToTab({ type: 'playback', action: a[0], amount: a[1] }).then(poll);
});

function seek(t) {
  sendToTab({ type: 'seek', t, play: true }).then((r) => {
    if ((!r || !r.ok) && S.page && S.page.ad) showToast('Can’t jump while an ad is playing.');
    poll();
  });
}

async function removeNote(noteId) {
  const before = (S.video.notes || []).find((n) => n.id === noteId);
  await deleteNote(S.videoId, noteId);
  S.video = await getVideo(S.videoId);
  renderHead();
  renderNotes();
  showToast('Note deleted', {
    action: 'Undo',
    onAction: async () => {
      await updateVideo(S.videoId, (v) => {
        v.notes = [...(v.notes || []), before].sort((a, b) => a.t - b.t);
      });
      S.video = await getVideo(S.videoId);
      renderHead();
      renderNotes();
    },
  });
}

function renderNotes() {
  const notes = S.video ? [...(S.video.notes || [])].sort((a, b) => a.t - b.t) : [];
  noteList.render(notes);
  timed.classList.toggle('no-notes', !notes.length);
  S.lastNote = -2;
  tick();
}

// ---------------------------------------------------------------- notepad (free-form, with pages)

const npSavers = new Map();
function npSaver(videoId, pageId) {
  const key = `${videoId}/${pageId}`;
  if (!npSavers.has(key)) {
    npSavers.set(
      key,
      debounce(async (text) => {
        if (videoId === S.videoId && !S.video) {
          if (!text.trim()) return;
          await ensureSaved();
        }
        await updatePage(videoId, pageId, { text });
      }, 500)
    );
  }
  return npSavers.get(key);
}

function flushPendingEdits() {
  noteList.flush();
  for (const s of npSavers.values()) s.flush();
}

function currentPages() {
  return pagesOf(S.video);
}
function activePageId() {
  const pages = currentPages();
  const want = S.activePage[S.videoId];
  return pages.some((p) => p.id === want) ? want : pages[0].id;
}
function setActivePage(id) {
  flushPendingEdits();
  S.activePage = { ...S.activePage, [S.videoId]: id };
  writePref('lectern.activePage', S.activePage);
  renderNotepad(true);
}

/** Add text to the end of the current notepad page (used by Ask's "Save to notepad"). */
async function appendToNotepad(text) {
  flushPendingEdits();
  await ensureSaved();
  const page = currentPages().find((p) => p.id === activePageId());
  const cur = (page.text || '').replace(/\s+$/, '');
  S.video = await updatePage(S.videoId, page.id, { text: cur ? `${cur}\n\n${text}` : text });
  renderNotepad(true);
}

npText.addEventListener('input', () => npSaver(S.videoId, activePageId())(npText.value));
npText.addEventListener('blur', () => flushPendingEdits());

function renderNotepad(force) {
  const pages = currentPages();
  const activeId = activePageId();
  const page = pages.find((p) => p.id === activeId);
  if (force || (document.activeElement !== npText && npText.value !== (page.text || ''))) {
    npText.value = page.text || '';
    syncWriteField(npText);
  }
  npText.setAttribute('aria-label', pages.length > 1 ? `Notepad, ${page.title}` : 'Notepad');
  npAdd.hidden = pages.length > 1;
  npHeading.hidden = pages.length > 1;
  pageBar.hidden = pages.length < 2;
  if (pages.length < 2) {
    pageBar.replaceChildren();
    return;
  }
  pageBar.replaceChildren(
    ...pages.map((p) => {
      const active = p.id === activeId;
      const tab = h(
        'button',
        {
          type: 'button',
          class: `page-tab${active ? ' active' : ''}`,
          'aria-current': active ? 'page' : null,
          title: active ? 'Page options' : `Open ${p.title}`,
        },
        h('span', { class: 'page-name' }, p.title),
        active ? icon('chevronDown') : null
      );
      tab.addEventListener('click', () => (active ? pageMenu(tab, p) : setActivePage(p.id)));
      tab.addEventListener('dblclick', () => renamePage(p));
      return tab;
    }),
    h('button', { type: 'button', class: 'icon-btn page-add', title: 'Add a page', 'aria-label': 'Add a page', onclick: newPage }, icon('plus'))
  );
}

function pageMenu(anchor, p) {
  openMenu(anchor, [
    { label: 'Rename page', icon: 'edit', onClick: () => renamePage(p) },
    { label: 'Add a page', icon: 'plus', onClick: newPage },
    'sep',
    { label: `Delete “${p.title}”`, icon: 'trash', danger: true, onClick: () => removePage(p) },
  ]);
}

async function newPage() {
  flushPendingEdits();
  await ensureSaved();
  const page = await addPage(S.videoId);
  S.video = await getVideo(S.videoId);
  setActivePage(page.id);
  npText.focus();
}
npAdd.addEventListener('click', newPage);

async function renamePage(p) {
  const title = await askText('Rename page', { value: p.title, confirm: 'Rename' });
  if (!title || title === p.title) return;
  S.video = await updatePage(S.videoId, p.id, { title: title.slice(0, 40) });
  renderNotepad();
}

async function removePage(p) {
  flushPendingEdits();
  const cur = currentPages().find((x) => x.id === p.id);
  if (cur && (cur.text || '').trim()) {
    const ok = await askConfirm(`Delete “${p.title}”?`, 'The text on this page will be deleted.', { confirm: 'Delete page' });
    if (!ok) return;
  }
  const idx = currentPages().findIndex((x) => x.id === p.id);
  S.video = await deletePage(S.videoId, p.id);
  const left = currentPages();
  setActivePage(left[Math.max(0, idx - 1)].id);
}

// ---------------------------------------------------------------- transcript

async function loadTracks() {
  if (S.tracks || !S.videoId || S.tabId == null) return;
  const res = await chrome.runtime.sendMessage({ type: 'listTracks', tabId: S.tabId, videoId: S.videoId });
  S.tracks = (res && res.tracks) || [];
  if (!S.transcript && !S.capture.busy && !S.pasteMode) renderTranscript();
}

function currentTrack() {
  return (S.transcript && S.transcript.vssId) || S.capture.vssId || '';
}

async function capture({ vssId = '', auto = false } = {}) {
  if (!S.videoId || S.capture.busy) return;
  if (S.tabId == null) return;
  const id = S.videoId;
  S.capture = { busy: true, error: '', vssId };
  renderTranscript();
  const res = await chrome.runtime.sendMessage({ type: 'captureTranscript', tabId: S.tabId, videoId: id, vssId, auto });
  if (S.videoId !== id) return;
  S.capture = {
    busy: false,
    error: res && res.ok ? '' : (res && res.error) || 'Capture failed.',
    vssId,
    noCaptions: res && res.noCaptions,
    log: (res && res.log) || [],
  };
  if (res && res.tracks) S.tracks = res.tracks;
  if (res && res.ok) {
    S.transcript = await getTranscript(id);
    S.video = await getVideo(id);
    renderHead();
    if (!auto) showToast(`Transcript saved (${plural(res.count, 'line')})`);
  }
  renderTranscript();
}

// YouTube changes its page often; this hands the maintainer what capture tried, without sending anything itself.
function reportCaptureLink() {
  const c = S.capture;
  const details = [c.error, ...(c.log || []).map((l) => `- ${l}`), `tracks found: ${(S.tracks || []).length}`].join('\n');
  const href = issueUrl('transcript.yml', {
    title: `Transcript capture failed: ${S.videoId}`,
    fields: { video: watchUrl(S.videoId), details },
  });
  return h(
    'p',
    { class: 'tr-report' },
    c.noCaptions ? 'Captions showing on YouTube? ' : 'Still failing? ',
    h('a', { href, target: '_blank', rel: 'noopener' }, 'Report this video'),
    ' so it can be fixed.'
  );
}

function trackPicker() {
  const sel = h(
    'select',
    { class: 'field tr-track', 'aria-label': 'Caption language' },
    (S.tracks || []).map((t) => h('option', { value: t.vssId }, t.name || t.lang))
  );
  if (currentTrack()) sel.value = currentTrack();
  sel.addEventListener('change', () => capture({ vssId: sel.value }));
  return h('label', { class: 'track-pick' }, 'Captions', sel);
}

function renderTranscript() {
  const tr = S.transcript;
  trBar.hidden = !tr;
  trStatus.replaceChildren();
  segList.replaceChildren();
  S.lastSeg = -2;

  if (S.capture.busy) {
    trStatus.append(h('p', { class: 'tr-busy' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Getting the transcript from YouTube…'));
    return;
  }
  if (S.pasteMode) {
    const ta = h('textarea', { class: 'field paste', rows: 10, 'aria-label': 'Paste transcript' });
    trStatus.append(
      h('p', null, 'Paste a transcript with timestamps, from YouTube’s “Show transcript” panel or a subtitle file.'),
      ta,
      h(
        'div',
        { class: 'row-actions' },
        h(
          'button',
          {
            class: 'btn primary',
            type: 'button',
            onclick: async () => {
              let segs = parsePastedTranscript(ta.value);
              let untimed = false;
              if (!segs.length) {
                const paras = ta.value.split(/\n\s*\n|\n/).map((s) => s.trim()).filter(Boolean);
                if (!paras.length) return ta.focus();
                segs = paras.map((text) => ({ t: 0, d: 0, text }));
                untimed = true;
              }
              const meta = S.video ? undefined : await bestMeta();
              await saveTranscript(S.videoId, { lang: '', label: 'Pasted', source: 'pasted', untimed, segments: segs }, meta);
              S.pasteMode = false;
              S.transcript = await getTranscript(S.videoId);
              S.video = await getVideo(S.videoId);
              renderHead();
              renderTranscript();
              showToast(`Transcript saved (${plural(segs.length, 'line')})`);
            },
          },
          'Save transcript'
        ),
        h('button', { class: 'btn quiet', type: 'button', onclick: () => ((S.pasteMode = false), renderTranscript()) }, 'Cancel')
      )
    );
    setTimeout(() => ta.focus(), 0);
    return;
  }
  if (!tr) {
    const err = S.capture.error;
    const showTracks = S.tracks && S.tracks.length > 1 && !S.capture.noCaptions;
    // Element.append writes null as the text "null", so drop the parts that don't apply
    const parts = [
      h('h2', null, err ? (S.capture.noCaptions ? 'No transcript available' : 'Couldn’t get the transcript') : 'No transcript yet'),
      err ? h('p', null, err) : null,
      h(
        'div',
        { class: 'row-actions' },
        S.capture.noCaptions
          ? null
          : h('button', { class: 'btn primary', type: 'button', onclick: () => capture({ vssId: currentTrack() }) }, err ? 'Try again' : 'Get transcript'),
        h('button', { class: 'btn quiet', type: 'button', onclick: () => ((S.pasteMode = true), renderTranscript()) }, 'Paste one')
      ),
      showTracks ? trackPicker() : null,
      err ? reportCaptureLink() : null,
    ];
    trStatus.append(...parts.filter(Boolean));
    return;
  }

  const q = S.trQuery.trim().toLowerCase();
  const frag = document.createDocumentFragment();
  let shown = 0;
  tr.segments.forEach((s, i) => {
    if (q && !s.text.toLowerCase().includes(q)) return;
    shown++;
    const textSpan = h('span', { class: 'hl-text' });
    if (q) {
      const lower = s.text.toLowerCase();
      let pos = 0;
      let idx;
      while ((idx = lower.indexOf(q, pos)) !== -1) {
        textSpan.append(s.text.slice(pos, idx), h('mark', null, s.text.slice(idx, idx + q.length)));
        pos = idx + q.length;
      }
      textSpan.append(s.text.slice(pos));
    } else textSpan.textContent = s.text;
    frag.append(
      h(
        'li',
        { class: 'seg', dataset: { i } },
        tr.untimed ? null : h('button', { class: 'time', type: 'button', tabindex: -1, 'aria-label': `Jump to ${formatTime(s.t)}` }, formatTime(s.t)),
        h('p', { class: 'seg-text' }, textSpan),
        h(
          'span',
          { class: 'seg-tools' },
          h('button', { class: 'icon-btn seg-ask', type: 'button', title: 'Ask about this line', 'aria-label': 'Ask about this line' }, icon('sparkle')),
          h('button', { class: 'icon-btn seg-add', type: 'button', title: 'Add this line to your time notes', 'aria-label': 'Add this line to your time notes' }, icon('plus'))
        )
      )
    );
  });
  segList.classList.toggle('untimed', !!tr.untimed);
  segList.append(frag);
  if (q) trStatus.append(h('p', { class: 'hint' }, shown ? `${plural(shown, 'line')} match.` : `No lines mention “${S.trQuery.trim()}”.`));
  tick();
}

segList.addEventListener('click', async (e) => {
  const li = e.target.closest('.seg');
  if (!li) return;
  const seg = S.transcript.segments[+li.dataset.i];
  if (e.target.closest('.seg-ask')) {
    ask.askAbout(seg.t, seg.text);
    return;
  }
  if (e.target.closest('.seg-add')) {
    const meta = S.video ? undefined : await bestMeta();
    const note = await addNote(S.videoId, { t: seg.t, text: seg.text }, meta);
    S.video = await getVideo(S.videoId);
    renderHead();
    renderNotes();
    showToast(`Added to time notes (${formatTime(seg.t)})`, {
      action: 'Edit',
      onAction: () => {
        setView('notes');
        setTimedOpen(true);
        noteList.edit(note.id);
      },
    });
    return;
  }
  if (String(window.getSelection() || '').trim()) return; // selecting text, not seeking
  if (!S.transcript.untimed) seek(seg.t);
});

trSearch.addEventListener(
  'input',
  debounce(() => {
    S.trQuery = trSearch.value;
    renderTranscript();
  }, 150)
);
trScroll.addEventListener('wheel', () => (S.lastUserScroll = Date.now()), { passive: true });
trScroll.addEventListener('touchmove', () => (S.lastUserScroll = Date.now()), { passive: true });

trMenuBtn.addEventListener('click', async () => {
  if (!S.tracks) await loadTracks();
  const items = [
    {
      label: 'Follow the video',
      checked: !!S.settings.followTranscript,
      onClick: async () => {
        S.settings = await setSettings({ followTranscript: !S.settings.followTranscript });
        S.lastSeg = -2;
        tick();
      },
    },
  ];
  if (S.tracks && S.tracks.length > 1) {
    items.push('sep', { heading: 'Captions' });
    for (const t of S.tracks) {
      items.push({ label: t.name || t.lang, checked: t.vssId === currentTrack(), onClick: () => t.vssId !== currentTrack() && capture({ vssId: t.vssId }) });
    }
  }
  items.push(
    'sep',
    {
      label: 'Copy transcript',
      icon: 'copy',
      onClick: async () => {
        const txt = S.transcript.segments.map((s) => (S.transcript.untimed ? s.text : `[${formatTime(s.t)}] ${s.text}`)).join('\n');
        (await copyText(txt)) && showToast('Transcript copied');
      },
    },
    { label: 'Get it again from YouTube', icon: 'refresh', onClick: () => capture({ vssId: currentTrack() }) },
    { label: 'Replace with pasted text', icon: 'edit', onClick: () => ((S.pasteMode = true), renderTranscript()) },
    'sep',
    {
      label: 'Delete transcript',
      icon: 'trash',
      danger: true,
      onClick: async () => {
        await deleteTranscript(S.videoId);
        S.transcript = null;
        S.video = await getVideo(S.videoId);
        renderTranscript();
      },
    }
  );
  openMenu(trMenuBtn, items);
});

// ---------------------------------------------------------------- per-tick updates

S.lastNote = -2;
S.lastSeg = -2;
function tick() {
  if (!S.videoId) return;
  adNote.hidden = !(S.page && S.page.ad);
  ask.tick();
  const t = S.page && S.page.currentTime != null ? S.page.currentTime : null;
  if (t == null) return;

  // current time note
  const notes = S.video ? [...(S.video.notes || [])].sort((a, b) => a.t - b.t) : [];
  const ni = indexAtTime(notes, t);
  if (ni !== S.lastNote) {
    S.lastNote = ni;
    noteList.setCurrent(ni);
  }

  // current transcript line
  if (S.transcript && !S.transcript.untimed && !trPane.hidden) {
    const si = indexAtTime(S.transcript.segments, t);
    if (si !== S.lastSeg) {
      S.lastSeg = si;
      segList.querySelector('.seg.is-current')?.classList.remove('is-current');
      segList.querySelector('.time.is-now')?.classList.remove('is-now');
      const li = segList.querySelector(`.seg[data-i="${si}"]`);
      if (li) {
        li.classList.add('is-current');
        li.querySelector('.time')?.classList.add('is-now');
        if (S.settings.followTranscript && Date.now() - S.lastUserScroll > 4000 && !S.trQuery) {
          const box = trScroll.getBoundingClientRect();
          const r = li.getBoundingClientRect();
          if (r.top < box.top + 40 || r.bottom > box.bottom - 40) {
            const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
            trScroll.scrollTo({ top: trScroll.scrollTop + (r.top - box.top) - box.height / 3, behavior: reduce ? 'auto' : 'smooth' });
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------- storage sync

onStorageChange(async (changes) => {
  if (changes.folders) {
    S.folders = changes.folders.newValue || {};
    if (S.videoId) renderHead();
  }
  if (changes.settings) {
    S.settings = await getSettings();
    applyTheme(S.settings.theme);
  }
  if (!S.videoId) {
    if (Object.keys(changes).some((k) => k.startsWith('v:'))) renderEmpty();
    return;
  }
  if (changes[vKey(S.videoId)]) {
    S.video = changes[vKey(S.videoId)].newValue || null;
    renderHead();
    renderNotes();
    renderNotepad();
  }
  if (changes[tKey(S.videoId)]) {
    S.transcript = changes[tKey(S.videoId)].newValue || null;
    if (!S.capture.busy && !S.pasteMode) renderTranscript();
  }
});

// messages from the content script / service worker
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg) return;
  if (msg.type === 'videoChanged' && sender.tab && sender.tab.id === S.tabId) poll();
  if (msg.type === 'noteAdded' && msg.videoId === S.videoId) {
    // marked with Alt+Shift+M: open it for a label once it has rendered
    setView('notes');
    setTimedOpen(true);
    setTimeout(() => noteList.edit(msg.noteId), 150);
  }
  if (msg.type === 'compose') handleCompose(msg);
});

/** The note button in the YouTube player: open the panel ready to write. */
async function handleCompose(p) {
  if (!p || Date.now() - p.at > 15000) return;
  if (S.tabId != null && p.tabId !== S.tabId) return;
  chrome.storage.session.remove('pendingCompose').catch(() => {});
  if (S.videoId !== p.videoId) await poll();
  setView('notes');
  if (S.settings.pauseWhileTyping && S.page && !S.page.paused) {
    S.pausedByUs = true;
    sendToTab({ type: 'playback', action: 'pause' });
  }
  cText.focus();
}

// ---------------------------------------------------------------- boot

async function boot() {
  S.settings = await getSettings();
  applyTheme(S.settings.theme);
  S.folders = await getFolders();
  setTimedOpen(S.timedOpen);
  const win = await chrome.windows.getCurrent();
  S.windowId = win.id;
  if (PINNED_TAB == null) {
    chrome.tabs.onActivated.addListener((info) => {
      if (info.windowId === S.windowId) retarget();
    });
    chrome.tabs.onUpdated.addListener((tabId, info) => {
      if (tabId === S.tabId && (info.url || info.status === 'complete')) poll();
    });
    await retarget();
  } else await poll();

  const { pendingCompose } = await chrome.storage.session.get('pendingCompose').catch(() => ({}));
  if (pendingCompose) handleCompose(pendingCompose);

  setInterval(() => {
    if (document.visibilityState === 'visible') poll();
  }, 500);
}
boot();
