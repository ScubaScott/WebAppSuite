// Tests for the detection core of htdocs/Bingo/scan/geometry.js on synthetic slider cards.
// Run: node geometry-test.js <scan folder>
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const dir = process.argv[2];
const ctx = vm.createContext({ Math, Uint8Array, Uint8ClampedArray, Float32Array, Float64Array, Int32Array, Map, Set, Array, Object, isFinite, console });
for (const f of ['imaging.js', 'profiles.js', 'geometry.js']) vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
vm.runInContext('globalThis.Imaging = Imaging; globalThis.Geometry = Geometry; globalThis.CardProfiles = CardProfiles;', ctx);
const { Imaging: I, Geometry: G, CardProfiles: P } = ctx;

let failed = 0;
const t = (name, ok, detail) => { if (!ok) failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : '')); };

// Renders a synthetic slider card photo. `H0` maps grid (col,row) to pixel position.
function render(w, h, H0, opts = {}) {
  const Hinv = invert(H0);
  const d = new Uint8ClampedArray(w * h * 4);
  const missing = new Set((opts.missing || []).map(([c, r]) => c + ',' + r));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const q = I.applyHomography(Hinv, x, y);
      const a = q.x, b = q.y;
      let col = [35, 38, 48];                                          // dark table
      if (a > -0.8 && a < 4.8 && b > -2.1 && b < 5.1) col = [226, 150, 60];       // orange card
      if (a > -0.45 && a < 4.45 && b > -1.7 && b < -0.75) col = [240, 205, 190];  // pale header strip
      const ra = Math.round(a), rb = Math.round(b);
      if (ra >= 0 && ra <= 4 && rb >= 0 && rb <= 4) {
        if (Math.abs(a - ra) < 0.27 && Math.abs(b - rb) < 0.30) {
          if (missing.has(ra + ',' + rb)) col = [170, 30, 30];                          // closed shutter
          else {
            col = [238, 238, 244];                                                      // window
            if (Math.abs(a - ra) < 0.11 && Math.abs(b - rb) < 0.15) col = [60, 60, 85]; // digit ink
          }
        } else if (Math.abs(b - (rb + 0.5)) < 0.06 && Math.abs(a - ra) < 0.4) {
          col = a - ra < -0.15 ? [150, 25, 25] : [225, 225, 230];                       // slider tab and rail
        }
      }
      // Clutter: bright squares and a large bright screen elsewhere in the picture
      for (const c of (opts.clutter || [])) if (x >= c[0] && x < c[0] + c[2] && y >= c[1] && y < c[1] + c[3]) col = [245, 245, 250];
      const o = (y * w + x) * 4;
      d[o] = col[0]; d[o + 1] = col[1]; d[o + 2] = col[2]; d[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: d };
}
function invert(H) {
  const [a, b, c, d, e, f, g, h, i] = H;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  return [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det,
    (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
    (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det];
}
const homog = pts => I.solveHomography([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }], pts);
const maxCornerError = (res, truthH) => {
  let m = 0;
  for (const [c, r] of [[0, 0], [4, 0], [4, 4], [0, 4], [2, 2]]) {
    const p = G.cellCenter(res, c, r), q = I.applyHomography(truthH, c, r);
    m = Math.max(m, Math.hypot(p.x - q.x, p.y - q.y));
  }
  return m;
};
const run = img => G.detectOnImageData(img, P.slider);

// 1. Upright card
const H1 = homog([{ x: 120, y: 200 }, { x: 400, y: 200 }, { x: 400, y: 520 }, { x: 120, y: 520 }].map(p => ({ x: p.x * 0.9 + 20, y: p.y * 0.9 + 10 })));
// (the grid is 4 cells wide and 4 cells tall between the outer window centers)
let r = run(render(520, 640, H1));
t('upright card: grid found with 25 windows', r.ok && r.windows === 25, `ok=${r.ok} windows=${r.windows} err=${(r.err * 100).toFixed(2)}%`);
t('upright card: fitted grid lands on the true window centers (< 1.5 px)', r.ok && maxCornerError({ H: r.H }, H1) < 1.5, r.ok ? maxCornerError({ H: r.H }, H1).toFixed(2) + ' px' : '');

// 2. Rotated about 12 degrees with perspective (the top is narrower than the bottom)
const H2 = homog([{ x: 150, y: 150 }, { x: 380, y: 190 }, { x: 440, y: 520 }, { x: 80, y: 480 }]);
r = run(render(560, 640, H2));
t('tilted card: grid found', r.ok && r.windows >= 24, `ok=${r.ok} windows=${r.windows} err=${(r.err * 100).toFixed(2)}% reason=${r.reason}`);
// Under strong perspective the centroid of a window blob sits a little off the projected window center, so allow 3 px (about 3% of the cell spacing)
t('tilted card: fitted grid lands on the true centers (< 3 px)', r.ok && maxCornerError({ H: r.H }, H2) < 3, r.ok ? maxCornerError({ H: r.H }, H2).toFixed(2) + ' px' : '');

// 3. Six closed shutters (windows missing from the picture)
r = run(render(520, 640, H1, { missing: [[0, 0], [3, 1], [1, 2], [4, 3], [2, 4], [0, 3]] }));
t('closed shutters: still found from the remaining windows', r.ok && r.windows === 19, `ok=${r.ok} windows=${r.windows}`);
t('closed shutters: missing cells are predicted correctly (< 1.5 px)', r.ok && maxCornerError({ H: r.H }, H1) < 1.5);

// 4. Clutter: a big bright screen and loose bright squares
r = run(render(560, 640, H2, { clutter: [[10, 10, 140, 90], [470, 20, 30, 34], [20, 560, 34, 36], [500, 580, 32, 34], [260, 600, 33, 33]] }));
t('clutter: grid still found and accurate (< 3 px)', r.ok && maxCornerError({ H: r.H }, H2) < 3, `ok=${r.ok} windows=${r.windows} error=${r.ok ? maxCornerError({ H: r.H }, H2).toFixed(2) : '-'} px`);

// 5. Too few windows (only 9 visible)
const missingMany = []; for (let rr = 0; rr < 5; rr++) for (let cc = 0; cc < 5; cc++) if ((cc + rr) % 2 === 1 || cc === 4) missingMany.push([cc, rr]);
r = run(render(520, 640, H1, { missing: missingMany }));
t('too few windows: rejected', !r.ok, `ok=${r.ok} windows=${r.windows} reason=${r.reason}`);

// 6. A whole column missing: the grid position is ambiguous
const col0 = [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]];
r = run(render(520, 640, H1, { missing: col0 }));
t('whole column missing: rejected as ambiguous', !r.ok, `ok=${r.ok} windows=${r.windows} reason=${r.reason}`);

// 7. No card at all
const blank = { width: 400, height: 500, data: new Uint8ClampedArray(400 * 500 * 4).fill(40) };
r = run(blank);
t('empty picture: rejected without error', !r.ok && r.windows === 0, r.reason);

// 8. Manual corners
const m = G.fromCorners({ tl: { x: 100, y: 100 }, tr: { x: 500, y: 110 }, br: { x: 510, y: 560 }, bl: { x: 90, y: 550 } });
const c22 = G.cellCenter(m, 2, 2);
t('manual: corner centers define the grid', m.ok && Math.abs(G.cellCenter(m, 0, 0).x - 100) < 1e-6 && c22.x > 250 && c22.x < 350, JSON.stringify(c22));
const q = G.gridQuad(m);
t('manual: outer quad extends half a cell beyond the corner centers', q.tl.x < 100 && q.tl.y < 100 && q.br.x > 510 && q.br.y > 560);
const bad = G.fromCorners({ tl: { x: 1, y: 1 }, tr: { x: 1, y: 1 }, br: { x: 1, y: 1 }, bl: { x: 1, y: 1 } });
t('manual: degenerate corners are reported, not thrown', !bad.ok);

// 9. estimateSteps on a plain lattice
const pts = []; for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) pts.push({ x: 100 + i * 80 + j * 8, y: 100 + j * 70 - i * 6 });
const st = G.estimateSteps(pts);
t('estimateSteps: finds one-cell-right and one-cell-down vectors', st && Math.abs(st.u.x - 80) < 3 && Math.abs(st.u.y + 6) < 3 && Math.abs(st.v.x - 8) < 3 && Math.abs(st.v.y - 70) < 3, JSON.stringify(st));

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
