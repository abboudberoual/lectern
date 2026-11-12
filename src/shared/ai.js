// Ask a model about a video, with the user's own Claude or OpenAI API key.
// The key is kept in chrome.storage.local on this computer, is never included
// in backups, and is only ever sent to the provider it belongs to.
import { formatTime } from './util.js';

export const AI_KEY = 'ai';

export const PROVIDERS = {
  anthropic: {
    id: 'anthropic',
    name: 'Claude',
    company: 'Anthropic',
    keyHelp: 'https://platform.claude.com/docs/en/get-api-key',
    keyPrefix: 'sk-ant-',
    models: [
      { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
      { id: 'claude-opus-5-5', label: 'Opus 5.5' },
      { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
    ],
    defaultModel: 'claude-sonnet-5-5',
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    company: 'OpenAI',
    keyHelp: 'https://platform.openai.com/api-keys',
    keyPrefix: 'sk-',
    models: [
      { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
      { id: 'gpt-6-astra', label: 'GPT-6 Astra' },
      { id: 'gpt-6-luna', label: 'GPT-6 Luna' },
    ],
    defaultModel: 'gpt-6.1-sol',
  },
};

// Overridable for tests.
export const ENDPOINTS = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
};

export async function getAI() {
  const r = await chrome.storage.local.get(AI_KEY);
  const ai = r[AI_KEY] || {};
  return { provider: ai.provider || null, keys: ai.keys || {}, models: ai.models || {} };
}

export async function saveAI(patch) {
  const cur = await getAI();
  const next = {
    provider: patch.provider !== undefined ? patch.provider : cur.provider,
    keys: { ...cur.keys, ...(patch.keys || {}) },
    models: { ...cur.models, ...(patch.models || {}) },
  };
  await chrome.storage.local.set({ [AI_KEY]: next });
  return next;
}

export async function disconnectAI() {
  await chrome.storage.local.remove(AI_KEY);
}

/** The active provider, model and key, or null when not set up. */
export function activeAI(ai) {
  if (!ai || !ai.provider || !PROVIDERS[ai.provider] || !ai.keys[ai.provider]) return null;
  const p = PROVIDERS[ai.provider];
  const model = ai.models[ai.provider] || p.defaultModel;
  const known = p.models.find((m) => m.id === model);
  return { provider: p.id, name: p.name, key: ai.keys[ai.provider], model, modelLabel: known ? known.label : model };
}

export function maskKey(key) {
  if (!key) return '';
  return `${key.slice(0, Math.min(7, key.length - 4))}…${key.slice(-4)}`;
}

// ---------- requests ----------

function headersFor(provider, key) {
  if (provider === 'anthropic') {
    return {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    };
  }
  return { 'content-type': 'application/json', authorization: `Bearer ${key}` };
}

export class AIError extends Error {
  constructor(message, { status = 0, kind = 'other' } = {}) {
    super(message);
    this.status = status;
    this.kind = kind;
  }
}

function friendlyError(provider, status, body) {
  const name = PROVIDERS[provider].company;
  let detail = '';
  try {
    const j = JSON.parse(body);
    detail = (j.error && (j.error.message || j.error.type)) || '';
  } catch {}
  if (status === 401 || status === 403) return new AIError(`${name} didn’t accept the API key. Check it in Ask settings.`, { status, kind: 'auth' });
  if (status === 404) return new AIError(`${name} doesn’t recognise this model${detail ? ` (${detail})` : ''}. Pick another in Ask settings.`, { status, kind: 'model' });
  if (status === 429) return new AIError(`${name} is rate-limiting this key, or it’s out of credit. Wait a moment and try again.`, { status, kind: 'rate' });
  if (status === 529 || status === 503) return new AIError(`${name} is overloaded right now. Try again in a moment.`, { status, kind: 'busy' });
  if (status === 400 && /credit|billing|balance/i.test(detail)) return new AIError(`${name} says this account is out of credit.`, { status, kind: 'billing' });
  return new AIError(`${name} returned an error${status ? ` (${status})` : ''}${detail ? `: ${detail}` : '.'}`, { status });
}

/** Check a key with a request that costs nothing (listing models). */
export async function testKey(provider, key) {
  let res;
  try {
    res = await fetch(`${ENDPOINTS[provider]}/v1/models`, { headers: headersFor(provider, key) });
  } catch {
    throw new AIError(`Couldn’t reach ${PROVIDERS[provider].company}. Check your connection.`, { kind: 'network' });
  }
  if (!res.ok) throw friendlyError(provider, res.status, await res.text().catch(() => ''));
  return true;
}

/** Read an SSE stream, calling onEvent(eventName, dataString) per event. */
async function readSSE(res, onEvent) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.search(/\r?\n\r?\n/)) !== -1) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + (buf[i] === '\r' ? 4 : 2));
      let event = 'message';
      const data = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) onEvent(event, data.join('\n'));
    }
  }
}

/**
 * Stream an answer. `system` is the shared context (cached by Claude between
 * follow-up questions), `messages` the conversation [{role, content}].
 * Calls onText(fullTextSoFar). Resolves to the full text.
 */
export async function streamAnswer({ provider, key, model, system, messages, signal, onText }) {
  let url;
  let body;
  if (provider === 'anthropic') {
    url = `${ENDPOINTS.anthropic}/v1/messages`;
    body = {
      model,
      max_tokens: 2048,
      stream: true,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages,
    };
  } else {
    url = `${ENDPOINTS.openai}/v1/chat/completions`;
    body = { model, stream: true, messages: [{ role: 'system', content: system }, ...messages] };
  }
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: headersFor(provider, key), body: JSON.stringify(body), signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new AIError(`Couldn’t reach ${PROVIDERS[provider].company}. Check your connection.`, { kind: 'network' });
  }
  if (!res.ok) throw friendlyError(provider, res.status, await res.text().catch(() => ''));

  let text = '';
  let streamError = null;
  await readSSE(res, (event, data) => {
    if (provider === 'anthropic') {
      let j;
      try {
        j = JSON.parse(data);
      } catch {
        return;
      }
      if (j.type === 'content_block_delta' && j.delta && j.delta.type === 'text_delta') {
        text += j.delta.text;
        onText && onText(text);
      } else if (j.type === 'error') {
        const t = j.error && j.error.type;
        streamError = friendlyError(provider, t === 'overloaded_error' ? 529 : t === 'rate_limit_error' ? 429 : 0, JSON.stringify(j));
      }
    } else {
      if (data === '[DONE]') return;
      let j;
      try {
        j = JSON.parse(data);
      } catch {
        return;
      }
      if (j.error) {
        streamError = friendlyError(provider, 0, JSON.stringify(j));
        return;
      }
      const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
      if (delta) {
        text += delta;
        onText && onText(text);
      }
    }
  });
  if (streamError && !text) throw streamError;
  return text;
}

// ---------- context ----------

const MAX_TRANSCRIPT_CHARS = 160000;

/** The system prompt: instructions plus the video's transcript and the user's notes. */
export function buildSystem(video, transcript, meta = {}) {
  const title = (video && video.title) || meta.title || 'Untitled video';
  const channel = (video && video.channel) || meta.channel || '';
  const duration = (video && video.duration) || meta.duration || 0;
  const parts = [
    'You are a study assistant inside a note-taking extension for YouTube. The user is watching the video below and asks you about it.',
    'Answer from the transcript first. If the transcript doesn’t cover something, say so in a few words and then answer from general knowledge.',
    'When you refer to a part of the video, cite its time in parentheses, like (4:05), so the user can click it to jump there.',
    'Keep answers short and plain unless the user asks for depth. Use brief paragraphs or short lists, no tables.',
    '',
    `<video>\nTitle: ${title}${channel ? `\nChannel: ${channel}` : ''}${duration ? `\nLength: ${formatTime(duration)}` : ''}\n</video>`,
  ];
  if (transcript && transcript.segments && transcript.segments.length) {
    let lines = transcript.segments.map((s) => (transcript.untimed ? s.text : `[${formatTime(s.t)}] ${s.text}`)).join('\n');
    let note = '';
    if (lines.length > MAX_TRANSCRIPT_CHARS) {
      lines = lines.slice(0, MAX_TRANSCRIPT_CHARS);
      note = '\n(The transcript was cut off here because it is very long.)';
    }
    parts.push(`<transcript>\n${lines}${note}\n</transcript>`);
  } else {
    parts.push('<transcript>\nNo transcript is available for this video. Say so if a question depends on what is said in it.\n</transcript>');
  }
  const notes = video && video.notes ? [...video.notes].sort((a, b) => a.t - b.t).filter((n) => (n.text || '').trim()) : [];
  if (notes.length) parts.push(`<my_time_notes>\n${notes.map((n) => `(${formatTime(n.t)}) ${n.text.trim()}`).join('\n')}\n</my_time_notes>`);
  return parts.join('\n');
}

/** Transcript lines around a moment, for scoping a question. */
export function linesAround(transcript, t, before = 45, after = 30) {
  if (!transcript || !transcript.segments || transcript.untimed) return [];
  return transcript.segments.filter((s) => s.t >= t - before && s.t <= t + after);
}

/** The text sent for one question, with its scope spelled out for the model. */
export function questionText(question, scope, transcript) {
  if (!scope || scope.kind === 'video') return question;
  const near = linesAround(transcript, scope.t)
    .map((s) => `[${formatTime(s.t)}] ${s.text}`)
    .join('\n');
  const head = scope.quote
    ? `This question is about the moment at (${formatTime(scope.t)}), where the video says: “${scope.quote}”`
    : `This question is about the moment around (${formatTime(scope.t)}) in the video.`;
  return `${head}${near ? `\nNearby transcript:\n${near}` : ''}\n\nQuestion: ${question}`;
}
