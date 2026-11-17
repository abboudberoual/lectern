// One description of a notes page, rendered to Markdown, Word (docx.js) and the PDF print page.
//
// Blocks: { t: 'h1' | 'h2' | 'h3' | 'h4' | 'p' | 'li' | 'meta', text?, runs? }
// Runs:   { text, href?, time?, bold? }   ("\n" inside text is a line break)

import { folderPath, folderSubtree, pagesOf } from './db.js';
import { formatTime, videoToMarkdown, watchUrl } from './util.js';

const run = (text, extra) => ({ text, ...extra });

/** Text with **bold** marked the Markdown way (answers saved from Ask use it) → runs. */
function inline(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(/\*\*(?=\S)(.+?\S)\*\*/g)) {
    if (m.index > last) out.push(run(text.slice(last, m.index)));
    out.push(run(m[1], { bold: true }));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(run(text.slice(last)));
  return out.length ? out : [run('')];
}

/** Videos grouped by folder id ('' for unfiled), each list in study order. */
export function videosByFolder(videos) {
  const out = new Map();
  for (const v of videos) {
    const k = v.folderId || '';
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(v);
  }
  for (const list of out.values()) list.sort((a, b) => (a.order ?? 1e15) - (b.order ?? 1e15) || (a.addedAt || 0) - (b.addedAt || 0));
  return out;
}

function sortedNotes(video) {
  return [...(video.notes || [])].sort((a, b) => a.t - b.t);
}

function filledPages(video) {
  return pagesOf(video).filter((p) => (p.text || '').trim());
}

/** A notepad page's text as paragraphs and list items. */
function textBlocks(text) {
  const out = [];
  let para = [];
  const flush = () => {
    if (para.length) out.push({ t: 'p', runs: inline(para.join('\n')) });
    para = [];
  };
  for (const line of text.replace(/\r/g, '').split('\n')) {
    const item = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      out.push({ t: 'li', runs: inline(item[1]) });
    } else if (!line.trim()) flush();
    else para.push(line);
  }
  flush();
  return out;
}

export function videoBlocks(video, transcript, { includeTranscript = false, level = 1 } = {}) {
  const H = (n) => 'h' + Math.min(4, level + n - 1);
  const url = watchUrl(video.videoId);
  const out = [
    { t: H(1), text: video.title || video.videoId },
    { t: 'meta', runs: [...(video.channel ? [run(`${video.channel} — `)] : []), run(url, { href: url })] },
  ];
  const notes = sortedNotes(video);
  if (notes.length) {
    out.push({ t: H(2), text: 'Time notes' });
    for (const n of notes) {
      const body = (n.text || '').trim() || '(marked moment)';
      out.push({ t: 'li', runs: [run(formatTime(n.t), { href: watchUrl(video.videoId, n.t), time: true }), ...inline(' ' + body)] });
    }
  }
  const pages = filledPages(video);
  if (pages.length) {
    out.push({ t: H(2), text: 'Notepad' });
    const many = pagesOf(video).length > 1;
    for (const p of pages) {
      if (many) out.push({ t: H(3), text: p.title });
      out.push(...textBlocks(p.text.trim()));
    }
  }
  const segs = includeTranscript && transcript && transcript.segments;
  if (segs && segs.length) {
    out.push({ t: H(2), text: 'Transcript' });
    for (const s of segs) out.push({ t: 'p', runs: [run(formatTime(s.t), { href: watchUrl(video.videoId, s.t), time: true }), run(' ' + s.text)] });
  }
  return out;
}

export function folderBlocks(folders, rootId, videos, transcripts, { includeTranscript = false } = {}) {
  const byFolder = videosByFolder(videos);
  const root = folders[rootId];
  const out = [{ t: 'h1', text: root.name }];
  if ((root.description || '').trim()) out.push({ t: 'meta', runs: [run(root.description.trim())] });
  const rootDepth = folderPath(folders, rootId).length;
  for (const fid of folderSubtree(folders, rootId)) {
    const vids = byFolder.get(fid) || [];
    if (!vids.length) continue;
    if (fid !== rootId) out.push({ t: 'h2', text: folderPath(folders, fid).slice(rootDepth).join(' / ') });
    for (const v of vids) out.push(...videoBlocks(v, transcripts && transcripts[v.videoId], { includeTranscript, level: fid === rootId ? 2 : 3 }));
  }
  return out;
}

// ---------- Markdown (videos use videoToMarkdown, which keeps notepad text exactly as typed)

export function folderMarkdown(folders, rootId, videos, transcripts, { includeTranscript = false } = {}) {
  const byFolder = videosByFolder(videos);
  const rootDepth = folderPath(folders, rootId).length;
  const parts = [`# ${folders[rootId].name}`, ''];
  if ((folders[rootId].description || '').trim()) parts.push(folders[rootId].description.trim(), '');
  for (const fid of folderSubtree(folders, rootId)) {
    const vids = byFolder.get(fid) || [];
    if (!vids.length) continue;
    const top = fid === rootId;
    if (!top) parts.push(`## ${folderPath(folders, fid).slice(rootDepth).join(' / ')}`, '');
    for (const v of vids) {
      const md = videoToMarkdown(v, transcripts && transcripts[v.videoId], { includeTranscript });
      const shift = top ? 1 : 2;
      parts.push(md.replace(/^(#{1,6}) /gm, (m, hashes) => `${'#'.repeat(Math.min(6, hashes.length + shift))} `), '');
    }
  }
  return parts.join('\n');
}

// ---------- HTML (the PDF print page)

export function blocksToNodes(blocks, h) {
  const nodes = [];
  let list = null;
  const runsTo = (runs) =>
    runs.flatMap((r) => {
      const parts = r.text.split('\n').flatMap((s, i) => (i ? [h('br'), s] : [s]));
      if (r.href) return [h('a', { href: r.href, class: r.time ? 'ts' : null }, ...parts)];
      return r.bold ? [h('strong', null, ...parts)] : parts;
    });
  for (const b of blocks) {
    if (b.t === 'li') {
      if (!list) nodes.push((list = h('ul')));
      list.append(h('li', null, ...runsTo(b.runs)));
      continue;
    }
    list = null;
    if (b.t[0] === 'h') nodes.push(h(b.t, null, b.text));
    else nodes.push(h('p', { class: b.t === 'meta' ? 'meta' : null }, ...runsTo(b.runs)));
  }
  return nodes;
}
