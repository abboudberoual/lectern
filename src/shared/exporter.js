// Export a video's notes, or a whole folder's, as Markdown, Word or PDF.

import { getAllTranscripts, getAllVideos, getFolders, getTranscript, getVideo } from './db.js';
import { folderBlocks, folderMarkdown, videoBlocks } from './doc.js';
import { blocksToDocx } from './docx.js';
import { dialogShell } from './ui.js';
import { downloadText, h, safeFilename, videoToMarkdown } from './util.js';

export const FORMATS = [
  { id: 'md', label: 'Markdown' },
  { id: 'docx', label: 'Word' },
  { id: 'pdf', label: 'PDF' },
];

let lastFormat = 'md';

/** Ask which format, and whether to include transcripts. Resolves to { format, includeTranscript } or null. */
export function chooseExport(title, { transcriptLabel = 'Include the transcript', transcriptDefault = false } = {}) {
  return new Promise((resolve) => {
    let format = lastFormat;
    const seg = h('div', { class: 'segmented export-formats', role: 'radiogroup', 'aria-label': 'Format' });
    const hint = h('p', { class: 'export-hint' });
    const paint = () => {
      for (const b of seg.children) {
        const on = b.dataset.id === format;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', String(on));
      }
      hint.textContent =
        format === 'pdf'
          ? 'Opens a print-ready page. Choose “Save as PDF” as the destination.'
          : format === 'docx'
          ? 'Opens in Word, Google Docs, Pages and LibreOffice. Times are links to that moment in the video.'
          : 'Plain text with clickable times, for Obsidian, Notion and other notes apps.';
    };
    for (const f of FORMATS) {
      seg.append(
        h(
          'button',
          {
            type: 'button',
            role: 'radio',
            'data-id': f.id,
            onclick: () => {
              format = f.id;
              paint();
            },
          },
          f.label
        )
      );
    }
    const tr = h('input', { type: 'checkbox', checked: transcriptDefault });
    const body = h('div', { class: 'export-body' }, seg, hint, h('label', { class: 'set-row export-tr' }, tr, h('span', null, transcriptLabel)));
    const ok = h('button', { class: 'btn primary', type: 'button', onclick: () => dlg.close('ok') }, 'Export');
    const cancel = h('button', { class: 'btn', type: 'button', onclick: () => dlg.close('cancel') }, 'Cancel');
    const dlg = dialogShell(title, body, [cancel, ok]);
    dlg.classList.add('export-dlg');
    paint();
    dlg.addEventListener('close', () => {
      if (dlg.returnValue !== 'ok') return resolve(null);
      lastFormat = format;
      resolve({ format, includeTranscript: tr.checked });
    });
    ok.focus();
  });
}

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** target: { video: id } or { folder: id } */
export async function exportNotes(target, { format, includeTranscript }) {
  if (format === 'pdf') {
    const q = new URLSearchParams(target.video ? { video: target.video } : { folder: target.folder });
    if (includeTranscript) q.set('transcript', '1');
    await chrome.tabs.create({ url: chrome.runtime.getURL(`src/print/print.html?${q}`) });
    return;
  }
  if (target.video) {
    const video = await getVideo(target.video);
    if (!video) throw new Error('Save the video first.');
    const transcript = includeTranscript ? await getTranscript(target.video) : null;
    const name = safeFilename(video.title || video.videoId);
    if (format === 'md') downloadText(`${name}.md`, videoToMarkdown(video, transcript, { includeTranscript }), 'text/markdown');
    else downloadBlob(`${name}.docx`, blocksToDocx(videoBlocks(video, transcript, { includeTranscript }), { title: video.title || name }));
    return;
  }
  const [folders, videos, transcripts] = await Promise.all([getFolders(), getAllVideos(), includeTranscript ? getAllTranscripts() : null]);
  const folder = folders[target.folder];
  if (!folder) throw new Error('That folder no longer exists.');
  const name = safeFilename(folder.name);
  if (format === 'md') downloadText(`${name}.md`, folderMarkdown(folders, target.folder, videos, transcripts, { includeTranscript }), 'text/markdown');
  else downloadBlob(`${name}.docx`, blocksToDocx(folderBlocks(folders, target.folder, videos, transcripts, { includeTranscript }), { title: folder.name }));
}

/** The whole flow behind an "Export…" menu item. */
export async function exportFlow(target, title, { onError } = {}) {
  const choice = await chooseExport(title, { transcriptLabel: target.folder ? 'Include transcripts' : 'Include the transcript' });
  if (!choice) return;
  try {
    await exportNotes(target, choice);
  } catch (e) {
    if (onError) onError(e.message || 'Export failed.');
  }
}
