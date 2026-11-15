// Tests for the pure parts of htdocs/Bingo/scan/training-store.js: which labels a sample may carry and the device text.
// The storage, upload and settings behavior is covered end to end in ../server-test/training-e2e-test.js.
// Run: node training-store-test.js <scan folder>
const fs = require('fs');
const vm = require('vm');
const path = require('path');

// Minimal browser stand-ins: the store only touches these when it is started or used for storage
const store = {};
const ctx = vm.createContext({
  Math, Map, Set, Array, Object, Number, String, JSON, Date, parseInt, isNaN, Promise, console,
  window: { addEventListener() {}, location: { pathname: '/Bingo/scan/scan.html' } },
  localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
  document: {}, navigator: { onLine: true }, screen: { width: 1, height: 1 }, crypto: {}
});
vm.runInContext(fs.readFileSync(path.join(process.argv[2], 'training-store.js'), 'utf8') + '\nglobalThis.TrainingStore = TrainingStore;', ctx, { filename: 'training-store.js' });
const T = ctx.TrainingStore;

let failed = 0;
const t = (name, ok, detail) => { if (!ok) failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : '')); };

// A card whose numbers all follow the rules: column c, row r holds 15*c + r + 1
const goodLabels = Array.from({ length: 25 }, (_, i) => (i === 12 ? 'FREE' : 15 * (i % 5) + Math.floor(i / 5) + 1));
const decoded = goodLabels.map((v, i) => ({ index: i, value: i === 12 ? null : v, score: 0.9, covered: false, glare: i === 3 }));

// ---- Defaults ----
const s = T.getSettings();
t('defaults: contributing on, photo off, notice not yet seen', s.contribute === true && s.includePhoto === false && s.noticeSeen === false && s.uploaded === 0 && s.blocked === null);
t('defaults: the notice is due on the first scan', T.shouldShowNotice() === true);
T.setSettings({ noticeSeen: true });
t('settings: dismissing the notice is remembered', T.shouldShowNotice() === false && T.getSettings().noticeSeen === true);
T.setSettings({ contribute: false, noticeSeen: false });
t('settings: no notice is due when contributing is off', T.shouldShowNotice() === false);
T.setSettings({ contribute: true });
t('settings: a change survives a reload (stored)', JSON.parse(store.bingoScanTrainingSettings).contribute === true);

// ---- Cell records ----
let cells = T.buildCellRecords(goodLabels, decoded);
t('cells: always 25 records', cells.length === 25);
t('cells: FREE has no label or prediction', cells[12].label === null && cells[12].predicted === null);
t('cells: confirmed numbers become labels', cells.every((c, i) => i === 12 || c.label === goodLabels[i]));
t('cells: a prediction equal to the label is not a correction', cells.every(c => c.corrected === false));
t('cells: scores and flags come from the decoder', cells[0].score === 0.9 && cells[3].glare === true && cells[0].glare === false);

const edited = goodLabels.slice(); edited[0] = 5; edited[7] = 22;   // the user changed two numbers
cells = T.buildCellRecords(edited, decoded);
t('cells: a number the user changed is a correction, with the reader\'s guess kept', cells[0].label === 5 && cells[0].predicted === 1 && cells[0].corrected === true);
t('cells: an unchanged number is not flagged', cells[1].corrected === false);

// ---- Labels that break the card rules are dropped, not sent ----
const broken = goodLabels.slice();
broken[0] = 20;           // B column holds 1-15
broken[5] = 3; broken[10] = 3;   // 3 twice in the B column
broken[1] = 'abc';        // not a number
broken[2] = null;         // left blank
cells = T.buildCellRecords(broken, decoded);
t('rules: a number outside its column range is dropped', cells[0].label === null);
t('rules: a repeated number keeps its first copy only', cells[5].label === 3 && cells[10].label === null);
t('rules: text and blanks give no label', cells[1].label === null && cells[2].label === null);
t('rules: a dropped label still records what the reader guessed', cells[0].predicted === 1 && cells[0].corrected === true);
t('rules: every label that remains is valid and unique', (() => {
  const seen = new Set();
  return cells.every((c, i) => { if (c.label === null) return true; const lo = 15 * (i % 5) + 1; const ok = c.label >= lo && c.label <= lo + 14 && !seen.has(c.label); seen.add(c.label); return ok; });
})());

// ---- Missing decoder data ----
cells = T.buildCellRecords(goodLabels, []);
t('cells: without decoder output the labels still come through, with no prediction', cells.every((c, i) => i === 12 || (c.label === goodLabels[i] && c.predicted === null && c.score === null && c.corrected === true)));

// ---- Device text ----
const chromeAndroid = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
t('device: browser, version, system and screen', T.deviceString(chromeAndroid, { width: 412, height: 915, ratio: 2.6 }) === 'Chrome 130 / Android; 412x915@2.6', T.deviceString(chromeAndroid, { width: 412, height: 915, ratio: 2.6 }));
const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
t('device: an iPhone', /iPhone/.test(T.deviceString(iphone, { width: 390, height: 844, ratio: 3 })));
t('device: Edge is named as Edge', /^Edg 1/.test(T.deviceString('Mozilla/5.0 (Windows NT 10.0) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0', { width: 1, height: 1, ratio: 1 })));
t('device: an empty user agent still gives text', T.deviceString('', { width: 1, height: 1, ratio: 1 }).length > 0);
t('device: never longer than the server accepts (100)', T.deviceString('x'.repeat(500) + ' Chrome/1 Android', { width: 99999, height: 99999, ratio: 99 }).length <= 100);

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
