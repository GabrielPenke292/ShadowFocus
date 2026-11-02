// Converte legendas em palavras com tempo e agrupa em trechos (frases) para exibição.

const MAX_WORDS = 14;
const MIN_WORDS = 4;
const PAUSE_GAP = 1.2; // segundos de silêncio que encerram um trecho

export function buildWords(cues) {
  const words = [];
  for (const cue of cues) {
    const segs = cue.segs.filter((s) => s.text && s.text.trim());
    segs.forEach((seg, i) => {
      const segEnd = i + 1 < segs.length ? segs[i + 1].start : cue.end;
      const parts = seg.text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
      const span = Math.max(segEnd - seg.start, 0.25 * parts.length);
      const totalChars = parts.reduce((n, p) => n + p.length + 1, 0);
      // Sem tempo por palavra: distribui o tempo do segmento pelo tamanho de cada palavra.
      let t = seg.start;
      for (const p of parts) {
        const dur = (span * (p.length + 1)) / totalChars;
        words.push({ text: p, start: t, end: t + dur });
        t += dur;
      }
    });
  }

  words.sort((a, b) => a.start - b.start);
  for (let i = 0; i < words.length - 1; i++) {
    words[i].end = Math.min(words[i].end, words[i + 1].start);
  }
  return words;
}

export function buildChunks(words) {
  const chunks = [];
  let cur = [];
  const flush = () => {
    chunks.push({
      start: cur[0].start,
      end: cur[cur.length - 1].end,
      words: cur,
      text: cur.map((w) => w.text).join(' '),
      translations: {}, // por idioma de destino: { pt: '...', es: '...' }
    });
    cur = [];
  };

  words.forEach((w, i) => {
    cur.push(w);
    const next = words[i + 1];
    const gap = next ? next.start - w.end : Infinity;
    const endsSentence = /[.!?…]["')\]]?$/.test(w.text);
    const endsClause = /[,;:]$/.test(w.text);
    if (
      !next ||
      gap > PAUSE_GAP ||
      cur.length >= MAX_WORDS ||
      (endsSentence && cur.length >= MIN_WORDS) ||
      (endsClause && cur.length >= 10)
    ) {
      flush();
    }
  });
  return chunks;
}

// Índice do último trecho que já começou em `t`, ou -1.
export function chunkIndexAt(chunks, t) {
  let lo = 0;
  let hi = chunks.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (chunks[mid].start <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

const SUB_TIME =
  /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})/;

const toSeconds = (h, m, s, ms) => (+h || 0) * 3600 + +m * 60 + +s + +ms / 1000;

// Lê arquivos .srt ou .vtt no mesmo formato de "cues" usado pelas legendas do YouTube.
export function parseSubtitleFile(text) {
  const cues = [];
  for (const block of text.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => SUB_TIME.test(l));
    if (i < 0) continue;
    const m = lines[i].match(SUB_TIME);
    const start = toSeconds(m[1], m[2], m[3], m[4]);
    const end = toSeconds(m[5], m[6], m[7], m[8]);
    const body = lines
      .slice(i + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (body) cues.push({ start, end, segs: [{ text: body, start }] });
  }
  return cues;
}
