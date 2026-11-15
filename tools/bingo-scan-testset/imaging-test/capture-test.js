// Tests for the pure rules in htdocs/Bingo/scan/capture.js: frame difference, the auto-shutter state machine and the
// outline geometry (no browser, no camera).
// Run: node capture-test.js <repo root>
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const scan = path.join(process.argv[2], 'htdocs/Bingo/scan');
const ctx = vm.createContext({ Math, Map, Set, Array, Object, parseInt, isNaN, String, Infinity, Uint8Array });
for (const [file, exports] of [['profiles.js', 'CardProfiles'], ['capture.js', 'Capture']]) {
  vm.runInContext(fs.readFileSync(path.join(scan, file), 'utf8') + `\nglobalThis.${exports} = ${exports};`, ctx, { filename: file });
}
const { Capture: C, CardProfiles: P } = ctx;

let failed = 0;
const t = (name, ok, detail) => { if (!ok) failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : '')); };

// ---- Frame difference ----
const a = new Uint8Array(100).fill(100);
t('identical frames differ by 0', C.frameDifference(a, a.slice()) === 0);
t('a uniform change of 7 levels differs by 7', C.frameDifference(a, new Uint8Array(100).fill(107)) === 7);
t('frames of different size are never steady', C.frameDifference(a, new Uint8Array(50)) === Infinity);
t('a missing first frame is never steady', C.frameDifference(null, a) === Infinity);

// ---- Shutter ----
const ok25 = { ok: true, windows: 25 };
const ok16 = { ok: true, windows: 16 };
const ok15 = { ok: true, windows: 15 };
const fresh = () => C.createShutter({ diffLimit: 5, holdMs: 600, minWindows: 16, cooldownMs: 1500 });

// Plays a sequence of [timeMs, diff, detectionResult or undefined]; returns the state after each step
function play(shutter, steps, enabled = true) {
  return steps.map(([now, diff, det]) => {
    shutter.frame(now, diff);
    if (det !== undefined) shutter.detection(now, det);
    return shutter.state(now, enabled);
  });
}

let s = fresh();
let out = play(s, [[0, 1, ok25], [200, 1, ok25], [400, 1, ok25], [599, 1, ok25], [600, 1, ok25]]);
t('steady with 25 windows holds, then fires at 600 ms', out.slice(0, 4).every(x => x.state === 'holding') && out[4].state === 'fire', out.map(x => x.state).join(','));
t('progress climbs towards 1 while holding', out[1].progress > out[0].progress && out[3].progress < 1 && out[4].progress === 1);

s = fresh();
out = play(s, [[0, 1, ok16], [700, 1, ok16]]);
t('exactly 16 windows is enough', out[1].state === 'fire');

s = fresh();
out = play(s, [[0, 1, ok15], [700, 1, ok15]]);
t('15 windows never fires', out.every(x => x.state === 'searching'), out.map(x => x.state).join(','));

s = fresh();
out = play(s, [[0, 1, { ok: false, windows: 25 }], [700, 1, { ok: false, windows: 25 }]]);
t('a rejected grid never fires even with many blobs', out.every(x => x.state === 'searching'));

s = fresh();
out = play(s, [[0, 1, ok25], [300, 1, ok25], [450, 9, ok25], [600, 1, ok25], [900, 1, ok25], [1200, 1, ok25]]);
t('movement restarts the 600 ms wait', out[2].state === 'moving' && out[4].state === 'holding' && out[5].state === 'fire', out.map(x => x.state).join(','));

s = fresh();
out = play(s, [[0, 1, ok25], [300, 9], [350, 1], [1000, 1]]);
t('a detection from before the movement does not count after it', out[2].state === 'searching' && out[3].state === 'searching', out.map(x => x.state).join(','));
s.detection(1010, ok25);
t('a fresh detection after the steady spell started allows the photo', s.state(1010, true).state === 'fire');

s = fresh();
out = play(s, [[0, 1, ok25], [700, 1, ok25]], false);
t('switched off: nothing fires', out.every(x => x.state === 'idle'));

s = fresh();
play(s, [[0, 1, ok25], [700, 1, ok25]]);
s.cooldown(700);
out = play(s, [[800, 1, ok25], [1500, 1, ok25], [2300, 1, ok25], [2400, 1, ok25], [3000, 1, ok25]]);
t('after a photo the shutter waits out the cooldown, then needs a new full steady spell', out[0].state === 'idle' && out[1].state === 'idle' && out[2].state === 'holding' && out[3].state === 'holding' && out[4].state === 'fire', out.map(x => x.state).join(','));

s = fresh();
t('searching for windows only when the picture is nearly steady', s.wantsDetection(5) && s.wantsDetection(15) && !s.wantsDetection(16));

s = fresh();
out = play(s, [[0, 1], [700, 1]]);
t('steady but no search yet: searching, never fires', out.every(x => x.state === 'searching'));

// ---- Outline ----
const rects = C.outlineRects(P.slider);
t('outline has 25 window rectangles', rects.length === 25);
const xs = rects.map(r => r.x), ys = rects.map(r => r.y);
const left = Math.min(...xs), right = Math.max(...rects.map(r => r.x + r.w));
const top = Math.min(...ys), bottom = Math.max(...rects.map(r => r.y + r.h));
t('outline is centered in the square', Math.abs(left - (1 - right)) < 1e-9 && Math.abs(top - (1 - bottom)) < 1e-9, `${left.toFixed(3)}..${right.toFixed(3)}`);
t('outline fills about 80% of the width', Math.abs((right - left) - 0.8) < 0.02, (right - left).toFixed(3));
t('window rectangles use the profile window shape (about 0.466 x 0.54 of the spacing)', Math.abs(rects[0].w / (rects[1].x - rects[0].x) - P.slider.cell.windowFrac) < 1e-9 && Math.abs(rects[0].h / (rects[5].y - rects[0].y) - P.slider.cell.windowFracY) < 1e-9);
t('outline stays inside the square', left > 0 && top > 0 && right < 1 && bottom < 1);
t('slider profile has live settings (320 px, 3 mask modes)', P.slider.live.size === 320 && P.slider.live.maskModes === 3);

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
