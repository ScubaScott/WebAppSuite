// Tests for htdocs/Bingo/scan/readers/tesseract-reader.js with a stand-in for the Tesseract worker.
// Run: node reader-test.js <scan folder>
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const dir = process.argv[2];
const ctx = vm.createContext({ Math, Uint8Array, Uint8ClampedArray, Float32Array, Float64Array, Int32Array, Map, Set, Array, Object, Promise, isFinite, parseInt, isNaN, performance, console });

// The reader needs these globals: the imaging module, the engine loader and Tesseract itself
vm.runInContext(fs.readFileSync(path.join(dir, 'imaging.js'), 'utf8'), ctx, { filename: 'imaging.js' });
let worker;                       // replaced per test
vm.runInContext(`
  Imaging.grayToCanvas = (gray, scale) => ({ gray, scale });          // no DOM here: pass the sheet through
  const EngineLoader = { load: async () => {}, tesseractOptions: () => ({}) };
  const Tesseract = { OEM: { LSTM_ONLY: 1 }, createWorker: async () => globalThis.__worker };
  globalThis.Imaging = Imaging;
`, ctx);
vm.runInContext(fs.readFileSync(path.join(dir, 'readers', 'tesseract-reader.js'), 'utf8') + '\nglobalThis.TesseractReader = TesseractReader;', ctx, { filename: 'tesseract-reader.js' });
const R = ctx.TesseractReader;
// Layout tests use flat-colored crops, so crop cleaning is off here (it is tested at the end)
R.options.prep = 'stretch';

let failed = 0;
const t = (name, ok, detail) => { if (!ok) failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : '')); };

const TW = 72, TH = 80;
const crop = v => ({ width: TW, height: TH, data: new Uint8Array(TW * TH).fill(v) });
const crops = n => Array.from({ length: n }, (_, i) => crop(100 + i));

// Where tile k sits on the sheet (mirrors the reader's layout rules)
function tileRect(k) {
  const cols = R.options.cols, gutterX = Math.round(TH * R.options.gutterX), margin = TH;
  return { x: margin + (k % cols) * (TW + gutterX), y: margin + Math.floor(k / cols) * (TH + TH), w: TW, h: TH };
}
// A recognized word whose box is centered in tile k (shifted by dx)
const wordIn = (k, text, conf, dx = 0) => {
  const r = tileRect(k), s = R.options.scale;
  return { text, confidence: conf, bbox: { x0: (r.x + 10 + dx) * s, x1: (r.x + 50 + dx) * s, y0: (r.y + 10) * s, y1: (r.y + 60) * s }, symbols: [] };
};

function makeWorker(sheetWords, singleResults = {}) {
  const calls = { recognize: [], params: [] };
  const w = {
    calls,
    loadLanguage: async () => {}, initialize: async () => {}, terminate: async () => {},
    setParameters: async p => { calls.params.push(p); },
    recognize: async canvas => {
      calls.recognize.push(canvas);
      if (canvas.gray.width > 400) return { data: { words: sheetWords, text: '' } };   // the sheet
      // a lone padded cell: identify it by its fill value (100 + index)
      const idx = canvas.gray.data[canvas.gray.width * 30 + 30] - 100;
      return { data: singleResults[idx] || { text: '', confidence: 0, words: [] } };
    }
  };
  ctx.__worker = w;
  return w;
}

// The reader keeps its worker between reads, so each test starts it again to pick up its own stand-in
const readFresh = async inputs => { await R.dispose(); return R.read(inputs); };

(async () => {
  // 1. Layout: one sheet, tiles do not overlap, gutters are white and at least one crop tall
  makeWorker([]);
  await R.dispose();
  let res = await readFresh(crops(24));
  const sheetCanvas = ctx.__worker.calls.recognize[0];
  const sheet = sheetCanvas.gray;
  t('layout: all 24 crops go on a single sheet recognized once (plus retries for empty tiles)', ctx.__worker.calls.recognize.filter(c => c.gray.width > 400).length === 1);
  let overlap = false;
  for (let a = 0; a < 24; a++) for (let b = a + 1; b < 24; b++) {
    const A = tileRect(a), B = tileRect(b);
    if (A.x < B.x + B.w && B.x < A.x + A.w && A.y < B.y + B.h && B.y < A.y + A.h) overlap = true;
  }
  t('layout: tiles never overlap', !overlap);
  const r0 = tileRect(0), r1 = tileRect(1), r4 = tileRect(4);
  t('layout: each tile holds its own crop', sheet.data[(r0.y + 5) * sheet.width + r0.x + 5] === 100 && sheet.data[(r1.y + 5) * sheet.width + r1.x + 5] === 101 && sheet.data[(r4.y + 5) * sheet.width + r4.x + 5] === 104);
  const gapX = r0.x + TW + 10, gapY = r0.y + TH + 10;
  t('layout: gaps between tiles are white', sheet.data[(r0.y + 20) * sheet.width + gapX] === 255 && sheet.data[gapY * sheet.width + r0.x + 20] === 255);
  t('layout: horizontal gap is at least one crop height', r1.x - (r0.x + TW) >= TH, `${r1.x - (r0.x + TW)} px`);
  t('result has one entry per input and carries stats', res.length === 24 && res.stats && res.stats.tiles === 24);

  // 2. Words are mapped to tiles by position
  const words = [wordIn(0, '25', 95), wordIn(5, '7', 90), wordIn(23, '67', 88)];
  makeWorker(words);
  res = await readFresh(crops(24));
  t('mapping: a word lands in the tile it sits in', res[0].candidates[0].value === 25 && res[5].candidates[0].value === 7 && res[23].candidates[0].value === 67);
  t('mapping: score is the confidence as 0-1', Math.abs(res[0].candidates[0].score - 0.95) < 1e-9);

  // 3. Two words in one tile are joined left to right; words in the gutter are ignored
  const rg = tileRect(2);
  makeWorker([wordIn(2, '4', 90, 25), wordIn(2, '4', 90, -5), { text: '99', confidence: 99, bbox: { x0: (rg.x + TW + 100) * R.options.scale, x1: (rg.x + TW + 140) * R.options.scale, y0: (rg.y + 10) * R.options.scale, y1: (rg.y + 60) * R.options.scale }, symbols: [] }]);
  res = await readFresh(crops(24));
  t('mapping: two digits in one tile are joined by position', res[2].candidates[0].value === 44, JSON.stringify(res[2]));
  t('mapping: a word in the middle of the empty gutter is ignored', !res.some(e => e.candidates.some(c => c.value === 99)));

  // 4. Non-digits are stripped; text without digits is ignored
  makeWorker([wordIn(1, '1|2', 80), wordIn(3, 'ab', 80)]);
  res = await readFresh(crops(24));
  t('mapping: non-digit characters are stripped', res[1].candidates[0].value === 12);
  t('mapping: a word with no digits gives no reading', res[3].candidates.length === 0 || res[3].raw === '');

  // 5. Weak or empty tiles are read again alone; both readings are kept
  const all = Array.from({ length: 24 }, (_, k) => wordIn(k, String(10 + k), 90));
  all[4] = wordIn(4, '63', 20);                      // weak: retried
  const w5 = makeWorker(all.filter((_, k) => k !== 7), { 4: { text: '53', confidence: 65, words: [] }, 7: { text: '37', confidence: 70, words: [] } });
  res = await readFresh(crops(24));
  t('retry: only the weak and the empty tile are read again', res.stats.retries === 2, 'retries=' + res.stats.retries);
  t('retry: retried cells are read with the single-word mode and the sheet mode is restored',
    w5.calls.params.some(p => p.tessedit_pageseg_mode === '8') && w5.calls.params[w5.calls.params.length - 1].tessedit_pageseg_mode === '11');
  t('retry: a weak sheet reading and its retry are both kept as candidates', res[4].candidates.map(c => c.value).sort().join() === '53,63', JSON.stringify(res[4].candidates));
  t('retry: the better-scored candidate comes first', res[4].candidates[0].value === 53);
  t('retry: an empty tile takes the retry reading', res[7].candidates[0].value === 37);
  t('retry: confident tiles are not read again', res[0].candidates[0].value === 10 && res.stats.retries === 2);

  // 6. Skipped cells (null input)
  const inputs = crops(24); inputs[3] = null; inputs[9] = null;
  makeWorker(Array.from({ length: 24 }, (_, k) => wordIn(k, String(20 + k), 90)));
  res = await readFresh(inputs);
  t('skip: null inputs get empty entries and are never retried', res[3].candidates.length === 0 && res[9].candidates.length === 0 && res[4].candidates.length === 1 && res.stats.retries === 0);
  t('skip: stats count only the cells that were read', res.stats.tiles === 22);

  // 7. Crop cleaning: ink becomes 0 and paper 255, and the cut factor decides how dark a pixel must be to count as ink
  const striped = { width: TW, height: TH, data: new Uint8Array(TW * TH).map((_, i) => (i % TW < 20 ? 40 : (i % TW < 30 ? 110 : 230))) };   // ink, shadow, paper
  const countValues = img => { const m = {}; for (const v of img.data) m[v] = (m[v] || 0) + 1; return m; };
  for (const [cut, shadowIsInk] of [[1, true], [0.5, false]]) {
    R.options.prep = 'otsu'; R.options.cut = cut;
    const w = makeWorker([]);
    await readFresh([striped, ...Array(23).fill(null)]);
    const sheetGray = w.calls.recognize[0].gray;
    const r = tileRect(0);
    const px = x => sheetGray.data[(r.y + 40) * sheetGray.width + r.x + x];
    t(`cleaning (cut ${cut}): crop becomes pure black and white`, Object.keys(countValues({ data: Array.from({ length: TW }, (_, x) => px(x)) })).every(v => v === '0' || v === '255'));
    t(`cleaning (cut ${cut}): dark ink is black, paper is white`, px(5) === 0 && px(60) === 255);
    t(`cleaning (cut ${cut}): mid-gray shadow ${shadowIsInk ? 'counts as ink' : 'is dropped'}`, (px(25) === 0) === shadowIsInk, 'pixel=' + px(25));
  }
  R.options.prep = 'stretch'; R.options.cut = 0.75;

  // 8. Nothing to read
  makeWorker([]);
  res = await readFresh(Array(24).fill(null));
  t('empty input: returns empty entries without calling the recognizer', res.length === 24 && ctx.__worker.calls.recognize.length === 0);

  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('ERROR', e.stack || e); process.exit(1); });
