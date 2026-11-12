// Minimal Markdown → DOM for model answers. Builds nodes directly (never
// innerHTML), so nothing in an answer can inject markup. Times like (4:05),
// [4:05] or 1:02:15 become buttons that jump the video there.
import { h, parseTime } from './util.js';

const TIME_RE = /[([]?\b((?:\d{1,2}:)?\d{1,2}:[0-5]\d)\b[)\]]?/g;

function inline(text, ctx) {
  const out = [];
  // tokens: `code`, **bold**, *em* / _em_, [label](http…)
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\b_[^_\s][^_]*_\b)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(...times(text.slice(last, m.index), ctx));
    const tok = m[0];
    if (m[1]) out.push(h('code', null, tok.slice(1, -1)));
    else if (m[2]) out.push(h('strong', null, ...inline(tok.slice(2, -2), ctx)));
    else if (m[3] || m[4]) out.push(h('em', null, ...inline(tok.slice(1, -1), ctx)));
    else if (m[5]) {
      const label = tok.slice(1, tok.indexOf(']('));
      out.push(h('a', { href: m[6], target: '_blank', rel: 'noopener noreferrer' }, label));
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(...times(text.slice(last), ctx));
  return out;
}

function times(text, ctx) {
  if (!ctx.onTime) return [text];
  const out = [];
  let last = 0;
  let m;
  TIME_RE.lastIndex = 0;
  while ((m = TIME_RE.exec(text))) {
    const t = parseTime(m[1]);
    if (t == null || (ctx.duration && t > ctx.duration + 5)) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    const b = h('button', { type: 'button', class: 'ts', title: 'Jump to this moment', 'aria-label': `Jump to ${m[1]}` }, `(${m[1]})`);
    b.addEventListener('click', () => ctx.onTime(t));
    out.push(b);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Render Markdown text into a fragment. ctx: { onTime(t), duration } */
export function renderMarkdown(src, ctx = {}) {
  const frag = document.createDocumentFragment();
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  let para = [];
  let list = null;

  const flushPara = () => {
    if (para.length) {
      const p = h('p');
      para.forEach((line, i) => {
        if (i) p.append(h('br'));
        p.append(...inline(line, ctx));
      });
      frag.append(p);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      frag.append(list.el);
      list = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flushPara();
      flushList();
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      frag.append(h('pre', null, h('code', null, code.join('\n'))));
      continue;
    }
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if (heading) {
      flushPara();
      flushList();
      frag.append(h('p', { class: 'md-h' }, h('strong', null, ...inline(heading[1], ctx))));
      continue;
    }
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const num = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (bullet || num) {
      flushPara();
      const type = bullet ? 'ul' : 'ol';
      if (!list || list.type !== type) {
        flushList();
        list = { type, el: h(type, num && num[1] !== '1' ? { start: num[1] } : null) };
      }
      list.el.append(h('li', null, ...inline(bullet ? bullet[1] : num[2], ctx)));
      continue;
    }
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    if (list && /^\s{2,}\S/.test(line) && list.el.lastChild) {
      list.el.lastChild.append(' ', ...inline(line.trim(), ctx));
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return frag;
}
