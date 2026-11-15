// Tests for htdocs/Bingo/scan/decoder.js on small synthetic cases (no browser, no photos).
// Run: node decoder-test.js <scan folder>
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ctx = vm.createContext({ Math, Map, Set, Array, Object, parseInt, isNaN, String, Infinity });
vm.runInContext(fs.readFileSync(path.join(process.argv[2], 'decoder.js'), 'utf8') + '\nglobalThis.Decoder = Decoder; globalThis.COLUMN_RANGES = COLUMN_RANGES;', ctx, { filename: 'decoder.js' });
const D = ctx.Decoder;

let failed = 0;
const t = (name, ok, detail) => { if (!ok) failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : '')); };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

// Builds the 24 numbered cells of a card from a map { index: [[value, score], ...] }
function card(readings, extra = {}) {
  const cells = [];
  for (let index = 0; index < 25; index++) {
    if (index === 12) continue;
    const list = readings[index] || [];
    cells.push({ index, col: index % 5, row: Math.floor(index / 5), candidates: list.map(([value, score]) => ({ value, score })), ...(extra[index] || {}) });
  }
  return cells;
}
const values = opts => opts.map(o => o.value).sort((a, b) => a - b);

// ---- Column ranges ----
t('ranges: B 1-15, I 16-30, N 31-45, G 46-60, O 61-75', JSON.stringify(ctx.COLUMN_RANGES) === JSON.stringify([[1, 15], [16, 30], [31, 45], [46, 60], [61, 75]]));

// ---- Candidate expansion ----
let o = D.optionsFor([{ value: 52, score: 0.9 }], 3);
t('options: an in-range reading is the top option, unchanged', o[0].value === 52 && o[0].kind === 'exact' && near(Math.exp(o[0].logp), 0.9));
o = D.optionsFor([{ value: 32, score: 0.9 }], 3);
t('options: out-of-range "32" in G offers 52 through the 3/5 look-alike', o.some(x => x.value === 52 && x.kind === 'swap'), JSON.stringify(values(o)));
t('options: the reading itself is never offered outside its column', !o.some(x => x.value === 32));
o = D.optionsFor([{ value: 4, score: 0.8 }], 3);
t('options: a lone "4" in G expands to 46-49 and 54 (spec example)', [46, 47, 48, 49, 54].every(v => o.some(x => x.value === v)), JSON.stringify(values(o)));
t('options: dropped-digit options are marked and weaker than an exact reading', o.every(x => x.kind === 'drop' && Math.exp(x.logp) < 0.8 * 0.5));
o = D.optionsFor([{ value: 2, score: 0.8 }], 4);
t('options: a lone "2" in O gives 62 and 72', JSON.stringify(values(o)) === JSON.stringify([62, 72]), JSON.stringify(values(o)));
o = D.optionsFor([{ value: 520, score: 0.7 }], 3);
t('options: extra digits "520" in G still offer 52 (and 5x, x0)', o.some(x => x.value === 52 && x.kind === 'extra'), JSON.stringify(values(o)));
o = D.optionsFor([{ value: 12, score: 0.7 }], 4);
t('options: "12" in O offers 72 (1 read for 7)', o.some(x => x.value === 72), JSON.stringify(values(o)));
t('options: score 0 is floored so a correct reading with confidence 0 still beats its swaps', (() => { const z = D.optionsFor([{ value: 63, score: 0 }], 4); return z[0].value === 63 && z[0].kind === 'exact'; })());
t('options: no candidates gives no options', D.optionsFor([], 2).length === 0);
t('options: at most 8 are kept', D.optionsFor([{ value: 3, score: 0.5 }], 2).length <= 8);

// ---- Column solve ----
const blankOpt = [];
let picks = D.solveColumn([[{ value: 5, logp: Math.log(0.9) }, { value: 6, logp: Math.log(0.5) }], [{ value: 5, logp: Math.log(0.8) }, { value: 6, logp: Math.log(0.1) }]]);
t('solve: conflicts go to the assignment with the best total (6 and 5, not 5 and 6)', picks[0].value === 6 && picks[1].value === 5, picks.map(p => p.value).join());
picks = D.solveColumn([[{ value: 7, logp: Math.log(0.9) }], [{ value: 7, logp: Math.log(0.9) }]]);
t('solve: two cells with only the same option: one gets it, the other is blank', picks.filter(p => p.value === 7).length === 1 && picks.filter(p => p.value === null).length === 1);
picks = D.solveColumn([[{ value: 9, logp: Math.log(0.4) }, { value: 3, logp: Math.log(0.4 * 0.3) }], [{ value: 9, logp: Math.log(0.7) }, { value: 3, logp: Math.log(0.7 * 0.3) }]]);
t('solve: an exact tie goes to the more confident reading (the 0.7 cell keeps the 9)', picks[1].value === 9 && picks[0].value === 3, picks.map(p => p.value).join());
picks = D.solveColumn([[], []]);
t('solve: cells with no options are blank', picks.every(p => p.value === null && p.kind === 'blank'));

// ---- Baseline (what the reader alone gives) ----
const base = D.baseline(card({ 1: [[25, 0.9]], 2: [[99, 0.9], [44, 0.5]], 6: [[25, 0.7]], 5: [[12, 0.9]] }));
t('baseline: first in-range candidate wins, FREE in the middle', base[0][1] === 25 && base[0][2] === 44 && base[2][2] === 'FREE');
t('baseline: a repeated number is cleared on its later cell', base[1][1] === null);

// ---- Whole card ----
let r = D.decode(card({ 3: [[32, 0.8]], 8: [[33, 0.85]], 19: [[33, 0.9]] }));
t('decode: out-of-range readings are corrected from look-alikes (32 to 52 in G)', r.grid[0][3] === 52 && r.cells.find(c => c.index === 3).changedByDecoder === true);
t('decode: corrected cells are flagged as changed with a lower score', r.cells.find(c => c.index === 3).score < 0.8);
t('decode: 33 in G (row 1) becomes 53, and a second 33 in G (row 3) becomes 53 or is left empty, never a repeat',
  r.grid[1][3] === 53 && r.grid[3][3] !== 53, `row1=${r.grid[1][3]} row3=${r.grid[3][3]}`);
r = D.decode(card({ 1: [[25, 0.9]], 6: [[20, 0.9]] }));
t('decode: a reading that is already valid is kept and not marked as changed', r.grid[0][1] === 25 && r.cells.find(c => c.index === 1).changedByDecoder === false && r.cells.find(c => c.index === 1).kind === 'exact');
r = D.decode(card({ 2: [[3, 0.6]] }));      // N column: a lone "3" could be 31-39 or 43
const cell2 = r.cells.find(c => c.index === 2);
t('decode: a lone digit that could be many numbers leaves the cell empty and lists alternatives', cell2.value === null && cell2.kind === 'ambiguous' && cell2.alternatives.length === 2, JSON.stringify(cell2.alternatives));
r = D.decode(card({ 10: [[3, 0.6]] }));      // B column: 3 is itself a valid number, so it is kept
t('decode: a lone digit that is itself a valid number for its column is kept', r.grid[2][0] === 3 && r.cells.find(c => c.index === 10).kind === 'exact');
r = D.decode(card({ 11: [[3, 0.6]] }));      // I column: 3 is out of range and ambiguous among 23, 30, 13... only 23/30/..
const cell11 = r.cells.find(c => c.index === 11);
t('decode: an ambiguous guess is left empty (kind "ambiguous") with alternatives to offer', cell11.value === null && cell11.kind === 'ambiguous' && cell11.alternatives.length > 0, JSON.stringify(cell11));
r = D.decode(card({ 4: [[2, 0.7]] }));
const cell4 = r.cells.find(c => c.index === 4);
t('decode: "2" in O is 62 or 72 equally likely: left empty, both offered', cell4.value === null && cell4.alternatives.includes(62) && cell4.alternatives.includes(72), JSON.stringify(cell4));
r = D.decode(card({ 0: [[2, 0.8]], 5: [[12, 0.9]] }, { 0: { glare: true } }));
t('decode: glare flag is carried through', r.cells.find(c => c.index === 0).glare === true && r.cells.find(c => c.index === 5).glare === false);
r = D.decode(card({ 0: [[2, 0.8]] }, { 0: { covered: true } }));
t('decode: a covered cell is never read, even if the reader gave something', r.grid[0][0] === null && r.cells.find(c => c.index === 0).covered === true);
r = D.decode(card({}));
t('decode: an empty card decodes to an empty grid with FREE', r.grid[2][2] === 'FREE' && r.grid.flat().filter(v => v !== null).length === 1 && r.score === 0);
t('decode: result has 24 cells in index order', r.cells.length === 24 && r.cells.every((c, k, a) => !k || a[k - 1].index < c.index));

// ---- Whole-card property: output is always valid ----
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
let allValid = true;
for (let trial = 0; trial < 300; trial++) {
  const readings = {};
  for (let index = 0; index < 25; index++) {
    if (index === 12 || rnd() < 0.15) continue;
    const n = 1 + Math.floor(rnd() * 2);
    readings[index] = Array.from({ length: n }, () => [Math.floor(rnd() * 130) + 1, rnd()]);
  }
  const res = D.decode(card(readings));
  const seen = new Set();
  for (const c of res.cells) {
    if (c.value === null) continue;
    const [lo, hi] = ctx.COLUMN_RANGES[c.col];
    if (c.value < lo || c.value > hi || seen.has(c.value)) allValid = false;
    seen.add(c.value);
  }
}
t('property: 300 random cards always decode to in-range numbers with no repeats', allValid);

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
