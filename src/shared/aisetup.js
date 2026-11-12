// Connect / change the model used by Ask. Shared by the side panel and the library's settings.
import { PROVIDERS, activeAI, disconnectAI, getAI, maskKey, releaseAccess, requestAccess, saveAI, testKey } from './ai.js';
import { h } from './util.js';
import { icon, showToast } from './ui.js';

/**
 * Build the setup form. onDone(active) runs after a successful connect,
 * onDisconnect after the key is removed.
 */
export async function createAISetup({ onDone, onDisconnect, compact = false } = {}) {
  const ai = await getAI();
  let provider = ai.provider || 'anthropic';

  const root = h('form', { class: `ai-setup${compact ? ' compact' : ''}`, novalidate: true });
  const seg = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Provider' });
  const keyInput = h('input', {
    class: 'field',
    type: 'password',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': 'API key',
  });
  const keyHelp = h('a', { class: 'linkish', target: '_blank', rel: 'noopener noreferrer' }, 'Get an API key');
  const modelSel = h('select', { class: 'field', 'aria-label': 'Model' });
  const status = h('p', { class: 'ai-status', role: 'status' });
  const connect = h('button', { class: 'btn primary', type: 'submit' }, 'Connect');
  const remove = h('button', { class: 'btn quiet danger', type: 'button', hidden: true }, 'Remove key');

  function drawProvider() {
    const p = PROVIDERS[provider];
    seg.replaceChildren(
      ...Object.values(PROVIDERS).map((x) =>
        h(
          'button',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(x.id === provider),
            class: x.id === provider ? 'on' : '',
            onclick: () => {
              provider = x.id;
              drawProvider();
            },
          },
          x.name
        )
      )
    );
    const saved = ai.keys[provider] || '';
    keyInput.value = '';
    keyInput.setAttribute('aria-label', `${p.company} API key`);
    keyInput.dataset.saved = saved ? '1' : '';
    keyLabel.textContent = saved ? `${p.company} API key (saved: ${maskKey(saved)})` : `${p.company} API key`;
    keyHelp.href = p.keyHelp;
    const current = ai.models[provider] || p.defaultModel;
    const opts = p.models.map((m) => h('option', { value: m.id }, m.label));
    if (!p.models.some((m) => m.id === current)) opts.push(h('option', { value: current }, current));
    modelSel.replaceChildren(...opts);
    modelSel.value = current;
    remove.hidden = !saved;
    connect.textContent = saved ? 'Save' : 'Connect';
    status.textContent = '';
    status.classList.remove('error');
  }

  const keyLabel = h('span');
  root.append(
    h('div', { class: 'ai-field' }, h('span', { class: 'ai-label' }, 'Use'), seg),
    h('label', { class: 'ai-field' }, h('span', { class: 'ai-label' }, keyLabel), keyInput),
    h(
      'p',
      { class: 'ai-help' },
      keyHelp,
      '. It stays in this browser and is sent only to the company it belongs to. When you ask something, your question, the video’s transcript and your time notes go to that company too. Questions use your API credit.'
    ),
    h('label', { class: 'ai-field' }, h('span', { class: 'ai-label' }, 'Model'), modelSel),
    status,
    h('div', { class: 'ai-actions' }, connect, remove)
  );

  root.addEventListener('submit', async (e) => {
    e.preventDefault();
    const typed = keyInput.value.trim();
    const key = typed || ai.keys[provider] || '';
    if (!key) {
      status.textContent = `Paste your ${PROVIDERS[provider].company} API key.`;
      status.classList.add('error');
      keyInput.focus();
      return;
    }
    // Chrome only shows its permission prompt in response to a click, so ask before any await
    const access = requestAccess(provider);
    connect.disabled = true;
    status.classList.remove('error');
    status.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' Checking the key…');
    try {
      if (!(await access)) {
        status.textContent = `Ask needs your permission to reach ${PROVIDERS[provider].company}. Click ${connect.textContent} again and choose Allow.`;
        status.classList.add('error');
        return;
      }
      if (typed || provider !== ai.provider) await testKey(provider, key);
      const next = await saveAI({ provider, keys: { [provider]: key }, models: { [provider]: modelSel.value } });
      Object.assign(ai, next);
      status.replaceChildren(icon('check'), ` Connected to ${PROVIDERS[provider].name}`);
      drawProvider();
      onDone && onDone(activeAI(next));
    } catch (err) {
      status.textContent = err.message;
      status.classList.add('error');
    } finally {
      connect.disabled = false;
    }
  });

  remove.addEventListener('click', async () => {
    await disconnectAI();
    await releaseAccess();
    ai.keys = {};
    ai.provider = null;
    drawProvider();
    showToast('API key removed');
    onDisconnect && onDisconnect();
  });

  drawProvider();
  return root;
}
