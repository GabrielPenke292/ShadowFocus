import { loadTranscript, fetchTrackCues } from './lib/youtube.js';
import { buildWords, buildChunks, chunkIndexAt, parseSubtitleFile } from './lib/transcript.js';
import { translateLines } from './lib/translate.js';
import { YouTubeEmbed } from './lib/embed.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const videoId = params.get('v');

const LIVE_HOLD = 2.5; // segundos que o último trecho fica na tela durante silêncios
const BLOCK_BEFORE = 2;
const BLOCK_AFTER = 2;
const EMBED_ERRORS = {
  2: 'ID de vídeo inválido.',
  5: 'O player do YouTube não conseguiu reproduzir este vídeo.',
  100: 'Vídeo não encontrado ou privado.',
  101: 'O dono do vídeo não permite reprodução fora do YouTube.',
  150: 'O dono do vídeo não permite reprodução fora do YouTube.',
  153: 'O YouTube recusou o player embutido (erro 153).',
};

const LANGUAGES = {
  pt: { name: 'Português (BR)', short: 'PT-BR' },
  en: { name: 'Inglês', short: 'EN' },
  es: { name: 'Espanhol', short: 'ES' },
};

const state = {
  track: null,
  chunks: [],
  mode: params.get('mode') === 'blocks' ? 'blocks' : 'live',
  translate: params.get('tr') === '1',
  source: null, // idioma do vídeo; null para arquivo de legenda (desconhecido)
  target: 'pt',
  translationJobs: {}, // por idioma de destino
  translationStatus: {}, // 'loading' | 'done' | 'error'
  translationVersion: 0,
  renderedKey: null,
  wordEls: [],
  started: false,
  fontSize: 48,
  looping: false,
};

let embed;

// Regras de sessão restritas a esta aba:
// - o YouTube recusa embeds sem Referer (páginas chrome-extension:// não enviam);
// - a API interna do player responde 403 quando recebe Origin chrome-extension://.
async function allowYouTubeInThisTab() {
  try {
    const tab = await chrome.tabs.getCurrent();
    if (!tab) return;
    const ruleIds = [tab.id * 2, tab.id * 2 + 1];
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: ruleIds,
      addRules: [
        {
          id: ruleIds[0],
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'referer', operation: 'set', value: 'https://www.google.com/' }],
          },
          condition: { tabIds: [tab.id], urlFilter: '||youtube.com/embed/', resourceTypes: ['sub_frame'] },
        },
        {
          id: ruleIds[1],
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'origin', operation: 'remove' }],
          },
          condition: {
            tabIds: [tab.id],
            urlFilter: '||youtube.com/youtubei/',
            resourceTypes: ['xmlhttprequest'],
          },
        },
      ],
    });
    window.addEventListener('pagehide', () =>
      chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIds })
    );
  } catch (e) {
    console.warn('ShadowFocus: não foi possível configurar as regras de cabeçalho', e);
  }
}

// ---------- Status ----------

function showStatus(html) {
  $('status').innerHTML = html;
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function showIdle() {
  const title = state.track?.title ? `<h1>${escapeHtml(state.track.title)}</h1>` : '';
  const notes = [];
  if (state.source) notes.push(`Idioma do vídeo: ${LANGUAGES[state.source].name}.`);
  if (state.track?.isAuto) notes.push('Legendas geradas automaticamente pelo YouTube.');
  const note = notes.length ? `<br><small>${notes.join(' ')}</small>` : '';
  showStatus(`${title}Pressione <b>▶ Play</b> para começar.${note}`);
}

// ---------- Transcrição ----------

// Idiomas de tradução disponíveis: todos menos o idioma do vídeo.
function targetOptions() {
  return Object.keys(LANGUAGES).filter((lang) => lang !== state.source);
}

function setCues(cues, source) {
  state.chunks = buildChunks(buildWords(cues));
  if (!state.chunks.length) throw new Error('A legenda está vazia.');

  state.source = source;
  if (!targetOptions().includes(state.target)) state.target = 'pt';
  state.translationJobs = {};
  state.translationStatus = {};
  state.translationVersion++;
  updateToggles();
  state.renderedKey = null;
  $('fallback').hidden = true;
  for (const id of ['play', 'pause', 'restart']) $(id).disabled = false;
  showIdle();
  if (state.translate) startTranslation();
  if (!state.looping) {
    state.looping = true;
    requestAnimationFrame(loop);
  }
}

function updateTrStatus() {
  const status = state.translate ? state.translationStatus[state.target] : null;
  $('tr-status').textContent =
    status === 'loading' ? 'Traduzindo…' : status === 'error' ? 'Falha na tradução' : '';
}

function startTranslation(target = state.target) {
  if (state.translationJobs[target] || !state.chunks.length) return;
  const chunks = state.chunks;
  const setStatus = (status) => {
    state.translationStatus[target] = status;
    updateTrStatus();
  };
  setStatus('loading');

  state.translationJobs[target] = (async () => {
    try {
      await translateLines(
        chunks.map((c) => c.text),
        {
          sl: state.source || 'auto',
          tl: target,
          onBatch(offset, out) {
            out.forEach((t, i) => (chunks[offset + i].translations[target] = t));
            state.translationVersion++;
          },
        }
      );
      setStatus('done');
    } catch {
      try {
        await translateFromYouTube(chunks, target);
        setStatus('done');
      } catch {
        setStatus('error');
        delete state.translationJobs[target];
      }
    }
  })();
}

// Alternativa: tradução automática do próprio YouTube, alinhada por tempo.
async function translateFromYouTube(chunks, target) {
  if (!state.track?.baseUrl) throw new Error('sem faixa do YouTube');
  const cues = await fetchTrackCues(state.track.baseUrl, target);
  if (!cues.length) throw new Error('sem tradução');
  for (const chunk of chunks) {
    const texts = cues
      .filter((c) => c.start >= chunk.start - 0.3 && c.start < chunk.end)
      .map((c) => c.segs.map((s) => s.text).join('').trim())
      .filter(Boolean);
    chunk.translations[target] = [...new Set(texts)].join(' ');
  }
  state.translationVersion++;
}

// ---------- Renderização ----------

function wordSpans(chunk) {
  const orig = document.createElement('div');
  orig.className = 'orig';
  chunk.words.forEach((w, i) => {
    const span = document.createElement('span');
    span.className = 'w';
    span.textContent = w.text;
    orig.appendChild(span);
    if (i < chunk.words.length - 1) orig.appendChild(document.createTextNode(' '));
    state.wordEls.push({ el: span, start: w.start });
  });
  return orig;
}

function translationEl(chunk) {
  const tr = document.createElement('div');
  tr.className = 'tr';
  tr.lang = state.target;
  tr.textContent = chunk.translations[state.target] || '';
  return tr;
}

function renderLive(t, idx) {
  const el = $('live');
  const chunk = state.chunks[idx];
  const visible = chunk && t <= chunk.end + LIVE_HOLD;
  el.classList.toggle('fade', !visible);

  const key = `live:${idx}:${state.translate}:${state.target}:${state.translationVersion}`;
  if (key === state.renderedKey || !chunk) return;
  state.renderedKey = key;
  state.wordEls = [];
  el.replaceChildren(wordSpans(chunk));
  if (state.translate) el.appendChild(translationEl(chunk));
}

function renderBlocks(idx) {
  const center = Math.max(idx, 0);
  const key = `blocks:${idx}:${state.translate}:${state.target}:${state.translationVersion}`;
  if (key === state.renderedKey) return;
  state.renderedKey = key;
  state.wordEls = [];

  const from = Math.max(0, center - BLOCK_BEFORE);
  const to = Math.min(state.chunks.length - 1, center + BLOCK_AFTER);
  const lines = [];
  for (let i = from; i <= to; i++) {
    const chunk = state.chunks[i];
    const line = document.createElement('div');
    line.className = `line ${i < idx ? 'past' : i === idx ? 'current' : 'future'}`;
    line.appendChild(wordSpans(chunk));
    if (state.translate) line.appendChild(translationEl(chunk));
    lines.push(line);
  }
  $('blocks').replaceChildren(...lines);
}

function render() {
  const t = embed.getCurrentTime();
  updateTimeline(t);
  if (!state.chunks.length || !state.started) return;

  const idx = chunkIndexAt(state.chunks, t);
  $('live').hidden = state.mode !== 'live';
  $('blocks').hidden = state.mode !== 'blocks';
  if (state.mode === 'live') renderLive(t, idx);
  else renderBlocks(idx);

  for (const { el, start } of state.wordEls) el.classList.toggle('on', start <= t);
}

function loop() {
  render();
  requestAnimationFrame(loop);
}

// ---------- Controles ----------

const formatTime = (s) => {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

let seeking = false;

function updateTimeline(t) {
  const duration = embed.duration || state.chunks.at(-1)?.end || 0;
  $('time').textContent = `${formatTime(t)} / ${formatTime(duration)}`;
  const seek = $('seek');
  seek.max = String(duration);
  if (!seeking) seek.value = String(t);
}

function updateButtons() {
  $('play').classList.toggle('primary', !embed.playing);
  $('pause').classList.toggle('primary', embed.playing);
}

function updateToggles() {
  const trButton = $('toggle-translate');
  trButton.classList.toggle('on', state.translate);
  trButton.textContent = `Tradução: ${state.translate ? LANGUAGES[state.target].short : 'desligada'} ▾`;
  $('toggle-mode').textContent = state.mode === 'live' ? 'Tempo real' : 'Blocos';
  $('toggle-video').classList.toggle('on', !$('video-panel').classList.contains('minimized'));
}

function setVideoMinimized(minimized) {
  $('video-panel').classList.toggle('minimized', minimized);
  $('video-restore').hidden = !minimized;
  updateToggles();
  try {
    localStorage.setItem('shadowfocus.videoMinimized', minimized ? '1' : '0');
  } catch {
    // armazenamento indisponível
  }
}

function toggleVideo() {
  setVideoMinimized(!$('video-panel').classList.contains('minimized'));
}

let draggingVolume = false;

function updateVolume() {
  const level = embed.muted ? 0 : embed.volume;
  $('mute').textContent = level === 0 ? '🔇' : level < 50 ? '🔉' : '🔊';
  $('mute').title = embed.muted ? 'Tirar do mudo' : 'Mudo';
  if (!draggingVolume) $('volume').value = String(level);
}

function changeVolume(delta) {
  embed.setVolume((embed.muted ? 0 : embed.volume) + delta);
}

function toggleMute() {
  // Sem volume, "tirar do mudo" volta para um nível audível, como no YouTube.
  if (embed.volume === 0) embed.setVolume(50);
  else embed.toggleMute();
}

function beginPlayback() {
  if (!state.chunks.length) return;
  if (!state.started) {
    state.started = true;
    showStatus('');
  }
}

function play() {
  if (!state.chunks.length) return;
  beginPlayback();
  embed.play();
}

function pause() {
  embed.pause();
}

function restart() {
  if (!state.chunks.length) return;
  beginPlayback();
  state.renderedKey = null;
  embed.restart();
}

function togglePlay() {
  embed.playing ? pause() : play();
}

function setTranslate(on) {
  state.translate = on;
  state.renderedKey = null;
  if (on) startTranslation();
  updateTrStatus();
  updateToggles();
}

function setTarget(target) {
  state.target = target;
  try {
    localStorage.setItem('shadowfocus.target', target);
  } catch {
    // armazenamento indisponível
  }
  setTranslate(true);
}

// ---------- Menu de tradução ----------

function openTranslateMenu() {
  const menu = $('translate-menu');
  const items = [{ value: null, label: 'Desligada' }].concat(
    targetOptions().map((lang) => ({ value: lang, label: LANGUAGES[lang].name }))
  );
  menu.replaceChildren(
    ...items.map(({ value, label }) => {
      const item = document.createElement('button');
      item.role = 'menuitemradio';
      const checked = value ? state.translate && state.target === value : !state.translate;
      item.ariaChecked = String(checked);
      item.classList.toggle('checked', checked);
      item.textContent = label;
      item.addEventListener('click', () => {
        closeTranslateMenu();
        value ? setTarget(value) : setTranslate(false);
      });
      return item;
    })
  );
  menu.hidden = false;
  $('toggle-translate').ariaExpanded = 'true';
}

function closeTranslateMenu() {
  $('translate-menu').hidden = true;
  $('toggle-translate').ariaExpanded = 'false';
}

function setMode(mode) {
  state.mode = mode;
  state.renderedKey = null;
  updateToggles();
}

function setFontSize(px) {
  state.fontSize = Math.min(96, Math.max(20, px));
  document.documentElement.style.setProperty('--font-size', `${state.fontSize}px`);
  try {
    localStorage.setItem('shadowfocus.fontSize', String(state.fontSize));
  } catch {
    // armazenamento indisponível
  }
}

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

function changeSpeed(step) {
  const i = SPEEDS.indexOf(embed.rate);
  const next = SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, (i < 0 ? 3 : i) + step))];
  embed.setPlaybackRate(next);
}

function updateSpeed() {
  const rate = embed.rate;
  const label = $('speed-reset');
  label.textContent = `${rate}×`;
  label.classList.toggle('changed', rate !== 1);
  $('speed-down').disabled = rate <= SPEEDS[0];
  $('speed-up').disabled = rate >= SPEEDS.at(-1);
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}

function updateFullscreenButton() {
  const on = !!document.fullscreenElement;
  const btn = $('toggle-fullscreen');
  btn.classList.toggle('on', on);
  btn.textContent = on ? '⛶ Sair da tela cheia' : '⛶ Tela cheia';
}

function seekBy(delta) {
  embed.seekTo(embed.getCurrentTime() + delta);
  state.renderedKey = null;
}

function bindControls() {
  $('play').addEventListener('click', play);
  $('pause').addEventListener('click', pause);
  $('restart').addEventListener('click', restart);
  $('toggle-translate').addEventListener('click', (e) => {
    e.stopPropagation();
    $('translate-menu').hidden ? openTranslateMenu() : closeTranslateMenu();
  });
  document.addEventListener('click', (e) => {
    if (!$('translate-menu').contains(e.target)) closeTranslateMenu();
  });
  $('toggle-mode').addEventListener('click', () => setMode(state.mode === 'live' ? 'blocks' : 'live'));
  $('font-up').addEventListener('click', () => setFontSize(state.fontSize + 4));
  $('font-down').addEventListener('click', () => setFontSize(state.fontSize - 4));
  $('toggle-video').addEventListener('click', toggleVideo);
  $('video-minimize').addEventListener('click', () => setVideoMinimized(true));
  $('video-restore').addEventListener('click', () => setVideoMinimized(false));

  const volume = $('volume');
  volume.addEventListener('input', () => {
    draggingVolume = true;
    embed.setVolume(parseInt(volume.value, 10));
  });
  volume.addEventListener('change', () => (draggingVolume = false));
  $('mute').addEventListener('click', toggleMute);
  embed.addEventListener('volumechange', updateVolume);
  $('toggle-fullscreen').addEventListener('click', toggleFullscreen);
  $('speed-down').addEventListener('click', () => changeSpeed(-1));
  $('speed-up').addEventListener('click', () => changeSpeed(1));
  $('speed-reset').addEventListener('click', () => embed.setPlaybackRate(1));
  embed.addEventListener('ratechange', updateSpeed);
  document.addEventListener('fullscreenchange', updateFullscreenButton);

  const seek = $('seek');
  seek.addEventListener('input', () => (seeking = true));
  seek.addEventListener('change', () => {
    seeking = false;
    beginPlayback();
    embed.seekTo(parseFloat(seek.value));
    state.renderedKey = null;
  });

  $('file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const cues = parseSubtitleFile(await file.text());
      state.track = { title: file.name };
      setCues(cues, null);
    } catch (err) {
      showStatus(escapeHtml(err.message || 'Arquivo de legenda inválido.'));
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
    const actions = {
      ' ': togglePlay,
      k: togglePlay,
      r: restart,
      t: () => setTranslate(!state.translate),
      m: () => setMode(state.mode === 'live' ? 'blocks' : 'live'),
      v: toggleVideo,
      f: toggleFullscreen,
      '<': () => changeSpeed(-1),
      '>': () => changeSpeed(1),
      '+': () => setFontSize(state.fontSize + 4),
      '=': () => setFontSize(state.fontSize + 4),
      '-': () => setFontSize(state.fontSize - 4),
      ArrowLeft: () => seekBy(-5),
      ArrowRight: () => seekBy(5),
      Escape: closeTranslateMenu,
      ArrowUp: () => changeVolume(5),
      ArrowDown: () => changeVolume(-5),
    };
    const action = actions[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (!action) return;
    e.preventDefault();
    action();
  });

  // Esconde controles e cursor após alguns segundos sem mexer o mouse.
  let idleTimer;
  const wake = () => {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => embed.playing && document.body.classList.add('idle'), 3000);
  };
  document.addEventListener('mousemove', wake);
  document.addEventListener('keydown', wake);
  embed.addEventListener('statechange', wake);
}

// ---------- Início ----------

async function init() {
  try {
    const size = parseInt(localStorage.getItem('shadowfocus.fontSize'), 10);
    if (size) state.fontSize = size;
    const target = localStorage.getItem('shadowfocus.target');
    if (LANGUAGES[target]) state.target = target;
  } catch {
    // armazenamento indisponível
  }
  setFontSize(state.fontSize);

  if (!videoId) {
    showStatus('URL de vídeo inválida. Abra pelo ícone da extensão.');
    return;
  }

  await allowYouTubeInThisTab();
  embed = new YouTubeEmbed($('video-wrap'), videoId);
  embed.addEventListener('statechange', updateButtons);
  embed.addEventListener('error', (e) => {
    const msg = EMBED_ERRORS[e.detail] || `Erro no player do YouTube (${e.detail}).`;
    state.started = false;
    $('live').hidden = $('blocks').hidden = true;
    showStatus(escapeHtml(msg));
  });

  bindControls();
  let minimized = false;
  try {
    minimized = localStorage.getItem('shadowfocus.videoMinimized') === '1';
  } catch {
    // armazenamento indisponível
  }
  setVideoMinimized(minimized);
  updateButtons();
  updateSpeed();
  updateVolume();

  showStatus('Carregando transcrição…');
  try {
    state.track = await loadTranscript(videoId);
    if (state.track.title) document.title = `${state.track.title} · ShadowFocus`;
    setCues(state.track.cues, state.track.language);
  } catch (err) {
    showStatus(
      `${escapeHtml(err.message)}<br><small>Você pode carregar um arquivo de legenda deste vídeo manualmente.</small>`
    );
    $('fallback').hidden = false;
  }
}

init();
