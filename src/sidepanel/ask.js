// The Ask pane: questions about the video, answered by Claude or OpenAI with
// the transcript as context. Opened from the sparkle icon in the panel's top bar,
// or from "Ask about this" on a transcript line or a time note.
import { AI_KEY, PROVIDERS, activeAI, buildSystem, getAI, hasAccess, questionText, streamAnswer } from '../shared/ai.js';
import { createAISetup } from '../shared/aisetup.js';
import { renderMarkdown } from '../shared/md.js';
import { copyText, formatTime, h } from '../shared/util.js';
import { autosize, icon, openMenu, showToast, syncWriteField, writeField } from '../shared/ui.js';

const chatKey = (videoId) => `chat:${videoId}`;
const MAX_TURNS = 12;

/**
 * api: {
 *   videoId(), video(), transcript(), meta(), now(), duration(),
 *   seek(t), ensureTranscript() -> Promise<transcript|null>,
 *   saveToNotepad(text), onOpenChange(open)
 * }
 */
export function createAsk(api) {
  const A = {
    open: false,
    ai: null, // active provider/model/key or null
    access: false, // Chrome has granted the provider's host
    chat: [],
    scope: { kind: 'video' },
    busy: null, // AbortController while answering
    settingUp: false,
  };

  // ---------- skeleton
  const title = h('span', { class: 'ask-title' }, 'Ask');
  const model = h('span', { class: 'ask-model' });
  const moreBtn = h('button', { class: 'icon-btn', type: 'button', title: 'Ask options', 'aria-label': 'Ask options' }, icon('more'));
  const closeBtn = h('button', { class: 'icon-btn', type: 'button', title: 'Back to notes (Esc)', 'aria-label': 'Close Ask' }, icon('close'));
  const head = h('div', { class: 'ask-head' }, h('div', { class: 'ask-name' }, title, model), moreBtn, closeBtn);

  const setupHost = h('div', { class: 'ask-setup', hidden: true });
  const msgs = h('ol', { class: 'ask-msgs', 'aria-label': 'Conversation', 'aria-live': 'polite' });
  const suggest = h('div', { class: 'ask-suggest' });
  const scroll = h('div', { class: 'pane-scroll ask-scroll' }, setupHost, msgs, suggest);

  const scopeChip = h('button', { class: 'scope-chip', type: 'button' });
  const scopeClear = h('button', { class: 'icon-btn scope-clear', type: 'button', title: 'Ask about the whole video instead', 'aria-label': 'Clear this moment' }, icon('close'));
  const scopeRow = h('div', { class: 'ask-scope' }, scopeChip, scopeClear);
  const input = h('textarea', { class: 'ask-text', rows: 1, 'aria-label': 'Your question', title: 'Enter sends. Shift+Enter starts a new line.' });
  const sendBtn = h('button', { class: 'icon-btn ask-send', type: 'button', title: 'Send', 'aria-label': 'Send question' }, icon('send'));
  const inputWrap = writeField(input, { className: 'ask-write' });
  inputWrap.append(sendBtn);
  const foot = h('div', { class: 'ask-foot' }, scopeRow, inputWrap);

  const el = h('section', { class: 'pane ask-pane', 'aria-label': 'Ask about this video', hidden: true }, head, scroll, foot);
  autosize(input, 40);

  // ---------- setup / provider
  async function refreshAI() {
    A.ai = activeAI(await getAI());
    A.access = A.ai ? await hasAccess(A.ai.provider) : false;
    title.textContent = A.ai ? `Ask ${A.ai.name}` : 'Ask about this video';
    model.textContent = A.ai ? A.ai.modelLabel : '';
    api.onProviderChange && api.onProviderChange(A.ai);
    render();
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[AI_KEY]) refreshAI();
  });
  // access can also be changed from chrome://extensions
  chrome.permissions.onAdded.addListener(() => refreshAI());
  chrome.permissions.onRemoved.addListener(() => refreshAI());

  async function showSetup(on) {
    A.settingUp = on;
    if (on) {
      setupHost.replaceChildren(
        h(
          'div',
          { class: 'ask-intro' },
          A.ai && !A.access
            ? h('p', null, `Ask needs your permission to reach ${PROVIDERS[A.ai.provider].company}. Click Save, then choose Allow when Chrome asks.`)
            : A.ai
            ? h('h2', null, 'Model and API key')
            : h('p', null, 'Connect your own Claude or OpenAI API key. Answers use the video’s transcript and your time notes, and cite moments you can click to jump to.')
        ),
        await createAISetup({
          compact: true,
          onDone: async () => {
            await refreshAI();
            showSetup(false);
            input.focus();
          },
          onDisconnect: () => refreshAI(),
        })
      );
    }
    render();
  }

  // ---------- chat persistence (cleared when the browser closes)
  async function loadChat() {
    const id = api.videoId();
    A.chat = [];
    A.scope = { kind: 'video' };
    if (id) {
      const r = await chrome.storage.session.get(chatKey(id)).catch(() => ({}));
      A.chat = (r && r[chatKey(id)]) || [];
    }
    render();
  }
  function saveChat() {
    const id = api.videoId();
    if (id) chrome.storage.session.set({ [chatKey(id)]: A.chat }).catch(() => {});
  }

  // ---------- scope
  function scopeLabel() {
    const s = A.scope;
    if (s.kind === 'now') return `Around now (${formatTime(api.now())})`;
    if (s.kind === 'moment') {
      const q = s.quote ? `“${s.quote.length > 38 ? `${s.quote.slice(0, 36).trim()}…` : s.quote}” ` : 'Around ';
      return `${q}(${formatTime(s.t)})`;
    }
    return 'Whole video';
  }
  function drawScope() {
    scopeChip.replaceChildren(icon(A.scope.kind === 'video' ? 'film' : 'target'), h('span', null, scopeLabel()), A.scope.kind === 'moment' ? '' : icon('chevronDown'));
    scopeChip.title = A.scope.kind === 'moment' ? 'This question is about this moment' : 'What the question is about';
    scopeClear.hidden = A.scope.kind !== 'moment';
  }
  scopeChip.addEventListener('click', () => {
    if (A.scope.kind === 'moment') return;
    openMenu(scopeChip, [
      { label: 'Whole video', checked: A.scope.kind === 'video', onClick: () => setScope({ kind: 'video' }) },
      { label: `Around now (${formatTime(api.now())})`, checked: A.scope.kind === 'now', onClick: () => setScope({ kind: 'now' }) },
    ]);
  });
  scopeClear.addEventListener('click', () => setScope({ kind: 'video' }));
  function setScope(s) {
    A.scope = s;
    drawScope();
  }

  // ---------- rendering
  function render() {
    const ready = !!A.ai && A.access && !A.settingUp;
    setupHost.hidden = ready;
    msgs.hidden = !ready;
    foot.hidden = !ready;
    suggest.hidden = !ready || A.chat.length > 0;
    moreBtn.hidden = !A.ai;
    if ((!A.ai || !A.access) && !A.settingUp && A.open) {
      showSetup(true);
      return;
    }
    if (!ready) return;
    drawScope();
    drawSuggestions();
    drawMessages();
    updateSend();
  }

  function drawSuggestions() {
    const items = [
      ['Summarize this video', { kind: 'video' }],
      ['Explain what’s happening right now', { kind: 'now' }],
      ['Quiz me on this video', { kind: 'video' }],
    ];
    suggest.replaceChildren(
      ...items.map(([q, scope]) =>
        h('button', { type: 'button', class: 'suggestion', onclick: () => send(q, scope) }, icon(scope.kind === 'now' ? 'target' : 'sparkle'), q)
      )
    );
  }

  function scopeTag(scope) {
    if (!scope || scope.kind === 'video') return null;
    const b = h('button', { type: 'button', class: 'ts msg-scope', title: 'Jump to this moment' }, `(${formatTime(scope.t)})`);
    b.addEventListener('click', () => api.seek(scope.t));
    return b;
  }

  function messageEl(m, i) {
    if (m.role === 'user') {
      return h('li', { class: 'msg user' }, h('p', null, m.q, m.scope && m.scope.kind !== 'video' ? ' ' : null, scopeTag(m.scope)));
    }
    const body = h('div', { class: 'msg-body' });
    if (m.text) body.append(renderMarkdown(m.text, { onTime: (t) => api.seek(t), duration: api.duration() }));
    else if (m.pending) body.append(h('p', { class: 'msg-wait' }, h('span', { class: 'dots', 'aria-label': 'Thinking' }, h('i'), h('i'), h('i')), m.status ? ` ${m.status}` : ''));
    const li = h('li', { class: `msg bot${m.error ? ' has-error' : ''}` }, body);
    if (m.error) {
      li.append(
        h(
          'p',
          { class: 'msg-error' },
          m.error,
          ' ',
          m.error && /key|model/i.test(m.error)
            ? h('button', { type: 'button', class: 'linkish', onclick: () => showSetup(true) }, 'Ask settings')
            : h('button', { type: 'button', class: 'linkish', onclick: () => retry(i) }, 'Try again')
        )
      );
    }
    if (m.text && !m.pending) {
      li.append(
        h(
          'div',
          { class: 'msg-actions' },
          h(
            'button',
            {
              type: 'button',
              class: 'icon-btn',
              title: 'Copy answer',
              'aria-label': 'Copy answer',
              onclick: async () => (await copyText(m.text)) && showToast('Answer copied'),
            },
            icon('copy')
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'icon-btn',
              title: 'Save to notepad',
              'aria-label': 'Save answer to notepad',
              onclick: async () => {
                const q = A.chat[i - 1] && A.chat[i - 1].role === 'user' ? A.chat[i - 1].q : '';
                await api.saveToNotepad(`${q ? `Q: ${q}\n` : ''}${m.text.trim()}`);
                showToast('Saved to notepad');
              },
            },
            icon('note')
          )
        )
      );
    }
    return li;
  }

  function drawMessages() {
    msgs.replaceChildren(...A.chat.map((m, i) => messageEl(m, i)));
  }

  let rafPending = false;
  function redrawLast() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const i = A.chat.length - 1;
      const old = msgs.children[i];
      const fresh = messageEl(A.chat[i], i);
      if (old) old.replaceWith(fresh);
      else msgs.append(fresh);
      stickToBottom();
    });
  }

  let pinned = true;
  scroll.addEventListener('scroll', () => {
    pinned = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40;
  });
  function stickToBottom(force) {
    if (force || pinned) scroll.scrollTop = scroll.scrollHeight;
  }

  function updateSend() {
    const busy = !!A.busy;
    sendBtn.replaceChildren(icon(busy ? 'stop' : 'send'));
    sendBtn.title = busy ? 'Stop' : 'Send';
    sendBtn.setAttribute('aria-label', busy ? 'Stop answering' : 'Send question');
    sendBtn.classList.toggle('visible', busy || !!input.value.trim());
  }

  // ---------- asking
  input.addEventListener('input', updateSend);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!A.busy) send(input.value.trim(), A.scope);
    }
  });
  sendBtn.addEventListener('click', () => {
    if (A.busy) A.busy.abort();
    else send(input.value.trim(), A.scope);
  });

  function historyForModel(transcript) {
    const out = [];
    const turns = A.chat.slice(0, -1); // the new question is added by the caller
    for (let i = 0; i < turns.length; i++) {
      const m = turns[i];
      if (m.role === 'user') {
        const ans = turns[i + 1];
        if (!ans || ans.role !== 'assistant' || !ans.text) continue; // skip failed turns
        out.push({ role: 'user', content: questionText(m.q, m.scope, transcript) }, { role: 'assistant', content: ans.text });
      }
    }
    return out.slice(-MAX_TURNS * 2);
  }

  async function send(q, scopeIn) {
    if (!q || A.busy || !A.ai) return;
    const scope = scopeIn.kind === 'now' ? { kind: 'moment', t: Math.floor(api.now()) } : scopeIn.kind === 'moment' ? { ...scopeIn } : { kind: 'video' };
    input.value = '';
    syncWriteField(input);
    input.dispatchEvent(new Event('input'));
    if (A.scope.kind === 'moment') setScope({ kind: 'video' }); // a quoted line applies to one question
    const videoId = api.videoId();
    A.chat.push({ role: 'user', q, scope });
    const answer = { role: 'assistant', text: '', pending: true };
    A.chat.push(answer);
    suggest.hidden = true;
    drawMessages();
    stickToBottom(true);
    await ask(answer, videoId);
  }

  async function ask(answer, videoId) {
    const ctrl = new AbortController();
    A.busy = ctrl;
    updateSend();
    try {
      let transcript = api.transcript();
      if (!transcript) {
        answer.status = 'Getting the transcript…';
        redrawLast();
        transcript = await api.ensureTranscript();
        answer.status = '';
      }
      if (api.videoId() !== videoId) return;
      const userTurn = A.chat[A.chat.length - 2];
      const messages = [...historyForModel(transcript), { role: 'user', content: questionText(userTurn.q, userTurn.scope, transcript) }];
      const system = buildSystem(api.video(), transcript, api.meta());
      const { provider, key, model: m } = A.ai;
      await streamAnswer({
        provider,
        key,
        model: m,
        system,
        messages,
        signal: ctrl.signal,
        onText: (t) => {
          if (api.videoId() !== videoId) return;
          answer.text = t;
          redrawLast();
        },
      });
      if (!answer.text) answer.error = 'The answer came back empty. Try asking again.';
    } catch (e) {
      if (e.name === 'AbortError') {
        if (!answer.text) answer.error = 'Stopped.';
      } else answer.error = e.message || 'Something went wrong.';
    } finally {
      answer.pending = false;
      A.busy = null;
      if (api.videoId() === videoId) {
        saveChat();
        drawMessages();
        stickToBottom();
        updateSend();
      }
    }
  }

  function retry(i) {
    const ans = A.chat[i];
    if (!ans || A.busy) return;
    A.chat = A.chat.slice(0, i + 1);
    Object.assign(ans, { text: '', error: '', pending: true });
    drawMessages();
    ask(ans, api.videoId());
  }

  moreBtn.addEventListener('click', () =>
    openMenu(moreBtn, [
      {
        label: 'New conversation',
        icon: 'refresh',
        onClick: () => {
          if (A.busy) A.busy.abort();
          A.chat = [];
          saveChat();
          render();
          input.focus();
        },
      },
      { label: 'Model and API key…', icon: 'gear', onClick: () => showSetup(true) },
    ])
  );

  // ---------- open / close
  function setOpen(open) {
    A.open = open;
    el.hidden = !open;
    api.onOpenChange && api.onOpenChange(open);
    if (open) {
      render();
      if (A.ai && !A.settingUp) setTimeout(() => input.focus(), 0);
      stickToBottom(true);
    }
  }
  closeBtn.addEventListener('click', () => setOpen(false));
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.querySelector('.menu')) {
      e.preventDefault();
      setOpen(false);
    }
  });

  refreshAI();

  return {
    el,
    toggle: () => setOpen(!A.open),
    open: () => setOpen(true),
    close: () => setOpen(false),
    isOpen: () => A.open,
    /** Open with a question scoped to a moment, optionally quoting a transcript line. */
    askAbout(t, quote) {
      setScope({ kind: 'moment', t: Math.floor(t), quote: quote || '' });
      setOpen(true);
    },
    videoChanged: () => {
      if (A.busy) A.busy.abort();
      loadChat();
    },
    tick: () => {
      if (A.open && A.scope.kind === 'now') drawScope();
    },
    hasProvider: () => !!A.ai,
  };
}
