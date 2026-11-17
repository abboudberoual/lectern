// Storage layer. Everything lives in chrome.storage.local so every view
// (side panel, library, service worker, content script) sees the same data
// and gets change events.
//
// Keys:
//   folders          { [folderId]: Folder }
//   settings         Settings
//   v:<videoId>      Video record (notes, summary, folder, order...)
//   t:<videoId>      Transcript { lang, label, source, capturedAt, segments: [{t, d, text}] }
//   p:<videoId>      Playback position { t, d, at } (written by the content script)

import { uid } from './util.js';

const store = chrome.storage.local;

export const WRITER = uid('w');

export const FOLDERS = 'folders';
export const SETTINGS = 'settings';
export const vKey = (id) => `v:${id}`;
export const tKey = (id) => `t:${id}`;
export const pKey = (id) => `p:${id}`;

export const DEFAULT_SETTINGS = {
  autoTranscript: true, // capture the transcript automatically when a video is saved/opened
  pauseWhileTyping: false, // pause the video when you start writing a note
  leadSeconds: 0, // stamp notes this many seconds before the moment you start typing
  openPanelFromLibrary: true, // open the notes panel when opening a video from the library
  autoOpenPanel: false, // open the notes panel on the first click or key press on a video's page
  followTranscript: true, // keep the current transcript line in view
};

export async function getSettings() {
  const r = await store.get(SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(r[SETTINGS] || {}) };
}

export async function setSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await store.set({ [SETTINGS]: next });
  return next;
}

// ---------- folders ----------

export async function getFolders() {
  const r = await store.get(FOLDERS);
  return r[FOLDERS] || {};
}

export async function saveFolders(folders) {
  await store.set({ [FOLDERS]: folders });
}

export async function createFolder(name, parentId = null) {
  const folders = await getFolders();
  const siblings = Object.values(folders).filter((f) => (f.parentId || null) === parentId);
  const folder = {
    id: uid('f'),
    name: name.trim() || 'Untitled folder',
    parentId,
    order: siblings.length ? Math.max(...siblings.map((f) => f.order || 0)) + 1 : 0,
    createdAt: Date.now(),
    description: '',
  };
  folders[folder.id] = folder;
  await saveFolders(folders);
  return folder;
}

export async function updateFolder(id, patch) {
  const folders = await getFolders();
  if (!folders[id]) return null;
  folders[id] = { ...folders[id], ...patch };
  await saveFolders(folders);
  return folders[id];
}

/** All descendant folder ids of `id` (including itself). */
export function folderSubtree(folders, id) {
  const out = [id];
  for (let i = 0; i < out.length; i++) {
    for (const f of Object.values(folders)) if (f.parentId === out[i]) out.push(f.id);
  }
  return out;
}

/** Path of folder names from the root, e.g. ["Machine learning", "Transformers"]. */
export function folderPath(folders, id) {
  const names = [];
  let cur = folders[id];
  let guard = 0;
  while (cur && guard++ < 50) {
    names.unshift(cur.name);
    cur = cur.parentId ? folders[cur.parentId] : null;
  }
  return names;
}

/** Delete a folder and its subfolders. Their videos move to the parent folder (or Unfiled). */
export async function deleteFolder(id) {
  const folders = await getFolders();
  const target = folders[id];
  if (!target) return;
  const doomed = new Set(folderSubtree(folders, id));
  const dest = target.parentId || null;
  const videos = await getAllVideos();
  const updates = {};
  for (const v of videos) {
    if (v.folderId && doomed.has(v.folderId)) updates[vKey(v.videoId)] = { ...v, folderId: dest, _w: WRITER };
  }
  for (const fid of doomed) delete folders[fid];
  await store.set({ ...updates, [FOLDERS]: folders });
}

// ---------- videos ----------

async function allKeys() {
  if (typeof store.getKeys === 'function') return store.getKeys();
  return Object.keys(await store.get(null));
}

export async function getVideo(videoId) {
  const r = await store.get(vKey(videoId));
  return r[vKey(videoId)] || null;
}

export async function getAllVideos() {
  const keys = (await allKeys()).filter((k) => k.startsWith('v:'));
  if (!keys.length) return [];
  const r = await store.get(keys);
  return Object.values(r);
}

export async function getPositions(videoIds) {
  const keys = videoIds ? videoIds.map(pKey) : (await allKeys()).filter((k) => k.startsWith('p:'));
  if (!keys.length) return {};
  const r = await store.get(keys);
  const out = {};
  for (const [k, v] of Object.entries(r)) out[k.slice(2)] = v;
  return out;
}

export function newVideoRecord(videoId, meta = {}) {
  const now = Date.now();
  return {
    videoId,
    title: meta.title || '',
    channel: meta.channel || '',
    duration: meta.duration || 0,
    folderId: meta.folderId ?? null,
    order: meta.order ?? now,
    done: false,
    summary: '',
    notes: [],
    transcriptInfo: null,
    addedAt: now,
    updatedAt: now,
  };
}

/** Next order value at the end of a folder. */
export async function nextOrder(folderId) {
  const vids = (await getAllVideos()).filter((v) => (v.folderId || null) === (folderId || null));
  return vids.length ? Math.max(...vids.map((v) => v.order || 0)) + 1 : 0;
}

/**
 * Read-modify-write a video. `fn` receives the current record (or a fresh one
 * when `create` is set) and returns the new record or mutates it in place.
 */
export async function updateVideo(videoId, fn, { create = false, meta = {} } = {}) {
  let rec = await getVideo(videoId);
  if (!rec) {
    if (!create) return null;
    rec = newVideoRecord(videoId, { ...meta, order: meta.order ?? (await nextOrder(meta.folderId ?? null)) });
  }
  const res = fn ? fn(rec) : undefined;
  const next = res && typeof res === 'object' ? res : rec;
  next.updatedAt = Date.now();
  next._w = WRITER;
  await store.set({ [vKey(videoId)]: next });
  return next;
}

export async function saveVideo(rec) {
  rec.updatedAt = Date.now();
  rec._w = WRITER;
  await store.set({ [vKey(rec.videoId)]: rec });
  return rec;
}

export async function deleteVideo(videoId) {
  await store.remove([vKey(videoId), tKey(videoId), pKey(videoId)]);
}

// ---------- notepad pages (free-form notes, not tied to a time) ----------

/** A video's notepad pages. Older records kept one `summary` text: that becomes Page 1. */
export function pagesOf(video) {
  if (video && Array.isArray(video.pages) && video.pages.length) return video.pages;
  return [{ id: 'p1', title: 'Page 1', text: (video && video.summary) || '' }];
}

function nextPageTitle(pages) {
  const used = pages.map((p) => +(/^Page (\d+)$/.exec(p.title) || [])[1] || 0);
  return `Page ${Math.max(pages.length, ...used) + 1}`;
}

export async function updatePage(videoId, pageId, patch) {
  return updateVideo(videoId, (v) => {
    v.pages = pagesOf(v).map((p) => (p.id === pageId ? { ...p, ...patch, updatedAt: Date.now() } : p));
    delete v.summary;
  });
}

export async function addPage(videoId) {
  let page = null;
  await updateVideo(videoId, (v) => {
    const pages = pagesOf(v);
    page = { id: uid('p'), title: nextPageTitle(pages), text: '', updatedAt: Date.now() };
    v.pages = [...pages, page];
    delete v.summary;
  });
  return page;
}

export async function deletePage(videoId, pageId) {
  return updateVideo(videoId, (v) => {
    const left = pagesOf(v).filter((p) => p.id !== pageId);
    v.pages = left.length ? left : [{ id: uid('p'), title: 'Page 1', text: '' }];
    delete v.summary;
  });
}

export async function addNote(videoId, { t, text = '' }, meta) {
  const note = { id: uid('n'), t: Math.max(0, t || 0), text, createdAt: Date.now(), updatedAt: Date.now() };
  await updateVideo(
    videoId,
    (v) => {
      v.notes = [...(v.notes || []), note].sort((a, b) => a.t - b.t);
      if (meta?.title && !v.title) v.title = meta.title;
      if (meta?.channel && !v.channel) v.channel = meta.channel;
      if (meta?.duration && !v.duration) v.duration = meta.duration;
    },
    { create: true, meta }
  );
  return note;
}

export async function updateNote(videoId, noteId, patch) {
  return updateVideo(videoId, (v) => {
    v.notes = (v.notes || [])
      .map((n) => (n.id === noteId ? { ...n, ...patch, updatedAt: Date.now() } : n))
      .sort((a, b) => a.t - b.t);
  });
}

export async function deleteNote(videoId, noteId) {
  return updateVideo(videoId, (v) => {
    v.notes = (v.notes || []).filter((n) => n.id !== noteId);
  });
}

// ---------- transcripts ----------

export async function getTranscript(videoId) {
  const r = await store.get(tKey(videoId));
  return r[tKey(videoId)] || null;
}

export async function getAllTranscripts() {
  const keys = (await allKeys()).filter((k) => k.startsWith('t:'));
  if (!keys.length) return {};
  const r = await store.get(keys);
  const out = {};
  for (const [k, v] of Object.entries(r)) out[k.slice(2)] = v;
  return out;
}

export async function saveTranscript(videoId, transcript, meta) {
  const tr = { ...transcript, capturedAt: Date.now() };
  await store.set({ [tKey(videoId)]: tr });
  await updateVideo(
    videoId,
    (v) => {
      v.transcriptInfo = {
        lang: tr.lang || '',
        label: tr.label || '',
        source: tr.source || '',
        count: tr.segments.length,
        capturedAt: tr.capturedAt,
      };
      if (meta?.title && !v.title) v.title = meta.title;
      if (meta?.channel && !v.channel) v.channel = meta.channel;
    },
    { create: true, meta }
  );
  return tr;
}

export async function deleteTranscript(videoId) {
  await store.remove(tKey(videoId));
  await updateVideo(videoId, (v) => {
    v.transcriptInfo = null;
  });
}

// ---------- backup ----------

export async function exportAll() {
  const all = await store.get(null);
  delete all.ai; // the Ask API key stays on this computer
  delete all.nsync; // so does the Notion sign-in
  delete all.fsync; // and which files this computer has synced
  return { app: 'lectern', version: 1, exportedAt: new Date().toISOString(), data: all };
}

/** Merge a backup into the current data. Newer video records win; notes are unioned by id. */
export async function importAll(backup) {
  if (!backup || typeof backup !== 'object' || !backup.data) throw new Error('This file is not a Lectern backup.');
  const incoming = backup.data;
  const current = await store.get(null);
  const out = {};
  for (const [k, val] of Object.entries(incoming)) {
    if (k === FOLDERS) {
      out[FOLDERS] = { ...(current[FOLDERS] || {}), ...(val || {}) };
    } else if (k === SETTINGS) {
      if (!current[SETTINGS]) out[SETTINGS] = val;
    } else if (k.startsWith('v:')) {
      const cur = current[k];
      if (!cur) out[k] = val;
      else {
        const byId = new Map((cur.notes || []).map((n) => [n.id, n]));
        for (const n of val.notes || []) {
          const mine = byId.get(n.id);
          if (!mine || (n.updatedAt || 0) > (mine.updatedAt || 0)) byId.set(n.id, n);
        }
        const newer = (val.updatedAt || 0) > (cur.updatedAt || 0) ? val : cur;
        out[k] = { ...newer, notes: [...byId.values()].sort((a, b) => a.t - b.t) };
      }
    } else if (k.startsWith('t:')) {
      if (!current[k]) out[k] = val;
    } else if (k.startsWith('p:')) {
      if (!current[k] || (val.at || 0) > (current[k].at || 0)) out[k] = val;
    }
  }
  await store.set(out);
  return Object.keys(out).filter((k) => k.startsWith('v:')).length;
}

/** Subscribe to storage changes. cb(changes) where changes is the chrome.storage changes object. */
export function onStorageChange(cb) {
  const listener = (changes, area) => {
    if (area === 'local') cb(changes);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/** True if this change for a video key came from this page itself. */
export function isOwnWrite(change) {
  return change && change.newValue && change.newValue._w === WRITER;
}
