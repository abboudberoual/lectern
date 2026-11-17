// Notion sync through Notion's hosted MCP server (https://mcp.notion.com/mcp).
//
// Connecting (from a click in the library): Chrome asks for access to mcp.notion.com, Lectern
// registers itself with Notion's sign-in server, and Notion's own sign-in page opens. Lectern
// gets a token that only works with Notion's MCP server, and stores it in this browser.
//
// Syncing (in the service worker): Lectern creates a private "Lectern" page, a page for each
// folder under it, and a page for each video under its folder. One-way: when notes change, the
// video's page content is replaced. Removing a video from Lectern leaves its Notion page alone.
//
// State in chrome.storage.local under `nsync`:
//   { client: { id, redirectUri, registrationEndpoint }, auth: { access, refresh, expiresAt, tokenEndpoint },
//     rootId, folders: { [folderId]: { id, name, parent } }, pages: { [videoId]: { id, hash, title, parent } },
//     includeTranscripts, lastSync, lastError, needsReconnect }

import { getAllTranscripts, getAllVideos, getFolders } from './db.js';
import { videoToMarkdown } from './util.js';

export const NSYNC = 'nsync';
const BASE = 'https://mcp.notion.com';
const MCP_URL = `${BASE}/mcp`;
const ORIGIN = `${BASE}/*`;
const PROTOCOL = '2025-06-18';

export class NotionError extends Error {
  constructor(message, kind = 'other') {
    super(message);
    this.kind = kind;
  }
}

// ---------- state

export async function getNotionSync() {
  return (await chrome.storage.local.get(NSYNC))[NSYNC] || null;
}

async function patchState(patch) {
  const cur = (await getNotionSync()) || {};
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ [NSYNC]: next });
  return next;
}

/** { state: 'off' | 'on' | 'error' | 'reconnect', rootId, rootUrl, lastSync, lastError, includeTranscripts } */
export async function notionStatus() {
  const st = await getNotionSync();
  if (!st || !st.auth) return { state: 'off', includeTranscripts: !!(st && st.includeTranscripts) };
  const base = { ...st, auth: undefined, client: undefined, rootUrl: st.rootId ? `https://www.notion.so/${st.rootId}` : '' };
  if (st.needsReconnect) return { ...base, state: 'reconnect' };
  return { ...base, state: st.lastError ? 'error' : 'on' };
}

// ---------- connecting (runs in an extension page)

/** Ask Chrome for access to Notion's MCP server. Call it straight from a click, before any await. */
export function requestNotionAccess() {
  return chrome.permissions.request({ origins: [ORIGIN] }).catch(() => false);
}

const b64url = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const randomString = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

/** Notion's sign-in endpoints: the resource metadata names the sign-in server, whose metadata names the rest. */
async function discover() {
  let issuer = null;
  // Notion documents the first address; the others are where the MCP spec says to look
  for (const u of [`${MCP_URL}/.well-known/oauth-protected-resource`, `${BASE}/.well-known/oauth-protected-resource/mcp`, `${BASE}/.well-known/oauth-protected-resource`]) {
    try {
      issuer = ((await getJson(u)).authorization_servers || [])[0] || null;
      if (issuer) break;
    } catch {
      /* try the next one */
    }
  }
  const iss = new URL(issuer || BASE);
  const path = iss.pathname.replace(/\/$/, '');
  const candidates = [`${iss.origin}/.well-known/oauth-authorization-server${path}`, `${iss.origin}${path}/.well-known/oauth-authorization-server`, `${BASE}/.well-known/oauth-authorization-server`];
  for (const u of candidates) {
    try {
      const meta = await getJson(u);
      if (meta.authorization_endpoint && meta.token_endpoint) return meta;
    } catch {
      /* try the next one */
    }
  }
  throw new NotionError('Couldn’t reach Notion. Check your connection and try again.', 'network');
}

async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new NotionError(`Notion didn’t accept Lectern (${res.status}).`, 'auth');
  return res.json();
}

async function postForm(url, fields) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(fields) });
}

/** The whole sign-in. Resolves when Lectern holds a token; the first sync then runs in the background. */
export async function connectNotion() {
  try {
    await signIn();
  } catch (e) {
    if (e instanceof NotionError) throw e;
    throw new NotionError('Couldn’t reach Notion’s sign-in. Check your connection and try again.', 'network');
  }
}

async function signIn() {
  const meta = await discover();
  const redirectUri = chrome.identity.getRedirectURL('notion');
  const st = (await getNotionSync()) || {};

  // Reuse the registration: registering again would orphan earlier sign-ins
  let client = st.client;
  if (!client || client.redirectUri !== redirectUri || client.registrationEndpoint !== meta.registration_endpoint) {
    if (!meta.registration_endpoint) throw new NotionError('Notion’s sign-in doesn’t accept new apps right now.', 'auth');
    const reg = await postJson(meta.registration_endpoint, {
      client_name: 'Lectern',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
    client = { id: reg.client_id, redirectUri, registrationEndpoint: meta.registration_endpoint };
    await patchState({ client });
  }

  const verifier = randomString(48);
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const state = randomString(16);
  const auth = new URL(meta.authorization_endpoint);
  auth.search = new URLSearchParams({
    response_type: 'code',
    client_id: client.id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    resource: MCP_URL,
  }).toString();

  let back;
  try {
    back = new URL(await chrome.identity.launchWebAuthFlow({ url: auth.href, interactive: true }));
  } catch {
    throw new NotionError('Notion sign-in was closed before it finished.', 'cancelled');
  }
  if (back.searchParams.get('error')) throw new NotionError('Notion didn’t give Lectern access.', 'denied');
  if (back.searchParams.get('state') !== state || !back.searchParams.get('code')) throw new NotionError('Notion sign-in didn’t finish properly. Try again.', 'auth');

  const res = await postForm(meta.token_endpoint, {
    grant_type: 'authorization_code',
    code: back.searchParams.get('code'),
    redirect_uri: redirectUri,
    client_id: client.id,
    code_verifier: verifier,
    resource: MCP_URL,
  });
  if (!res.ok) throw new NotionError('Notion sign-in didn’t finish properly. Try again.', 'auth');
  const tok = await res.json();
  await patchState({
    auth: { access: tok.access_token, refresh: tok.refresh_token || '', expiresAt: Date.now() + (tok.expires_in || 3600) * 1000, tokenEndpoint: meta.token_endpoint },
    needsReconnect: false,
    lastError: '',
  });
}

/** Stop syncing. Pages already in Notion stay; the registration is kept for next time. */
export async function disconnectNotion() {
  const st = await getNotionSync();
  if (st) await chrome.storage.local.set({ [NSYNC]: { client: st.client, includeTranscripts: st.includeTranscripts } });
  await chrome.permissions.remove({ origins: [ORIGIN] }).catch(() => {});
}

export async function setNotionOptions(patch) {
  await patchState(patch);
}

// ---------- tokens

let refreshing = null;

async function markReconnect() {
  await patchState({ needsReconnect: true, lastError: 'Notion signed Lectern out. Connect again in Settings.' });
}

async function refreshToken() {
  if (!refreshing) {
    refreshing = (async () => {
      const st = await getNotionSync();
      const a = st && st.auth;
      if (!a || !a.refresh) {
        await markReconnect();
        throw new NotionError('Connect Notion again in Settings.', 'auth');
      }
      const res = await postForm(a.tokenEndpoint, { grant_type: 'refresh_token', refresh_token: a.refresh, client_id: st.client.id, resource: MCP_URL }).catch(() => null);
      if (!res) throw new NotionError('Couldn’t reach Notion.', 'network');
      if (!res.ok) {
        await markReconnect();
        throw new NotionError('Notion signed Lectern out. Connect again in Settings.', 'auth');
      }
      const t = await res.json();
      // Notion rotates refresh tokens: keep the new one together with the new access token
      const auth = { ...a, access: t.access_token, refresh: t.refresh_token || a.refresh, expiresAt: Date.now() + (t.expires_in || 3600) * 1000 };
      await patchState({ auth });
      return auth.access;
    })().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

async function accessToken() {
  const st = await getNotionSync();
  const a = st && st.auth;
  if (!a) throw new NotionError('Connect Notion first.', 'auth');
  if (a.expiresAt - 60000 > Date.now()) return a.access;
  return refreshToken();
}

// ---------- MCP over Streamable HTTP

let session = null; // { id, protocol, tools }
let seq = 0;

// MCP servers refuse requests that carry a browser Origin header (their guard against DNS
// rebinding), and Chrome adds chrome-extension://… to this extension's own requests. This rule
// removes that header, only for Lectern's requests to Notion's MCP server.
const ORIGIN_RULE = 7101;
let originRule = null;

function stripOrigin() {
  if (!originRule) {
    originRule = chrome.declarativeNetRequest
      .updateSessionRules({
        removeRuleIds: [ORIGIN_RULE],
        addRules: [
          {
            id: ORIGIN_RULE,
            priority: 1,
            action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
            condition: { requestDomains: ['mcp.notion.com'], initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest', 'other'] },
          },
        ],
      })
      .catch(() => {
        originRule = null;
      });
  }
  return originRule;
}

/** Notion's stated reason for refusing a request, if it gave one. */
async function refusal(res) {
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      const m = (j.error && (j.error.message || j.error_description || (typeof j.error === 'string' ? j.error : ''))) || j.message || '';
      return String(m).slice(0, 160);
    } catch {
      return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    }
  } catch {
    return '';
  }
}

function parseEvent(block) {
  const data = block
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).replace(/^ /, ''))
    .join('\n');
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function readReply(res, id) {
  const type = res.headers.get('content-type') || '';
  if (!type.includes('text/event-stream')) return res.json();
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    let m;
    while ((m = /\r?\n\r?\n/.exec(buf))) {
      const msg = parseEvent(buf.slice(0, m.index));
      buf = buf.slice(m.index + m[0].length);
      if (msg && msg.id === id) {
        reader.cancel().catch(() => {});
        return msg;
      }
    }
    if (done) break;
  }
  const last = parseEvent(buf);
  if (last && last.id === id) return last;
  throw new NotionError('Notion sent a reply Lectern didn’t understand.', 'protocol');
}

async function rpc(method, params, { notify = false, retried = false } = {}) {
  const body = notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++seq, method, params };
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${await accessToken()}` };
  if (session && session.id && method !== 'initialize') headers['Mcp-Session-Id'] = session.id;
  if (session && session.protocol) headers['MCP-Protocol-Version'] = session.protocol;
  await stripOrigin();
  let res;
  try {
    res = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch {
    throw new NotionError('Couldn’t reach Notion.', 'network');
  }
  if (res.status === 401 && !retried) {
    await refreshToken();
    return rpc(method, params, { notify, retried: true });
  }
  if (res.status === 404 && session && method !== 'initialize' && !retried) {
    session = null; // the server forgot this session
    await ensureSession();
    return rpc(method, params, { notify, retried: true });
  }
  if (res.status === 401) {
    await markReconnect();
    throw new NotionError('Notion signed Lectern out. Connect again in Settings.', 'auth');
  }
  if (!res.ok && res.status !== 202) {
    const why = await refusal(res);
    throw new NotionError(`Notion refused the request (${res.status})${why ? `: ${why}` : ''}.`, 'http');
  }
  if (method === 'initialize') session = { id: res.headers.get('Mcp-Session-Id'), protocol: null, tools: null };
  if (notify) return null;
  const msg = await readReply(res, body.id);
  if (msg.error) throw new NotionError(msg.error.message || 'Notion returned an error.', 'rpc');
  return msg.result;
}

async function ensureSession() {
  if (session && session.protocol) return;
  const r = await rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'Lectern', version: chrome.runtime.getManifest().version } });
  session.protocol = (r && r.protocolVersion) || PROTOCOL;
  await rpc('notifications/initialized', {}, { notify: true });
  // Find the tools by what they do, in case Notion renames them
  const names = { create: 'notion-create-pages', update: 'notion-update-page', move: 'notion-move-pages' };
  try {
    const list = await rpc('tools/list', {});
    for (const t of (list && list.tools) || []) {
      if (/create[-_]pages$/.test(t.name)) names.create = t.name;
      else if (/update[-_]page$/.test(t.name)) names.update = t.name;
      else if (/move[-_]pages$/.test(t.name)) names.move = t.name;
    }
  } catch {
    /* keep the known names */
  }
  session.tools = names;
}

async function callTool(which, args) {
  await ensureSession();
  const r = await rpc('tools/call', { name: session.tools[which], arguments: args });
  const text = ((r && r.content) || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  if (r && r.isError) throw new NotionError(text || 'Notion couldn’t do that.', 'tool');
  return { text, structured: r && r.structuredContent };
}

// ---------- Notion operations

const ID = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/gi;
const normId = (s) => s.replace(/-/g, '').toLowerCase();

/** Page ids in a create result: structured data first, then JSON in the text, then any id in the text. */
function pageIds(result) {
  const ids = [];
  const visit = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach(visit);
    if (typeof o.id === 'string' && o.id.match(ID)) ids.push(normId(o.id.match(ID)[0]));
    else if (typeof o.url === 'string' && o.url.match(ID)) ids.push(normId(o.url.match(ID).pop()));
    for (const v of Object.values(o)) if (v && typeof v === 'object') visit(v);
  };
  visit(result.structured);
  if (!ids.length) {
    try {
      visit(JSON.parse(result.text));
    } catch {
      /* not JSON */
    }
  }
  if (!ids.length) for (const m of result.text.matchAll(ID)) ids.push(normId(m[0]));
  return ids;
}

async function createPage(parentId, title, content) {
  const args = { pages: [{ properties: { title }, content }], allow_async: false };
  if (parentId) args.parent = { type: 'page_id', page_id: parentId };
  const ids = pageIds(await callTool('create', args)).filter((id) => id !== parentId);
  if (!ids.length) throw new NotionError('Notion created a page but didn’t say which one.', 'protocol');
  return ids[0];
}

const setTitle = (id, title) => callTool('update', { page_id: id, command: 'update_properties', properties: { title } });
const setContent = (id, content) => callTool('update', { page_id: id, command: 'replace_content', new_str: content, allow_async: false });
const movePage = (id, parentId) => callTool('move', { page_or_database_ids: [id], new_parent: { type: 'page_id', page_id: parentId } });

const gone = (e) => e instanceof NotionError && e.kind === 'tool' && /not\s*found|could not find|does not exist|archived|deleted|in trash|no access/i.test(e.message);

// ---------- content

const ROOT_INTRO = 'Notes from Lectern. Each folder has a page here, and each video a page inside its folder. Lectern keeps them up to date, so make changes in Lectern.';
const FOOTER = '\n\n---\n*Synced from Lectern. Changes made here are replaced the next time these notes change.*';

function videoContent(video, transcript, includeTranscript) {
  const md = videoToMarkdown(video, transcript, { includeTranscript });
  // The page title is the video title; keep the channel and link line
  return md.replace(/^# .*\n+/, '').trim() + FOOTER;
}

function fingerprint(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36) + ':' + str.length;
}

function byDepth(folders) {
  const depth = (id) => {
    let d = 0;
    for (let f = folders[id]; f && f.parentId && d < 50; f = folders[f.parentId]) d++;
    return d;
  };
  return Object.keys(folders).sort((a, b) => depth(a) - depth(b));
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- sync

async function syncOnce() {
  let st = await getNotionSync();
  if (!st || !st.auth) return 'off';
  if (st.needsReconnect) return 'reconnect';
  if (!(await chrome.permissions.contains({ origins: [ORIGIN] }).catch(() => false))) {
    await patchState({ lastError: 'Chrome no longer lets Lectern reach Notion. Connect again in Settings.', needsReconnect: true });
    return 'reconnect';
  }
  const [folders, videos, transcripts] = await Promise.all([getFolders(), getAllVideos(), st.includeTranscripts ? getAllTranscripts() : {}]);
  const fmap = { ...(st.folders || {}) };
  const pages = { ...(st.pages || {}) };
  const save = async (extra = {}) => (st = await patchState({ folders: fmap, pages, ...extra }));

  if (!st.rootId) await save({ rootId: await createPage(null, 'Lectern', ROOT_INTRO) });

  // Folders, parents before children
  for (const fid of byDepth(folders)) {
    const f = folders[fid];
    const parent = f.parentId && fmap[f.parentId] ? fmap[f.parentId].id : st.rootId;
    const cur = fmap[fid];
    if (!cur) {
      fmap[fid] = { id: await createPage(parent, f.name, (f.description || '').trim()), name: f.name, parent };
      await save();
      await pause(200);
      continue;
    }
    try {
      if (cur.name !== f.name) await setTitle(cur.id, f.name);
      if (cur.parent !== parent) await movePage(cur.id, parent);
    } catch (e) {
      if (!gone(e)) throw e;
      cur.id = await createPage(parent, f.name, (f.description || '').trim()); // deleted in Notion: make it again
    }
    fmap[fid] = { id: cur.id, name: f.name, parent };
  }
  for (const fid of Object.keys(fmap)) if (!folders[fid]) delete fmap[fid];
  await save();

  // Videos
  for (const v of videos) {
    const parent = v.folderId && fmap[v.folderId] ? fmap[v.folderId].id : st.rootId;
    const title = v.title || v.videoId;
    const content = videoContent(v, transcripts[v.videoId], st.includeTranscripts);
    const hash = fingerprint(content);
    const cur = pages[v.videoId];
    if (cur && cur.hash === hash && cur.title === title && cur.parent === parent) continue;
    if (!cur) {
      pages[v.videoId] = { id: await createPage(parent, title, content), hash, title, parent };
    } else {
      try {
        if (cur.parent !== parent) await movePage(cur.id, parent);
        if (cur.title !== title) await setTitle(cur.id, title);
        if (cur.hash !== hash) await setContent(cur.id, content);
        pages[v.videoId] = { id: cur.id, hash, title, parent };
      } catch (e) {
        if (!gone(e)) throw e;
        pages[v.videoId] = { id: await createPage(parent, title, content), hash, title, parent };
      }
    }
    await save();
    await pause(200);
  }
  const live = new Set(videos.map((v) => v.videoId));
  for (const id of Object.keys(pages)) if (!live.has(id)) delete pages[id]; // its Notion page stays
  await save({ lastSync: Date.now(), lastError: '' });
  return 'ok';
}

let running = null;
let again = false;
let timer = null;

/** Run a sync now, or queue one if a sync is already running. */
export function runNotionSync() {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      return await syncOnce();
    } catch (e) {
      const root = e instanceof NotionError && e.kind === 'tool' && /parent/i.test(e.message) && gone(e);
      // The Lectern page itself was deleted in Notion: start over with a new one next time
      await patchState(root ? { rootId: null, folders: {}, pages: {}, lastError: '' } : { lastError: e.message || String(e) });
      if (root) again = true;
      return root ? 'retry' : 'error';
    } finally {
      running = null;
      if (again) {
        again = false;
        scheduleNotionSync(500);
      }
    }
  })();
  return running;
}

export function scheduleNotionSync(ms = 6000) {
  clearTimeout(timer);
  timer = setTimeout(() => runNotionSync(), ms);
}

/** Whether a storage change should start a sync. */
export function notionCares(changes, includeTranscripts) {
  return Object.keys(changes).some((k) => k.startsWith('v:') || k === 'folders' || (includeTranscripts && k.startsWith('t:')));
}
