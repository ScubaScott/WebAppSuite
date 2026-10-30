// Tests for htdocs/Bingo/scan/review.js (cell states and summary line) with synthetic decoder output, plus a check
// against the saved real readings that the amber "check" state catches the silent wrong readings.
// Run: node review-test.js <repo root>
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const repo = process.argv[2];
const scan = path.join(repo, 'htdocs/Bingo/scan');
const ctx = vm.createContext({ Math, Map, Set, Array, Object, parseInt, isNaN, String, Infinity });
for (const [file, exports] of [['decoder.js', 'Decoder'], ['review.js', 'Review']]) {
  vm.runInContext(fs.readFileSync(path.join(scan, file), 'utf8') + `\nglobalThis.${exports} = ${exports};`, ctx, { filename: file });
}
const { Decoder: D, Review: R } = ctx;

let failed = 0;
const t = (name, ok, detail) => { if (!ok) failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : '')); };

const cell = over => ({ index: 0, value: 5, score: 0.95, kind: 'exact', changedByDecoder: false, covered: false, glare: false, ...over });

// ---- One cell ----
t('clean confident reading is confident', R.classifyCell(cell()).state === 'confident');
t('score exactly at the limit is confident', R.classifyCell(cell({ score: R.CHECK_BELOW })).state === 'confident');
t('score just under the limit is check', R.classifyCell(cell({ score: R.CHECK_BELOW - 0.01 })).state === 'check');
t('a digit corrected by the decoder (swap) is check', R.classifyCell(cell({ kind: 'swap', changedByDecoder: true })).state === 'check');
t('a missing digit supplied by the decoder (drop) is check', R.classifyCell(cell({ kind: 'drop', changedByDecoder: true })).state === 'check');
t('an exact reading the decoder still changed is check', R.classifyCell(cell({ changedByDecoder: true })).state === 'check');
t('glare makes a confident reading check', R.classifyCell(cell({ glare: true })).state === 'check');
t('an empty cell is missing', R.classifyCell(cell({ value: null, score: 0, kind: 'blank' })).state === 'missing');
t('an ambiguous empty cell is missing and says several numbers fit', (() => { const r = R.classifyCell(cell({ value: null, score: 0, kind: 'ambiguous' })); return r.state === 'missing' && /Several/.test(r.reason); })());
t('a covered cell is covered even when empty', R.classifyCell(cell({ value: null, covered: true, kind: 'blank' })).state === 'covered');
t('covered wins over a value', R.classifyCell(cell({ covered: true })).state === 'covered');
t('check and missing carry a reason for the tooltip', R.classifyCell(cell({ glare: true })).reason !== '' && R.classifyCell(cell({ value: null })).reason !== '');

t('check and missing cells pass on the decoder alternatives; confident and covered ones carry none', JSON.stringify(R.classifyCell(cell({ glare: true, alternatives: [7, 9] })).alternatives) === '[7,9]' && JSON.stringify(R.classifyCell(cell({ value: null, alternatives: [62, 72] })).alternatives) === '[62,72]' && R.classifyCell(cell({ alternatives: [3] })).alternatives.length === 0 && R.classifyCell(cell({ covered: true, alternatives: [3] })).alternatives.length === 0);

// ---- A whole card ----
const decoded = { cells: [] };
for (let i = 0; i < 25; i++) if (i !== 12) decoded.cells.push(cell({ index: i }));
decoded.cells[0] = cell({ index: 0, kind: 'swap', changedByDecoder: true });
decoded.cells[1] = cell({ index: 1, value: null, kind: 'blank', score: 0 });
decoded.cells[2] = cell({ index: 2, value: null, covered: true });
decoded.cells[3] = cell({ index: 3, score: 0.5 });
const states = R.classify(decoded);
t('classify returns 25 states with FREE at index 12', states.length === 25 && states[12].state === 'free');
t('classify keeps each cell at its own index', states[0].state === 'check' && states[1].state === 'missing' && states[2].state === 'covered' && states[3].state === 'check' && states[4].state === 'confident');
const sum = R.summarize(states);
t('summary counts read and to-check cells (20 read, 4 to check)', sum.read === 20 && sum.toCheck === 4, sum.text);
t('summary text reads "20 read · 4 to check"', sum.text === '20 read · 4 to check', sum.text);
t('FREE is not counted', sum.read + sum.toCheck === 24);
states[0] = { state: 'edited', reason: '' };
states[1] = { state: 'edited', reason: '' };
t('cells the user settled count as read', R.summarize(states).text === '22 read · 2 to check', R.summarize(states).text);
t('classify of an empty decode marks every numbered cell missing', R.classify({ cells: [] }).filter((s, i) => i !== 12 && s.state === 'missing').length === 24);

// ---- Real readings: how well "check" finds the silent errors ----
const data = JSON.parse(fs.readFileSync(path.join(repo, 'tools/bingo-scan-testset/baselines/1.5-reader-readings.json'), 'utf8'));
const labels = JSON.parse(fs.readFileSync(path.join(repo, 'tools/bingo-scan-testset/labels.json'), 'utf8')).photos;
let wrongFilled = 0, caught = 0, correct = 0, correctFlagged = 0, cards = 0, perCardCheck = [];
for (const r of data.photos) {
  if (!r.readings || r.profile !== 'slider' || r.labelStatus !== 'checked') continue;
  const want = labels[r.name].labels;
  const cells = r.readings.map(x => ({ index: x.index, col: x.index % 5, row: Math.floor(x.index / 5), raw: x.raw, candidates: x.candidates, covered: x.covered, glare: x.glare }));
  const dec = D.decode(cells);
  const st = R.classify(dec);
  cards++;
  let flagged = 0;
  for (const c of dec.cells) {
    const s = st[c.index].state;
    if (s === 'check' || s === 'missing' || s === 'covered') flagged++;
    if (c.value === null) continue;
    if (c.value === want[c.index]) { correct++; if (s !== 'confident') correctFlagged++; }
    else { wrongFilled++; if (s !== 'confident') caught++; }
  }
  perCardCheck.push(flagged);
}
console.log(`  ${cards} real photos: ${caught} of ${wrongFilled} wrong readings are flagged; ${correctFlagged} of ${correct + correctFlagged} correct readings are flagged; to-check per card: ${perCardCheck.join(' ')}`);
t('real readings: at least 3 of the 4 silent wrong readings are flagged', caught >= 3 && wrongFilled === 4, `${caught}/${wrongFilled}`);
t('real readings: fewer than a quarter of the correct readings are flagged', correctFlagged / (correct + correctFlagged) < 0.25, `${correctFlagged}/${correct + correctFlagged}`);

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
