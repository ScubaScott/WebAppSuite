// Unit tests for htdocs/Bingo/scan/imaging.js (numeric functions only; run with: node imaging-test.js <path to imaging.js>)
const fs = require('fs');
const vm = require('vm');

const code = fs.readFileSync(process.argv[2], 'utf8');
const ctx = vm.createContext({ Math, Uint8Array, Uint8ClampedArray, Float32Array, Float64Array, Int32Array, Map, Array, Object });
vm.runInContext(code + '\nglobalThis.Imaging = Imaging;', ctx);
const I = ctx.Imaging;

let failed = 0;
const t = (name, ok, detail) => { if (!ok) failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : '')); };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
const gray = (w, h, f) => { const d = new Uint8Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = f(x, y); return { width: w, height: h, data: d }; };
const rgba = (w, h, f) => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = f(x, y); const o = (y * w + x) * 4; d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255; } return { width: w, height: h, data: d }; };

// Gray conversion
let g = I.grayFromRGBA(rgba(3, 1, x => [[255, 0, 0], [0, 255, 0], [255, 255, 255]][x]));
t('gray: red/green/white luma', g.data[0] === 76 && g.data[1] === 150 && g.data[2] === 255, Array.from(g.data).join(','));

// Gaussian kernels sum to 1 and are symmetric
for (const k of [3, 5, 7, 11, 15]) {
  const ker = I.gaussianKernel(k);
  t(`gaussian kernel ${k} sums to 1`, near(ker.reduce((a, b) => a + b, 0), 1, 1e-9));
}
t('gaussian blur keeps a flat image flat', Array.from(I.gaussianBlur(gray(9, 9, () => 120), 5).data).every(v => v === 120));
const spike = I.gaussianBlur(gray(9, 9, (x, y) => x === 4 && y === 4 ? 255 : 0), 3);
t('gaussian blur spreads a spike (center 255/4 => 64)', spike.data[4 * 9 + 4] === 64 && spike.data[4 * 9 + 5] === 32 && spike.data[3 * 9 + 3] === 16);

// Median removes a single hot pixel
const hot = I.medianBlur(gray(7, 7, (x, y) => x === 3 && y === 3 ? 255 : 10), 5);
t('median blur removes an isolated pixel', hot.data[3 * 7 + 3] === 10);

// Otsu / threshold
const bi = gray(20, 20, (x) => x < 10 ? 50 : 200);
const ot = I.otsuThreshold(bi);
t('otsu splits 50/200 (threshold in [50,199])', ot >= 50 && ot < 200, 'threshold=' + ot);
const th = I.threshold(bi, ot);
t('threshold maps dark to 0 and bright to 255', th.data[0] === 0 && th.data[19] === 255);

// Adaptive threshold
const flat = I.adaptiveThreshold(gray(15, 15, () => 100), { method: 'gaussian', blockSize: 11, c: 2 });
t('adaptive: flat image is all 255', Array.from(flat.data).every(v => v === 255));
const dot = gray(21, 21, (x, y) => (x === 10 && y === 10) ? 0 : 200);
const ad = I.adaptiveThreshold(dot, { method: 'gaussian', blockSize: 11, c: 2 });
const adInv = I.adaptiveThreshold(dot, { method: 'gaussian', blockSize: 11, c: 2, invert: true });
t('adaptive: dark dot becomes 0, background 255', ad.data[10 * 21 + 10] === 0 && ad.data[0] === 255);
t('adaptive inverse: dark dot becomes 255, background 0', adInv.data[10 * 21 + 10] === 255 && adInv.data[0] === 0);
const mean = I.adaptiveThreshold(dot, { method: 'mean', blockSize: 5, c: 2 });
t('adaptive mean method marks the dark dot', mean.data[10 * 21 + 10] === 0);

// Morphology (2x2 window)
const one = gray(12, 12, (x, y) => x === 5 && y === 5 ? 255 : 0);
const dil = I.morphology(one, 'dilate');
const covered = []; for (let i = 0; i < dil.data.length; i++) if (dil.data[i] === 255) covered.push([i % 12, Math.floor(i / 12)].join(':'));
t('dilate grows one pixel to a 2x2 block', covered.sort().join(',') === '5:5,5:6,6:5,6:6', covered.join(','));
t('erode removes a lone pixel', I.morphology(one, 'erode').data.every(v => v === 0));
const blob = gray(12, 12, (x, y) => (x >= 3 && x <= 7 && y >= 3 && y <= 7) ? 255 : 0);
t('open keeps a large block', I.morphology(blob, 'open').data[5 * 12 + 5] === 255);
const holed = gray(12, 12, (x, y) => (x >= 3 && x <= 7 && y >= 3 && y <= 7 && !(x === 5 && y === 5)) ? 255 : 0);
t('close fills a one-pixel hole', I.morphology(holed, 'close').data[5 * 12 + 5] === 255);

// Connected components
const two = gray(20, 20, (x, y) => ((x >= 2 && x <= 4 && y >= 2 && y <= 4) || (x >= 10 && x <= 13 && y >= 8 && y <= 9)) ? 255 : 0);
const c2 = I.connectedComponents(two).sort((a, b) => a.x - b.x);
t('components: finds two groups', c2.length === 2);
t('components: bbox/area/centroid of first', c2[0].x === 2 && c2[0].y === 2 && c2[0].w === 3 && c2[0].h === 3 && c2[0].area === 9 && near(c2[0].cx, 3) && near(c2[0].cy, 3));
t('components: bbox of second', c2[1].x === 10 && c2[1].y === 8 && c2[1].w === 4 && c2[1].h === 2 && c2[1].area === 8);
const diag = gray(6, 6, (x, y) => (x === 1 && y === 1) || (x === 2 && y === 2) ? 255 : 0);
t('components: diagonal pixels join with 8-connectivity', I.connectedComponents(diag, { connectivity: 8 }).length === 1);
t('components: diagonal pixels split with 4-connectivity', I.connectedComponents(diag, { connectivity: 4 }).length === 2);
const ushape = gray(9, 9, (x, y) => (x === 1 || x === 7 || y === 7) && x >= 1 && x <= 7 && y >= 1 && y <= 7 ? 255 : 0);
t('components: U shape is one group (merge of branches)', I.connectedComponents(ushape).length === 1);
const tilted = gray(30, 30, (x, y) => (Math.abs(x - 15) + Math.abs(y - 15) <= 8) ? 255 : 0);
const [diamond] = I.connectedComponents(tilted);
// A diamond of radius 8 around (15,15): smallest x+y is 22, largest 38, largest x-y is 8, smallest -8
t('components: extreme points have the optimal sums/differences',
  diamond.tl.x + diamond.tl.y === 22 && diamond.br.x + diamond.br.y === 38 && diamond.tr.x - diamond.tr.y === 8 && diamond.bl.x - diamond.bl.y === -8,
  JSON.stringify([diamond.tl, diamond.tr, diamond.br, diamond.bl]));
const para = gray(40, 40, (x, y) => (y >= 5 && y <= 25 && x >= 5 + (y - 5) * 0.5 && x <= 20 + (y - 5) * 0.5) ? 255 : 0);
const [pg] = I.connectedComponents(para);
t('components: parallelogram corners are distinct and ordered',
  pg.tl.y < pg.bl.y && pg.tr.y < pg.br.y && pg.tl.x < pg.tr.x && pg.bl.x < pg.br.x, JSON.stringify([pg.tl, pg.tr, pg.br, pg.bl]));
t('components: background groups via fg=0', I.connectedComponents(two, { fg: 0, connectivity: 4 }).length === 1);

// HSV mask
const hsvImg = rgba(3, 1, x => [[255, 0, 0], [0, 0, 255], [200, 30, 30]][x]);
const m = I.hsvMask(hsvImg, [[0, 40, 40, 20, 255, 255], [150, 40, 40, 180, 255, 255]]);
t('hsv mask: red and dark red pass, blue is rejected', m.data[0] === 255 && m.data[1] === 0 && m.data[2] === 255, Array.from(m.data).join(','));

// Homography
const sq = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
const idH = I.solveHomography(sq, sq);
t('homography: identity', idH.every((v, i) => near(v, [1, 0, 0, 0, 1, 0, 0, 0, 1][i], 1e-9)));
const quad = [{ x: 10, y: 20 }, { x: 90, y: 5 }, { x: 110, y: 95 }, { x: 0, y: 80 }];
const H = I.solveHomography(sq, quad);
let ok = true;
for (let i = 0; i < 4; i++) { const p = I.applyHomography(H, sq[i].x, sq[i].y); if (!near(p.x, quad[i].x, 1e-6) || !near(p.y, quad[i].y, 1e-6)) ok = false; }
t('homography: corners map exactly', ok);
t('homography: degenerate points return null', I.solveHomography([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }], sq) === null);

// Warp: axis-aligned crop
const src = rgba(100, 100, (x, y) => [x * 2, y * 2, 0]);
const w1 = I.warpPerspectiveData(src, { tl: { x: 10, y: 10 }, tr: { x: 90, y: 10 }, br: { x: 90, y: 90 }, bl: { x: 10, y: 90 } }, 80, 80);
t('warp: top-left output pixel equals source (10,10)', w1.data[0] === 20 && w1.data[1] === 20);
t('warp: pixel (40,40) equals source (50,50)', w1.data[(40 * 80 + 40) * 4] === 100 && w1.data[(40 * 80 + 40) * 4 + 1] === 100);
// Warp: tilted quad, check the output center equals the source point the homography predicts
const tq = { tl: { x: 20, y: 10 }, tr: { x: 80, y: 20 }, br: { x: 90, y: 85 }, bl: { x: 10, y: 75 } };
const w2 = I.warpPerspectiveData(src, tq, 60, 60);
const Hq = I.solveHomography([{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 60 }, { x: 0, y: 60 }], [tq.tl, tq.tr, tq.br, tq.bl]);
const center = I.applyHomography(Hq, 30, 30);
t('warp: tilted center samples the predicted source point', Math.abs(w2.data[(30 * 60 + 30) * 4] - center.x * 2) <= 1.5 && Math.abs(w2.data[(30 * 60 + 30) * 4 + 1] - center.y * 2) <= 1.5, `got ${w2.data[(30 * 60 + 30) * 4]},${w2.data[(30 * 60 + 30) * 4 + 1]} want ${(center.x * 2).toFixed(1)},${(center.y * 2).toFixed(1)}`);
const w3 = I.warpPerspectiveData(src, { tl: { x: -50, y: -50 }, tr: { x: 20, y: -50 }, br: { x: 20, y: 20 }, bl: { x: -50, y: 20 } }, 10, 10);
t('warp: area outside the source is transparent black', w3.data[3] === 0);

// Crop
const cr = I.cropGray(gray(10, 10, (x, y) => x + y * 10), 2, 3, 4, 2);
t('cropGray: size and first value', cr.width === 4 && cr.height === 2 && cr.data[0] === 32 && cr.data[7] === 45);
t('invert', I.invert(gray(2, 1, x => x === 0 ? 0 : 200)).data.join(',') === '255,55');

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
