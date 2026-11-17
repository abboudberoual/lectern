// Service worker: opens the side panel, handles the keyboard shortcut, and
// runs transcript capture in YouTube tabs.
import { addNote, getSettings, getVideo, saveTranscript } from './shared/db.js';
import { fetchVideoMeta, formatTime } from './shared/util.js';
import { extractTranscriptInPage } from './transcript.js';
import { NSYNC, getNotionSync, notionCares, runNotionSync, scheduleNotionSync } from './shared/notion.js';

const LIBRARY_URL = chrome.runtime.getURL('src/library/library.html');

async function setup() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {}
}
setup();

chrome.runtime.onInstalled.addListener(async (details) => {
  await setup();
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'open-library', title: 'Open library', contexts: ['action'] });
  });
  // Make the notebook work in YouTube tabs that were already open.
  const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
  for (const tab of tabs) {
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['src/content.css'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content.js'] });
    } catch {}
  }
  if (details.reason === 'install') chrome.tabs.create({ url: `${LIBRARY_URL}?welcome=1` });
});

// Notion sync: follow note changes, a few seconds after the last one
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || changes[NSYNC]) return;
  const st = await getNotionSync();
  if (st && st.auth && !st.needsReconnect && notionCares(changes, st.includeTranscripts)) scheduleNotionSync();
});
chrome.runtime.onStartup.addListener(() => scheduleNotionSync(5000));

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'open-library') openLibrary();
});

/** Focus the library tab if one is open (optionally navigating it), otherwise open one. */
export async function openLibrary(query = '', windowId) {
  const url = query ? `${LIBRARY_URL}?${query}` : LIBRARY_URL;
  let existing = null;
  try {
    // tabs.query can't see extension-page URLs without the broad "tabs" permission; getContexts can.
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
    existing = contexts.find((c) => c.documentUrl && c.documentUrl.startsWith(LIBRARY_URL) && c.tabId >= 0);
  } catch {}
  if (existing) {
    await chrome.tabs.update(existing.tabId, query ? { active: true, url } : { active: true });
    await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
  } else await chrome.tabs.create({ url, ...(windowId != null ? { windowId } : {}) });
}

// ---------- tab helpers ----------

async function tabState(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'getState' });
  } catch {
    try {
      await chrome.scripting.insertCSS({ target: { tabId }, files: ['src/content.css'] });
      await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content.js'] });
      return await chrome.tabs.sendMessage(tabId, { type: 'getState' });
    } catch {
      return null;
    }
  }
}

function toast(tabId, text) {
  chrome.tabs.sendMessage(tabId, { type: 'toast', text }).catch(() => {});
}

// ---------- transcript capture ----------

const inFlight = new Map();

export function captureTranscript(tabId, videoId, { vssId = '', auto = false } = {}) {
  const key = `${tabId}:${videoId}:${vssId}`;
  if (inFlight.has(key)) return inFlight.get(key);
  const job = (async () => {
    let res;
    try {
      const [inj] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: extractTranscriptInPage,
        args: [{ videoId, vssId, allowPanel: !auto }],
      });
      res = inj && inj.result;
    } catch (e) {
      return { ok: false, error: `Couldn't read the YouTube page (${e.message}). Reload the video and try again.` };
    }
    if (!res) return { ok: false, error: 'Couldn’t read the YouTube page. Reload the video and try again.' };
    if (!res.ok) return res;
    if (auto && !(await getVideo(videoId))) return { ok: false, error: 'Video was removed.' };
    await saveTranscript(
      videoId,
      { lang: res.lang, label: res.label, source: res.source, vssId: res.vssId, tracks: res.tracks, segments: res.segments },
      res.meta
    );
    return { ok: true, count: res.segments.length, label: res.label, source: res.source };
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, job);
  return job;
}

async function listTracks(tabId, videoId) {
  try {
    const [inj] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: extractTranscriptInPage,
      args: [{ videoId, listOnly: true }],
    });
    return inj && inj.result ? inj.result : { ok: false, tracks: [] };
  } catch (e) {
    return { ok: false, tracks: [], error: e.message };
  }
}

// ---------- mark moment (keyboard shortcut) ----------

async function markMoment(tab) {
  if (!tab || !tab.id) return;
  const st = await tabState(tab.id);
  if (!st || !st.videoId) return;
  if (st.ad || st.currentTime == null) {
    toast(tab.id, 'Wait for the ad to finish, then mark the moment.');
    return;
  }
  const settings = await getSettings();
  const t = Math.max(0, st.currentTime - (settings.leadSeconds || 0));
  const existed = await getVideo(st.videoId);
  let meta = { title: st.title, channel: st.channel, duration: st.duration || 0 };
  if (!existed && !meta.title) meta = { ...meta, ...((await fetchVideoMeta(st.videoId)) || {}) };
  const note = await addNote(st.videoId, { t, text: '' }, meta);
  toast(tab.id, `Marked ${formatTime(t)} in Lectern`);
  chrome.runtime.sendMessage({ type: 'noteAdded', videoId: st.videoId, noteId: note.id, tabId: tab.id }).catch(() => {});
  if (!existed && settings.autoTranscript) captureTranscript(tab.id, st.videoId, { auto: true });
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'mark-moment') return;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  markMoment(tab);
});

// ---------- messages ----------

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'openPanelAndCompose' && sender.tab) {
    // Must run synchronously inside the click's user gesture.
    chrome.sidePanel.open({ windowId: sender.tab.windowId }).catch(() => {});
    const pending = { tabId: sender.tab.id, videoId: msg.videoId, t: msg.t, at: Date.now() };
    chrome.storage.session.set({ pendingCompose: pending }).catch(() => {});
    chrome.runtime.sendMessage({ type: 'compose', ...pending }).catch(() => {});
    reply({ ok: true });
    return;
  }

  if (msg.type === 'autoCapture' && sender.tab) {
    captureTranscript(sender.tab.id, msg.videoId, { auto: true });
    reply({ ok: true });
    return;
  }

  if (msg.type === 'notionSync') {
    runNotionSync().then((result) => reply({ result }));
    return true;
  }

  if (msg.type === 'captureTranscript') {
    captureTranscript(msg.tabId, msg.videoId, { vssId: msg.vssId || '', auto: !!msg.auto }).then(reply);
    return true;
  }

  if (msg.type === 'listTracks') {
    listTracks(msg.tabId, msg.videoId).then(reply);
    return true;
  }

  if (msg.type === 'openLibrary') {
    openLibrary(msg.query || '', msg.windowId).then(() => reply({ ok: true }));
    return true;
  }
});
