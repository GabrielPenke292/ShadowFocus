import { parseVideoId } from './lib/youtube.js';

const form = document.getElementById('form');
const urlInput = document.getElementById('url');
const errorEl = document.getElementById('error');

async function init() {
  const { translate = '0', mode = 'live' } = await chrome.storage.sync.get(['translate', 'mode']);
  form.translate.value = translate;
  form.mode.value = mode;

  // Se a aba atual já é um vídeo do YouTube, preenche a URL.
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url && parseVideoId(tab.url)) urlInput.value = tab.url;
  } catch {
    // sem acesso à aba atual
  }
  urlInput.focus();
  urlInput.select();
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const videoId = parseVideoId(urlInput.value);
  if (!videoId) {
    errorEl.textContent = 'URL do YouTube inválida.';
    errorEl.hidden = false;
    return;
  }

  const translate = form.translate.value;
  const mode = form.mode.value;
  await chrome.storage.sync.set({ translate, mode });

  const params = new URLSearchParams({ v: videoId, tr: translate, mode });
  await chrome.tabs.create({ url: chrome.runtime.getURL(`player.html?${params}`) });
  window.close();
});

urlInput.addEventListener('input', () => (errorEl.hidden = true));

init();
