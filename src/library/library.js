import {
  DEFAULT_SETTINGS,
  addNote,
  addPage,
  deletePage,
  getVideo as getVideoFresh,
  pagesOf,
  updatePage,
  createFolder,
  deleteFolder,
  deleteNote,
  deleteTranscript,
  deleteVideo,
  exportAll,
  folderPath,
  folderSubtree,
  getAllTranscripts,
  getAllVideos,
  getFolders,
  getPositions,
  getSettings,
  getTranscript,
  importAll,
  newVideoRecord,
  onStorageChange,
  saveTranscript,
  setSettings,
  updateFolder,
  updateNote,
  updateVideo,
  vKey,
  WRITER,
} from '../shared/db.js';
import {
  copyText,
  debounce,
  downloadText,
  fetchVideoMeta,
  formatTime,
  h,
  issueUrl,
  parsePastedTranscript,
  parseTime,
  parseVideoId,
  plural,
  REPO_URL,
  thumbUrl,
  videoToMarkdown,
  watchUrl,
} from '../shared/util.js';
import { applyTheme, askConfirm, askText, autosize, icon, openMenu, showToast, syncWriteField, writeField } from '../shared/ui.js';
import { createAISetup } from '../shared/aisetup.js';
import { exportFlow } from '../shared/exporter.js';
import { folderSyncStatus, resumeFolderSync, startFolderSync } from '../shared/foldersync.js';
import { createSyncSection } from './syncsettings.js';
import { createNoteList } from '../shared/notelist.js';

const L = {
  folders: {},
  videos: [],
  byId: new Map(),
  positions: {},
  settings: { ...DEFAULT_SETTINGS },
  transcripts: null, // lazy, for search
  windowId: null,
};

const main = document.getElementById('main');
const nav = document.getElementById('nav');
const tree = document.getElementById('tree');
const searchInput = document.getElementById('search');

document.getElementById('newFolder').append(icon('plus'));
document.getElementById('settingsBtn').append(icon('gear'), 'Settings');
searchInput.parentElement.prepend(icon('search'));
searchInput.parentElement.classList.add('search');

/** Thumbnails that fail to load fall back to the plain tile behind them. */
function hideBroken(e) {
  e.target.style.visibility = 'hidden';
}

// ---------------------------------------------------------------- routing

function currentRoute() {
  const p = new URLSearchParams(location.search);
  if (p.get('video')) return { view: 'video', id: p.get('video'), q: p.get('tq') || '' };
  if (p.get('q')) return { view: 'search', q: p.get('q') };
  return { view: 'folder', folder: p.get('folder') || 'all', welcome: p.has('welcome') };
}

function go(params, { replace = false } = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${location.pathname}${qs ? `?${qs}` : ''}`;
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  render();
  main.scrollTop = 0;
  window.scrollTo(0, 0);
}
window.addEventListener('popstate', render);

// ---------------------------------------------------------------- data

async function loadAll() {
  const [folders, videos, positions, settings] = await Promise.all([getFolders(), getAllVideos(), getPositions(), getSettings()]);
  L.folders = folders;
  L.videos = videos;
  L.byId = new Map(videos.map((v) => [v.videoId, v]));
  L.positions = positions;
  L.settings = settings;
  applyTheme(settings.theme);
}

const childrenOf = (pid) =>
  Object.values(L.folders)
    .filter((f) => (f.parentId || null) === pid)
    .sort((a, b) => (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name));

function videosIn(folderKey) {
  let list;
  if (folderKey === 'all') list = [...L.videos].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  else if (folderKey === 'unfiled') list = L.videos.filter((v) => !v.folderId || !L.folders[v.folderId]);
  else list = L.videos.filter((v) => v.folderId === folderKey);
  if (folderKey !== 'all') list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.addedAt || 0) - (b.addedAt || 0));
  return list;
}

function countDeep(folderId) {
  const ids = new Set(folderSubtree(L.folders, folderId));
  return L.videos.filter((v) => ids.has(v.folderId)).length;
}

function progressOf(v) {
  const p = L.positions[v.videoId];
  const d = v.duration || (p && p.d) || 0;
  if (v.done) return { pct: 1, t: p ? p.t : 0, d };
  if (!p || !d) return { pct: 0, t: p ? p.t : 0, d };
  return { pct: Math.min(1, p.t / d), t: p.t, d };
}

function resumeTime(v) {
  const { t, d } = progressOf(v);
  if (!t || t < 5) return 0;
  if (d && t > d - 10) return 0;
  return t;
}

// ---------------------------------------------------------------- open videos

async function openVideo(videoId, t) {
  // sidePanel.open needs the click's user gesture, so it runs before any await.
  if (L.settings.openPanelFromLibrary && L.windowId != null) chrome.sidePanel.open({ windowId: L.windowId }).catch(() => {});
  const tabs = await chrome.tabs.query({ url: ['https://www.youtube.com/watch*', 'https://www.youtube.com/shorts/*'] });
  const existing = tabs.find((tab) => parseVideoId(tab.url) === videoId);
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
    if (t != null) chrome.tabs.sendMessage(existing.id, { type: 'seek', t, play: true }).catch(() => {});
  } else {
    await chrome.tabs.create({ url: watchUrl(videoId, t), windowId: L.windowId ?? undefined });
  }
}

// ---------------------------------------------------------------- sidebar

function navItem(label, key, count) {
  const r = currentRoute();
  const active = r.view === 'folder' && r.folder === key;
  const btn = h(
    'button',
    { type: 'button', class: `nav-item${active ? ' active' : ''}`, 'aria-current': active ? 'page' : null, onclick: () => go({ folder: key }) },
    h('span', { class: 'nav-label' }, label),
    h('span', { class: 'nav-count' }, count ? String(count) : '')
  );
  if (key === 'unfiled') makeDropTarget(btn, null);
  return btn;
}

function renderSidebar() {
  nav.replaceChildren(navItem('All videos', 'all', L.videos.length), navItem('Unfiled', 'unfiled', videosIn('unfiled').length));
  const r = currentRoute();
  // subfolders are always shown, indented under their parent
  const build = (pid, depth) =>
    childrenOf(pid).map((f) => {
      const kids = childrenOf(f.id);
      const active = r.view === 'folder' && r.folder === f.id;
      const more = h('button', { type: 'button', class: 'icon-btn row-more', 'aria-label': `Actions for ${f.name}`, title: 'Folder options' }, icon('more'));
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        folderMenu(more, f.id);
      });
      const row = h(
        'div',
        { class: `tree-row${active ? ' active' : ''}` },
        h(
          'button',
          {
            type: 'button',
            class: 'tree-open',
            style: { paddingLeft: `${8 + depth * 16}px` },
            'aria-current': active ? 'page' : null,
            onclick: () => go({ folder: f.id }),
          },
          h('span', { class: 'nav-label' }, f.name),
          h('span', { class: 'nav-count' }, String(countDeep(f.id) || ''))
        ),
        more
      );
      makeDropTarget(row, f.id);
      return h('li', { role: 'treeitem', 'aria-expanded': kids.length ? 'true' : null }, row, kids.length ? h('ul', { role: 'group' }, build(f.id, depth + 1)) : null);
    });
  const items = build(null, 0);
  tree.replaceChildren(...items);
  if (!items.length) tree.append(h('li', { class: 'tree-empty' }, 'Make a folder for each topic you’re learning.'));
}

document.getElementById('newFolder').addEventListener('click', () => newFolderFlow(null));

async function newFolderFlow(parentId) {
  const name = await askText(parentId ? `New folder in ${L.folders[parentId]?.name}` : 'New folder', {
    confirm: 'Create folder',
  });
  if (!name) return;
  const f = await createFolder(name, parentId);
  L.folders[f.id] = f;
  go({ folder: f.id });
}

function folderMenu(anchor, id) {
  const f = L.folders[id];
  openMenu(anchor, [
    { label: 'Rename', icon: 'edit', onClick: () => renameFolder(id) },
    { label: f.description ? 'Edit goal' : 'Add a goal', icon: 'target', onClick: () => editGoal(id) },
    { label: 'New folder inside', icon: 'plus', onClick: () => newFolderFlow(id) },
    { label: 'Move folder…', icon: 'move', onClick: () => moveFolderFlow(id) },
    { label: 'Export…', icon: 'download', onClick: () => exportFlow({ folder: id }, `Export “${f.name}”`, { onError: showToast }) },
    'sep',
    { label: `Delete “${f.name}”`, icon: 'trash', danger: true, onClick: () => deleteFolderFlow(id) },
  ]);
}

function editGoal(id) {
  const r = currentRoute();
  if (!(r.view === 'folder' && r.folder === id)) go({ folder: id });
  setTimeout(() => {
    const g = document.querySelector('.fv-goal');
    if (!g) return;
    g.hidden = false;
    g.focus();
    g.setSelectionRange(g.value.length, g.value.length);
  }, 0);
}

async function renameFolder(id) {
  const name = await askText('Rename folder', { value: L.folders[id].name, confirm: 'Rename' });
  if (name) await updateFolder(id, { name });
}

async function moveFolderFlow(id) {
  const banned = new Set(folderSubtree(L.folders, id));
  const opts = [h('option', { value: '' }, 'Top level')];
  const walk = (pid, depth) => {
    for (const f of childrenOf(pid)) {
      if (banned.has(f.id)) continue;
      opts.push(h('option', { value: f.id }, `${' '.repeat(depth)}${f.name}`));
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  const sel = h('select', { class: 'field', 'aria-label': 'Destination' }, opts);
  sel.value = L.folders[id].parentId || '';
  const dlg = h(
    'dialog',
    { class: 'dlg' },
    h('h2', null, `Move “${L.folders[id].name}”`),
    sel,
    h(
      'div',
      { class: 'dlg-actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => dlg.close('cancel') }, 'Cancel'),
      h('button', { class: 'btn primary', type: 'button', onclick: () => dlg.close('ok') }, 'Move')
    )
  );
  document.body.append(dlg);
  dlg.addEventListener('close', async () => {
    dlg.remove();
    if (dlg.returnValue !== 'ok') return;
    const parentId = sel.value || null;
    const siblings = childrenOf(parentId);
    await updateFolder(id, { parentId, order: siblings.length ? Math.max(...siblings.map((s) => s.order || 0)) + 1 : 0 });
  });
  dlg.showModal();
}

async function deleteFolderFlow(id) {
  const f = L.folders[id];
  const n = countDeep(id);
  const dest = f.parentId ? L.folders[f.parentId]?.name : 'Unfiled';
  const subs = folderSubtree(L.folders, id).length - 1;
  const ok = await askConfirm(
    `Delete “${f.name}”?`,
    `${n ? `${plural(n, 'video')} will move to ${dest}. ` : ''}${subs ? `${plural(subs, 'folder')} inside it will be deleted too. ` : ''}Notes are kept.`,
    { confirm: 'Delete folder' }
  );
  if (!ok) return;
  await deleteFolder(id);
  const r = currentRoute();
  if (r.view === 'folder' && folderSubtree(L.folders, id).includes(r.folder)) go({ folder: f.parentId || 'unfiled' }, { replace: true });
}

// ---------------------------------------------------------------- drag & drop

let dragVideo = null;
function makeDropTarget(el, folderId) {
  el.addEventListener('dragover', (e) => {
    if (!dragVideo) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    el.classList.add('drop-hover');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-hover'));
  el.addEventListener('drop', async (e) => {
    e.preventDefault();
    el.classList.remove('drop-hover');
    const id = dragVideo;
    dragVideo = null;
    if (!id) return;
    await moveVideo(id, folderId);
  });
}

async function moveVideo(videoId, folderId) {
  const v = L.byId.get(videoId);
  if (!v || (v.folderId || null) === folderId) return;
  const inDest = L.videos.filter((x) => (x.folderId || null) === folderId);
  const order = inDest.length ? Math.max(...inDest.map((x) => x.order ?? 0)) + 1 : 0;
  await updateVideo(videoId, (rec) => {
    rec.folderId = folderId;
    rec.order = order;
  });
  showToast(`Moved to ${folderId ? L.folders[folderId].name : 'Unfiled'}`);
}

async function reorder(folderKey, orderedIds) {
  const updates = {};
  orderedIds.forEach((id, i) => {
    const v = L.byId.get(id);
    if (v && v.order !== i) updates[vKey(id)] = { ...v, order: i, _w: WRITER };
  });
  if (Object.keys(updates).length) await chrome.storage.local.set(updates);
}

// ---------------------------------------------------------------- folder view

let fv = null; // the folder view currently on screen, updated in place

function renderFolderView(r) {
  const key = r.folder;
  const folder = L.folders[key];
  if (key !== 'all' && key !== 'unfiled' && !folder) return go({ folder: 'all' }, { replace: true });
  if (fv && fv.key === key && main.contains(fv.root)) return refreshFolderView();

  const crumbsHost = h('nav', { class: 'crumbs', 'aria-label': 'Parent folders' });
  const titleEl = h('h1');
  let moreBtn = null;
  if (folder) {
    moreBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Folder actions', title: 'Folder actions' }, icon('more'));
    moreBtn.addEventListener('click', () => folderMenu(moreBtn, key));
  }
  let goal = null;
  if (folder) {
    goal = h('textarea', { class: 'fv-goal', rows: 1, 'aria-label': 'What you want to learn in this folder' });
    goal.value = folder.description || '';
    const save = debounce(() => updateFolder(key, { description: goal.value }), 500);
    goal.addEventListener('input', save);
    goal.addEventListener('blur', () => {
      save.flush();
      goal.hidden = !goal.value.trim();
    });
    goal.hidden = !goal.value.trim();
    goal._fit = autosize(goal);
  }
  const head = h('header', { class: 'fv-head' }, crumbsHost, h('div', { class: 'fv-title-row' }, titleEl, moreBtn), goal);

  const target = key === 'all' || key === 'unfiled' ? null : key;
  const addInput = h('textarea', {
    class: 'field add-input',
    rows: 1,
    placeholder: target ? 'Paste a YouTube link to add it here' : 'Paste a YouTube link to add it to your library',
    'aria-label': 'YouTube links to add',
    title: 'Paste one or more links, then press Enter',
  });
  autosize(addInput, 42);
  const addForm = h('form', { class: 'add-videos' }, h('label', { class: 'search add-field' }, icon('plus'), addInput));
  addInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      addForm.requestSubmit();
    }
  });
  addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const tokens = addInput.value.split(/[\s,]+/).filter(Boolean);
    const ids = [...new Set(tokens.map(parseVideoId).filter(Boolean))];
    if (!ids.length) {
      showToast(tokens.length ? 'Those don’t look like YouTube video links.' : 'Paste a YouTube link first.');
      return;
    }
    addInput.disabled = true;
    const fresh = ids.filter((id) => !L.byId.has(id));
    const already = ids.length - fresh.length;
    const metas = await Promise.all(fresh.map((id) => fetchVideoMeta(id)));
    const inDest = L.videos.filter((x) => (x.folderId || null) === target);
    let order = inDest.length ? Math.max(...inDest.map((x) => x.order ?? 0)) + 1 : 0;
    const updates = {};
    fresh.forEach((id, i) => {
      const rec = newVideoRecord(id, { ...(metas[i] || {}), folderId: target, order: order++ });
      rec._w = WRITER;
      updates[vKey(id)] = rec;
    });
    if (fresh.length) await chrome.storage.local.set(updates);
    addInput.disabled = false;
    addInput.focus();
    addInput.value = '';
    addInput.dispatchEvent(new Event('input'));
    const missing = metas.filter((m) => !m).length;
    showToast(
      [
        fresh.length ? `Added ${plural(fresh.length, 'video')}` : '',
        already ? `${plural(already, 'video')} already in your library` : '',
        missing ? `${missing} couldn’t be looked up` : '',
      ]
        .filter(Boolean)
        .join('. ') || 'Nothing to add'
    );
  });

  const subsHost = h('div');
  const list = h('ol', { class: `vlist${key !== 'all' ? ' sortable' : ''}`, 'aria-label': 'Videos' });
  if (key !== 'all') wireReorder(list, key);
  const emptyHost = h('div');
  const root = h('div', { class: 'page' }, head, addForm, subsHost, list, emptyHost);
  main.replaceChildren(root);
  fv = { key, root, crumbsHost, titleEl, goal, subsHost, list, emptyHost };
  refreshFolderView();
}

function refreshFolderView() {
  const { key, crumbsHost, titleEl, goal, subsHost, list, emptyHost } = fv;
  const folder = L.folders[key];
  const title = key === 'all' ? 'All videos' : key === 'unfiled' ? 'Unfiled' : folder.name;
  titleEl.textContent = title;
  document.title = `${title} · Lectern`;

  // breadcrumbs for nested folders
  const crumbIds = [];
  let pid = folder && folder.parentId;
  while (pid && L.folders[pid]) {
    crumbIds.unshift(pid);
    pid = L.folders[pid].parentId;
  }
  crumbsHost.hidden = !crumbIds.length;
  crumbsHost.replaceChildren(
    ...crumbIds.flatMap((cid) => [h('button', { type: 'button', onclick: () => go({ folder: cid }) }, L.folders[cid].name), h('span', { 'aria-hidden': 'true' }, ' / ')])
  );

  if (goal && document.activeElement !== goal && goal.value !== (folder.description || '')) {
    goal.value = folder.description || '';
    goal.hidden = !goal.value.trim();
    goal._fit();
  }

  const vids = videosIn(key);

  const subs = folder ? childrenOf(folder.id) : [];
  subsHost.replaceChildren(
    subs.length
      ? h(
          'ul',
          { class: 'subfolders', 'aria-label': 'Folders inside' },
          subs.map((s) => {
            const b = h(
              'button',
              { type: 'button', class: 'subfolder', onclick: () => go({ folder: s.id }) },
              s.name,
              h('span', { class: 'nav-count' }, String(countDeep(s.id) || ''))
            );
            makeDropTarget(b, s.id);
            return h('li', null, b);
          })
        )
      : ''
  );

  const sortable = key !== 'all';
  list.replaceChildren(...vids.map((v, i) => videoRow(v, sortable ? i + 1 : null, key === 'all')));
  emptyHost.replaceChildren(
    vids.length ? '' : h('div', { class: 'fv-empty' }, L.videos.length || Object.keys(L.folders).length ? emptyFolderCopy(key) : welcome())
  );
}

function emptyFolderCopy(key) {
  if (key === 'unfiled') return h('p', null, 'Videos you save without choosing a folder land here.');
  return h('p', null, 'Paste a YouTube link above, or pick this folder in the notes panel while you watch.');
}

function welcome() {
  return h(
    'section',
    { class: 'welcome' },
    h('h2', null, 'Start a notebook for something you’re learning'),
    h(
      'ol',
      null,
      h('li', null, h('strong', null, 'Make a folder for the topic.'), ' Use the + next to Folders.'),
      h('li', null, h('strong', null, 'Add videos.'), ' Paste links above, or open a video on YouTube and click the Lectern icon in the toolbar.'),
      h('li', null, h('strong', null, 'Take notes while you watch.'), ' Each note is stamped with the video time when you save it. Click any time to jump back.')
    ),
    h('p', { class: 'hint' }, 'Pin the extension from the puzzle-piece menu so the icon is always one click away. Alt+Shift+M marks a moment without leaving the video.')
  );
}

function videoRow(v, n, showFolder) {
  const prog = progressOf(v);
  const resume = resumeTime(v);
  const d = prog.d;
  const metaBits = [];
  if (v.channel) metaBits.push(v.channel);
  if (showFolder && v.folderId && L.folders[v.folderId]) metaBits.push(L.folders[v.folderId].name);
  const nNotes = (v.notes || []).length;
  if (nNotes) metaBits.push(plural(nNotes, 'note'));

  const lesson = h(
    'button',
    {
      type: 'button',
      class: `lesson${v.done ? ' done' : ''}`,
      'aria-pressed': String(!!v.done),
      title: v.done ? 'Finished. Click to mark as not finished.' : 'Mark as finished',
      'aria-label': v.done ? `Finished: ${v.title}` : `Mark “${v.title || v.videoId}” as finished`,
      onclick: () => updateVideo(v.videoId, (rec) => void (rec.done = !rec.done)),
    },
    v.done ? icon('check') : n != null ? String(n) : icon('check')
  );

  const thumb = h(
    'button',
    {
      type: 'button',
      class: 'thumb',
      title: resume ? `Resume at ${formatTime(resume)}` : 'Watch',
      'aria-label': resume ? `Resume ${v.title} at ${formatTime(resume)}` : `Watch ${v.title}`,
      onclick: () => openVideo(v.videoId, resume || null),
    },
    h('img', { src: thumbUrl(v.videoId), alt: '', loading: 'lazy', draggable: false, onerror: hideBroken }),
    h('span', { class: 'play' }, icon('play')),
    d ? h('span', { class: 'dur' }, resume ? `${formatTime(resume)} / ${formatTime(d)}` : formatTime(d)) : null,
    prog.pct > 0 ? h('span', { class: 'bar', style: { width: `${Math.round(prog.pct * 100)}%` } }) : null
  );

  const more = h('button', { type: 'button', class: 'icon-btn vmore', title: 'Video actions', 'aria-label': `Actions for ${v.title || v.videoId}` }, icon('more'));
  more.addEventListener('click', () => videoMenu(more, v));

  const li = h(
    'li',
    { class: `vrow${v.done ? ' is-done' : ''}`, dataset: { id: v.videoId }, draggable: 'true', title: 'Drag to reorder, or onto a folder to move it' },
    lesson,
    thumb,
    h(
      'div',
      { class: 'vinfo' },
      h('button', { type: 'button', class: 'vtitle', onclick: () => go({ video: v.videoId }) }, v.title || `Video ${v.videoId}`),
      h('p', { class: 'vmeta' }, metaBits.join(' · '))
    ),
    more
  );
  li.addEventListener('dragstart', (e) => {
    dragVideo = v.videoId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', watchUrl(v.videoId));
    li.classList.add('dragging');
  });
  li.addEventListener('dragend', () => {
    li.classList.remove('dragging');
    dragVideo = null;
    document.querySelectorAll('.drop-hover').forEach((el) => el.classList.remove('drop-hover'));
  });
  return li;
}

function wireReorder(list, key) {
  let marker = null;
  const clear = () => {
    marker && marker.classList.remove('drop-before', 'drop-after');
    marker = null;
  };
  list.addEventListener('dragover', (e) => {
    if (!dragVideo) return;
    const row = e.target.closest('.vrow');
    if (!row || row.dataset.id === dragVideo) return clear();
    e.preventDefault();
    const r = row.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    if (marker !== row) clear();
    marker = row;
    row.classList.toggle('drop-after', after);
    row.classList.toggle('drop-before', !after);
  });
  list.addEventListener('dragleave', (e) => {
    if (!list.contains(e.relatedTarget)) clear();
  });
  list.addEventListener('drop', async (e) => {
    if (!dragVideo || !marker) return;
    e.preventDefault();
    const after = marker.classList.contains('drop-after');
    const targetId = marker.dataset.id;
    clear();
    const id = dragVideo;
    dragVideo = null;
    const ids = [...list.querySelectorAll('.vrow')].map((li) => li.dataset.id).filter((x) => x !== id);
    let idx = ids.indexOf(targetId);
    if (after) idx++;
    // a video dragged in from elsewhere (e.g. search) joins this folder
    const v = L.byId.get(id);
    const folderId = key === 'unfiled' ? null : key;
    if (v && (v.folderId || null) !== folderId) await updateVideo(id, (rec) => void (rec.folderId = folderId));
    ids.splice(idx, 0, id);
    await reorder(key, ids);
  });
}

function videoMenu(anchor, v) {
  const resume = resumeTime(v);
  const moveTargets = [{ id: null, name: 'Unfiled', depth: 0 }];
  const walk = (pid, depth) => {
    for (const f of childrenOf(pid)) {
      moveTargets.push({ id: f.id, name: f.name, depth });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  openMenu(anchor, [
    { label: 'Open notes', icon: 'note', onClick: () => go({ video: v.videoId }) },
    { label: resume ? `Resume at ${formatTime(resume)}` : 'Watch', icon: 'play', onClick: () => openVideo(v.videoId, resume || null) },
    ...(resume ? [{ label: 'Watch from the start', icon: 'back5', onClick: () => openVideo(v.videoId, 0) }] : []),
    { label: 'Move to folder…', icon: 'move', onClick: () => moveVideoFlow(v, moveTargets) },
    { label: 'Copy notes as Markdown', icon: 'copy', onClick: async () => (await copyText(videoToMarkdown(v, null))) && showToast('Notes copied') },
    { label: 'Export…', icon: 'download', onClick: () => exportFlow({ video: v.videoId }, 'Export notes', { onError: showToast }) },
    'sep',
    { label: 'Remove from library', icon: 'trash', danger: true, onClick: () => removeVideoFlow(v) },
  ]);
}

function moveVideoFlow(v, targets) {
  const sel = h(
    'select',
    { class: 'field', 'aria-label': 'Folder' },
    targets.map((t) => h('option', { value: t.id || '' }, `${' '.repeat(t.depth)}${t.name}`))
  );
  sel.value = v.folderId || '';
  const dlg = h(
    'dialog',
    { class: 'dlg' },
    h('h2', null, 'Move to folder'),
    sel,
    h(
      'div',
      { class: 'dlg-actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => dlg.close('cancel') }, 'Cancel'),
      h('button', { class: 'btn primary', type: 'button', onclick: () => dlg.close('ok') }, 'Move')
    )
  );
  document.body.append(dlg);
  dlg.addEventListener('close', () => {
    dlg.remove();
    if (dlg.returnValue === 'ok') moveVideo(v.videoId, sel.value || null);
  });
  dlg.showModal();
}

async function removeVideoFlow(v) {
  const ok = await askConfirm(`Remove “${v.title || v.videoId}”?`, `Its ${plural((v.notes || []).length, 'note')}, notepad and transcript will be deleted.`, {
    confirm: 'Remove',
  });
  if (!ok) return;
  await deleteVideo(v.videoId);
  const r = currentRoute();
  if (r.view === 'video' && r.id === v.videoId) go({ folder: v.folderId && L.folders[v.folderId] ? v.folderId : 'all' }, { replace: true });
  showToast('Removed from your library');
}

// ---------------------------------------------------------------- video detail view

let detail = null; // { id, update(video), refreshTranscript() }

async function renderVideoView(r) {
  const v = L.byId.get(r.id);
  if (!v) {
    main.replaceChildren(
      h(
        'div',
        { class: 'page' },
        h('h1', null, 'This video isn’t in your library'),
        h('p', null, h('button', { class: 'btn', type: 'button', onclick: () => go({ folder: 'all' }) }, 'Back to all videos'))
      )
    );
    detail = null;
    return;
  }
  const id = v.videoId;
  let transcript = await getTranscript(id);

  const backTarget = v.folderId && L.folders[v.folderId] ? v.folderId : 'unfiled';
  const back = h('button', { type: 'button', class: 'back' });
  back.addEventListener('click', () => {
    const cur = L.byId.get(id);
    go({ folder: cur && cur.folderId && L.folders[cur.folderId] ? cur.folderId : backTarget });
  });

  // header
  const titleEl = h('h1', { class: 'd-title' });
  const metaEl = h('p', { class: 'd-meta' });
  const resumeBtn = h('button', { class: 'btn primary', type: 'button' });
  const folderSel = h('select', { class: 'field d-folder', 'aria-label': 'Folder' });
  const doneBtn = h('button', { class: 'btn', type: 'button' });
  const moreBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'More actions', title: 'More actions' }, icon('more'));
  const thumbBtn = h(
    'button',
    { type: 'button', class: 'd-thumb', 'aria-label': 'Watch this video' },
    h('img', { src: thumbUrl(id, 'hqdefault'), alt: '', onerror: hideBroken }),
    h('span', { class: 'play' }, icon('play')),
    h('span', { class: 'bar' })
  );

  function fillFolderSel(cur) {
    const opts = [h('option', { value: '' }, 'Unfiled')];
    const walk = (pid, depth) => {
      for (const f of childrenOf(pid)) {
        opts.push(h('option', { value: f.id }, `${' '.repeat(depth)}${f.name}`));
        walk(f.id, depth + 1);
      }
    };
    walk(null, 0);
    folderSel.replaceChildren(...opts);
    folderSel.value = cur || '';
  }
  folderSel.addEventListener('change', () => moveVideo(id, folderSel.value || null));
  doneBtn.addEventListener('click', () => updateVideo(id, (rec) => void (rec.done = !rec.done)));
  moreBtn.addEventListener('click', () =>
    openMenu(moreBtn, [
      ...(resumeTime(L.byId.get(id)) ? [{ label: 'Watch from the start', icon: 'play', onClick: () => openVideo(id, 0) }] : []),
      { label: 'Copy notes as Markdown', icon: 'copy', onClick: async () => (await copyText(videoToMarkdown(L.byId.get(id), transcript))) && showToast('Notes copied') },
      { label: 'Export…', icon: 'download', onClick: () => exportFlow({ video: id }, 'Export notes', { onError: showToast }) },
      { label: 'Copy video link', icon: 'external', onClick: async () => (await copyText(watchUrl(id))) && showToast('Link copied') },
      'sep',
      { label: 'Remove from library', icon: 'trash', danger: true, onClick: () => removeVideoFlow(L.byId.get(id)) },
    ])
  );

  const header = h(
    'header',
    { class: 'd-head' },
    thumbBtn,
    h('div', { class: 'd-info' }, titleEl, metaEl, h('div', { class: 'd-actions' }, resumeBtn, h('label', { class: 'd-folder-pick' }, icon('folder'), folderSel), doneBtn, moreBtn))
  );

  // notes column: time notes, then the notepad
  const noteList = createNoteList({
    onTime: (t) => openVideo(id, t),
    onSave: (nid, text) => updateNote(id, nid, { text }),
    menuFor: (n, { edit }) => [
      { label: 'Edit note', icon: 'edit', onClick: edit },
      {
        label: 'Change time…',
        icon: 'refresh',
        onClick: async () => {
          const val = await askText('Note time', { value: formatTime(n.t), confirm: 'Save' });
          const t = parseTime(val);
          if (val && t == null) showToast('Use a time like 4:30 or 1:02:15.');
          else if (t != null) updateNote(id, n.id, { t });
        },
      },
      { label: 'Copy link to this moment', icon: 'copy', onClick: async () => (await copyText(watchUrl(id, n.t))) && showToast('Link copied') },
      'sep',
      {
        label: 'Delete note',
        icon: 'trash',
        danger: true,
        onClick: async () => {
          const before = (L.byId.get(id).notes || []).find((x) => x.id === n.id);
          await deleteNote(id, n.id);
          showToast('Note deleted', {
            action: 'Undo',
            onAction: () => updateVideo(id, (rec) => void (rec.notes = [...(rec.notes || []), before].sort((a, b) => a.t - b.t))),
          });
        },
      },
    ],
  });
  const notesEmpty = h('p', { class: 'd-empty' }, 'No time notes yet. Notes you write in the panel while watching show up here.');

  // notepad with pages
  let activePageId = null;
  const npText = h('textarea', { class: 'd-summary', 'aria-label': 'Notepad', title: 'Ideas, questions, anything not tied to a moment' });
  const npWrap = writeField(npText, { className: 'd-np-write' });
  const fitNp = autosize(npText, 140);
  const npSavers = new Map();
  const npSaver = (pid) => {
    if (!npSavers.has(pid)) npSavers.set(pid, debounce((text) => updatePage(id, pid, { text }), 500));
    return npSavers.get(pid);
  };
  const flushNp = () => npSavers.forEach((s) => s.flush());
  npText.addEventListener('input', () => npSaver(activePageId)(npText.value));
  npText.addEventListener('blur', flushNp);
  const pageTabs = h('nav', { class: 'd-pages', 'aria-label': 'Notepad pages' });

  function renderNotepad(video, force) {
    const pages = pagesOf(video);
    if (!pages.some((p) => p.id === activePageId)) activePageId = pages[0].id;
    const page = pages.find((p) => p.id === activePageId);
    if (force || (document.activeElement !== npText && npText.value !== (page.text || ''))) {
      npText.value = page.text || '';
      syncWriteField(npText);
      fitNp();
    }
    npText.setAttribute('aria-label', pages.length > 1 ? `Notepad, ${page.title}` : 'Notepad');
    const add = h('button', { type: 'button', class: 'icon-btn', title: 'Add a page', 'aria-label': 'Add a page' }, icon('plus'));
    add.addEventListener('click', async () => {
      flushNp();
      const p = await addPage(id);
      activePageId = p.id;
      renderNotepad(await getVideoFresh(id), true);
      npText.focus();
    });
    const tabs =
      pages.length > 1
        ? pages.map((p) => {
            const active = p.id === activePageId;
            const b = h(
              'button',
              { type: 'button', class: `d-page${active ? ' active' : ''}`, 'aria-current': active ? 'page' : null, title: active ? 'Page options' : `Open ${p.title}` },
              p.title,
              active ? icon('chevronDown') : null
            );
            b.addEventListener('click', () => {
              if (!active) {
                flushNp();
                activePageId = p.id;
                renderNotepad(L.byId.get(id), true);
                return;
              }
              openMenu(b, [
                {
                  label: 'Rename page',
                  icon: 'edit',
                  onClick: async () => {
                    const title = await askText('Rename page', { value: p.title, confirm: 'Rename' });
                    if (title && title !== p.title) await updatePage(id, p.id, { title: title.slice(0, 40) });
                  },
                },
                'sep',
                {
                  label: `Delete “${p.title}”`,
                  icon: 'trash',
                  danger: true,
                  onClick: async () => {
                    flushNp();
                    const cur = pagesOf(L.byId.get(id)).find((x) => x.id === p.id);
                    if (cur && (cur.text || '').trim()) {
                      const ok = await askConfirm(`Delete “${p.title}”?`, 'The text on this page will be deleted.', { confirm: 'Delete page' });
                      if (!ok) return;
                    }
                    await deletePage(id, p.id);
                  },
                },
              ]);
            });
            return b;
          })
        : [];
    pageTabs.replaceChildren(...tabs, add);
  }

  const notesCol = h(
    'section',
    { class: 'd-col', 'aria-labelledby': 'notesHeading' },
    h('div', { class: 'd-np-head' }, h('h2', null, 'Notepad'), pageTabs),
    npWrap,
    h('h2', { id: 'notesHeading', class: 'd-timed-h' }, 'Time notes', h('span', { class: 'count' })),
    noteList.el,
    notesEmpty
  );

  // transcript column
  const trCol = h('section', { class: 'd-col d-tr', 'aria-labelledby': 'trHeading' });
  let trQuery = r.q || '';

  function renderTr() {
    const head = h('h2', { id: 'trHeading' }, 'Transcript');
    if (!transcript) {
      const ta = h('textarea', { class: 'field paste', rows: 8, 'aria-label': 'Paste transcript' });
      trCol.replaceChildren(
        head,
        h(
          'p',
          { class: 'hint d-empty' },
          'No transcript yet. Open the video and get it from the Transcript tab in the panel, or paste one here.'
        ),
        ta,
        h(
          'div',
          { class: 'row-actions' },
          h('button', { class: 'btn', type: 'button', onclick: () => openVideo(id, null) }, 'Open video'),
          h(
            'button',
            {
              class: 'btn quiet',
              type: 'button',
              onclick: async () => {
                let segs = parsePastedTranscript(ta.value);
                let untimed = false;
                if (!segs.length) {
                  const paras = ta.value.split(/\n+/).map((s) => s.trim()).filter(Boolean);
                  if (!paras.length) return ta.focus();
                  segs = paras.map((text) => ({ t: 0, d: 0, text }));
                  untimed = true;
                }
                await saveTranscript(id, { lang: '', label: 'Pasted', source: 'pasted', untimed, segments: segs });
              },
            },
            'Save pasted text'
          )
        )
      );
      return;
    }
    const search = h('input', { class: 'field', type: 'search', placeholder: 'Search transcript', value: trQuery, 'aria-label': 'Search transcript' });
    const list = h('ol', { class: 'd-segs' });
    const status = h('p', { class: 'hint' });
    const fill = () => {
      const q = trQuery.trim().toLowerCase();
      const frag = document.createDocumentFragment();
      let shown = 0;
      transcript.segments.forEach((s, i) => {
        if (q && !s.text.toLowerCase().includes(q)) return;
        shown++;
        frag.append(
          h(
            'li',
            { class: 'd-seg', dataset: { i } },
            transcript.untimed ? null : h('button', { type: 'button', class: 'time', title: `Watch from ${formatTime(s.t)}` }, formatTime(s.t)),
            h('p', null, highlight(s.text, q)),
            h('button', { type: 'button', class: 'icon-btn seg-add', title: 'Add this line to your notes', 'aria-label': 'Add this line to your notes' }, icon('plus'))
          )
        );
      });
      list.replaceChildren(frag);
      status.textContent = q ? (shown ? `${plural(shown, 'line')} match.` : `No lines mention “${trQuery.trim()}”.`) : '';
    };
    search.addEventListener(
      'input',
      debounce(() => {
        trQuery = search.value;
        fill();
      }, 150)
    );
    list.addEventListener('click', async (e) => {
      const li = e.target.closest('.d-seg');
      if (!li) return;
      const s = transcript.segments[+li.dataset.i];
      if (e.target.closest('.seg-add')) {
        await addNote(id, { t: s.t, text: s.text });
        showToast(`Added to time notes (${formatTime(s.t)})`);
      } else if (e.target.closest('.time')) openVideo(id, s.t);
    });
    const trMore = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Transcript actions', title: 'Transcript actions' }, icon('more'));
    trMore.addEventListener('click', () =>
      openMenu(trMore, [
        {
          label: 'Copy transcript',
          icon: 'copy',
          onClick: async () => (await copyText(transcript.segments.map((s) => (transcript.untimed ? s.text : `[${formatTime(s.t)}] ${s.text}`)).join('\n'))) && showToast('Transcript copied'),
        },
        'sep',
        { label: 'Delete transcript', icon: 'trash', danger: true, onClick: () => deleteTranscript(id) },
      ])
    );
    trCol.replaceChildren(h('div', { class: 'd-tr-head' }, head, trMore), h('label', { class: 'search' }, icon('search'), search), status, list);
    fill();
  }

  function renderNotes(video) {
    const notes = [...(video.notes || [])].sort((a, b) => a.t - b.t);
    notesCol.querySelector('h2 .count').textContent = notes.length ? String(notes.length) : '';
    notesEmpty.hidden = notes.length > 0;
    noteList.render(notes);
  }

  function update(video) {
    titleEl.textContent = video.title || `Video ${id}`;
    const prog = progressOf(video);
    const resume = resumeTime(video);
    metaEl.replaceChildren([video.channel, prog.d ? formatTime(prog.d) : null].filter(Boolean).join(' · '));
    resumeBtn.replaceChildren(icon('play'), resume ? `Resume at ${formatTime(resume)}` : 'Watch');
    resumeBtn.onclick = () => openVideo(id, resume || null);
    thumbBtn.onclick = () => openVideo(id, resume || null);
    thumbBtn.querySelector('.bar').style.width = `${Math.round(prog.pct * 100)}%`;
    fillFolderSel(video.folderId);
    doneBtn.replaceChildren(icon('check'), video.done ? 'Finished' : 'Mark finished');
    doneBtn.classList.toggle('is-on', !!video.done);
    doneBtn.setAttribute('aria-pressed', String(!!video.done));
    back.replaceChildren(icon('chevronLeft'), video.folderId && L.folders[video.folderId] ? L.folders[video.folderId].name : 'Unfiled');
    renderNotes(video);
    renderNotepad(video);
    document.title = `${video.title || id} · Lectern`;
  }

  main.replaceChildren(h('div', { class: 'page detail' }, back, header, h('div', { class: 'd-cols' }, notesCol, trCol)));
  update(v);
  renderNotepad(v, true);
  renderTr();
  detail = {
    id,
    update,
    async refreshTranscript() {
      transcript = await getTranscript(id);
      renderTr();
    },
  };
}

function highlight(text, q) {
  if (!q) return text;
  const frag = document.createDocumentFragment();
  const lower = text.toLowerCase();
  let pos = 0;
  let idx;
  while ((idx = lower.indexOf(q, pos)) !== -1) {
    frag.append(text.slice(pos, idx), h('mark', null, text.slice(idx, idx + q.length)));
    pos = idx + q.length;
  }
  frag.append(text.slice(pos));
  return frag;
}

// ---------------------------------------------------------------- search view

async function renderSearchView(r) {
  const q = r.q.trim().toLowerCase();
  if (!L.transcripts) L.transcripts = await getAllTranscripts();
  const results = [];
  for (const v of L.videos) {
    const inTitle = (v.title || '').toLowerCase().includes(q) || (v.channel || '').toLowerCase().includes(q);
    const notes = (v.notes || []).filter((n) => (n.text || '').toLowerCase().includes(q));
    const pageHits = pagesOf(v).filter((pg) => (pg.text || '').toLowerCase().includes(q));
    const tr = L.transcripts[v.videoId];
    const lines = tr ? tr.segments.filter((s) => s.text.toLowerCase().includes(q)) : [];
    const score = (inTitle ? 100 : 0) + notes.length * 10 + pageHits.length * 10 + lines.length;
    if (score) results.push({ v, inTitle, notes, pageHits, lines, tr, score });
  }
  results.sort((a, b) => b.score - a.score);

  const list = h(
    'ol',
    { class: 'results' },
    results.map(({ v, notes, pageHits, lines, tr }) => {
      const path = v.folderId && L.folders[v.folderId] ? folderPath(L.folders, v.folderId).join(' / ') : 'Unfiled';
      const hits = [];
      for (const n of notes.slice(0, 6)) {
        hits.push(
          h(
            'li',
            { class: 'hit' },
            h('button', { type: 'button', class: 'time', title: `Watch from ${formatTime(n.t)}`, onclick: () => openVideo(v.videoId, n.t) }, formatTime(n.t)),
            h('span', { class: 'hit-kind' }, 'Note'),
            h('p', null, highlight(n.text, q))
          )
        );
      }
      const many = pagesOf(v).length > 1;
      for (const pg of pageHits.slice(0, 3)) {
        const s = pg.text;
        const i = s.toLowerCase().indexOf(q);
        const snippet = (i > 60 ? '…' : '') + s.slice(Math.max(0, i - 60), i + q.length + 80) + (i + q.length + 80 < s.length ? '…' : '');
        hits.push(
          h('li', { class: 'hit' }, h('span', { class: 'time ghost' }), h('span', { class: 'hit-kind' }, many ? pg.title : 'Notepad'), h('p', null, highlight(snippet, q)))
        );
      }
      for (const s of lines.slice(0, 4)) {
        hits.push(
          h(
            'li',
            { class: 'hit' },
            tr.untimed
              ? h('span', { class: 'time ghost' })
              : h('button', { type: 'button', class: 'time', title: `Watch from ${formatTime(s.t)}`, onclick: () => openVideo(v.videoId, s.t) }, formatTime(s.t)),
            h('span', { class: 'hit-kind' }, 'Transcript'),
            h('p', null, highlight(s.text, q))
          )
        );
      }
      if (lines.length > 4) {
        hits.push(
          h(
            'li',
            { class: 'hit more' },
            h('button', { type: 'button', class: 'linkish', onclick: () => go({ video: v.videoId, tq: r.q.trim() }) }, `${plural(lines.length - 4, 'more transcript line')}`)
          )
        );
      }
      return h(
        'li',
        { class: 'result' },
        h(
          'div',
          { class: 'result-head' },
          h('img', { src: thumbUrl(v.videoId), alt: '', loading: 'lazy', onerror: hideBroken }),
          h(
            'div',
            null,
            h('button', { type: 'button', class: 'vtitle', onclick: () => go({ video: v.videoId, tq: r.q.trim() }) }, highlight(v.title || v.videoId, q)),
            h('p', { class: 'vmeta' }, path)
          )
        ),
        hits.length ? h('ul', { class: 'hits' }, hits) : null
      );
    })
  );

  main.replaceChildren(
    h(
      'div',
      { class: 'page' },
      h('header', { class: 'fv-head' }, h('h1', null, `Results for “${r.q.trim()}”`), h('p', { class: 'fv-stats' }, results.length ? plural(results.length, 'video') : '')),
      results.length ? list : h('p', { class: 'fv-empty' }, 'Nothing in your titles, notes, summaries or transcripts matches that. Try a shorter word.')
    )
  );
  document.title = `Search · Lectern`;
}

const runSearch = debounce(() => {
  const q = searchInput.value.trim();
  const r = currentRoute();
  if (q) go({ q }, { replace: r.view === 'search' });
  else if (r.view === 'search') go({ folder: 'all' }, { replace: true });
}, 220);
searchInput.addEventListener('input', runSearch);
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    searchInput.value = '';
    runSearch();
    runSearch.flush();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
    e.preventDefault();
    searchInput.focus();
  }
});

// ---------------------------------------------------------------- settings & backup

document.getElementById('settingsBtn').addEventListener('click', openSettings);
const importFile = document.getElementById('importFile');

async function exportBackup() {
  const data = await exportAll();
  const day = new Date().toISOString().slice(0, 10);
  downloadText(`lectern-backup-${day}.json`, JSON.stringify(data), 'application/json');
}

async function openSettings() {
  const s = L.settings;
  const askSection = h(
    'div',
    { class: 'set-field set-ask' },
    h('strong', null, 'Ask about videos'),
    h('small', null, 'Use your own Claude or OpenAI API key to ask questions about a video from the notes panel.'),
    await createAISetup({ onDone: () => showToast('Ask is connected') })
  );
  const syncSection = createSyncSection();
  const toggle = (key, label, help) => {
    const input = h('input', { type: 'checkbox', checked: !!s[key] });
    input.addEventListener('change', () => setSettings({ [key]: input.checked }));
    return h('label', { class: 'set-row' }, input, h('span', null, h('strong', null, label), help ? h('small', null, help) : null));
  };
  const lead = h(
    'select',
    { class: 'field', 'aria-label': 'Note timestamps' },
    [0, 2, 5, 10].map((n) => h('option', { value: n }, n ? `${n} seconds before I save` : 'The moment I save the note'))
  );
  lead.value = String(s.leadSeconds || 0);
  lead.addEventListener('change', () => setSettings({ leadSeconds: Number(lead.value) }));
  const theme = h(
    'select',
    { class: 'field', 'aria-label': 'Appearance' },
    h('option', { value: 'system' }, 'Match my system'),
    h('option', { value: 'light' }, 'Light'),
    h('option', { value: 'dark' }, 'Dark')
  );
  theme.value = s.theme || 'system';
  theme.addEventListener('change', () => setSettings({ theme: theme.value }));

  const dlg = h(
    'dialog',
    { class: 'dlg settings' },
    h('h2', null, 'Settings'),
    toggle('autoTranscript', 'Get transcripts automatically', 'When a video is saved, its captions are saved with it.'),
    toggle('pauseWhileTyping', 'Pause the video while I write a note', 'It plays again when you save the note.'),
    toggle('openPanelFromLibrary', 'Open the notes panel when I open a video from here'),
    h('label', { class: 'set-field' }, h('strong', null, 'Note timestamps'), lead),
    h('label', { class: 'set-field' }, h('strong', null, 'Appearance'), theme),
    askSection,
    syncSection,
    h(
      'div',
      { class: 'set-field' },
      h('strong', null, 'Backup'),
      h(
        'div',
        { class: 'set-actions' },
        h('button', { class: 'btn', type: 'button', onclick: exportBackup }, icon('download'), 'Export backup'),
        h('button', { class: 'btn', type: 'button', onclick: () => importFile.click() }, icon('upload'), 'Import backup')
      )
    ),
    h(
      'p',
      { class: 'hint' },
      'Alt+Shift+Y opens the panel and Alt+Shift+M marks a moment. In the panel, Alt+J, Alt+K and Alt+L rewind, play/pause and skip. ',
      h('button', { type: 'button', class: 'linkish', onclick: () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }) }, 'Change shortcuts')
    ),
    h(
      'p',
      { class: 'hint about' },
      `Lectern ${chrome.runtime.getManifest().version}. `,
      h('a', { href: issueUrl('bug.yml'), target: '_blank', rel: 'noopener' }, 'Report a problem'),
      ' or ',
      h('a', { href: REPO_URL, target: '_blank', rel: 'noopener' }, 'read the source code'),
      '.'
    ),
    h('div', { class: 'dlg-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: () => dlg.close() }, 'Done'))
  );
  document.body.append(dlg);
  dlg.addEventListener('close', () => {
    syncSection.cleanup();
    dlg.remove();
  });
  dlg.showModal();
}

importFile.addEventListener('change', async () => {
  const file = importFile.files[0];
  importFile.value = '';
  if (!file) return;
  try {
    const n = await importAll(JSON.parse(await file.text()));
    showToast(`Imported ${plural(n, 'video')}`);
  } catch (e) {
    showToast(e instanceof SyntaxError ? 'That file isn’t valid JSON.' : e.message);
  }
});

// ---------------------------------------------------------------- render + sync

async function render() {
  const r = currentRoute();
  if (r.view !== 'search' && document.activeElement !== searchInput) searchInput.value = '';
  if (r.view === 'search' && searchInput.value.trim() !== r.q) searchInput.value = r.q;
  renderSidebar();
  if (r.view === 'video') await renderVideoView(r);
  else {
    detail = null;
    if (r.view === 'search') await renderSearchView(r);
    else renderFolderView(r);
  }
}

let pending = {};
let renderAfterDrag = false;

async function resync() {
  const keys = Object.keys(pending).filter((k) => !QUIET_KEYS.has(k));
  pending = {};
  if (!keys.length) return;
  await loadAll();
  if (keys.some((k) => k.startsWith('t:'))) L.transcripts = null;
  if (dragVideo) {
    renderAfterDrag = true; // rebuilding the list mid-drag would cancel the drag
    return;
  }
  const r = currentRoute();
  if (r.view === 'video' && detail && detail.id === r.id && L.byId.has(r.id)) {
    renderSidebar();
    detail.update(L.byId.get(r.id));
    if (keys.includes(`t:${r.id}`)) detail.refreshTranscript();
    return;
  }
  if (r.view === 'search' && keys.every((k) => k.startsWith('p:'))) return;
  render(); // the folder view updates in place, so typing isn't interrupted
}
const scheduleResync = debounce(resync, 120);

onStorageChange((changes) => {
  Object.assign(pending, changes);
  scheduleResync();
});
document.addEventListener('dragend', () => {
  if (renderAfterDrag) {
    renderAfterDrag = false;
    setTimeout(render, 0);
  }
});

// Keys that don't change what the library shows
const QUIET_KEYS = new Set(['ai', 'fsync', 'nsync']);

// Folder sync runs while the library or the panel is open. When Chrome drops the folder
// permission (after a restart, unless "Allow on every visit" was chosen), offer to resume.
const syncPaused = h(
  'p',
  { class: 'sync-paused', hidden: true },
  'Folder sync is paused. ',
  h(
    'button',
    {
      type: 'button',
      class: 'linkish',
      onclick: async () => {
        if (await resumeFolderSync()) {
          syncPaused.hidden = true;
          showToast('Folder sync resumed');
        }
      },
    },
    'Resume'
  )
);
document.querySelector('.side-foot').prepend(syncPaused);

async function boot() {
  const win = await chrome.windows.getCurrent();
  L.windowId = win.id;
  await loadAll();
  await render();
  startFolderSync({ onStatus: (r) => (syncPaused.hidden = r !== 'paused') });
  folderSyncStatus().then((s) => (syncPaused.hidden = s.state !== 'paused'));
}
boot();
