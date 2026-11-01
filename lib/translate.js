// Tradução dos trechos via endpoint público do Google Tradutor.

const MAX_BATCH_CHARS = 1500;
const CONCURRENCY = 3;

async function gtx(text, sl, tl) {
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t' +
    `&sl=${sl}&tl=${tl}&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`translate HTTP ${res.status}`);
  const data = await res.json();
  return (data[0] || []).map((part) => part[0] || '').join('');
}

function makeBatches(lines) {
  const batches = [];
  let cur = { offset: 0, lines: [], chars: 0 };
  lines.forEach((line, i) => {
    if (cur.lines.length && cur.chars + line.length > MAX_BATCH_CHARS) {
      batches.push(cur);
      cur = { offset: i, lines: [], chars: 0 };
    }
    cur.lines.push(line);
    cur.chars += line.length + 1;
  });
  if (cur.lines.length) batches.push(cur);
  return batches;
}

// Traduz as linhas em lotes (uma linha por "\n"). Se o lote voltar com número
// de linhas diferente, traduz cada linha separadamente.
// `onBatch(offset, translations)` é chamado conforme cada lote fica pronto.
export async function translateLines(lines, { sl = 'auto', tl = 'pt', onBatch } = {}) {
  const queue = makeBatches(lines);
  let failures = 0;

  async function worker() {
    while (queue.length) {
      const batch = queue.shift();
      try {
        let out = (await gtx(batch.lines.join('\n'), sl, tl)).split('\n');
        if (out.length !== batch.lines.length) {
          out = await Promise.all(batch.lines.map((l) => gtx(l, sl, tl)));
        }
        onBatch?.(batch.offset, out.map((s) => s.trim()));
      } catch {
        failures++;
      }
    }
  }

  const total = queue.length;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
  if (failures === total) throw new Error('Falha ao traduzir');
}
