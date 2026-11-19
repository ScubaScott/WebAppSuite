// Domino pip counting version identifier
const DOMINO_PIPS_VERSION = '1.7';

// Counts the pips on each half of a straightened 240x120 tile crop (see DominoTiles.extractTile).
// A pip is anything whose color differs from the tile body, so pale pips on a dark tile, dark pips on a light tile
// and every color of a colored set (yellow and orange on ivory differ little in brightness but a lot in color) use the
// same path. Depends on the shared imaging module; every function works on plain RGBA image objects, so the module
// runs in a browser or in Node.
const DominoPips = (() => {

    const CROP_W = 240;
    const CROP_H = 120;
    const MARGIN_X = 10;               // border of the crop ignored, so the tile edge and its rounded corners are never pips
    const MARGIN_Y = 10;

    const LIMITS = {
        minColorDistance: 48,          // a pip's color differs from the body color's direction by at least this (RGB units, 0-441)
        darkRatio: 0.3,                // a pixel darker than this fraction of the body's brightness is a pip regardless of color
        surroundBlock: 31,             // pale pips: compared with the average brightness of this many pixels around
        surroundRatio: 0.88,           // ...a pip is darker than this fraction of its surroundings...
        bodyRatio: 0.86,               // ...and darker than this fraction of the body's brightness (so shading alone is not a pip)
        darkBodyNorm: 150,             // a body color with a smaller RGB length than this is a dark tile (plain distance is used)
        darkBodyDistance: 70,          // dark tile: a pip differs from the body color by at least this
        highlightReach: 3,             // a highlight pixel must be within this many pixels of a pip pixel to join the pip
        highlightWhiteness: 40,        // ...and whiter than the body: its weakest channel exceeds the body's weakest by this much
        highlightHole: 60,             // a glossy pip's highlight is a hole in its blob; holes up to this many pixels are filled
        minPipArea: 30,                // pixels; smaller blobs are specks
        maxPipArea: 900,
        minPipFill: 0.5,               // blob area / bounding box area (a disc is 0.785)
        minPipAspect: 0.55,
        maxPipAspect: 1.8,
        noiseRatio: 0.35,              // blobs below this fraction of the typical pip area are dropped
        mergeRatio: 1.6,               // blobs above this multiple of the typical pip area are touching pips
        minReferenceArea: 45,          // typical pip area below this means only noise was found
        referenceQuantile: 0.4,        // typical pip size: this quantile (0 = smallest, 1 = largest) of the round blobs
        dividerFrom: 90,               // the divider bar is searched for between these columns
        dividerTo: 150,
        dividerCover: 0.55,            // fraction of the tile height a bar column must cover
        dividerMinWidth: 2,            // a bar is a run of covered columns this wide...
        dividerMaxWidth: 18,           // ...up to this wide (a column of pips is also tall, but made of separate round pips)
        dividerPad: 2,                 // columns cleared beyond the bar's own width
        rivetX: 10,                    // blobs this close to the middle of the divider are the center rivet
        rivetY: 16,
        unevenLow: 0.6,                // pips outside this range of the typical size mark the half as uneven
        unevenHigh: 1.5
    };

    function median(values) {
        if (!values.length) return 0;
        const sorted = values.slice().sort((a, b) => a - b);
        const mid = sorted.length >> 1;
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    // Median color of the crop inside its margins: the tile body, since pips cover a minority of it. Used for the
    // polarity label only. Returns [r, g, b].
    function bodyColorOf(crop) {
        const channels = [[], [], []];
        for (let y = MARGIN_Y; y < crop.height - MARGIN_Y; y += 2) {
            for (let x = MARGIN_X; x < crop.width - MARGIN_X; x += 2) {
                const p = (y * crop.width + x) * 4;
                for (let c = 0; c < 3; c++) channels[c].push(crop.data[p + c]);
            }
        }
        return channels.map(median);
    }

    // The dominant color of one half of the crop (inside its margins): the tile body. Colors are counted in a coarse
    // 3-D histogram. A cell's score also counts its neighbors, because shaded ivory spreads over several adjacent cells
    // while a pip is one tight color and would otherwise out-vote it. The best cell and its neighbors give the color, so
    // pips (a minority of the half) cannot outvote the body the way they would a median or an average.
    // Returns [r, g, b].
    function dominantColor(crop, x0, x1) {
        const cells = new Map();
        const keyOf = (r, g, b) => (r << 8) | (g << 4) | b;
        for (let y = MARGIN_Y; y < crop.height - MARGIN_Y; y += 2) {
            for (let x = x0; x < x1; x += 2) {
                const p = (y * crop.width + x) * 4;
                const r = crop.data[p] >> 4, g = crop.data[p + 1] >> 4, b = crop.data[p + 2] >> 4;
                const key = keyOf(r, g, b);
                let cell = cells.get(key);
                if (!cell) { cell = { r, g, b, n: 0, sr: 0, sg: 0, sb: 0 }; cells.set(key, cell); }
                cell.n++; cell.sr += crop.data[p]; cell.sg += crop.data[p + 1]; cell.sb += crop.data[p + 2];
            }
        }
        let best = null;
        cells.forEach(cell => {
            let n = 0, sr = 0, sg = 0, sb = 0;
            for (let dr = -1; dr <= 1; dr++) {
                for (let dg = -1; dg <= 1; dg++) {
                    for (let db = -1; db <= 1; db++) {
                        const near = cells.get(keyOf(cell.r + dr, cell.g + dg, cell.b + db));
                        if (near) { n += near.n; sr += near.sr; sg += near.sg; sb += near.sb; }
                    }
                }
            }
            if (!best || n > best.n) best = { n, sr, sg, sb };
        });
        return best ? [best.sr / best.n, best.sg / best.n, best.sb / best.n] : [128, 128, 128];
    }

    // Mask (255 where a pixel is a pip candidate). For a light tile a pixel is a pip when its color differs from the
    // body color in direction (the part of it not along the body color's own direction in RGB space): shadow only scales
    // the body color along that direction, so shading does not count, while any other color does. A pixel much darker than
    // the body is also a pip (black pips are along every direction). For a dark tile the plain color distance is used.
    // The two halves each use their own body color, so a tile lying half in shadow is handled.
    function pipMask(crop) {
        const w = crop.width, h = crop.height;
        const smooth = [0, 1, 2].map(c => {
            const g = { width: w, height: h, data: new Uint8Array(w * h) };
            for (let i = 0, p = c; i < g.data.length; i++, p += 4) g.data[i] = crop.data[p];
            return Imaging.gaussianBlur(g, 3);
        });
        // Brightness of every pixel against the average of its surroundings: pale gray pips share the body's color
        // direction and differ mainly in brightness, but they are darker than the ivory around them, shading or not
        const lum = { width: w, height: h, data: new Uint8Array(w * h) };
        for (let i = 0; i < lum.data.length; i++) lum.data[i] = (smooth[0].data[i] + smooth[1].data[i] + smooth[2].data[i]) / 3;
        const surround = Imaging.boxMean(lum, LIMITS.surroundBlock);
        const half = [dominantColor(crop, MARGIN_X, w >> 1), dominantColor(crop, w >> 1, w - MARGIN_X)].map(body => {
            const norm = Math.hypot(body[0], body[1], body[2]) || 1;
            return { body, norm, unit: body.map(v => v / norm), dark: norm < LIMITS.darkBodyNorm };
        });
        const out = new Uint8Array(w * h);
        for (let y = MARGIN_Y; y < h - MARGIN_Y; y++) {
            for (let x = MARGIN_X; x < w - MARGIN_X; x++) {
                const i = y * w + x;
                const b = half[x < (w >> 1) ? 0 : 1];
                const r = smooth[0].data[i], g = smooth[1].data[i], bl = smooth[2].data[i];
                if (b.dark) {
                    const d = Math.hypot(r - b.body[0], g - b.body[1], bl - b.body[2]);
                    if (d >= LIMITS.darkBodyDistance) out[i] = 255;
                    continue;
                }
                const mag = Math.hypot(r, g, bl);
                const along = r * b.unit[0] + g * b.unit[1] + bl * b.unit[2];
                const off = Math.sqrt(Math.max(0, mag * mag - along * along));
                const bodyLum = (b.body[0] + b.body[1] + b.body[2]) / 3;
                const darkerThanAround = lum.data[i] < LIMITS.surroundRatio * surround[i] && lum.data[i] < LIMITS.bodyRatio * bodyLum;
                if (off >= LIMITS.minColorDistance || mag < LIMITS.darkRatio * b.norm || darkerThanAround) out[i] = 255;
            }
        }
        joinHighlights(out, smooth, half, w, h);
        return Imaging.fillHoles({ width: w, height: h, data: out }, LIMITS.highlightHole);
    }

    // A glossy pip has a white highlight that can split it into two crescents. Pixels clearly whiter than the body
    // that lie within a few pixels of a pip pixel are added to the pip, which closes the highlight; bright sheen out on
    // the bare tile is not near any pip pixel and stays untouched. Changes the mask in place.
    function joinHighlights(mask, smooth, half, w, h) {
        const reach = LIMITS.highlightReach;
        const near = new Uint8Array(w * h);
        for (let y = MARGIN_Y; y < h - MARGIN_Y; y++) {
            for (let x = MARGIN_X; x < w - MARGIN_X; x++) {
                if (mask[y * w + x] !== 255) continue;
                for (let dy = -reach; dy <= reach; dy++) {
                    for (let dx = -reach; dx <= reach; dx++) {
                        const xx = x + dx, yy = y + dy;
                        if (xx >= MARGIN_X && xx < w - MARGIN_X && yy >= MARGIN_Y && yy < h - MARGIN_Y) near[yy * w + xx] = 1;
                    }
                }
            }
        }
        for (let y = MARGIN_Y; y < h - MARGIN_Y; y++) {
            for (let x = MARGIN_X; x < w - MARGIN_X; x++) {
                const i = y * w + x;
                if (mask[i] === 255 || !near[i]) continue;
                const b = half[x < (w >> 1) ? 0 : 1];
                // Whiteness: the weakest channel of a highlight is far above the body's weakest channel (ivory is weak in blue)
                const weakest = Math.min(smooth[0].data[i], smooth[1].data[i], smooth[2].data[i]);
                if (weakest - Math.min(b.body[0], b.body[1], b.body[2]) >= LIMITS.highlightWhiteness) mask[i] = 255;
            }
        }
    }

    // Finds the divider bar between the two halves: a run of columns marked from top to bottom. A column of pips is as
    // tall but is broken up by gaps between the round pips, and is wider than a bar run only when several columns of pips
    // touch, which the width limit excludes. Returns { x, half } (center and half width in pixels), or null when no bar
    // stands out (the tile is then split in the middle).
    function findDivider(mask) {
        const { width: w, height: h, data } = mask;
        const span = h - 2 * MARGIN_Y;
        const cover = new Array(w).fill(0);
        for (let x = MARGIN_X; x < w - MARGIN_X; x++) {
            let longest = 0, run = 0;
            for (let y = MARGIN_Y; y < h - MARGIN_Y; y++) {
                run = data[y * w + x] === 255 ? run + 1 : 0;
                if (run > longest) longest = run;
            }
            cover[x] = longest;          // longest unbroken vertical stretch: a bar is unbroken, a column of pips is not
        }
        let best = null;
        let x = LIMITS.dividerFrom;
        while (x <= LIMITS.dividerTo) {
            if (cover[x] < LIMITS.dividerCover * span) { x++; continue; }
            let end = x;
            while (end + 1 <= LIMITS.dividerTo + LIMITS.dividerMaxWidth && cover[end + 1] >= LIMITS.dividerCover * span) end++;
            const width = end - x + 1;
            if (width >= LIMITS.dividerMinWidth && width <= LIMITS.dividerMaxWidth) {
                const score = width * 1000 + cover[Math.round((x + end) / 2)];
                if (!best || score > best.score) best = { score, x: (x + end) / 2, half: width / 2 };
            }
            x = end + 1;
        }
        return best ? { x: best.x, half: best.half } : null;
    }

    // Counts the pips on both halves of a crop. options.tileColor ('auto', 'light', 'dark') only labels the result's
    // polarity; counting does not depend on it. Returns { polarity, dividerX, hasDivider, pipArea,
    // left: { pips, flags }, right: { pips, flags } } where each pip is { x, y, r, merged } in crop pixels.
    function analyze(crop, options) {
        const tileColor = (options && options.tileColor) || 'auto';
        const body = bodyColorOf(crop);
        const brightness = (body[0] + body[1] + body[2]) / 3;
        const polarity = tileColor === 'light' || tileColor === 'dark' ? tileColor : (brightness >= 110 ? 'light' : 'dark');

        const mask = pipMask(crop);
        const bar = findDivider(mask);
        const dividerX = bar ? bar.x : crop.width / 2;
        const result = {
            polarity, dividerX, hasDivider: !!bar, pipArea: 0,
            left: { pips: [], flags: [] }, right: { pips: [], flags: [] }
        };

        // The bar itself is not a pip: clear it (with a little padding) before looking for blobs
        const clear = (bar ? bar.half : 3) + LIMITS.dividerPad;
        for (let y = 0; y < mask.height; y++) {
            for (let x = Math.max(0, Math.round(dividerX - clear)); x <= Math.round(dividerX + clear) && x < mask.width; x++) {
                mask.data[y * mask.width + x] = 0;
            }
        }

        const midY = crop.height / 2;
        // With options.debug (an array) every blob is recorded with the reason it was kept or dropped
        const note = (c, reason) => { if (options && options.debug) options.debug.push({ x: c.x, y: c.y, w: c.w, h: c.h, area: c.area, reason }); };
        const candidates = Imaging.connectedComponents(mask, { connectivity: 8 }).filter(c => {
            const aspect = c.w / c.h;
            const fill = c.area / (c.w * c.h);
            if (c.area < LIMITS.minPipArea) { if (c.area > 8) note(c, 'tiny'); return false; }
            if (c.area > LIMITS.maxPipArea) { note(c, 'too-big'); return false; }
            if (fill < LIMITS.minPipFill || aspect < LIMITS.minPipAspect || aspect > LIMITS.maxPipAspect) { note(c, 'shape fill=' + fill.toFixed(2) + ' aspect=' + aspect.toFixed(2)); return false; }
            // The brass rivet in the middle of the divider is not a pip, and neither is anything straddling the divider
            if (Math.abs(c.cx - dividerX) <= LIMITS.rivetX && Math.abs(c.cy - midY) <= LIMITS.rivetY) { note(c, 'rivet'); return false; }
            if (c.x < dividerX - clear && c.x + c.w > dividerX + clear) { note(c, 'straddles'); return false; }
            note(c, 'pip');
            return true;
        });
        if (!candidates.length) return result;

        // Typical pip size, from blobs that look like single round pips. Each half has its own: a tile photographed at an
        // angle shows the half nearer the camera with much larger pips, and one shared size would read those as touching pairs.
        const isRound = c => c.area / (c.w * c.h) >= 0.65 && c.w / c.h > 0.75 && c.w / c.h < 1.33;
        const allReference = referenceSize(candidates.filter(isRound), candidates);
        result.pipArea = allReference;
        if (allReference < LIMITS.minReferenceArea) return result;

        ['left', 'right'].forEach(side => {
            const mine = candidates.filter(c => (c.cx < dividerX) === (side === 'left'));
            if (!mine.length) return;
            const half = result[side];
            // The half's own size, even from one or two blobs: the other half can be photographed at a very different scale
            const own = referenceSize(mine.filter(isRound), mine);
            const reference = own >= LIMITS.minReferenceArea ? own : allReference;
            mine.forEach(c => {
                const ratio = c.area / reference;
                if (ratio < LIMITS.noiseRatio) return;
                if (ratio >= LIMITS.mergeRatio) {
                    // Touching pips form one blob: place one marker per pip along its long side
                    const count = Math.min(4, Math.round(ratio));
                    for (let i = 0; i < count; i++) {
                        const f = (i + 0.5) / count;
                        half.pips.push({
                            x: c.w >= c.h ? c.x + c.w * f : c.cx,
                            y: c.w >= c.h ? c.cy : c.y + c.h * f,
                            r: Math.sqrt(reference / Math.PI), merged: true
                        });
                    }
                    if (!half.flags.includes('merged')) half.flags.push('merged');
                } else {
                    half.pips.push({ x: c.cx, y: c.cy, r: Math.sqrt(c.area / Math.PI), merged: false });
                    if ((ratio < LIMITS.unevenLow || ratio > LIMITS.unevenHigh) && !half.flags.includes('uneven')) half.flags.push('uneven');
                }
            });
        });
        return result;
    }

    // A typical single-pip area from a list of blobs: a lower quantile of the round ones (or of all of them when none is
    // round), so a few merged blobs cannot pull the estimate up
    function referenceSize(round, all) {
        const areas = (round.length ? round : all).map(c => c.area).sort((a, b) => a - b);
        return areas.length ? areas[Math.floor((areas.length - 1) * LIMITS.referenceQuantile)] : 0;
    }

    // Order-independent key for a tile: the smaller half first ("3|7" for both 3|7 and 7|3)
    function tileKey(a, b) {
        return Math.min(a, b) + '|' + Math.max(a, b);
    }

    // Sets tile.flags on every tile of a hand. Each tile has left.pips and right.pips arrays.
    // Flags: 'over-max' (a half has more pips than the set allows), 'duplicate' (the same tile appears twice,
    // which a real set cannot do), 'merged' (touching pips were split by size), 'uneven' (pip sizes disagree).
    function flagTiles(tiles, setMax) {
        const seen = {};
        tiles.forEach(t => {
            const key = tileKey(t.left.pips.length, t.right.pips.length);
            seen[key] = (seen[key] || 0) + 1;
        });
        tiles.forEach(t => {
            const a = t.left.pips.length;
            const b = t.right.pips.length;
            const flags = [];
            if (a > setMax || b > setMax) flags.push('over-max');
            if (seen[tileKey(a, b)] > 1) flags.push('duplicate');
            const halfFlags = (t.left.flags || []).concat(t.right.flags || []);
            if (halfFlags.includes('merged')) flags.push('merged');
            if (halfFlags.includes('uneven')) flags.push('uneven');
            t.flags = flags;
        });
        return tiles;
    }

    return {
        VERSION: DOMINO_PIPS_VERSION,
        CROP_W, CROP_H, LIMITS,
        analyze, tileKey, flagTiles
    };
})();
