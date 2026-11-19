// Domino tile detection version identifier
const DOMINO_TILES_VERSION = '1.1';

// Finds individual domino tiles in a photo and cuts each one out as a straightened, horizontal crop.
// Depends on the shared imaging module (htdocs/media/scan/imaging.js). Every function works on plain RGBA
// image objects { width, height, data }, so the module runs in a browser or in Node.
const DominoTiles = (() => {

    const DETECT_MAX_DIM = 800;        // photos are analysed at this size; crops are cut from the full photo
    const CROP_W = 240;                // straightened tile crop size (a tile is twice as long as it is wide)
    const CROP_H = 120;

    const LIMITS = {
        minAreaFrac: 0.0008,           // smallest tile, as a fraction of the picture area
        maxAreaFrac: 0.25,             // largest tile
        minFill: 0.86,                 // convex hull area / bounding rectangle area: how rectangular the outline is
        minSolidity: 0.7,              // blob area / convex hull area: pips at the edge may notch the outline, but only so far
        minTintBrightness: 70,         // pixels darker than this (brightest channel) have no usable tint
        tintGain: 2,                   // scales the normalized tint into the 0-255 range
        minAspect: 1.55,               // long side / short side of a single tile
        maxAspect: 2.6,
        holeFrac: 0.004,               // pips are holes in the tile mask; holes up to this fraction of the picture are filled
        chainMinAspect: 3.3,           // blobs this long and narrow are tiles lying end to end
        chainMaxAspect: 7.5,
        shrink: 0.03,                  // crops start this far inside the outline so the table edge is excluded
        dividerAspect: 3.5,            // a divider bar is at least this many times longer than wide
        barBrightness: 60,             // a bar is darker than this (brightest channel)
        barMargin: 3,                  // pixels beside and beyond a bar that must be tile surface
        surfaceBrightness: 100,        // tile surface: brightest channel at least this...
        surfaceWarmth: 8,              // ...and (R + G) / 2 - B at least this (ivory is warm, a gray table is not)
        minDividerArea: 12,            // pixels (in the detection image)
        maxDividerFrac: 0.003,         // largest bar, as a fraction of the picture
        maxClusterFrac: 0.6,           // a blob with bars may be this large: it holds several tiles
        defaultBarRatio: 0.75,         // bar length / tile short side when no isolated tile is available to measure it
        minBarRatio: 0.55,
        maxBarRatio: 0.95,
        coverageSamples: 7,            // the model rectangle is checked on a grid of this many points per side
        minCoverage: 0.5,              // share of those points that must look like tile surface (pips are not surface)
        minBarsForFit: 4,              // fewest bars for fitting how bar length changes across the picture
        minSideHits: 2,                // of 5 points along a bar, this many beside it on each side must be tile surface
        maxOverlap: 0.35,              // two tiles may overlap by at most this share of either one's area
        minWarmGap: 45,                // warm-tint channel: the tiles must average this much above the surface (0-255 scale)
        maxForegroundShare: 0.6        // a split that marks more than this share of the picture as tiles is not a tile split
    };

    // ---- Small helpers ----

    function median(values) {
        if (!values.length) return 0;
        const sorted = values.slice().sort((a, b) => a - b);
        const mid = sorted.length >> 1;
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    // Shrinks an RGBA image so its longer side is at most maxDim, averaging the source pixels under each new pixel.
    // Returns { img, scale } where scale is newSize / oldSize (1 when no shrinking was needed).
    function downscaleRGBA(img, maxDim) {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        if (scale === 1) return { img, scale: 1 };
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const out = new Uint8ClampedArray(w * h * 4);
        const sx = img.width / w;
        const sy = img.height / h;
        for (let y = 0; y < h; y++) {
            const y0 = Math.floor(y * sy);
            const y1 = Math.min(img.height, Math.max(y0 + 1, Math.ceil((y + 1) * sy)));
            for (let x = 0; x < w; x++) {
                const x0 = Math.floor(x * sx);
                const x1 = Math.min(img.width, Math.max(x0 + 1, Math.ceil((x + 1) * sx)));
                let r = 0, g = 0, b = 0, n = 0;
                for (let yy = y0; yy < y1; yy++) {
                    let p = (yy * img.width + x0) * 4;
                    for (let xx = x0; xx < x1; xx++, p += 4) {
                        r += img.data[p]; g += img.data[p + 1]; b += img.data[p + 2]; n++;
                    }
                }
                const o = (y * w + x) * 4;
                out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
            }
        }
        return { img: { width: w, height: h, data: out }, scale: w / img.width };
    }

    // ---- Geometry ----

    // Convex hull of {x, y} points (monotone chain); returns the hull in order
    function convexHull(points) {
        const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
        if (pts.length < 3) return pts;
        const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
        const lower = [];
        for (const p of pts) {
            while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
            lower.push(p);
        }
        const upper = [];
        for (let i = pts.length - 1; i >= 0; i--) {
            const p = pts[i];
            while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
            upper.push(p);
        }
        lower.pop();
        upper.pop();
        return lower.concat(upper);
    }

    // Smallest rectangle around a convex hull. The frame (u, v) has u along the long side and v = u turned 90 degrees
    // (screen coordinates, y down), so corners tl, tr, br, bl read like an upright picture. Returns the frame and extents.
    function minAreaRect(hull) {
        let best = null;
        for (let i = 0; i < hull.length; i++) {
            const p = hull[i], q = hull[(i + 1) % hull.length];
            let ux = q.x - p.x, uy = q.y - p.y;
            const len = Math.hypot(ux, uy);
            if (len < 1e-9) continue;
            ux /= len; uy /= len;
            const vx = -uy, vy = ux;
            let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
            for (const pt of hull) {
                const du = pt.x * ux + pt.y * uy;
                const dv = pt.x * vx + pt.y * vy;
                if (du < minU) minU = du;
                if (du > maxU) maxU = du;
                if (dv < minV) minV = dv;
                if (dv > maxV) maxV = dv;
            }
            const area = (maxU - minU) * (maxV - minV);
            if (!best || area < best.area) best = { area, ux, uy, vx, vy, minU, maxU, minV, maxV };
        }
        if (!best) return null;
        // Make u the long axis (turning the frame a quarter keeps v = u turned 90 degrees)
        if (best.maxU - best.minU < best.maxV - best.minV) {
            best = {
                area: best.area,
                ux: best.vx, uy: best.vy, vx: -best.ux, vy: -best.uy,
                minU: best.minV, maxU: best.maxV, minV: -best.maxU, maxV: -best.minU
            };
        }
        return best;
    }

    // Corner points {tl, tr, br, bl} of the part of a rectangle frame between u0..u1 along its long side
    function frameCorners(f, u0, u1) {
        const at = (u, v) => ({ x: u * f.ux + v * f.vx, y: u * f.uy + v * f.vy });
        return { tl: at(u0, f.minV), tr: at(u1, f.minV), br: at(u1, f.maxV), bl: at(u0, f.maxV) };
    }

    function scaleCorners(c, k) {
        const s = p => ({ x: p.x * k, y: p.y * k });
        return { tl: s(c.tl), tr: s(c.tr), br: s(c.br), bl: s(c.bl) };
    }

    function centerOf(c) {
        return { x: (c.tl.x + c.tr.x + c.br.x + c.bl.x) / 4, y: (c.tl.y + c.tr.y + c.br.y + c.bl.y) / 4 };
    }

    // ---- Detection ----

    // Boundary pixels of one component (pixels with a 4-neighbour outside it), as {x, y} points
    function boundaryPoints(comp, index, k, w, h) {
        const pts = [];
        for (let y = comp.y; y < comp.y + comp.h; y++) {
            for (let x = comp.x; x < comp.x + comp.w; x++) {
                const i = y * w + x;
                if (index[i] !== k) continue;
                const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
                    index[i - 1] !== k || index[i + 1] !== k || index[i - w] !== k || index[i + w] !== k;
                if (edge) pts.push({ x, y });
            }
        }
        return pts;
    }

    // Yellowish tint of every pixel relative to its brightness: ((R + G) / 2 - B) / max(R, G, B), scaled to 0-255 and
    // blurred. Ivory tiles are warm while a gray or black table is neutral, so this separates them even when the table
    // is as bright as the tiles; dividing by brightness keeps a tile in shadow as warm as a lit one. Very dark pixels
    // carry no usable tint and count as zero.
    function warmChannel(img) {
        const n = img.width * img.height;
        const out = new Uint8Array(n);
        for (let i = 0, p = 0; i < n; i++, p += 4) {
            const r = img.data[p], g = img.data[p + 1], b = img.data[p + 2];
            const peak = Math.max(r, g, b);
            if (peak < LIMITS.minTintBrightness) continue;
            const v = (((r + g) / 2 - b) / peak) * 255 * LIMITS.tintGain;
            out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
        return Imaging.gaussianBlur({ width: img.width, height: img.height, data: out }, 5);
    }

    // Area of a polygon given as {x, y} points in order (shoelace formula)
    function polygonArea(points) {
        let sum = 0;
        for (let i = 0; i < points.length; i++) {
            const a = points[i], b = points[(i + 1) % points.length];
            sum += a.x * b.y - b.x * a.y;
        }
        return Math.abs(sum) / 2;
    }

    // True where the picture at (x, y) looks like tile surface: bright and warm (ivory). Judged on the picture itself,
    // not the blurred mask, whose edges are smeared several pixels wide around thin dark marks.
    function isSurface(img, x, y) {
        const w = img.width, h = img.height;
        const xi = Math.round(x), yi = Math.round(y);
        if (xi < 1 || yi < 1 || xi >= w - 1 || yi >= h - 1) return false;
        let r = 0, g = 0, b = 0;
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const p = ((yi + dy) * w + xi + dx) * 4;
                r += img.data[p]; g += img.data[p + 1]; b += img.data[p + 2];
            }
        }
        r /= 9; g /= 9; b /= 9;
        return Math.max(r, g, b) >= LIMITS.surfaceBrightness && (r + g) / 2 - b >= LIMITS.surfaceWarmth;
    }

    // Finds the divider bars: long, thin, very dark marks (the bar between a tile's two halves). Every tile has one,
    // so the bars tell how many tiles a blob holds and where each tile is centered. They are found from the unblurred
    // picture because a bar is only a few pixels wide. A real bar has tile surface on both sides and past both ends
    // (it stops short of the tile edge) on at least one side; cables, creases between tiles and shadows do not.
    // Returns [{ cx, cy, bx, by, len, wid }] with (bx, by) the unit direction along the bar.
    function findDividers(img, mask, debug) {
        const { width: w, height: h } = img;
        const dark = { width: w, height: h, data: new Uint8Array(w * h) };
        for (let i = 0, p = 0; i < w * h; i++, p += 4) {
            if (Math.max(img.data[p], img.data[p + 1], img.data[p + 2]) < LIMITS.barBrightness) dark.data[i] = 255;
        }
        const marks = Imaging.connectedComponents(dark, { connectivity: 8, labels: true });
        const onTile = (x, y) => isSurface(img, x, y);
        const found = [];
        // When a debug list is given, every long-enough mark is recorded there with the reason it was kept or dropped
        const note = (mark, reason, extra) => { if (debug) debug.push(Object.assign({ x: mark.x, y: mark.y, w: mark.w, h: mark.h, reason }, extra)); };
        marks.forEach((mark, k) => {
            if (mark.area < LIMITS.minDividerArea || mark.area > w * h * LIMITS.maxDividerFrac) return;
            if (mark.x === 0 || mark.y === 0 || mark.x + mark.w >= w || mark.y + mark.h >= h) return;
            const hull = convexHull(boundaryPoints(mark, marks.index, k, w, h));
            const f = hull.length >= 3 ? minAreaRect(hull) : null;
            if (!f) return;
            const len = f.maxU - f.minU;
            const wid = Math.max(f.maxV - f.minV, 1);
            if (len / wid < LIMITS.dividerAspect) { if (len > 12) note(mark, 'not-thin', { aspect: +(len / wid).toFixed(2), len: +len.toFixed(1), wid: +wid.toFixed(1) }); return; }
            const um = (f.minU + f.maxU) / 2, vm = (f.minV + f.maxV) / 2;
            const cx = um * f.ux + vm * f.vx, cy = um * f.uy + vm * f.vy;
            // Tile surface beside the bar, sampled at several points along it on each side (a pip may sit against the bar
            // at some of them), and past at least one end
            const side = wid / 2 + LIMITS.barMargin, end = len / 2 + LIMITS.barMargin;
            const bx = f.ux, by = f.uy;
            let hitsA = 0, hitsB = 0;
            [-0.35, -0.175, 0, 0.175, 0.35].forEach(a => {
                const px = cx + bx * len * a, py = cy + by * len * a;
                if (onTile(px + by * side, py - bx * side)) hitsA++;
                if (onTile(px - by * side, py + bx * side)) hitsB++;
            });
            const ends = [onTile(cx + bx * end, cy + by * end), onTile(cx - bx * end, cy - by * end)];
            const enclosed = hitsA >= LIMITS.minSideHits && hitsB >= LIMITS.minSideHits && (ends[0] || ends[1]);
            note(mark, enclosed ? 'bar' : 'not-enclosed', { len: +len.toFixed(1), wid: +wid.toFixed(1), sides: hitsA + '/' + hitsB, ends: ends.join() });
            if (enclosed) found.push({ cx, cy, bx, by, len, wid });
        });
        return found;
    }

    // Fits how long a divider bar looks at each place in the picture: a plane len = a + b*x + c*y through the bars, found by
    // repeated least squares that gives less weight to bars far from the fit (a glossy bar can read short, a bar merged
    // with a pip long). Perspective makes tiles nearer the camera larger, and this follows that change.
    // With fewer than LIMITS.minBarsForFit bars the typical (median) length is used everywhere.
    // Returns a function (x, y) => expected bar length.
    function fitBarScale(bars) {
        const typical = median(bars.map(b => b.len));
        const constant = () => typical;
        if (bars.length < LIMITS.minBarsForFit) return constant;
        const mx = bars.reduce((s, b) => s + b.cx, 0) / bars.length;
        const my = bars.reduce((s, b) => s + b.cy, 0) / bars.length;
        let weights = bars.map(() => 1);
        let coef = [typical, 0, 0];
        for (let pass = 0; pass < 4; pass++) {
            // Weighted normal equations for the rows [1, x - mx, y - my]
            const m = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
            bars.forEach((b, i) => {
                const row = [1, b.cx - mx, b.cy - my];
                for (let r = 0; r < 3; r++) {
                    for (let c = 0; c < 3; c++) m[r][c] += weights[i] * row[r] * row[c];
                    m[r][3] += weights[i] * row[r] * b.len;
                }
            });
            for (let col = 0; col < 3; col++) {
                let pivot = col;
                for (let r = col + 1; r < 3; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
                if (Math.abs(m[pivot][col]) < 1e-9) return constant;
                [m[col], m[pivot]] = [m[pivot], m[col]];
                for (let r = 0; r < 3; r++) {
                    if (r === col) continue;
                    const f = m[r][col] / m[col][col];
                    for (let c = col; c < 4; c++) m[r][c] -= f * m[col][c];
                }
            }
            coef = [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
            weights = bars.map(b => {
                const miss = b.len - (coef[0] + coef[1] * (b.cx - mx) + coef[2] * (b.cy - my));
                return 1 / (1 + Math.pow(miss / (0.15 * typical), 2));
            });
        }
        return (x, y) => Math.min(typical * 1.6, Math.max(typical * 0.6, coef[0] + coef[1] * (x - mx) + coef[2] * (y - my)));
    }

    // True when (x, y) lies inside a rectangle frame
    function insideFrame(f, x, y) {
        const u = x * f.ux + y * f.uy, v = x * f.vx + y * f.vy;
        return u >= f.minU && u <= f.maxU && v >= f.minV && v <= f.maxV;
    }

    // Share of rectangle a's area that lies inside rectangle b, estimated on a grid of points
    function frameOverlap(a, b) {
        let inside = 0, total = 0;
        for (let i = 0; i < 12; i++) {
            for (let j = 0; j < 6; j++) {
                const u = a.minU + (a.maxU - a.minU) * (i + 0.5) / 12;
                const v = a.minV + (a.maxV - a.minV) * (j + 0.5) / 6;
                total++;
                if (insideFrame(b, u * a.ux + v * a.vx, u * a.uy + v * a.vy)) inside++;
            }
        }
        return inside / total;
    }

    // The tile a divider bar implies. The tile is centered on its bar and runs perpendicular to it. Its short side is the
    // bar's expected length (from the fit over all bars, so perspective is followed) divided by `ratio` (bar length / tile
    // short side), and its long side is twice that.
    // Returns a rectangle record, or { rejected: true, coverage } when the rectangle leaves the picture or does not
    // mostly cover tile surface (a false bar on something else).
    function tileFromBar(bar, expectedLen, ratio, picture) {
        const shortSide = expectedLen / ratio;
        // Frame: u along the tile's long side (perpendicular to the bar), v along the bar
        const ux = -bar.by, uy = bar.bx;
        const vx = -uy, vy = ux;
        const cu = bar.cx * ux + bar.cy * uy, cv = bar.cx * vx + bar.cy * vy;
        const frame = { ux, uy, vx, vy, minU: cu - shortSide, maxU: cu + shortSide, minV: cv - shortSide / 2, maxV: cv + shortSide / 2 };
        const corners = frameCorners(frame, frame.minU, frame.maxU);
        const margin = shortSide * 0.1;
        const inside = [corners.tl, corners.tr, corners.br, corners.bl].every(p =>
            p.x >= -margin && p.y >= -margin && p.x <= picture.width + margin && p.y <= picture.height + margin);
        if (!inside) return { rejected: true, coverage: 0 };

        // Share of the rectangle's interior that looks like tile surface
        let hit = 0, total = 0;
        for (let i = 0; i < LIMITS.coverageSamples; i++) {
            for (let j = 0; j < LIMITS.coverageSamples; j++) {
                const u = frame.minU + shortSide * 2 * (0.1 + 0.8 * i / (LIMITS.coverageSamples - 1));
                const v = frame.minV + shortSide * (0.1 + 0.8 * j / (LIMITS.coverageSamples - 1));
                total++;
                if (isSurface(picture, u * ux + v * vx, u * uy + v * vy)) hit++;
            }
        }
        const coverage = hit / total;
        if (coverage < LIMITS.minCoverage) return { rejected: true, coverage };
        return { frame, area: 2 * shortSide * shortSide, aspect: 2, fill: coverage, solidity: 1, box: null, modeled: true };
    }

    // Bar length / tile short side for this photo: measured on isolated tiles (a blob with exactly one bar), where the
    // tile's short side is visible; falls back to a typical value when every tile touches another
    function barRatio(comps, barsByBlob, total, w, h) {
        const ratios = [];
        barsByBlob.forEach((list, k) => {
            if (list.length !== 1) return;
            const comp = comps[k];
            const frac = comp.area / total;
            if (frac < LIMITS.minAreaFrac || frac > LIMITS.maxAreaFrac) return;
            if (comp.x === 0 || comp.y === 0 || comp.x + comp.w >= w || comp.y + comp.h >= h) return;
            const hull = convexHull(boundaryPoints(comp, comps.index, k, w, h));
            const frame = hull.length >= 3 ? minAreaRect(hull) : null;
            if (!frame) return;
            const aspect = (frame.maxU - frame.minU) / Math.max(frame.maxV - frame.minV, 1e-6);
            if (aspect < LIMITS.minAspect || aspect > LIMITS.maxAspect) return;
            ratios.push(list[0].len / (frame.maxV - frame.minV));
        });
        const ratio = ratios.length ? median(ratios) : LIMITS.defaultBarRatio;
        return Math.min(LIMITS.maxBarRatio, Math.max(LIMITS.minBarRatio, ratio));
    }

    // Looks for tiles in a channel image. polarity: 'light' = tiles brighter than the surface in the channel,
    // 'dark' = darker, 'warm' = the warm-tint channel, where tiles are above the threshold.
    // picture is the RGBA detection image (used to find the divider bars).
    // Returns { tiles, uncertain, rejected, bars } in detection-image coordinates, or null when the channel has no clear split.
    function findCandidates(channel, polarity, picture, debug) {
        const { width: w, height: h } = channel;
        const total = w * h;
        const t = Imaging.otsuThreshold(channel);
        let mask = Imaging.threshold(channel, t);
        if (polarity === 'warm') {
            // Without clearly tinted tiles the split is meaningless: need a real gap between the two groups
            let sumLo = 0, nLo = 0, sumHi = 0, nHi = 0;
            for (let i = 0; i < channel.data.length; i += 7) {
                if (channel.data[i] > t) { sumHi += channel.data[i]; nHi++; } else { sumLo += channel.data[i]; nLo++; }
            }
            const share = nHi / Math.max(1, nHi + nLo);
            if (!nHi || !nLo || sumHi / nHi - sumLo / nLo < LIMITS.minWarmGap || share > LIMITS.maxForegroundShare) return null;
        }
        if (polarity === 'dark') mask = Imaging.invert(mask);

        mask = Imaging.fillHoles(mask, Math.round(total * LIMITS.holeFrac));
        const bars = polarity === 'dark' ? [] : findDividers(picture, mask, debug);

        const comps = Imaging.connectedComponents(mask, { connectivity: 4, labels: true });
        const barsByBlob = new Map();
        bars.forEach(bar => {
            // The tile blob a bar belongs to: usually the blob at the bar's center, but a bar the hole filling left open
            // sits on background, so points beside it and past its ends (tile surface) are tried next
            const side = bar.wid / 2 + LIMITS.barMargin + 1, end = bar.len / 2 + LIMITS.barMargin + 1;
            const probes = [
                [bar.cx, bar.cy],
                [bar.cx + bar.by * side, bar.cy - bar.bx * side], [bar.cx - bar.by * side, bar.cy + bar.bx * side],
                [bar.cx + bar.bx * end, bar.cy + bar.by * end], [bar.cx - bar.bx * end, bar.cy - bar.by * end]
            ];
            for (const [px, py] of probes) {
                const xi = Math.round(px), yi = Math.round(py);
                if (xi < 0 || yi < 0 || xi >= w || yi >= h) continue;
                const k = comps.index[yi * w + xi];
                if (k >= 0) { barsByBlob.set(k, (barsByBlob.get(k) || []).concat(bar)); break; }
            }
        });
        const ratio = barRatio(comps, barsByBlob, total, w, h);
        const barLength = fitBarScale(bars);
        const singles = [];
        const longBlobs = [];
        const squareBlobs = [];
        const rejected = [];

        comps.forEach((comp, k) => {
            const frac = comp.area / total;
            if (frac < LIMITS.minAreaFrac) return;
            const box = { x: comp.x, y: comp.y, w: comp.w, h: comp.h };
            const blobBars = barsByBlob.get(k);
            if (frac > (blobBars ? LIMITS.maxClusterFrac : LIMITS.maxAreaFrac)) { rejected.push({ box, reason: 'too-large' }); return; }
            if (comp.x === 0 || comp.y === 0 || comp.x + comp.w >= w || comp.y + comp.h >= h) {
                rejected.push({ box, reason: 'clipped' });
                return;
            }

            const hull = convexHull(boundaryPoints(comp, comps.index, k, w, h));
            const frame = hull.length >= 3 ? minAreaRect(hull) : null;
            if (!frame) return;
            const length = frame.maxU - frame.minU;
            const width = frame.maxV - frame.minV;
            const aspect = length / Math.max(width, 1e-6);
            // Judged on the convex hull so pips that bite into the edge do not make a tile look misshapen
            const hullArea = Math.max(polygonArea(hull), 1e-6);
            const fill = hullArea / Math.max(length * width, 1e-6);
            const solidity = comp.area / hullArea;
            const info = { frame, area: comp.area, aspect, fill, solidity, box };
            const rectangular = fill >= LIMITS.minFill && solidity >= LIMITS.minSolidity;

            // A blob with divider bars holds exactly one tile per bar, however the tiles touch. A blob with a single bar
            // and a clean rectangular outline is just that tile, and its own outline is more exact than the bar model.
            const cleanSingle = blobBars && blobBars.length === 1 && rectangular && aspect >= LIMITS.minAspect && aspect <= LIMITS.maxAspect;
            if (blobBars && !cleanSingle) {
                blobBars.forEach(bar => {
                    const modeled = tileFromBar(bar, barLength(bar.cx, bar.cy), ratio, picture);
                    if (modeled.rejected) { rejected.push({ box, reason: 'bad-bar', coverage: modeled.coverage }); return; }
                    modeled.box = box;
                    modeled.split = blobBars.length > 1;
                    singles.push(modeled);
                });
                return;
            }
            if (!rectangular) {
                rejected.push({ box, reason: 'not-rectangular', fill, solidity });
                return;
            }
            if (aspect >= LIMITS.minAspect && aspect <= LIMITS.maxAspect) singles.push(info);
            else if (aspect >= LIMITS.chainMinAspect && aspect <= LIMITS.chainMaxAspect) longBlobs.push(info);
            else if (aspect >= 0.8 && aspect <= 1.3) squareBlobs.push(info);
            else rejected.push({ box, reason: 'wrong-shape', aspect });
        });

        // Two tiles cannot occupy the same place: where a modeled tile mostly overlaps a better one (a measured outline,
        // or a modeled tile covering more tile surface), it is dropped
        const kept = [];
        singles.slice().sort((a, b) => (a.modeled ? 1 : 0) - (b.modeled ? 1 : 0) || b.fill - a.fill).forEach(s => {
            const clash = kept.some(o => frameOverlap(s.frame, o.frame) > LIMITS.maxOverlap || frameOverlap(o.frame, s.frame) > LIMITS.maxOverlap);
            if (clash) { rejected.push({ box: s.box, reason: 'overlaps' }); return; }
            kept.push(s);
        });
        const typicalArea = median(kept.map(s => s.area));
        const tiles = kept.map(s => ({
            corners: frameCorners(s.frame, s.frame.minU, s.frame.maxU),
            area: s.area, aspect: s.aspect, fill: s.fill, split: !!s.split,
            confidence: Math.min(1, s.fill) * (1 - Math.min(1, Math.abs(s.aspect - 2) / 0.8) * 0.5) * (s.split ? 0.8 : 1)
        }));

        // Tiles lying end to end form one long blob: cut it into equal parts along its length
        longBlobs.forEach(s => {
            const parts = Math.round(s.aspect / 2);
            const sizeOk = !typicalArea || Math.abs(s.area / parts - typicalArea) / typicalArea < 0.35;
            if (parts < 2 || parts > 6 || !sizeOk) { rejected.push({ box: s.box, reason: 'wrong-shape', aspect: s.aspect }); return; }
            const len = s.frame.maxU - s.frame.minU;
            for (let i = 0; i < parts; i++) {
                const u0 = s.frame.minU + (len * i) / parts;
                const u1 = s.frame.minU + (len * (i + 1)) / parts;
                tiles.push({
                    corners: frameCorners(s.frame, u0, u1),
                    area: s.area / parts, aspect: s.aspect / parts, fill: s.fill, split: true, confidence: 0.5
                });
            }
        });

        // A roughly square blob about twice the typical tile is two tiles side by side; which way they run is
        // ambiguous from the outline alone, so it is reported for the user to spread apart instead of guessed
        const uncertain = squareBlobs
            .filter(s => typicalArea && s.area > typicalArea * 1.6 && s.area < typicalArea * 2.6)
            .map(s => ({ box: s.box, reason: 'touching' }));

        return { tiles, uncertain, rejected, bars };
    }

    // Detects tiles in an RGBA photo. options.tileColor is 'auto' (try both), 'light' or 'dark'.
    // options.debug may be an array that receives a record for each candidate divider mark (detection-image coordinates).
    // Returns { tiles, uncertain, rejected, polarity, scale }; tile corners are in full-photo pixels, in reading order.
    function detect(img, options) {
        const tileColor = (options && options.tileColor) || 'auto';
        const { img: small, scale } = downscaleRGBA(img, DETECT_MAX_DIM);
        const blurred = Imaging.gaussianBlur(Imaging.grayFromRGBA(small), 5);
        const warm = warmChannel(small);

        // Each way of splitting tiles from the surface; the one that yields the most tile-like shapes wins.
        // Light tiles can be white or ivory, so 'light' also tries the warm tint.
        const polarities = tileColor === 'light' ? ['warm', 'light'] : tileColor === 'dark' ? ['dark'] : ['warm', 'light', 'dark'];
        let best = null;
        polarities.forEach(polarity => {
            const notes = options && options.debug ? [] : null;
            const found = findCandidates(polarity === 'warm' ? warm : blurred, polarity, small, notes);
            if (!found) return;
            found.notes = notes;
            const score = found.tiles.length + 0.5 * found.tiles.reduce((s, t) => s + t.confidence, 0);
            if (!best || score > best.score) best = Object.assign({ polarity, score }, found);
        });
        if (!best) best = { polarity: polarities[0], score: 0, tiles: [], uncertain: [], rejected: [], bars: [] };
        if (options && options.debug && best.notes) best.notes.forEach(n => options.debug.push(n));

        // Back to full-photo coordinates, then reading order (rows top to bottom, left to right within a row)
        const inv = 1 / scale;
        const tiles = best.tiles.map(t => {
            const corners = scaleCorners(t.corners, inv);
            return Object.assign({}, t, { corners, center: centerOf(corners) });
        });
        const rowHeight = median(tiles.map(t => Math.hypot(t.corners.bl.x - t.corners.tl.x, t.corners.bl.y - t.corners.tl.y))) || 1;
        tiles.sort((a, b) => Math.round(a.center.y / rowHeight) - Math.round(b.center.y / rowHeight) || a.center.x - b.center.x);
        const box = b => ({ x: b.x * inv, y: b.y * inv, w: b.w * inv, h: b.h * inv });
        return {
            tiles,
            uncertain: best.uncertain.map(u => Object.assign({}, u, { box: box(u.box) })),
            rejected: best.rejected.map(r => Object.assign({}, r, { box: box(r.box) })),
            bars: best.bars.map(b => Object.assign({}, b, { cx: b.cx * inv, cy: b.cy * inv, len: b.len * inv, wid: b.wid * inv })),
            polarity: best.polarity,
            scale
        };
    }

    // Cuts one detected tile out of the full photo, straightened into an outW x outH horizontal crop.
    // Returns an RGBA image object, or null when the outline is degenerate.
    function extractTile(img, tile, outW, outH) {
        const c = tile.corners;
        const ctr = centerOf(c);
        const pull = p => ({ x: p.x + (ctr.x - p.x) * LIMITS.shrink * 2, y: p.y + (ctr.y - p.y) * LIMITS.shrink * 2 });
        const corners = { tl: pull(c.tl), tr: pull(c.tr), br: pull(c.br), bl: pull(c.bl) };
        return Imaging.warpPerspectiveData(img, corners, outW || CROP_W, outH || CROP_H);
    }

    return {
        VERSION: DOMINO_TILES_VERSION,
        CROP_W, CROP_H, LIMITS,
        downscaleRGBA, convexHull, minAreaRect, detect, extractTile
    };
})();
