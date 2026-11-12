// Transcript extraction. `extractTranscriptInPage` is injected into the YouTube
// tab's MAIN world with chrome.scripting.executeScript, so it must be fully
// self-contained (no references to anything outside the function body).
//
// YouTube's caption URLs return an empty body unless they carry a proof-of-origin
// token (`pot`) minted by the player, so the strategies run in this order:
//   1. Reuse a caption request the player already made (it carries `pot`),
//      forcing the player to make one if needed, then restoring caption state.
//   2. Fetch the track's plain baseUrl (still works for some videos).
//   3. Ask the /youtubei/v1/get_transcript endpoint (what the panel calls).
//   4. Open the "Show transcript" panel and read its rows from the page.

export async function extractTranscriptInPage(opts) {
  const { videoId, vssId = '', listOnly = false, allowPanel = true } = opts || {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = [];
  const player = document.getElementById('movie_player') || document.querySelector('.html5-video-player');

  // ---- helpers ----
  function extractJsonVar(html, name) {
    const idx = html.search(new RegExp(`(?:var\\s+|window\\[["']|\\b)${name}["']?\\]?\\s*=\\s*\\{`));
    if (idx < 0) return null;
    const start = html.indexOf('{', idx);
    let depth = 0;
    let inStr = false;
    let quote = '';
    for (let i = start; i < html.length; i++) {
      const c = html[i];
      if (inStr) {
        if (c === '\\') i++;
        else if (c === quote) inStr = false;
        continue;
      }
      if (c === '"' || c === "'") {
        inStr = true;
        quote = c;
      } else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(html.slice(start, i + 1));
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }

  function findDeep(obj, key, max = 1) {
    const out = [];
    const stack = [obj];
    let n = 0;
    while (stack.length && n++ < 400000) {
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object') continue;
      if (Object.prototype.hasOwnProperty.call(cur, key)) {
        out.push(cur[key]);
        if (out.length >= max) break;
      }
      for (const v of Object.values(cur)) if (v && typeof v === 'object') stack.push(v);
    }
    return out;
  }

  const textOf = (x) =>
    !x ? '' : typeof x === 'string' ? x : x.simpleText || (x.runs || []).map((r) => r.text).join('') || x.content || '';

  function parseClock(s) {
    const m = String(s || '').trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    return (+m[1] || 0) * 3600 + +m[2] * 60 + +m[3];
  }

  function cleanText(s) {
    return String(s || '')
      .replace(/​/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function finalize(segs) {
    const out = segs.filter((s) => s.text && Number.isFinite(s.t)).sort((a, b) => a.t - b.t);
    for (let i = 0; i < out.length; i++) {
      if (!out[i].d || out[i].d <= 0) out[i].d = i + 1 < out.length ? Math.max(0.5, out[i + 1].t - out[i].t) : 3;
      out[i].t = Math.round(out[i].t * 100) / 100;
      out[i].d = Math.round(out[i].d * 100) / 100;
    }
    return out;
  }

  function parseCaptionBody(body) {
    const trimmed = body.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('{')) {
      const j = JSON.parse(trimmed);
      const segs = [];
      for (const e of j.events || []) {
        if (!e.segs) continue;
        const text = cleanText(e.segs.map((s) => s.utf8 || '').join(''));
        if (!text) continue;
        segs.push({ t: (e.tStartMs || 0) / 1000, d: (e.dDurationMs || 0) / 1000, text });
      }
      return finalize(segs);
    }
    if (trimmed.startsWith('<')) {
      // Parsed as text: YouTube enforces Trusted Types, which blocks DOMParser here.
      const decode = (s) =>
        s
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;(#?\w+;)/g, '&$1') // srv1 double-encodes entities like &amp;#39;
          .replace(/&#x([0-9a-f]+);/gi, (_, x) => String.fromCodePoint(parseInt(x, 16)))
          .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
          .replace(/&quot;/g, '"')
          .replace(/&apos;|&#39;/g, "'")
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&');
      const attr = (tag, name) => {
        const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
        return m ? parseFloat(m[1]) || 0 : 0;
      };
      const segs = [];
      for (const m of trimmed.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
        segs.push({ t: attr(m[1], 'start'), d: attr(m[1], 'dur'), text: cleanText(decode(m[2])) });
      }
      if (!segs.length) {
        for (const m of trimmed.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
          segs.push({ t: attr(m[1], 't') / 1000, d: attr(m[1], 'd') / 1000, text: cleanText(decode(m[2])) });
        }
      }
      return finalize(segs);
    }
    return [];
  }

  async function fetchCaption(url) {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseCaptionBody(await res.text());
  }

  // ---- 0. player response + caption tracks ----
  let pr = null;
  let initialData = null;
  try {
    pr = player && typeof player.getPlayerResponse === 'function' ? player.getPlayerResponse() : null;
  } catch {}
  if (!pr || pr?.videoDetails?.videoId !== videoId) {
    if (window.ytInitialPlayerResponse?.videoDetails?.videoId === videoId) pr = window.ytInitialPlayerResponse;
  }
  let watchHtml = null;
  async function loadWatchHtml() {
    if (watchHtml !== null) return watchHtml;
    try {
      const res = await fetch(`/watch?v=${encodeURIComponent(videoId)}&hl=${encodeURIComponent(navigator.language || 'en')}`, {
        credentials: 'include',
      });
      watchHtml = res.ok ? await res.text() : '';
    } catch {
      watchHtml = '';
    }
    return watchHtml;
  }
  if (!pr || pr?.videoDetails?.videoId !== videoId) {
    const html = await loadWatchHtml();
    pr = html ? extractJsonVar(html, 'ytInitialPlayerResponse') : null;
    log.push(pr ? 'player response from watch page' : 'no player response');
  }

  const rawTracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  const tracks = rawTracks.map((t) => ({
    lang: t.languageCode,
    name: textOf(t.name) || t.languageCode,
    kind: t.kind || '',
    vssId: t.vssId || `${t.kind === 'asr' ? 'a' : ''}.${t.languageCode}`,
    baseUrl: t.baseUrl,
  }));
  const publicTracks = tracks.map(({ baseUrl, ...rest }) => rest);
  const meta = {
    title: pr?.videoDetails?.title || '',
    channel: pr?.videoDetails?.author || '',
    duration: +pr?.videoDetails?.lengthSeconds || 0,
  };

  if (listOnly) return { ok: true, tracks: publicTracks, meta };

  // pick a track
  let track = null;
  if (tracks.length) {
    const ui = (navigator.language || 'en').split('-')[0];
    track =
      (vssId && tracks.find((t) => t.vssId === vssId)) ||
      tracks.find((t) => t.kind !== 'asr' && t.lang.split('-')[0] === ui) ||
      tracks.find((t) => t.kind === 'asr') ||
      tracks.find((t) => t.kind !== 'asr') ||
      tracks[0];
  }
  const result = (segments, source) => ({
    ok: true,
    segments,
    source,
    lang: track ? track.lang : '',
    label: track ? `${track.name}${track.kind === 'asr' && !/auto/i.test(track.name) ? ' (auto-generated)' : ''}` : 'Transcript',
    vssId: track ? track.vssId : '',
    tracks: publicTracks,
    meta,
    log,
  });

  const urlFor = (base, template) => {
    const u = new URL(template || base, location.origin);
    const b = new URL(base, location.origin);
    for (const p of ['lang', 'kind', 'name', 'tlang', 'variant']) {
      if (b.searchParams.has(p)) u.searchParams.set(p, b.searchParams.get(p));
      else u.searchParams.delete(p);
    }
    u.searchParams.set('fmt', 'json3');
    return u.toString();
  };

  // ---- 1. reuse the player's own caption request (carries pot) ----
  if (track && player) {
    const isMatch = (name) => {
      if (!name.includes('/api/timedtext') || !name.includes('pot=')) return false;
      try {
        return new URL(name).searchParams.get('v') === videoId;
      } catch {
        return false;
      }
    };
    const seen = [];
    let observer = null;
    try {
      observer = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (isMatch(e.name)) seen.push(e.name);
      });
      observer.observe({ type: 'resource', buffered: true });
    } catch {}
    const fromBuffer = () =>
      performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .filter(isMatch);
    let potUrl = [...fromBuffer(), ...seen].pop();

    if (!potUrl) {
      // Force the player to request captions, then put things back the way they were.
      let prev = null;
      try {
        prev = player.getOption && player.getOption('captions', 'track');
      } catch {}
      const wasOn = !!(prev && prev.languageCode);
      try {
        if (!wasOn && player.unloadModule) player.unloadModule('captions');
        if (player.loadModule) player.loadModule('captions');
      } catch {}
      await sleep(150);
      try {
        player.setOption && player.setOption('captions', 'track', { languageCode: track.lang, kind: track.kind || undefined });
      } catch {}
      for (let i = 0; i < 35 && !potUrl; i++) {
        await sleep(200);
        potUrl = [...seen, ...fromBuffer()].pop();
      }
      try {
        if (wasOn) player.setOption('captions', 'track', prev);
        else {
          player.setOption && player.setOption('captions', 'track', {});
          player.unloadModule && player.unloadModule('captions');
        }
      } catch {}
      log.push(potUrl ? 'forced player caption request' : 'player made no caption request');
    } else log.push('found player caption request');
    try {
      observer && observer.disconnect();
    } catch {}

    if (potUrl) {
      try {
        const segs = await fetchCaption(urlFor(track.baseUrl, potUrl));
        if (segs.length) return result(segs, 'captions');
        log.push('pot request returned no lines');
      } catch (e) {
        log.push(`pot request failed: ${e.message}`);
      }
    }
  }

  // ---- 2. plain baseUrl ----
  if (track && track.baseUrl) {
    try {
      const segs = await fetchCaption(urlFor(track.baseUrl));
      if (segs.length) return result(segs, 'captions');
      log.push('baseUrl returned empty');
    } catch (e) {
      log.push(`baseUrl failed: ${e.message}`);
    }
  }

  // ---- 3. get_transcript ----
  try {
    let params = null;
    if (window.ytInitialData && pr && window.ytInitialPlayerResponse?.videoDetails?.videoId === videoId) {
      params = findDeep(window.ytInitialData, 'getTranscriptEndpoint')[0]?.params;
    }
    if (!params) {
      const html = await loadWatchHtml();
      initialData = html ? extractJsonVar(html, 'ytInitialData') : null;
      params = initialData ? findDeep(initialData, 'getTranscriptEndpoint')[0]?.params : null;
    }
    const cfg = window.ytcfg && window.ytcfg.get ? window.ytcfg : null;
    const context = cfg && cfg.get('INNERTUBE_CONTEXT');
    if (params && context) {
      const key = cfg.get('INNERTUBE_API_KEY');
      const res = await fetch(`/youtubei/v1/get_transcript?prettyPrint=false${key ? `&key=${key}` : ''}`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-Youtube-Client-Name': String(cfg.get('INNERTUBE_CONTEXT_CLIENT_NAME') || 1),
          'X-Youtube-Client-Version': String(cfg.get('INNERTUBE_CLIENT_VERSION') || context.client?.clientVersion || ''),
        },
        body: JSON.stringify({ context, params }),
      });
      if (res.ok) {
        const j = await res.json();
        const rows = findDeep(j, 'transcriptSegmentRenderer', 100000);
        const segs = rows.map((r) => ({
          t: (+r.startMs || 0) / 1000,
          d: Math.max(0, (+r.endMs || 0) - (+r.startMs || 0)) / 1000,
          text: cleanText(textOf(r.snippet)),
        }));
        const out = finalize(segs);
        if (out.length) return result(out, 'transcript-api');
        log.push('get_transcript had no rows');
      } else log.push(`get_transcript HTTP ${res.status}`);
    } else log.push('no get_transcript params');
  } catch (e) {
    log.push(`get_transcript failed: ${e.message}`);
  }

  // ---- 4. the transcript panel in the page ----
  const onThisVideo = new URLSearchParams(location.search).get('v') === videoId || location.pathname.includes(videoId);
  if (allowPanel && onThisVideo && (tracks.length || !pr)) {
    const ROW_SEL = 'transcript-segment-view-model, ytd-transcript-segment-renderer';
    const PANEL_SEL =
      'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"], ytd-engagement-panel-section-list-renderer[target-id="PAmodern_transcript_view"]';
    const panels = () => [...document.querySelectorAll(PANEL_SEL)];
    const rows = () => {
      const inPanels = panels().flatMap((p) => [...p.querySelectorAll(ROW_SEL)]);
      return inPanels.length ? inPanels : [...document.querySelectorAll(ROW_SEL)];
    };
    const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const prevVisibility = panels().map((p) => [p, p.getAttribute('visibility')]);
    let opened = false;

    if (!rows().length) {
      const candidates = [
        ...document.querySelectorAll('ytd-video-description-transcript-section-renderer button'),
        ...document.querySelectorAll('button[aria-label]'),
      ].filter((b) => b.closest('ytd-video-description-transcript-section-renderer') || /transcript/i.test(b.getAttribute('aria-label') || ''));
      const btn = candidates.find(visible) || candidates[0];
      if (btn) {
        btn.click();
        opened = true;
      } else {
        const p = panels()[0];
        if (p) {
          p.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED');
          opened = true;
        }
      }
      for (let i = 0; i < 50 && !rows().length; i++) await sleep(200);
      // let the list finish rendering
      let last = -1;
      for (let i = 0; i < 10; i++) {
        const n = rows().length;
        if (n === last) break;
        last = n;
        await sleep(250);
      }
    }

    const segs = [];
    for (const row of rows()) {
      if (row.closest('timeline-chapter-view-model')) continue;
      const tsEl = row.querySelector('.ytwTranscriptSegmentViewModelTimestamp, .segment-timestamp');
      const txEl = row.querySelector('.ytAttributedStringHost, .segment-text, yt-formatted-string.segment-text');
      let t = tsEl ? parseClock(tsEl.textContent) : null;
      let text = txEl ? cleanText(txEl.textContent) : '';
      if (t == null || !text) {
        const lines = (row.innerText || row.textContent || '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
        const i = lines.findIndex((l) => parseClock(l) != null);
        if (i >= 0) {
          t = parseClock(lines[i]);
          text = cleanText(
            lines
              .slice(i + 1)
              .filter((l) => !/^\d+\s+(seconds?|minutes?|hours?)/i.test(l))
              .join(' ')
          );
        }
      }
      if (t != null && text) segs.push({ t, d: 0, text });
    }

    if (opened) {
      for (const p of panels()) {
        const before = prevVisibility.find(([el]) => el === p);
        p.setAttribute('visibility', (before && before[1]) || 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
      }
    }
    const out = finalize(segs);
    if (out.length) {
      const r = result(out, 'transcript-panel');
      if (!track) r.label = 'Transcript';
      return r;
    }
    log.push('transcript panel had no rows');
  }

  return {
    ok: false,
    tracks: publicTracks,
    meta,
    log,
    error: tracks.length
      ? 'YouTube did not return the transcript for this video. Try again after the video starts playing, or paste it in.'
      : 'This video has no captions or transcript.',
    noCaptions: !tracks.length,
  };
}
