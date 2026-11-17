// The Sync section of Settings: a Markdown folder (Obsidian and friends) and Notion.

import { FSYNC, chooseSyncFolder, folderSyncStatus, resumeFolderSync, setFolderSyncOptions, stopFolderSync, syncToFolder } from '../shared/foldersync.js';
import { NSYNC, connectNotion, disconnectNotion, notionStatus, requestNotionAccess, setNotionOptions } from '../shared/notion.js';
import { askConfirm, showToast } from '../shared/ui.js';
import { h, relativeTime } from '../shared/util.js';

const kickNotion = () => chrome.runtime.sendMessage({ type: 'notionSync' }).catch(() => {});

function transcriptToggle(checked, onChange) {
  const input = h('input', { type: 'checkbox', checked: !!checked });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'sync-check' }, input, h('span', null, 'Include transcripts'));
}

const lastSynced = (ts) => (ts ? ` Last synced ${relativeTime(ts)}.` : '');

export function createSyncSection() {
  const folderBox = h('div', { class: 'sync-target', 'data-target': 'folder' });
  const notionBox = h('div', { class: 'sync-target', 'data-target': 'notion' });
  const el = h(
    'div',
    { class: 'set-field set-sync' },
    h('strong', null, 'Sync'),
    h('small', null, 'Keep a copy of your notes in another notes app. Sync goes one way: Lectern replaces its copies when your notes change, so make edits here.'),
    folderBox,
    notionBox
  );

  let folderBusy = false;
  async function renderFolder(message) {
    const s = await folderSyncStatus();
    const head = h('div', { class: 'sync-head' }, h('span', { class: 'sync-name' }, 'Markdown folder'), h('span', { class: `sync-state ${s.state}` }));
    const status = h('p', { class: 'sync-status', role: 'status' });
    const actions = h('div', { class: 'set-actions' });
    if (s.state === 'off') {
      status.textContent = message || 'For Obsidian, Logseq and other apps that read a folder of Markdown files. Lectern writes one file per video.';
      actions.append(
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: async () => {
              try {
                folderBusy = true;
                const r = await chooseSyncFolder();
                showToast(r === 'ok' ? 'Folder sync is on' : 'Couldn’t write to that folder');
              } catch (e) {
                if (e && e.name !== 'AbortError') showToast('Couldn’t use that folder.');
              } finally {
                folderBusy = false;
                renderFolder();
              }
            },
          },
          'Choose folder…'
        )
      );
      folderBox.replaceChildren(head, status, actions);
      return;
    }
    if (s.state === 'paused') {
      status.textContent = `Paused. Chrome needs your OK to keep writing to “${s.name}”.`;
      actions.append(
        h('button', { class: 'btn', type: 'button', onclick: async () => (await resumeFolderSync()) ? showToast('Folder sync resumed') : renderFolder() }, 'Resume')
      );
    } else {
      status.textContent = s.state === 'error' ? `Couldn’t write to “${s.name}”: ${s.lastError}` : `Writing to “${s.name}/Lectern”.${lastSynced(s.lastSync)}`;
      actions.append(
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: async () => {
              const r = await syncToFolder();
              showToast(r === 'ok' ? 'Folder is up to date' : r === 'paused' ? 'Folder sync is paused' : 'Couldn’t sync the folder');
            },
          },
          'Sync now'
        )
      );
    }
    actions.append(
      h(
        'button',
        {
          class: 'btn quiet danger',
          type: 'button',
          onclick: async () => {
            if (!(await askConfirm('Stop syncing to this folder?', 'The files already there stay where they are.', { confirm: 'Stop syncing' }))) return;
            await stopFolderSync();
            renderFolder();
          },
        },
        'Stop syncing'
      )
    );
    folderBox.replaceChildren(head, status, actions, transcriptToggle(s.includeTranscripts, (on) => setFolderSyncOptions({ includeTranscripts: on })));
  }

  async function renderNotion(message) {
    const s = await notionStatus();
    const head = h('div', { class: 'sync-head' }, h('span', { class: 'sync-name' }, 'Notion'), h('span', { class: `sync-state ${s.state}` }));
    const status = h('p', { class: 'sync-status', role: 'status' });
    const actions = h('div', { class: 'set-actions' });
    const connectBtn = (label) =>
      h(
        'button',
        {
          class: 'btn',
          type: 'button',
          onclick: async (e) => {
            const access = requestNotionAccess(); // Chrome's prompt has to come straight from the click
            const btn = e.currentTarget;
            btn.disabled = true;
            try {
              if (!(await access)) {
                renderNotion('Notion sync needs your permission to reach mcp.notion.com. Click Connect again and choose Allow.');
                return;
              }
              await connectNotion();
              kickNotion();
              showToast('Notion is connected');
              renderNotion();
            } catch (err) {
              renderNotion(err.message || 'Couldn’t connect to Notion.');
            } finally {
              btn.disabled = false;
            }
          },
        },
        label
      );
    if (s.state === 'off') {
      status.textContent = message || 'Lectern creates a private “Lectern” page in your Notion, with a page for each folder and video inside it. You sign in on Notion’s own page.';
      if (message) status.classList.add('error');
      actions.append(connectBtn('Connect Notion'));
      notionBox.replaceChildren(head, status, actions);
      return;
    }
    if (s.state === 'reconnect') {
      status.textContent = message || s.lastError || 'Notion signed Lectern out.';
      status.classList.add('error');
      actions.append(connectBtn('Connect again'));
    } else {
      if (s.state === 'error') {
        status.textContent = `Last sync didn’t finish: ${s.lastError}`;
        status.classList.add('error');
      } else if (!s.lastSync) status.textContent = 'Setting up your Lectern page in Notion…';
      else status.append(`Syncing to the “Lectern” page in Notion.${lastSynced(s.lastSync)} `, s.rootUrl ? h('a', { href: s.rootUrl, target: '_blank', rel: 'noopener' }, 'Open in Notion') : '');
      actions.append(
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: async () => {
              const r = await chrome.runtime.sendMessage({ type: 'notionSync' }).catch(() => null);
              const result = r && r.result;
              showToast(result === 'ok' ? 'Notion is up to date' : result === 'reconnect' ? 'Connect Notion again' : 'Notion sync didn’t finish');
            },
          },
          'Sync now'
        )
      );
    }
    actions.append(
      h(
        'button',
        {
          class: 'btn quiet danger',
          type: 'button',
          onclick: async () => {
            if (!(await askConfirm('Disconnect Notion?', 'Pages Lectern already made in Notion stay there.', { confirm: 'Disconnect' }))) return;
            await disconnectNotion();
            renderNotion();
          },
        },
        'Disconnect'
      )
    );
    notionBox.replaceChildren(
      head,
      status,
      actions,
      transcriptToggle(s.includeTranscripts, async (on) => {
        await setNotionOptions({ includeTranscripts: on });
        kickNotion();
      })
    );
  }

  const onChange = (changes, area) => {
    if (area !== 'local') return;
    if (changes[FSYNC] && !folderBusy) renderFolder();
    if (changes[NSYNC]) renderNotion();
  };
  chrome.storage.onChanged.addListener(onChange);
  el.cleanup = () => chrome.storage.onChanged.removeListener(onChange);
  renderFolder();
  renderNotion();
  return el;
}
