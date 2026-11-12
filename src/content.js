// Content script on youtube.com (isolated world). Talks to the player's <video>
// element, reports the current video and time, remembers where you stopped
// watching saved videos, and adds a "note" button to the player controls.
(() => {
  if (window.__lecternLoaded) return;
  window.__lecternLoaded = true;

  const alive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };

  // ---------- page inspection ----------

  function currentVideoId() {
    const url = new URL(location.href);
    if (url.pathname === '/watch') return url.searchParams.get('v');
    const m = url.pathname.match(/^\/(?:shorts|live)\/([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
  }

  function videoEl() {
    if (location.pathname.startsWith('/shorts/')) {
      return (
        document.querySelector('ytd-reel-video-renderer[is-active] video') ||
        document.querySelector('#shorts-player video') ||
        document.querySelector('video')
      );
    }
    return (
      document.querySelector('#movie_player video.html5-main-video') ||
      document.querySelector('#movie_player video') ||
      document.querySelector('video.html5-main-video') ||
      document.querySelector('video')
    );
  }

  function playerEl() {
    return document.getElementById('movie_player') || document.querySelector('.html5-video-player');
  }

  function isAdPlaying() {
    const p = playerEl();
    return !!(p && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting')));
  }

  function text(sel) {
    const el = document.querySelector(sel);
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  function pageMeta(videoId) {
    // Only trust the DOM when YouTube has finished swapping it to this video.
    const flexy = document.querySelector('ytd-watch-flexy');
    const domId = flexy && flexy.getAttribute('video-id');
    let title = '';
    let channel = '';
    if (location.pathname === '/watch' && (!domId || domId === videoId)) {
      title = text('ytd-watch-metadata h1') || text('h1.ytd-watch-metadata') || text('#title h1');
      channel =
        text('ytd-watch-metadata ytd-channel-name a') ||
        text('#owner ytd-channel-name a') ||
        text('ytd-video-owner-renderer #channel-name a');
    } else if (location.pathname.startsWith('/shorts/')) {
      const active = document.querySelector('ytd-reel-video-renderer[is-active]');
      if (active) {
        title = text('ytd-reel-video-renderer[is-active] h2') || '';
        channel = text('ytd-reel-video-renderer[is-active] ytd-channel-name a') || '';
      }
    }
    if (!title && domId === videoId) {
      title = document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube\s*$/, '');
    }
    return { title, channel };
  }

  function state() {
    const videoId = currentVideoId();
    const v = videoEl();
    const ad = isAdPlaying();
    const base = { ok: true, url: location.href, videoId, ad };
    if (!videoId) return base;
    const meta = pageMeta(videoId);
    return {
      ...base,
      ...meta,
      currentTime: v && !ad ? v.currentTime : null,
      duration: v && !ad && Number.isFinite(v.duration) ? v.duration : null,
      paused: v ? v.paused : true,
      ready: !!(v && v.readyState > 0),
    };
  }

  // ---------- playback control ----------

  function seek(t, play) {
    const v = videoEl();
    if (!v || isAdPlaying()) return false;
    v.currentTime = Math.max(0, t);
    if (play) v.play().catch(() => {});
    return true;
  }

  function playback(action, amount = 5) {
    const v = videoEl();
    if (!v) return false;
    if (action === 'toggle') v.paused ? v.play().catch(() => {}) : v.pause();
    else if (action === 'play') v.play().catch(() => {});
    else if (action === 'pause') v.pause();
    else if (action === 'rewind') v.currentTime = Math.max(0, v.currentTime - amount);
    else if (action === 'forward') v.currentTime = Math.min(v.duration || Infinity, v.currentTime + amount);
    return true;
  }

  // ---------- toast ----------

  let toastTimer = null;
  function toast(msg) {
    const host = playerEl() || document.body;
    let el = document.getElementById('lectern-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'lectern-toast';
      el.setAttribute('role', 'status');
    }
    if (el.parentElement !== host) host.append(el);
    el.textContent = msg;
    el.classList.add('lectern-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('lectern-show'), 1800);
  }

  // ---------- messages ----------

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'ping':
        reply({ ok: true });
        break;
      case 'getState':
        reply(state());
        break;
      case 'seek':
        reply({ ok: seek(msg.t, msg.play !== false) });
        break;
      case 'playback':
        reply({ ok: playback(msg.action, msg.amount) });
        break;
      case 'toast':
        toast(msg.text);
        reply({ ok: true });
        break;
      default:
        return;
    }
  });

  // ---------- saved-video tracking ----------

  let savedIds = new Set();
  let settings = { autoTranscript: true };
  const autoRequested = new Set();

  async function refreshSaved() {
    if (!alive()) return;
    const id = currentVideoId();
    if (!id) return;
    const r = await chrome.storage.local.get([`v:${id}`, 'settings']);
    if (r[`v:${id}`]) savedIds.add(id);
    else savedIds.delete(id);
    settings = { autoTranscript: true, ...(r.settings || {}) };
    savedVideo = r[`v:${id}`] || null;
  }
  let savedVideo = null;

  if (alive()) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const id = currentVideoId();
      if (id && changes[`v:${id}`]) {
        savedVideo = changes[`v:${id}`].newValue || null;
        if (savedVideo) savedIds.add(id);
        else savedIds.delete(id);
        maybeAutoCapture();
      }
      if (changes.settings) settings = { autoTranscript: true, ...(changes.settings.newValue || {}) };
    });
  }

  let lastWrite = { id: null, t: -1, at: 0 };
  function writePosition(force = false) {
    if (!alive()) return;
    const id = currentVideoId();
    const v = videoEl();
    if (!id || !v || !savedIds.has(id) || isAdPlaying() || !(v.readyState > 0)) return;
    const t = v.currentTime;
    const d = Number.isFinite(v.duration) ? v.duration : 0;
    if (!force && lastWrite.id === id && Math.abs(lastWrite.t - t) < 4) return;
    if (!force && Date.now() - lastWrite.at < 8000 && lastWrite.id === id) return;
    lastWrite = { id, t, at: Date.now() };
    chrome.storage.local.set({ [`p:${id}`]: { t: Math.floor(t), d: Math.floor(d), at: Date.now() } }).catch(() => {});
  }

  function maybeAutoCapture() {
    if (!alive()) return;
    const id = currentVideoId();
    if (!id || !savedVideo || savedVideo.transcriptInfo || !settings.autoTranscript || autoRequested.has(id)) return;
    const v = videoEl();
    if (!v || isAdPlaying() || !(v.readyState > 1)) return;
    autoRequested.add(id);
    chrome.runtime.sendMessage({ type: 'autoCapture', videoId: id }).catch(() => {});
  }

  setInterval(() => {
    const v = videoEl();
    if (v && !v.paused) writePosition();
    maybeAutoCapture();
  }, 3000);
  document.addEventListener(
    'pause',
    (e) => {
      if (e.target instanceof HTMLVideoElement) writePosition(true);
    },
    true
  );
  window.addEventListener('pagehide', () => writePosition(true));

  // ---------- navigation ----------

  let lastId = currentVideoId();
  function onNavigate() {
    const id = currentVideoId();
    if (id === lastId) return;
    writePosition(true);
    lastId = id;
    lastWrite = { id: null, t: -1, at: 0 };
    refreshSaved().then(() => setTimeout(maybeAutoCapture, 4000));
    if (alive()) chrome.runtime.sendMessage({ type: 'videoChanged', videoId: id }).catch(() => {});
    ensureButton();
  }
  window.addEventListener('yt-navigate-finish', onNavigate);
  window.addEventListener('popstate', onNavigate);
  setInterval(onNavigate, 1000);

  refreshSaved().then(() => setTimeout(maybeAutoCapture, 4000));

  // ---------- player button ----------

  // Built with DOM APIs: YouTube enforces Trusted Types, so innerHTML would throw.
  const ICON_PATHS = [
    'M11 9h11.5a2.5 2.5 0 0 1 2.5 2.5V15h-2v-3.5a.5.5 0 0 0-.5-.5H11.5a.5.5 0 0 0-.5.5v13a.5.5 0 0 0 .5.5H16v2h-4.5A2.5 2.5 0 0 1 9 24.5v-13A2.5 2.5 0 0 1 11 9Z',
    'M13 14h8v2h-8zm0 4h5v2h-5z',
    'm25.6 17.2 2.2 2.2-7.3 7.3-3 .8.8-3 7.3-7.3Z',
  ];
  function buildIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 36 36');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of ICON_PATHS) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('fill', 'currentColor');
      p.setAttribute('d', d);
      svg.append(p);
    }
    return svg;
  }

  function ensureButton() {
    if (!alive()) return;
    const controls = document.querySelector('#movie_player .ytp-right-controls');
    if (!controls || controls.querySelector('.lectern-note-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'ytp-button lectern-note-btn';
    btn.title = 'Add a note at this moment';
    btn.setAttribute('aria-label', 'Add a note at this moment (Lectern)');
    btn.append(buildIcon());
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const v = videoEl();
      if (!alive()) {
        toast('Lectern was updated. Reload this page to keep taking notes.');
        return;
      }
      chrome.runtime
        .sendMessage({
          type: 'openPanelAndCompose',
          videoId: currentVideoId(),
          t: v && !isAdPlaying() ? v.currentTime : null,
        })
        .catch(() => {});
    });
    controls.prepend(btn);
  }

  const mo = new MutationObserver(() => ensureButton());
  const watchControls = () => {
    const p = playerEl();
    if (p) mo.observe(p, { childList: true, subtree: true });
    ensureButton();
  };
  watchControls();
  setInterval(() => {
    if (!document.querySelector('.lectern-note-btn')) watchControls();
  }, 2500);
})();
