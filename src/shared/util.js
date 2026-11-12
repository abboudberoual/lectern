// Shared helpers for extension pages and the service worker (ES module).

export const REPO_URL = 'https://github.com/abboudberoual/lectern';

/**
 * Link to a new GitHub issue, prefilled through the repo's issue forms.
 * Nothing is sent until the person reviews the form and submits it themselves.
 */
export function issueUrl(template, { title = '', fields = {} } = {}) {
  const q = new URLSearchParams({ template });
  if (title) q.set('title', title);
  const manifest = globalThis.chrome?.runtime?.getManifest?.();
  const chromeVer = (globalThis.navigator?.userAgent || '').match(/Chrome\/(\d+)/);
  q.set('version', `${manifest ? manifest.version : '?'} · Chrome ${chromeVer ? chromeVer[1] : '?'}`);
  for (const [k, v] of Object.entries(fields)) if (v) q.set(k, String(v).slice(0, 1500));
  return `${REPO_URL}/issues/new?${q}`;
}

export function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

/** "1:02:03" | "2:03" | "45" | "1h2m3s" -> seconds, or null */
export function parseTime(str) {
  if (str == null) return null;
  const s = String(str).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  const hms = s.match(/^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?$/i);
  if (hms && (hms[1] || hms[2] || hms[3])) {
    return (+hms[1] || 0) * 3600 + (+hms[2] || 0) * 60 + (+hms[3] || 0);
  }
  const parts = s.split(':');
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + parseFloat(p), 0);
}

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function parseVideoId(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (ID_RE.test(s)) return s;
  let url;
  try {
    url = new URL(s.startsWith('http') ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\.|^m\.|^music\./, '');
  let id = null;
  if (host === 'youtu.be') {
    id = url.pathname.split('/')[1];
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else {
      const m = url.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/?#]+)/);
      if (m) id = m[1];
    }
  }
  return id && ID_RE.test(id) ? id : null;
}

/** Start time encoded in a YouTube URL (t= or start=), in seconds. */
export function parseUrlTime(input) {
  try {
    const url = new URL(String(input).trim());
    const t = url.searchParams.get('t') || url.searchParams.get('start');
    return t ? parseTime(t) : null;
  } catch {
    return null;
  }
}

export function watchUrl(videoId, t) {
  const base = `https://www.youtube.com/watch?v=${videoId}`;
  return t && t >= 1 ? `${base}&t=${Math.floor(t)}s` : base;
}

export function thumbUrl(videoId, size = 'mqdefault') {
  return `https://i.ytimg.com/vi/${videoId}/${size}.jpg`;
}

export function uid(prefix = '') {
  const r = crypto.getRandomValues(new Uint32Array(2));
  return prefix + Date.now().toString(36) + r[0].toString(36) + r[1].toString(36).slice(0, 4);
}

export function debounce(fn, ms) {
  let timer = null;
  let last = [];
  const wrapped = (...args) => {
    last = args;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...last);
    }, ms);
  };
  /** Run the pending call now (if any) with the latest arguments. */
  wrapped.flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      return fn(...last);
    }
  };
  return wrapped;
}

/** Tiny DOM builder: h('div', {class: 'x', onclick: fn}, 'text', child) */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'value' || k === 'checked') el[k] = v;
      else if (v === true) el.setAttribute(k, '');
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function relativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const min = 60e3;
  const hr = 60 * min;
  const day = 24 * hr;
  if (diff < min) return 'just now';
  if (diff < hr) return `${Math.floor(diff / min)} min ago`;
  if (diff < day) return `${Math.floor(diff / hr)} h ago`;
  if (diff < 2 * day) return 'yesterday';
  if (diff < 14 * day) return `${Math.floor(diff / day)} days ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function plural(n, one, many = one + 's') {
  return `${n} ${n === 1 ? one : many}`;
}

/** Fetch title/channel for a video via YouTube's public oEmbed endpoint. */
export async function fetchVideoMeta(videoId) {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watchUrl(videoId))}`,
      { credentials: 'omit' }
    );
    if (!res.ok) return null;
    const j = await res.json();
    return { title: j.title || '', channel: j.author_name || '' };
  } catch {
    return null;
  }
}

/**
 * Parse a transcript pasted by the user. Supports:
 *  - YouTube's panel copy ("0:00\ntext\n0:05\ntext")
 *  - "0:00 text" / "[00:00] text" / "(0:00) text" lines
 *  - SRT / WebVTT cues ("00:00:01,000 --> 00:00:04,000")
 * Returns [{t, d, text}] (d may be 0) or [] when nothing time-coded was found.
 */
export function parsePastedTranscript(raw) {
  const text = String(raw || '').replace(/\r/g, '');
  const lines = text.split('\n');
  const out = [];
  const cueRe = /^(\d{1,2}:)?\d{1,2}:\d{2}([.,]\d+)?\s*-->\s*((\d{1,2}:)?\d{1,2}:\d{2}([.,]\d+)?)/;
  const leadRe = /^[[(]?((?:\d{1,2}:)?\d{1,2}:\d{2})(?:[.,]\d+)?[\])]?\s*[-–—:]?\s*(.*)$/;
  let pending = null;

  const push = (t, d, body) => {
    const clean = body.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (clean) out.push({ t, d, text: clean });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line === 'WEBVTT' || /^\d+$/.test(line)) {
      if (pending && pending.body.length) {
        push(pending.t, pending.d, pending.body.join(' '));
        pending = null;
      }
      continue;
    }
    const cue = line.match(cueRe);
    if (cue) {
      if (pending && pending.body.length) push(pending.t, pending.d, pending.body.join(' '));
      const [a, b] = line.split('-->').map((x) => parseTime(x.trim().split(/\s/)[0].replace(',', '.')));
      pending = { t: a ?? 0, d: Math.max(0, (b ?? a) - a), body: [] };
      continue;
    }
    const lead = line.match(leadRe);
    if (lead && parseTime(lead[1]) != null) {
      if (pending && pending.body.length) push(pending.t, pending.d, pending.body.join(' '));
      pending = { t: parseTime(lead[1]), d: 0, body: lead[2] ? [lead[2]] : [] };
      continue;
    }
    if (pending) pending.body.push(line);
  }
  if (pending && pending.body.length) push(pending.t, pending.d, pending.body.join(' '));

  out.sort((a, b) => a.t - b.t);
  for (let i = 0; i < out.length; i++) {
    if (!out[i].d) out[i].d = i + 1 < out.length ? Math.max(0, out[i + 1].t - out[i].t) : 3;
  }
  return out;
}

/** Find the index of the segment/note that is "current" at time t (last item with item.t <= t). */
export function indexAtTime(items, t) {
  let lo = 0;
  let hi = items.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].t <= t + 0.25) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export function videoToMarkdown(video, transcript, { includeTranscript = false } = {}) {
  const lines = [];
  lines.push(`# ${video.title || video.videoId}`);
  lines.push('');
  lines.push(`${video.channel ? video.channel + ' — ' : ''}${watchUrl(video.videoId)}`);
  lines.push('');
  const notes = [...(video.notes || [])].sort((a, b) => a.t - b.t);
  if (notes.length) {
    lines.push('## Time notes');
    lines.push('');
    for (const n of notes) {
      const body = (n.text || '').trim() || '(marked moment)';
      const [first, ...rest] = body.split('\n');
      lines.push(`- [${formatTime(n.t)}](${watchUrl(video.videoId, n.t)}) ${first}`);
      for (const r of rest) lines.push(`  ${r}`);
    }
    lines.push('');
  }
  const pages = (Array.isArray(video.pages) && video.pages.length ? video.pages : [{ title: 'Page 1', text: video.summary || '' }]).filter(
    (p) => (p.text || '').trim()
  );
  if (pages.length) {
    lines.push('## Notepad');
    lines.push('');
    const many = (video.pages || []).length > 1;
    for (const p of pages) {
      if (many) lines.push(`### ${p.title}`, '');
      lines.push(p.text.trim(), '');
    }
  }
  if (includeTranscript && transcript && transcript.segments && transcript.segments.length) {
    lines.push('## Transcript');
    lines.push('');
    for (const s of transcript.segments) lines.push(`[${formatTime(s.t)}] ${s.text}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function downloadText(filename, text, type = 'text/plain') {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function safeFilename(name) {
  return (
    String(name || 'notes')
      .replace(/[\\/:*?"<>|]+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'notes'
  );
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
