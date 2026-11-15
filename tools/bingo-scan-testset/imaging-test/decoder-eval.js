// Compares the raw reader answers with the decoder's answers on saved real readings (no browser needed).
// The readings come from the benchmark (tools/bingo-scan-testset/baselines/1.5-reader-readings.json).
// Usage: node decoder-eval.js <repo root> [verbose]
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const repo = process.argv[2];
const verbose = process.argv[3] === 'verbose';
const ctx = vm.createContext({ Math, Map, Set, Array, Object, parseInt, isNaN, String, Infinity });
vm.runInContext(fs.readFileSync(path.join(repo, 'htdocs/Bingo/scan/decoder.js'), 'utf8') + '\nglobalThis.Decoder = Decoder;', ctx, { filename: 'decoder.js' });
const D = ctx.Decoder;

const data = JSON.parse(fs.readFileSync(path.join(repo, 'tools/bingo-scan-testset/baselines/1.5-reader-readings.json'), 'utf8'));
const labels = JSON.parse(fs.readFileSync(path.join(repo, 'tools/bingo-scan-testset/labels.json'), 'utf8')).photos;

const groups = {};
const add = (g, key, v) => { groups[g] = groups[g] || { photos: 0, cells: 0, raw: 0, dec: 0, rawWrong: 0, decWrong: 0, rawExact: 0, decExact: 0, changed: 0 }; groups[g][key] += v; };

for (const r of data.photos) {
  if (!r.readings || r.profile !== 'slider') continue;
  const L = labels[r.name].labels;
  const cells = r.readings.map(x => ({ index: x.index, col: x.index % 5, row: Math.floor(x.index / 5), raw: x.raw, candidates: x.candidates, covered: x.covered, glare: x.glare }));
  const rawGrid = D.baseline(cells);
  const dec = D.decode(cells);
  let rc = 0, dc = 0, rw = 0, dw = 0;
  for (const c of cells) {
    const want = L[c.index];
    const rv = rawGrid[c.row][c.col], dv = dec.grid[c.row][c.col];
    if (rv === want) rc++; else if (rv !== null) rw++;
    if (dv === want) dc++; else if (dv !== null) dw++;
    if (verbose && rv !== dv) console.log(`  ${r.name} cell ${c.index} want ${want}: raw ${rv} -> decoded ${dv}   (reader: ${JSON.stringify(c.candidates.map(x => x.value + ':' + x.score.toFixed(2)))})`);
  }
  const g = r.labelStatus === 'checked' ? 'headline (' + r.split + ')' : 'needs-review (' + r.split + ')';
  for (const key of [g, r.labelStatus === 'checked' ? 'headline (all)' : 'needs-review (all)']) {
    add(key, 'photos', 1); add(key, 'cells', 24);
    add(key, 'raw', rc); add(key, 'dec', dc); add(key, 'rawWrong', rw); add(key, 'decWrong', dw);
    add(key, 'rawExact', rc === 24 ? 1 : 0); add(key, 'decExact', dc === 24 ? 1 : 0);
    add(key, 'changed', dec.cells.filter(c => c.changedByDecoder).length);
  }
  if (verbose) console.log(r.name.padEnd(28), `raw ${rc}/24 (wrong ${rw})  decoded ${dc}/24 (wrong ${dw})`);
}

console.log('\ngroup'.padEnd(26), 'photos', 'raw correct', 'decoded correct', 'raw wrong', 'dec wrong', 'exact raw/dec', 'cells changed');
for (const [name, g] of Object.entries(groups)) {
  console.log(name.padEnd(25), String(g.photos).padStart(6), `${g.raw}/${g.cells}`.padStart(11), `${g.dec}/${g.cells} (${(100 * g.dec / g.cells).toFixed(1)}%)`.padStart(20), String(g.rawWrong).padStart(9), String(g.decWrong).padStart(9), `${g.rawExact}/${g.decExact}`.padStart(13), String(g.changed).padStart(13));
}
