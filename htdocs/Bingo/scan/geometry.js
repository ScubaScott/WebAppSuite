// Geometry module version identifier
const GEOMETRY_VERSION = '1.3';

// Finds the 5x5 grid of number windows in a card photo, fits the camera perspective to it, and cuts one
// standard-size crop per cell. Works from the windows themselves (not the card outline or slider tabs).
// Depends on imaging.js and profiles.js. The numeric detection functions take ImageData and run anywhere;
// the canvas wrappers (analyze, extractCells, rectifiedGrid, drawOverlay) need a browser.
const Geometry = (() => {
    const N = 5;                       // grid is N x N
    const FREE_INDEX = 12;             // center cell of the grid
    const NEIGHBOR_STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const median = values => {
        const s = values.slice().sort((a, b) => a - b);
        return s.length ? s[Math.floor(s.length / 2)] : 0;
    };

    // ---- Step 1: bright blobs that could be windows ----

    // One color channel of an image as a gray image: 'min' (lowest of R,G,B), 'r', 'g' or 'b'
    function channel(img, name) {
        if (name === 'min') return Imaging.minChannel(img);
        const offset = { r: 0, g: 1, b: 2 }[name];
        const n = img.width * img.height;
        const out = new Uint8Array(n);
        for (let i = 0, p = offset; i < n; i++, p += 4) out[i] = img.data[p];
        return { width: img.width, height: img.height, data: out };
    }

    // Black/white mask where number windows are white. `mode` picks how a window is told from the card
    // (see CardProfiles): 'local:<channel>:<fraction>:<margin>' compares each pixel with the average of its
    // surroundings, 'min-otsu2' uses a global cut. Windows are light plastic on an orange or dark card, so a
    // channel where plastic is bright and the card is not (blue, or the min of R,G,B) separates them.
    function buildMask(img, mode) {
        if (mode.startsWith('local:')) {
            const [, name, frac, margin] = mode.split(':');
            const gray = Imaging.gaussianBlur(channel(img, name), 3);
            const block = (Math.round(Math.max(img.width, img.height) * Number(frac)) | 1);
            // Brighter than the neighborhood average by at least `margin`
            return Imaging.adaptiveThreshold(gray, { method: 'mean', blockSize: Math.max(15, block), c: -Number(margin) });
        }
        const white = Imaging.gaussianBlur(Imaging.minChannel(img), 3);
        if (mode === 'min-otsu2') {
            // First cut separates the dark table from the card; a second cut among the brighter pixels separates windows from card
            const first = Imaging.otsuThreshold(white);
            const brighter = white.data.filter(v => v > first);
            const second = brighter.length ? Imaging.otsuThreshold({ width: brighter.length, height: 1, data: brighter }) : first;
            return Imaging.threshold(white, second);
        }
        // 'min-otsu': one global cut
        return Imaging.threshold(white, Imaging.otsuThreshold(white));
    }

    // Blobs of the mask that have a window-like size and shape
    function candidateBlobs(mask, profile) {
        const total = mask.width * mask.height;
        const b = profile.blob;
        const solid = Imaging.fillHoles(mask, Math.max(20, Math.round(total * b.maxHoleFrac)));
        const out = [];
        for (const c of Imaging.connectedComponents(solid, { fg: 255, connectivity: 8 })) {
            const aspect = c.w / c.h;
            const fill = c.area / (c.w * c.h);
            if (c.area < total * b.minAreaFrac || c.area > total * b.maxAreaFrac) continue;
            if (aspect < b.aspect[0] || aspect > b.aspect[1] || fill < b.minFill) continue;
            // A blob touching the picture edge is cut off, so its center is unreliable
            if (c.x <= 0 || c.y <= 0 || c.x + c.w >= mask.width || c.y + c.h >= mask.height) continue;
            out.push({ x: c.cx, y: c.cy, w: c.w, h: c.h, area: c.area });
        }
        return out;
    }

    // ---- Step 2: grid directions ----

    // Estimates the two grid step vectors (one cell to the right, one cell down) from how nearby blobs sit
    // relative to each other. Returns { u, v } or null.
    function estimateSteps(pts) {
        if (pts.length < 8) return null;
        const nn = pts.map((p, i) => {
            let best = Infinity;
            pts.forEach((q, j) => { if (i !== j) best = Math.min(best, dist(p, q)); });
            return best;
        });
        const nnMed = median(nn);

        // Direction of every near-neighbor offset, folded to a half circle (a step and its opposite are one direction)
        const vecs = [];
        for (let i = 0; i < pts.length; i++) {
            for (let j = 0; j < pts.length; j++) {
                if (i === j) continue;
                const dx = pts[j].x - pts[i].x, dy = pts[j].y - pts[i].y;
                const d = Math.hypot(dx, dy);
                if (d < nnMed * 0.75 || d > nnMed * 1.25) continue;
                const flip = dx < 0 || (dx === 0 && dy < 0);
                vecs.push({ dx: flip ? -dx : dx, dy: flip ? -dy : dy, ang: Math.atan2(flip ? -dy : dy, flip ? -dx : dx) });
            }
        }
        if (vecs.length < 8) return null;

        // Histogram of directions (36 bins over 180 degrees, circular), lightly smoothed
        const bins = new Array(36).fill(0);
        for (const v of vecs) bins[Math.min(35, Math.floor((v.ang + Math.PI / 2) / Math.PI * 36))]++;
        const smooth = bins.map((_, i) => bins[(i + 35) % 36] + 2 * bins[i] + bins[(i + 1) % 36]);
        const peak1 = smooth.indexOf(Math.max(...smooth));
        let peak2 = -1, best2 = 0;
        for (let i = 0; i < 36; i++) {
            const sep = Math.min(Math.abs(i - peak1), 36 - Math.abs(i - peak1));
            if (sep >= 8 && smooth[i] > best2) { best2 = smooth[i]; peak2 = i; }
        }
        if (peak2 < 0 || best2 < 4) return null;

        // Average the offsets that fall within 25 degrees of each peak direction
        const cluster = peak => {
            const center = (peak + 0.5) / 36 * Math.PI - Math.PI / 2;
            let sx = 0, sy = 0, n = 0;
            for (const v of vecs) {
                let diff = Math.abs(v.ang - center);
                diff = Math.min(diff, Math.PI - diff);
                if (diff <= 25 * Math.PI / 180) {
                    // Orient consistently with the cluster center before averaging
                    const dot = v.dx * Math.cos(center) + v.dy * Math.sin(center);
                    const sign = dot >= 0 ? 1 : -1;
                    sx += sign * v.dx; sy += sign * v.dy; n++;
                }
            }
            return n ? { x: sx / n, y: sy / n, n } : null;
        };
        const a = cluster(peak1), b = cluster(peak2);
        if (!a || !b) return null;

        // The direction closer to horizontal is "one cell right", the other "one cell down"
        let u = Math.abs(a.x) >= Math.abs(a.y) ? a : b;
        let v = u === a ? b : a;
        if (u.x < 0) u = { x: -u.x, y: -u.y };
        if (v.y < 0) v = { x: -v.x, y: -v.y };
        // Directions must be roughly perpendicular (perspective can shear them, but not flatten them)
        const cos = (u.x * v.x + u.y * v.y) / (Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y));
        if (Math.abs(cos) > 0.75) return null;
        return { u, v };
    }

    // ---- Step 3: assign blobs to grid cells ----

    // Walks outward from one blob, labeling neighbors with grid coordinates, then picks the best 5x5 window
    // of those coordinates. Returns [{ blob, col, row }] or null.
    function growLattice(blobs, seed, steps, tol) {
        const coords = new Map();       // blob index -> { i, j }
        const taken = new Map();        // "i,j" -> blob index
        const local = new Map();        // blob index -> { u, v } steps measured near that blob
        coords.set(seed, { i: 0, j: 0 });
        taken.set('0,0', seed);
        local.set(seed, { u: steps.u, v: steps.v });
        const queue = [seed];

        while (queue.length) {
            const p = queue.shift();
            const { i, j } = coords.get(p);
            const ls = local.get(p);
            for (const [a, b] of NEIGHBOR_STEPS) {
                const ni = i + a, nj = j + b;
                if (Math.abs(ni) > N - 1 || Math.abs(nj) > N - 1 || taken.has(ni + ',' + nj)) continue;
                const step = a !== 0 ? { x: ls.u.x * a, y: ls.u.y * a } : { x: ls.v.x * b, y: ls.v.y * b };
                const pred = { x: blobs[p].x + step.x, y: blobs[p].y + step.y };
                const limit = Math.hypot(step.x, step.y) * tol;
                let found = -1, foundD = limit;
                for (let q = 0; q < blobs.length; q++) {
                    if (coords.has(q)) continue;
                    const d = dist(blobs[q], pred);
                    if (d < foundD) { foundD = d; found = q; }
                }
                if (found < 0) continue;
                coords.set(found, { i: ni, j: nj });
                taken.set(ni + ',' + nj, found);
                // Update the local step estimate from the measured offset
                const meas = { x: (blobs[found].x - blobs[p].x) * (a !== 0 ? a : 1), y: (blobs[found].y - blobs[p].y) * (a !== 0 ? a : 1) };
                const measV = { x: (blobs[found].x - blobs[p].x) * (b !== 0 ? b : 1), y: (blobs[found].y - blobs[p].y) * (b !== 0 ? b : 1) };
                local.set(found, a !== 0 ? { u: meas, v: ls.v } : { u: ls.u, v: measV });
                queue.push(found);
            }
        }

        // Choose the 5x5 window of coordinates that holds the most blobs
        const all = Array.from(coords.entries());
        const is = all.map(([, c]) => c.i), js = all.map(([, c]) => c.j);
        const minI = Math.min(...is), maxI = Math.max(...is), minJ = Math.min(...js), maxJ = Math.max(...js);
        let best = null;
        for (let i0 = Math.min(minI, maxI - (N - 1)); i0 <= Math.max(minI, maxI - (N - 1)); i0++) {
            for (let j0 = Math.min(minJ, maxJ - (N - 1)); j0 <= Math.max(minJ, maxJ - (N - 1)); j0++) {
                const members = all.filter(([, c]) => c.i >= i0 && c.i < i0 + N && c.j >= j0 && c.j < j0 + N);
                if (!best || members.length > best.members.length) best = { i0, j0, members };
            }
        }
        if (!best) return null;
        return best.members.map(([idx, c]) => ({ blob: idx, col: c.i - best.i0, row: c.j - best.j0 }));
    }

    // ---- Step 4: fit the perspective ----

    // Fits grid (col,row) -> picture pixels, drops blobs that do not agree with the fit, and measures quality.
    // Returns { H, err, pitch, used, dropped } or null.
    function fitLattice(blobs, assigned, minWindows) {
        let set = assigned.slice();
        for (let round = 0; round < 4; round++) {
            if (set.length < Math.max(8, minWindows - 4)) return null;
            const H = Imaging.fitHomography(
                set.map(a => ({ x: a.col, y: a.row })),
                set.map(a => ({ x: blobs[a.blob].x, y: blobs[a.blob].y })));
            if (!H) return null;
            const origin = Imaging.applyHomography(H, 2, 2);
            const pitchX = dist(origin, Imaging.applyHomography(H, 3, 2));
            const pitchY = dist(origin, Imaging.applyHomography(H, 2, 3));
            const pitch = (pitchX + pitchY) / 2;
            if (!(pitch > 0) || !isFinite(pitch)) return null;
            const resid = set.map(a => dist(Imaging.applyHomography(H, a.col, a.row), blobs[a.blob]));
            const worst = Math.max(...resid);
            if (worst > 0.22 * pitch && set.length > minWindows) {
                // Remove the single worst blob and refit
                set = set.filter((_, k) => k !== resid.indexOf(worst));
                continue;
            }
            const err = resid.reduce((s, r) => s + r, 0) / resid.length / pitch;
            return { H, err, pitch, pitchX, pitchY, used: set, dropped: assigned.length - set.length };
        }
        return null;
    }

    // A grid that makes sense: corners form a convex quadrilateral and the two spacings are similar
    function plausible(fit) {
        const P = [[0, 0], [4, 0], [4, 4], [0, 4]].map(([c, r]) => Imaging.applyHomography(fit.H, c, r));
        let sign = 0;
        for (let k = 0; k < 4; k++) {
            const a = P[k], b = P[(k + 1) % 4], c = P[(k + 2) % 4];
            const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
            const s = Math.sign(cross);
            if (s === 0 || (sign !== 0 && s !== sign)) return false;
            sign = s;
        }
        const ratio = fit.pitchX / fit.pitchY;
        return ratio > 0.5 && ratio < 2;
    }

    // Tries to find the grid among the candidate blobs of one mask. Returns a result object or null.
    function latticeFromBlobs(allBlobs, profile) {
        if (allBlobs.length < profile.lattice.minWindows) return null;
        // Reference window size: try the typical, smaller and larger areas in case other bright objects skew the median
        const areas = allBlobs.map(b => b.area).sort((a, b) => a - b);
        const refs = [0.5, 0.3, 0.7].map(q => areas[Math.min(areas.length - 1, Math.floor(areas.length * q))]);
        const tried = new Set();
        let best = null;

        for (const ref of refs) {
            const blobs = allBlobs.filter(b => b.area >= ref * profile.areaBand[0] && b.area <= ref * profile.areaBand[1]);
            if (blobs.length < profile.lattice.minWindows) continue;
            const key = blobs.length + ':' + Math.round(blobs[0].x) + ',' + Math.round(blobs[0].y);
            if (tried.has(key)) continue;
            tried.add(key);

            const steps = estimateSteps(blobs);
            if (!steps) continue;
            let bestAssign = null;
            for (let seed = 0; seed < blobs.length; seed++) {
                const assigned = growLattice(blobs, seed, steps, profile.lattice.neighborTol);
                if (assigned && (!bestAssign || assigned.length > bestAssign.length)) bestAssign = assigned;
            }
            if (!bestAssign || bestAssign.length < profile.lattice.minWindows) continue;

            const fit = fitLattice(blobs, bestAssign, profile.lattice.minWindows);
            if (!fit || !plausible(fit)) continue;
            const cols = fit.used.map(a => a.col), rows = fit.used.map(a => a.row);
            // The outermost columns and rows must hold windows, otherwise the grid position is ambiguous
            const covers = Math.min(...cols) === 0 && Math.max(...cols) === N - 1 && Math.min(...rows) === 0 && Math.max(...rows) === N - 1;
            const ok = covers && fit.used.length >= profile.lattice.minWindows && fit.err < profile.lattice.maxError;
            const score = ok ? fit.used.length * (1 - fit.err) : 0;
            if (!best || score > best.score || (!best.ok && fit.used.length > best.windows)) {
                best = {
                    ok, score, windows: fit.used.length, err: fit.err, pitch: fit.pitch, pitchX: fit.pitchX, pitchY: fit.pitchY,
                    H: fit.H, used: fit.used.map(a => ({ blob: blobs[a.blob], col: a.col, row: a.row })),
                    candidates: blobs, covers
                };
            }
        }
        return best;
    }

    // Runs the window detector of one profile on ImageData; returns the best result across its mask modes
    function detectOnImageData(img, profile) {
        let best = null;
        const seenCandidates = [];
        for (const mode of profile.maskModes) {
            const blobs = candidateBlobs(buildMask(img, mode), profile);
            seenCandidates.push({ mode, blobs });
            const res = latticeFromBlobs(blobs, profile);
            if (res) {
                res.mode = mode;
                if (!best || res.score > best.score) best = res;
                // A clean, nearly complete grid ends the search early
                const good = profile.lattice.goodEnough;
                if (res.ok && good && res.windows >= good.windows && res.err <= good.error) break;
            }
        }
        const out = best || { ok: false, score: 0, windows: 0, err: null, mode: null, used: [], candidates: [] };
        if (!best) {
            // Report the largest candidate set so the debug view shows what was considered
            const most = seenCandidates.reduce((m, c) => (c.blobs.length > m.blobs.length ? c : m), { mode: null, blobs: [] });
            out.candidates = most.blobs;
            out.mode = most.mode;
            out.reason = most.blobs.length < profile.lattice.minWindows ? 'too few window-shaped blobs' : 'blobs do not form a 5x5 grid';
        } else if (!best.ok) {
            out.reason = !best.covers ? 'grid position is ambiguous' : (best.err >= profile.lattice.maxError ? 'grid fit error too large' : 'too few windows');
        }
        return out;
    }

    // ---- Public: analyze a photo ----

    // Scales a detection-space result (found on a smaller copy) back to the original photo's pixel coordinates
    function toFullResolution(res, scale, profileId) {
        const S = [1 / scale, 0, 0, 0, 1 / scale, 0, 0, 0, 1];
        const mul = (A, B) => {
            const C = new Array(9).fill(0);
            for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) C[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
            return C;
        };
        const full = {
            ok: res.ok, profileId, score: res.score, windows: res.windows, err: res.err, mode: res.mode, reason: res.reason || null,
            scale,
            candidates: res.candidates.map(b => ({ x: b.x / scale, y: b.y / scale, w: b.w / scale, h: b.h / scale })),
            used: res.used.map(a => ({ x: a.blob.x / scale, y: a.blob.y / scale, w: a.blob.w / scale, h: a.blob.h / scale, col: a.col, row: a.row }))
        };
        if (res.H) {
            full.H = mul(S, res.H);
            full.pitch = res.pitch / scale;
            full.pitchX = res.pitchX / scale;
            full.pitchY = res.pitchY / scale;
            // Typical window width as a fraction of the cell spacing, measured from the matched blobs
            const widths = res.used.map(a => a.blob.w), heights = res.used.map(a => a.blob.h);
            full.windowFrac = res.pitchX > 0 ? median(widths) / res.pitchX : null;
            full.windowFracY = res.pitchY > 0 ? median(heights) / res.pitchY : null;
        }
        return full;
    }

    // Finds the grid in a photo canvas. options.profiles overrides which profiles to try.
    function analyze(canvas, options) {
        const started = performance.now();
        const ids = (options && options.profiles) || CardProfiles.autoOrder;
        let best = null;
        const profileScores = {};
        for (const id of ids) {
            const profile = CardProfiles[id];
            const { canvas: small, scale } = Imaging.downscaleCanvas(canvas, profile.detectMaxDim);
            const res = detectOnImageData(Imaging.canvasToImageData(small), profile);
            profileScores[id] = res.score;
            const full = toFullResolution(res, scale, id);
            if (!best || full.score > best.score) best = full;
        }
        best.profileScores = profileScores;
        best.ms = Math.round(performance.now() - started);
        best.photo = { width: canvas.width, height: canvas.height };
        return best;
    }

    // ---- Manual placement ----

    // Builds a result from the centers of the four corner windows: { tl, tr, br, bl } in photo pixels
    function fromCorners(corners) {
        const H = Imaging.solveHomography(
            [{ x: 0, y: 0 }, { x: N - 1, y: 0 }, { x: N - 1, y: N - 1 }, { x: 0, y: N - 1 }],
            [corners.tl, corners.tr, corners.br, corners.bl]);
        if (!H) return { ok: false, profileId: 'manual', reason: 'corner points are degenerate', used: [], candidates: [] };
        const o = Imaging.applyHomography(H, 2, 2);
        const pitchX = dist(o, Imaging.applyHomography(H, 3, 2));
        const pitchY = dist(o, Imaging.applyHomography(H, 2, 3));
        return {
            ok: true, profileId: 'manual', score: 0, windows: 4, err: 0, mode: 'corners', reason: null, scale: 1,
            H, pitch: (pitchX + pitchY) / 2, pitchX, pitchY,
            windowFrac: CardProfiles.manual.cell.windowFrac, windowFracY: CardProfiles.manual.cell.windowFracY,
            candidates: [], used: [
                { ...corners.tl, w: 0, h: 0, col: 0, row: 0 }, { ...corners.tr, w: 0, h: 0, col: N - 1, row: 0 },
                { ...corners.br, w: 0, h: 0, col: N - 1, row: N - 1 }, { ...corners.bl, w: 0, h: 0, col: 0, row: N - 1 }
            ]
        };
    }

    // ---- Using a result ----

    // Photo position of the center of grid cell (col,row); fractional values allowed
    function cellCenter(result, col, row) {
        return Imaging.applyHomography(result.H, col, row);
    }

    // Centers of the four corner windows
    function cornerCenters(result) {
        return {
            tl: cellCenter(result, 0, 0), tr: cellCenter(result, N - 1, 0),
            br: cellCenter(result, N - 1, N - 1), bl: cellCenter(result, 0, N - 1)
        };
    }

    // Outline of the whole grid: each cell is a half-spacing wide square around its center, so this is the
    // quadrilateral from (-0.5,-0.5) to (4.5,4.5) in grid coordinates
    function gridQuad(result) {
        const m = 0.5;
        return {
            tl: cellCenter(result, -m, -m), tr: cellCenter(result, N - 1 + m, -m),
            br: cellCenter(result, N - 1 + m, N - 1 + m), bl: cellCenter(result, -m, N - 1 + m)
        };
    }

    // Straightens the photo so the 25 cells fall on an exact 5x5 grid of equal squares filling a size x size canvas
    function rectifiedGrid(canvas, result, size) {
        return Imaging.warpPerspective(canvas, gridQuad(result), size || 600, size || 600);
    }

    // Fraction of pixels of an RGBA crop that satisfy a test
    function fractionWhere(img, test) {
        const d = img.data;
        let n = 0;
        for (let p = 0; p < d.length; p += 4) if (test(d[p], d[p + 1], d[p + 2])) n++;
        return n / (d.length / 4);
    }

    // Cuts one crop per cell (row-major, 25 entries) in the profile's canonical size, with shutter and glare flags.
    // Each entry: { index, col, row, found, image (ImageData), covered, glare }
    function extractCells(canvas, result, options) {
        const profile = CardProfiles[(options && options.profile) || result.profileId] || CardProfiles.slider;
        const cell = profile.cell;
        const src = Imaging.canvasToImageData(canvas);

        // Half the crop width/height in grid units: the measured window size minus the edge inset on both sides.
        // When the window height could not be measured it follows from the profile's width/height ratio.
        const winFrac = result.windowFrac || cell.windowFrac;
        const halfW = winFrac / 2 * (1 - 2 * cell.inset);
        const halfH = result.windowFracY
            ? result.windowFracY / 2 * (1 - 2 * cell.inset)
            : halfW * result.pitchX / (result.pitchY * cell.aspect);

        const usedKey = new Set(result.used.map(u => u.col + ',' + u.row));
        const cells = [];
        for (let row = 0; row < N; row++) {
            for (let col = 0; col < N; col++) {
                const quad = {
                    tl: cellCenter(result, col - halfW, row - halfH), tr: cellCenter(result, col + halfW, row - halfH),
                    br: cellCenter(result, col + halfW, row + halfH), bl: cellCenter(result, col - halfW, row + halfH)
                };
                const image = Imaging.warpPerspectiveData(src, quad, cell.size.w, cell.size.h);
                const entry = { index: row * N + col, col, row, found: usedKey.has(col + ',' + row), image, covered: false, glare: false };
                if (image) {
                    if (profile.checks.shutterTint) {
                        // Closed shutter: the window is filled with saturated red/orange plastic
                        entry.covered = fractionWhere(image, (r, g, b) => r > 90 && r > g * 1.6 && r > b * 1.6) > 0.35;
                    }
                    if (profile.checks.glare) {
                        // Glare: a large share of nearly white pixels washes the digits out
                        entry.glare = fractionWhere(image, (r, g, b) => r >= 245 && g >= 245 && b >= 245) > 0.35;
                    }
                }
                cells.push(entry);
            }
        }
        return cells;
    }

    // Gray version of a crop with its contrast stretched between the 2nd and 98th brightness percentiles
    function normalizeCrop(image) {
        const gray = Imaging.grayFromRGBA(image);
        const hist = new Array(256).fill(0);
        for (const v of gray.data) hist[v]++;
        const total = gray.data.length;
        let acc = 0, lo = 0, hi = 255;
        for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * 0.02) { lo = v; break; } }
        acc = 0;
        for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= total * 0.02) { hi = v; break; } }
        const span = Math.max(1, hi - lo);
        const out = new Uint8Array(total);
        for (let i = 0; i < total; i++) out[i] = Math.max(0, Math.min(255, Math.round((gray.data[i] - lo) * 255 / span)));
        return { width: gray.width, height: gray.height, data: out };
    }

    // Debug view for tuning a mask mode: shows the mask after hole filling and outlines every region the blob
    // filter looked at (green = accepted as a window candidate, red = wrong size, yellow = wrong shape).
    function debugMask(photoCanvas, mode, maxWidth) {
        const profile = CardProfiles.slider;
        const { canvas: small } = Imaging.downscaleCanvas(photoCanvas, profile.detectMaxDim);
        const img = Imaging.canvasToImageData(small);
        const total = img.width * img.height;
        const b = profile.blob;
        const solid = Imaging.fillHoles(buildMask(img, mode), Math.max(20, Math.round(total * b.maxHoleFrac)));
        const out = document.createElement('canvas');
        out.width = img.width; out.height = img.height;
        const g = out.getContext('2d');
        const rgba = new Uint8ClampedArray(total * 4);
        for (let i = 0, p = 0; i < total; i++, p += 4) { const v = solid.data[i] ? 255 : 30; rgba[p] = rgba[p + 1] = rgba[p + 2] = v; rgba[p + 3] = 255; }
        g.putImageData(new ImageData(rgba, img.width, img.height), 0, 0);
        g.lineWidth = 2;
        for (const c of Imaging.connectedComponents(solid, { fg: 255, connectivity: 8 })) {
            if (c.area < total * 0.00004) continue;
            const aspect = c.w / c.h, fill = c.area / (c.w * c.h);
            const sizeOk = c.area >= total * b.minAreaFrac && c.area <= total * b.maxAreaFrac;
            const shapeOk = aspect >= b.aspect[0] && aspect <= b.aspect[1] && fill >= b.minFill;
            g.strokeStyle = sizeOk && shapeOk ? '#2ecc71' : (sizeOk ? '#f1c40f' : '#e74c3c');
            g.strokeRect(c.x, c.y, c.w, c.h);
        }
        const scale = Math.min(1, (maxWidth || 360) / out.width);
        const thumb = document.createElement('canvas');
        thumb.width = Math.round(out.width * scale); thumb.height = Math.round(out.height * scale);
        thumb.getContext('2d').drawImage(out, 0, 0, thumb.width, thumb.height);
        return thumb;
    }

    // Tiles the 25 crops from extractCells() into one 5x5 sheet canvas (row-major). Cells whose window was not
    // seen are outlined orange, closed shutters red and glare yellow.
    function drawCellSheet(cells) {
        const first = cells.find(c => c.image);
        if (!first) return null;
        const w = first.image.width, h = first.image.height;
        const sheet = document.createElement('canvas');
        sheet.width = w * N;
        sheet.height = h * N;
        const g = sheet.getContext('2d');
        g.fillStyle = '#222';
        g.fillRect(0, 0, sheet.width, sheet.height);
        g.lineWidth = 3;
        for (const cell of cells) {
            if (!cell.image) continue;
            const x = cell.col * w, y = cell.row * h;
            g.putImageData(new ImageData(cell.image.data, w, h), x, y);
            const color = cell.covered ? '#e74c3c' : (cell.glare ? '#f1c40f' : (cell.found ? null : '#ff9800'));
            if (color) { g.strokeStyle = color; g.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3); }
        }
        return sheet;
    }

    // ---- Debug overlay ----

    // Draws the photo (scaled to maxWidth) with what the detector saw: candidate blobs (gray), matched windows
    // (green), the fitted grid lines, predicted positions of windows that were not seen (orange), and a summary line.
    function drawOverlay(photoCanvas, result, maxWidth) {
        const scale = Math.min(1, (maxWidth || 700) / photoCanvas.width);
        const out = document.createElement('canvas');
        out.width = Math.round(photoCanvas.width * scale);
        out.height = Math.round(photoCanvas.height * scale);
        const g = out.getContext('2d');
        g.drawImage(photoCanvas, 0, 0, out.width, out.height);
        g.lineWidth = 2;

        g.strokeStyle = 'rgba(200,200,200,0.8)';
        for (const b of result.candidates) g.strokeRect((b.x - b.w / 2) * scale, (b.y - b.h / 2) * scale, b.w * scale, b.h * scale);

        if (result.H) {
            g.strokeStyle = 'rgba(0,200,255,0.9)';
            for (let k = 0; k < N; k++) {
                g.beginPath();
                for (let t = 0; t <= N - 1; t++) { const p = cellCenter(result, t, k); (t ? g.lineTo : g.moveTo).call(g, p.x * scale, p.y * scale); }
                g.stroke();
                g.beginPath();
                for (let t = 0; t <= N - 1; t++) { const p = cellCenter(result, k, t); (t ? g.lineTo : g.moveTo).call(g, p.x * scale, p.y * scale); }
                g.stroke();
            }
            const seen = new Set(result.used.map(u => u.col + ',' + u.row));
            for (let row = 0; row < N; row++) {
                for (let col = 0; col < N; col++) {
                    const p = cellCenter(result, col, row);
                    g.fillStyle = seen.has(col + ',' + row) ? '#2ecc71' : '#ff9800';
                    g.beginPath();
                    g.arc(p.x * scale, p.y * scale, 5, 0, Math.PI * 2);
                    g.fill();
                }
            }
            g.strokeStyle = '#2ecc71';
            for (const u of result.used) if (u.w) g.strokeRect((u.x - u.w / 2) * scale, (u.y - u.h / 2) * scale, u.w * scale, u.h * scale);
        }

        const text = result.ok
            ? `${result.profileId}: ${result.windows}/25 windows, error ${(result.err * 100).toFixed(1)}%, ${result.ms || 0} ms`
            : `not found: ${result.reason || 'no grid'} (${result.candidates.length} blobs)`;
        g.font = 'bold 16px sans-serif';
        g.fillStyle = 'rgba(0,0,0,0.65)';
        g.fillRect(0, 0, out.width, 24);
        g.fillStyle = result.ok ? '#2ecc71' : '#ff6b6b';
        g.fillText(text, 6, 18);
        return out;
    }

    return {
        VERSION: GEOMETRY_VERSION, FREE_INDEX,
        // Detection (ImageData in, no browser needed)
        detectOnImageData, estimateSteps, candidateBlobs, buildMask,
        // Photo canvas in
        analyze, fromCorners,
        // Using a result
        cellCenter, cornerCenters, gridQuad, rectifiedGrid, extractCells, normalizeCrop, drawOverlay, debugMask, drawCellSheet
    };
})();
