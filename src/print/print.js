// Print-ready notes page. Chrome's print window saves it as a PDF, links included.
//   print.html?video=<id>[&transcript=1]   or   print.html?folder=<id>[&transcript=1]
//   &noprint=1 skips opening the print window (used by tests)

import { getAllTranscripts, getAllVideos, getFolders, getTranscript, getVideo } from '../shared/db.js';
import { blocksToNodes, folderBlocks, videoBlocks } from '../shared/doc.js';
import { h } from '../shared/util.js';

const q = new URLSearchParams(location.search);
const includeTranscript = q.get('transcript') === '1';
const docEl = document.getElementById('doc');

async function build() {
  if (q.get('video')) {
    const id = q.get('video');
    const video = await getVideo(id);
    if (!video) return null;
    const transcript = includeTranscript ? await getTranscript(id) : null;
    return { title: video.title || id, blocks: videoBlocks(video, transcript, { includeTranscript }) };
  }
  if (q.get('folder')) {
    const [folders, videos, transcripts] = await Promise.all([getFolders(), getAllVideos(), includeTranscript ? getAllTranscripts() : null]);
    const folder = folders[q.get('folder')];
    if (!folder) return null;
    return { title: folder.name, blocks: folderBlocks(folders, folder.id, videos, transcripts, { includeTranscript }) };
  }
  return null;
}

document.getElementById('printBtn').addEventListener('click', () => window.print());

const doc = await build();
if (!doc) {
  docEl.append(h('p', { class: 'empty' }, 'These notes are no longer in your library.'));
  document.getElementById('printBtn').disabled = true;
} else {
  document.title = doc.title; // Chrome suggests the title as the PDF's file name
  docEl.append(...blocksToNodes(doc.blocks, h));
  await document.fonts.ready;
  if (q.get('noprint') !== '1') setTimeout(() => window.print(), 150);
}
