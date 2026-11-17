// Folder sync: one Markdown file per video, kept up to date in a folder the person picks
// (an Obsidian vault, a Logseq graph, or any folder of Markdown files).
//
// One-way: Lectern writes the files, and replaces them when the notes change. Files live under
// <chosen folder>/Lectern/<Lectern folder path>/<video title>.md. Removing a video from Lectern
// leaves its file alone. Runs in extension pages (the panel and the library), because Chrome only
// lets a page ask for folder access.
//
// State in chrome.storage.local under `fsync`:
//   { name, includeTranscripts, files: { [videoId]: { path, hash } }, lastSync, lastError }
// The folder handle itself is kept in IndexedDB, the only place a handle can be stored.

import { folderPath, getAllTranscripts, getAllVideos, getFolders } from './db.js';
import { debounce, safeFilename, videoToMarkdown, watchUrl } from './util.js';

export const FSYNC = 'fsync';
const ROOT = 'Lectern';
const LOCK = 'lectern-folder-sync';
const HANDLE_KEY = 'syncFolder';

// ---------- IndexedDB for the folder handle

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('lectern', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('handles');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb(mode, fn) {
  const db = await openIdb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('handles', mode);
      const req = fn(tx.objectStore('handles'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

const getHandle = () => idb('readonly', (s) => s.get(HANDLE_KEY)).catch(() => null);
const putHandle = (dir) => idb('readwrite', (s) => s.put(dir, HANDLE_KEY));
const dropHandle = () => idb('readwrite', (s) => s.delete(HANDLE_KEY)).catch(() => {});

// ---------- state

export async function getFolderSync() {
  return (await chrome.storage.local.get(FSYNC))[FSYNC] || null;
}

async function patchState(patch) {
  const cur = (await getFolderSync()) || {};
  await chrome.storage.local.set({ [FSYNC]: { ...cur, ...patch } });
}

export async function setFolderSyncOptions(patch) {
  if (!(await getFolderSync())) return;
  await patchState(patch);
  return syncToFolder();
}

/** { state: 'off' | 'paused' | 'on' | 'error', name, lastSync, lastError, includeTranscripts } */
export async function folderSyncStatus() {
  const st = await getFolderSync();
  if (!st) return { state: 'off' };
  const dir = await getHandle();
  if (!dir) return { ...st, state: 'off' };
  const perm = await dir.queryPermission({ mode: 'readwrite' }).catch(() => 'denied');
  if (perm !== 'granted') return { ...st, state: 'paused' };
  return { ...st, state: st.lastError ? 'error' : 'on' };
}

// ---------- choosing, resuming, stopping (these three must run from a click)

export async function chooseSyncFolder() {
  const dir = await window.showDirectoryPicker({ id: 'lectern-sync', mode: 'readwrite' });
  await putHandle(dir);
  const prev = await getFolderSync();
  await chrome.storage.local.set({
    [FSYNC]: { name: dir.name, includeTranscripts: !!(prev && prev.includeTranscripts), files: {}, lastSync: 0, lastError: '' },
  });
  return syncToFolder();
}

export async function resumeFolderSync() {
  const dir = await getHandle();
  if (!dir) return false;
  const perm = await dir.requestPermission({ mode: 'readwrite' }).catch(() => 'denied');
  if (perm !== 'granted') return false;
  await syncToFolder();
  return true;
}

export async function stopFolderSync() {
  await dropHandle();
  await chrome.storage.local.remove(FSYNC);
}

// ---------- what goes where

const segment = (s) => safeFilename(s).replace(/^[.\s]+/, '').trim() || 'Untitled';

/** videoId → path parts under the Lectern folder, e.g. ["Machine learning", "Backprop.md"]. */
function planPaths(folders, videos) {
  const used = new Map();
  const out = new Map();
  for (const v of [...videos].sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0) || a.videoId.localeCompare(b.videoId))) {
    const dirs = v.folderId && folders[v.folderId] ? folderPath(folders, v.folderId).map(segment) : ['Unfiled'];
    const key = dirs.join('/').toLowerCase();
    if (!used.has(key)) used.set(key, new Set());
    const base = segment(v.title || v.videoId);
    let name = `${base}.md`;
    if (used.get(key).has(name.toLowerCase())) name = `${base} (${v.videoId}).md`;
    used.get(key).add(name.toLowerCase());
    out.set(v.videoId, [...dirs, name]);
  }
  return out;
}

const yaml = (s) => JSON.stringify(String(s));

function fileText(video, transcript, folders, includeTranscript) {
  const front = ['---', `title: ${yaml(video.title || video.videoId)}`];
  if (video.channel) front.push(`channel: ${yaml(video.channel)}`);
  front.push(`url: ${watchUrl(video.videoId)}`);
  if (video.folderId && folders[video.folderId]) front.push(`lectern_folder: ${yaml(folderPath(folders, video.folderId).join(' / '))}`);
  if (video.updatedAt) front.push(`updated: ${new Date(video.updatedAt).toISOString().slice(0, 10)}`);
  front.push('tags: [lectern]', '---', '');
  return (
    front.join('\n') +
    videoToMarkdown(video, transcript, { includeTranscript }).trimEnd() +
    '\n\n---\n*Synced from Lectern. Edit these notes in Lectern: changes made here are replaced the next time they sync.*\n'
  );
}

/** A short content fingerprint (cyrb53), so unchanged files aren't rewritten. */
function fingerprint(str) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

async function writeFile(root, parts, text) {
  let dir = root;
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
  const file = await dir.getFileHandle(parts[parts.length - 1], { create: true });
  const w = await file.createWritable();
  await w.write(text);
  await w.close();
}

/** Remove an old file after a rename or move, then any folders that left empty. */
async function removeFile(root, parts) {
  const chain = [root];
  try {
    for (const p of parts.slice(0, -1)) chain.push(await chain[chain.length - 1].getDirectoryHandle(p));
    await chain[chain.length - 1].removeEntry(parts[parts.length - 1]);
  } catch {
    return; // already gone
  }
  for (let i = chain.length - 1; i > 0; i--) {
    for await (const _ of chain[i].keys()) return; // not empty: stop here
    await chain[i - 1].removeEntry(parts[i - 1]).catch(() => {});
  }
}

// ---------- the sync itself

/** Bring the folder up to date. Resolves to 'off', 'paused', 'ok' or 'error'. */
export async function syncToFolder() {
  if (!(await getFolderSync())) return 'off';
  const dir = await getHandle();
  if (!dir) return 'off';
  if ((await dir.queryPermission({ mode: 'readwrite' }).catch(() => 'denied')) !== 'granted') return 'paused';
  return navigator.locks.request(LOCK, async () => {
    const st = await getFolderSync();
    if (!st) return 'off';
    try {
      const [folders, videos, transcripts] = await Promise.all([getFolders(), getAllVideos(), st.includeTranscripts ? getAllTranscripts() : {}]);
      const root = await dir.getDirectoryHandle(ROOT, { create: true });
      const files = { ...(st.files || {}) };
      const paths = planPaths(folders, videos);
      for (const v of videos) {
        const parts = paths.get(v.videoId);
        const path = parts.join('/');
        const text = fileText(v, transcripts[v.videoId], folders, st.includeTranscripts);
        const hash = fingerprint(text);
        const prev = files[v.videoId];
        if (prev && prev.hash === hash && prev.path === path) continue;
        await writeFile(root, parts, text);
        if (prev && prev.path !== path) await removeFile(root, prev.path.split('/'));
        files[v.videoId] = { path, hash };
      }
      const live = new Set(videos.map((v) => v.videoId));
      for (const id of Object.keys(files)) if (!live.has(id)) delete files[id]; // its file stays
      await patchState({ files, lastSync: Date.now(), lastError: '' });
      return 'ok';
    } catch (e) {
      await patchState({ lastError: e && e.message ? e.message : String(e) });
      return 'error';
    }
  });
}

/** Keep the folder in step while this page is open. onStatus(status) after each run. */
export function startFolderSync({ onStatus } = {}) {
  const run = debounce(async () => {
    const r = await syncToFolder().catch(() => 'error');
    if (onStatus) onStatus(r);
  }, 1200);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (Object.keys(changes).some((k) => k.startsWith('v:') || k.startsWith('t:') || k === 'folders')) run();
  });
  setTimeout(run, 600);
  return run;
}
