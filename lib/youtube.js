// Identificação do vídeo e obtenção das legendas do YouTube.

const ID_RE = /^[\w-]{11}$/;
const FALLBACK_API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const ANDROID_CLIENT = { clientName: 'ANDROID', clientVersion: '20.10.38' };

export function parseVideoId(input) {
  const s = (input || '').trim();
  if (ID_RE.test(s)) return s;

  let url;
  try {
    url = new URL(s.includes('://') ? s : `https://${s}`);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') {
    id = url.pathname.slice(1).split('/')[0];
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = url.searchParams.get('v');
    if (!id) {
      const m = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/);
      if (m) id = m[1];
    }
  }
  return id && ID_RE.test(id) ? id : null;
}

function decodeHtml(s) {
  return new DOMParser().parseFromString(s, 'text/html').documentElement.textContent;
}

// Extrai o array JSON que segue `"captionTracks":` no HTML da página do vídeo.
function watchPageTracks(html) {
  const key = html.indexOf('"captionTracks":');
  if (key < 0) return [];
  const start = html.indexOf('[', key);
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[') depth++;
    else if (c === ']' && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, i + 1));
      } catch {
        return [];
      }
    }
  }
  return [];
}

async function innertubePlayer(videoId, apiKey) {
  const res = await fetch(
    `https://www.youtube.com/youtubei/v1/player?key=${apiKey}&prettyPrint=false`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: { client: ANDROID_CLIENT }, videoId }),
    }
  );
  if (!res.ok) throw new Error(`player HTTP ${res.status}`);
  const data = await res.json();
  const captions = data?.captions?.playerCaptionsTracklistRenderer ?? {};
  const tracks = captions.captionTracks ?? [];
  const audio = captions.audioTracks?.[captions.defaultAudioTrackIndex ?? 0];
  const details = data?.videoDetails ?? {};
  return {
    tracks,
    title: details.title,
    status: data?.playabilityStatus,
    hints: {
      // Vídeos com várias faixas de áudio informam o idioma do áudio original (ex.: "es-US.4").
      audio: baseLang(audio?.audioTrackId?.split('.')[0]),
      text: guessTextLanguage(`${details.title || ''} ${(details.shortDescription || '').slice(0, 300)}`),
    },
  };
}

// Idiomas de vídeo suportados.
export const SOURCE_LANGUAGES = ['en', 'es'];

const baseLang = (code) => (code || '').split('-')[0];

const STOPWORDS = {
  en: new Set('the and you of to is in that with for how what this my your are was be it on'.split(' ')),
  es: new Set('el la los las de que y en un una con para por es del cómo qué tu mi se lo al su'.split(' ')),
};

// Palpite simples (inglês x espanhol) contando palavras comuns de cada idioma.
function guessTextLanguage(text) {
  const words = text.toLowerCase().match(/\p{L}+/gu) || [];
  const score = { en: 0, es: /[ñ¿¡áéíóú]/i.test(text) ? 2 : 0 };
  for (const w of words) {
    for (const lang of SOURCE_LANGUAGES) if (STOPWORDS[lang].has(w)) score[lang]++;
  }
  if (score.es === score.en) return '';
  return score.es > score.en ? 'es' : 'en';
}

const hasLanguage = (tracks, lang) => tracks.some((t) => baseLang(t.languageCode) === lang);

// Idioma falado no vídeo, do sinal mais confiável para o menos:
// faixa automática (sempre no idioma do áudio) > idioma do áudio original >
// único idioma suportado com legenda > idioma do título/descrição.
function detectLanguage(tracks, hints) {
  const asr = tracks.find((t) => t.kind === 'asr');
  if (asr) return baseLang(asr.languageCode);
  if (hints.audio) return hints.audio;
  const available = SOURCE_LANGUAGES.filter((lang) => hasLanguage(tracks, lang));
  if (available.length === 1) return available[0];
  return hints.text;
}

// No idioma do vídeo, prefere a legenda manual. Vídeos em outros idiomas usam a
// legenda original traduzida pelo YouTube para inglês.
function pickTrack(tracks, hints = {}) {
  const language = detectLanguage(tracks, hints);
  const same = tracks.filter((t) => baseLang(t.languageCode) === language);
  if (SOURCE_LANGUAGES.includes(language) && same.length) {
    return { track: same.find((t) => t.kind !== 'asr') || same[0], language };
  }
  const original = same[0] || tracks.find((t) => t.kind === 'asr') || tracks[0];
  return { track: original, tlang: 'en', language: 'en' };
}

function parseJson3(data) {
  return (data.events || [])
    .filter((e) => e.segs)
    .map((e) => ({
      start: e.tStartMs / 1000,
      end: (e.tStartMs + (e.dDurationMs || 0)) / 1000,
      segs: e.segs.map((s) => ({
        text: s.utf8 || '',
        start: (e.tStartMs + (s.tOffsetMs || 0)) / 1000,
      })),
    }));
}

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  const cues = [];

  // Formato padrão: <text start="1.2" dur="3.4">...</text> (segundos)
  for (const el of doc.querySelectorAll('text')) {
    const start = parseFloat(el.getAttribute('start'));
    const dur = parseFloat(el.getAttribute('dur') || '0');
    cues.push({ start, end: start + dur, segs: [{ text: decodeHtml(el.textContent), start }] });
  }
  if (cues.length) return cues;

  // Formato srv3: <p t="1200" d="3400"><s t="0">...</s></p> (milissegundos)
  for (const p of doc.querySelectorAll('p')) {
    const start = parseInt(p.getAttribute('t'), 10) / 1000;
    const end = start + parseInt(p.getAttribute('d') || '0', 10) / 1000;
    const words = p.querySelectorAll('s');
    const segs = words.length
      ? [...words].map((s) => ({
          text: decodeHtml(s.textContent),
          start: start + parseInt(s.getAttribute('t') || '0', 10) / 1000,
        }))
      : [{ text: decodeHtml(p.textContent), start }];
    cues.push({ start, end, segs });
  }
  return cues;
}

export async function fetchTrackCues(baseUrl, tlang) {
  const url = new URL(baseUrl);
  url.searchParams.delete('fmt');
  if (tlang) url.searchParams.set('tlang', tlang);

  const jsonUrl = new URL(url);
  jsonUrl.searchParams.set('fmt', 'json3');
  const jsonText = await (await fetch(jsonUrl)).text();
  if (jsonText.trim().startsWith('{')) {
    const cues = parseJson3(JSON.parse(jsonText));
    if (cues.length) return cues;
  }

  const xmlText = await (await fetch(url)).text();
  return xmlText.trim() ? parseXml(xmlText) : [];
}

export async function loadTranscript(videoId) {
  let html = '';
  try {
    html = await (await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`)).text();
  } catch {
    // segue só com a API interna
  }

  const apiKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1] || FALLBACK_API_KEY;
  const metaTitle = html.match(/<meta name="title" content="([^"]*)"/)?.[1];
  let title = metaTitle ? decodeHtml(metaTitle) : '';
  let reason = '';

  const sources = [];
  let hints = { text: guessTextLanguage(title) };
  try {
    const r = await innertubePlayer(videoId, apiKey);
    title ||= r.title || '';
    if (r.status && r.status.status !== 'OK') reason = r.status.reason || '';
    hints = r.hints;
    sources.push(r.tracks);
  } catch (e) {
    console.warn('ShadowFocus: API do player falhou, tentando a página do vídeo', e);
  }
  sources.push(watchPageTracks(html));

  for (const tracks of sources) {
    if (!tracks.length) continue;
    const { track, tlang, language } = pickTrack(tracks, hints);
    try {
      const cues = await fetchTrackCues(track.baseUrl, tlang);
      if (cues.length) {
        return {
          title,
          cues,
          baseUrl: track.baseUrl,
          tlang,
          isAuto: track.kind === 'asr',
          language,
        };
      }
    } catch (e) {
      console.warn('ShadowFocus: falha ao baixar a legenda', track.baseUrl, e);
    }
  }

  throw new Error(
    reason ||
      'Não foi possível obter as legendas deste vídeo. Ele pode não ter legendas, ou o YouTube bloqueou o acesso.'
  );
}
