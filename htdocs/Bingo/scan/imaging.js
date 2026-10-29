// Imaging module version identifier
const IMAGING_VERSION = '1.0';

// Small plain-JavaScript image toolkit used by the scanner (no external libraries).
// Gray images are objects { width, height, data } where data is a Uint8Array of 0-255 values.
// Color images are standard ImageData (RGBA). Only the canvas helpers at the bottom touch the DOM,
// so the numeric functions can run anywhere JavaScript runs.
const Imaging = (() => {

    // ---- Conversions ----

    // Reads a canvas into ImageData
    function canvasToImageData(canvas) {
        return canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
    }

    // RGBA to gray using the standard luma weights (0.299 R + 0.587 G + 0.114 B)
    function grayFromRGBA(img) {
        const n = img.width * img.height;
        const out = new Uint8Array(n);
        const d = img.data;
        for (let i = 0, p = 0; i < n; i++, p += 4) {
            out[i] = (d[p] * 4899 + d[p + 1] * 9617 + d[p + 2] * 1868 + 8192) >> 14;
        }
        return { width: img.width, height: img.height, data: out };
    }

    // Returns a copy with every value flipped (255 - v)
    function invert(gray) {
        const out = new Uint8Array(gray.data.length);
        for (let i = 0; i < out.length; i++) out[i] = 255 - gray.data[i];
        return { width: gray.width, height: gray.height, data: out };
    }

    // Copies a rectangle out of a gray image (clamped to the image bounds)
    function cropGray(gray, x, y, w, h) {
        const x0 = Math.max(0, Math.min(gray.width - 1, Math.round(x)));
        const y0 = Math.max(0, Math.min(gray.height - 1, Math.round(y)));
        const cw = Math.max(1, Math.min(gray.width - x0, Math.round(w)));
        const ch = Math.max(1, Math.min(gray.height - y0, Math.round(h)));
        const out = new Uint8Array(cw * ch);
        for (let row = 0; row < ch; row++) {
            const s = (y0 + row) * gray.width + x0;
            out.set(gray.data.subarray(s, s + cw), row * cw);
        }
        return { width: cw, height: ch, data: out };
    }

    // ---- Filters ----

    // Reflects an out-of-range index back into [0, n) without repeating the edge pixel
    function reflect(i, n) {
        if (n === 1) return 0;
        if (i < 0) i = -i;
        if (i >= n) i = 2 * n - 2 - i;
        return i < 0 ? 0 : (i >= n ? n - 1 : i);
    }

    // Normalized 1-D Gaussian kernel of an odd size. Small sizes use the exact binomial tables.
    function gaussianKernel(size) {
        const fixed = {
            1: [1],
            3: [0.25, 0.5, 0.25],
            5: [0.0625, 0.25, 0.375, 0.25, 0.0625],
            7: [0.03125, 0.109375, 0.21875, 0.28125, 0.21875, 0.109375, 0.03125]
        };
        if (fixed[size]) return fixed[size];
        const sigma = 0.3 * ((size - 1) * 0.5 - 1) + 0.8;
        const half = (size - 1) / 2;
        const k = new Array(size);
        let sum = 0;
        for (let i = 0; i < size; i++) {
            const d = i - half;
            k[i] = Math.exp(-(d * d) / (2 * sigma * sigma));
            sum += k[i];
        }
        return k.map(v => v / sum);
    }

    // Applies the same 1-D kernel along rows and then columns; returns Float32 values
    function convolveSeparable(data, w, h, kernel) {
        const r = (kernel.length - 1) >> 1;
        const tmp = new Float32Array(w * h);
        const out = new Float32Array(w * h);
        for (let y = 0; y < h; y++) {
            const row = y * w;
            for (let x = 0; x < w; x++) {
                let s = 0;
                for (let k = -r; k <= r; k++) s += data[row + reflect(x + k, w)] * kernel[k + r];
                tmp[row + x] = s;
            }
        }
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                let s = 0;
                for (let k = -r; k <= r; k++) s += tmp[reflect(y + k, h) * w + x] * kernel[k + r];
                out[y * w + x] = s;
            }
        }
        return out;
    }

    // Gaussian blur with an odd kernel size
    function gaussianBlur(gray, size) {
        const f = convolveSeparable(gray.data, gray.width, gray.height, gaussianKernel(size));
        const out = new Uint8Array(f.length);
        for (let i = 0; i < f.length; i++) out[i] = Math.round(f[i]);
        return { width: gray.width, height: gray.height, data: out };
    }

    // Median blur with a square window of an odd size
    function medianBlur(gray, size) {
        const { width: w, height: h, data } = gray;
        const r = (size - 1) >> 1;
        const out = new Uint8Array(w * h);
        const win = new Uint8Array(size * size);
        const mid = (size * size) >> 1;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                let n = 0;
                for (let dy = -r; dy <= r; dy++) {
                    const row = reflect(y + dy, h) * w;
                    for (let dx = -r; dx <= r; dx++) win[n++] = data[row + reflect(x + dx, w)];
                }
                win.sort();
                out[y * w + x] = win[mid];
            }
        }
        return { width: w, height: h, data: out };
    }

    // ---- Thresholding ----

    // Otsu threshold: the cut that best separates the two brightness groups
    function otsuThreshold(gray) {
        const hist = new Float64Array(256);
        for (let i = 0; i < gray.data.length; i++) hist[gray.data[i]]++;
        const total = gray.data.length;
        let sumAll = 0;
        for (let t = 0; t < 256; t++) sumAll += t * hist[t];
        let sumB = 0, wB = 0, best = 0, bestT = 0;
        for (let t = 0; t < 256; t++) {
            wB += hist[t];
            if (wB === 0) continue;
            const wF = total - wB;
            if (wF === 0) break;
            sumB += t * hist[t];
            const mB = sumB / wB;
            const mF = (sumAll - sumB) / wF;
            const between = wB * wF * (mB - mF) * (mB - mF);
            if (between > best) { best = between; bestT = t; }
        }
        return bestT;
    }

    // Pixels brighter than t become 255, the rest 0
    function threshold(gray, t) {
        const out = new Uint8Array(gray.data.length);
        for (let i = 0; i < out.length; i++) out[i] = gray.data[i] > t ? 255 : 0;
        return { width: gray.width, height: gray.height, data: out };
    }

    // Local threshold: each pixel is compared with the (Gaussian or box) average of its neighborhood minus c.
    // With invert, pixels darker than the local average become 255.
    function adaptiveThreshold(gray, options) {
        const { method = 'gaussian', blockSize = 11, c = 2, invert: inv = false } = options || {};
        const { width: w, height: h, data } = gray;
        let mean;
        if (method === 'mean') {
            mean = convolveSeparable(data, w, h, new Array(blockSize).fill(1 / blockSize));
        } else {
            mean = convolveSeparable(data, w, h, gaussianKernel(blockSize));
        }
        const out = new Uint8Array(w * h);
        for (let i = 0; i < out.length; i++) {
            const above = data[i] > mean[i] - c;
            out[i] = (above !== inv) ? 255 : 0;
        }
        return { width: w, height: h, data: out };
    }

    // ---- Morphology (2x2 square window anchored at its lower-right pixel) ----

    function morphStep(bin, takeMax) {
        const { width: w, height: h, data } = bin;
        const out = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                let v = takeMax ? 0 : 255;
                for (let dy = -1; dy <= 0; dy++) {
                    const yy = y + dy;
                    if (yy < 0) continue;
                    for (let dx = -1; dx <= 0; dx++) {
                        const xx = x + dx;
                        if (xx < 0) continue;
                        const p = data[yy * w + xx];
                        if (takeMax ? p > v : p < v) v = p;
                    }
                }
                out[y * w + x] = v;
            }
        }
        return { width: w, height: h, data: out };
    }

    // op is 'dilate', 'erode', 'open' (erode then dilate) or 'close' (dilate then erode)
    function morphology(bin, op) {
        if (op === 'dilate') return morphStep(bin, true);
        if (op === 'erode') return morphStep(bin, false);
        if (op === 'open') return morphStep(morphStep(bin, false), true);
        if (op === 'close') return morphStep(morphStep(bin, true), false);
        return bin;
    }

    // ---- Regions ----

    // Finds connected groups of pixels equal to `fg` (default 255) in a mask.
    // Returns one entry per group with its bounding box, pixel count, centroid and the four
    // extreme pixels (tl = smallest x+y, br = largest x+y, tr = largest x-y, bl = smallest x-y).
    function connectedComponents(mask, options) {
        const { fg = 255, connectivity = 8 } = options || {};
        const { width: w, height: h, data } = mask;
        const labels = new Int32Array(w * h);
        const parent = [0];
        let next = 1;

        const find = a => {
            while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
            return a;
        };
        const union = (a, b) => {
            const ra = find(a), rb = find(b);
            if (ra !== rb) { if (ra < rb) parent[rb] = ra; else parent[ra] = rb; }
        };

        // First pass: give each pixel a label, merging with already-labeled neighbors
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const i = y * w + x;
                if (data[i] !== fg) continue;
                const neighbors = [];
                if (x > 0 && labels[i - 1]) neighbors.push(labels[i - 1]);
                if (y > 0) {
                    if (labels[i - w]) neighbors.push(labels[i - w]);
                    if (connectivity === 8) {
                        if (x > 0 && labels[i - w - 1]) neighbors.push(labels[i - w - 1]);
                        if (x < w - 1 && labels[i - w + 1]) neighbors.push(labels[i - w + 1]);
                    }
                }
                if (!neighbors.length) {
                    parent.push(next);
                    labels[i] = next++;
                } else {
                    let m = neighbors[0];
                    for (const n of neighbors) if (n < m) m = n;
                    labels[i] = m;
                    for (const n of neighbors) union(m, n);
                }
            }
        }

        // Second pass: collect statistics per final group
        const stats = new Map();
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const l = labels[y * w + x];
                if (!l) continue;
                const root = find(l);
                let s = stats.get(root);
                if (!s) {
                    s = {
                        minX: x, maxX: x, minY: y, maxY: y, area: 0, sumX: 0, sumY: 0,
                        tl: { x, y }, br: { x, y }, tr: { x, y }, bl: { x, y }
                    };
                    stats.set(root, s);
                }
                if (x < s.minX) s.minX = x;
                if (x > s.maxX) s.maxX = x;
                if (y < s.minY) s.minY = y;
                if (y > s.maxY) s.maxY = y;
                s.area++;
                s.sumX += x;
                s.sumY += y;
                if (x + y < s.tl.x + s.tl.y) s.tl = { x, y };
                if (x + y > s.br.x + s.br.y) s.br = { x, y };
                if (x - y > s.tr.x - s.tr.y) s.tr = { x, y };
                if (x - y < s.bl.x - s.bl.y) s.bl = { x, y };
            }
        }

        return Array.from(stats.values()).map(s => ({
            x: s.minX, y: s.minY, w: s.maxX - s.minX + 1, h: s.maxY - s.minY + 1,
            area: s.area, cx: s.sumX / s.area, cy: s.sumY / s.area,
            tl: s.tl, tr: s.tr, br: s.br, bl: s.bl
        }));
    }

    // Mask (255/0) of pixels whose hue/saturation/value fall in any of the given ranges.
    // Ranges are [hLow, sLow, vLow, hHigh, sHigh, vHigh] with hue 0-180 and saturation/value 0-255.
    function hsvMask(img, ranges) {
        const n = img.width * img.height;
        const out = new Uint8Array(n);
        const d = img.data;
        for (let i = 0, p = 0; i < n; i++, p += 4) {
            const r = d[p], g = d[p + 1], b = d[p + 2];
            const max = Math.max(r, g, b);
            const min = Math.min(r, g, b);
            const delta = max - min;
            const v = max;
            const s = max === 0 ? 0 : Math.round(255 * delta / max);
            let hue = 0;
            if (delta !== 0) {
                if (max === r) hue = 60 * (g - b) / delta;
                else if (max === g) hue = 120 + 60 * (b - r) / delta;
                else hue = 240 + 60 * (r - g) / delta;
                if (hue < 0) hue += 360;
            }
            const h = Math.round(hue / 2);
            for (const q of ranges) {
                if (h >= q[0] && h <= q[3] && s >= q[1] && s <= q[4] && v >= q[2] && v <= q[5]) { out[i] = 255; break; }
            }
        }
        return { width: img.width, height: img.height, data: out };
    }

    // ---- Perspective ----

    // Solves for the 3x3 matrix (9 numbers, row-major, last = 1) that maps four source points to four
    // destination points. Returns null when the points are degenerate.
    function solveHomography(src, dst) {
        const a = [];
        for (let i = 0; i < 4; i++) {
            const { x, y } = src[i];
            const { x: u, y: v } = dst[i];
            a.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
            a.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
        }
        // Gaussian elimination with partial pivoting on the 8x9 augmented system
        for (let col = 0; col < 8; col++) {
            let pivot = col;
            for (let r = col + 1; r < 8; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
            if (Math.abs(a[pivot][col]) < 1e-12) return null;
            [a[col], a[pivot]] = [a[pivot], a[col]];
            for (let r = 0; r < 8; r++) {
                if (r === col) continue;
                const f = a[r][col] / a[col][col];
                for (let c = col; c < 9; c++) a[r][c] -= f * a[col][c];
            }
        }
        const h = [];
        for (let i = 0; i < 8; i++) h.push(a[i][8] / a[i][i]);
        h.push(1);
        return h;
    }

    // Maps a point through a homography
    function applyHomography(H, x, y) {
        const w = H[6] * x + H[7] * y + H[8];
        return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w };
    }

    // Bilinear sample of one RGBA pixel at fractional coordinates; writes into out[0..3]
    function sampleBilinear(img, x, y, out) {
        const w = img.width, h = img.height, d = img.data;
        if (x < 0 || y < 0 || x > w - 1 || y > h - 1) { out[0] = out[1] = out[2] = out[3] = 0; return; }
        const x0 = Math.floor(x), y0 = Math.floor(y);
        const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
        const fx = x - x0, fy = y - y0;
        const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4, i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
        for (let c = 0; c < 4; c++) {
            const top = d[i00 + c] * (1 - fx) + d[i10 + c] * fx;
            const bottom = d[i01 + c] * (1 - fx) + d[i11 + c] * fx;
            out[c] = top * (1 - fy) + bottom * fy;
        }
    }

    // Cuts the quadrilateral given by corners {tl,tr,br,bl} out of an RGBA image and stretches it onto an
    // outW x outH rectangle. Returns ImageData, or null when the corners are degenerate.
    function warpPerspectiveData(img, corners, outW, outH) {
        const rect = [{ x: 0, y: 0 }, { x: outW, y: 0 }, { x: outW, y: outH }, { x: 0, y: outH }];
        const quad = [corners.tl, corners.tr, corners.br, corners.bl];
        // Map output pixels back into the source image
        const H = solveHomography(rect, quad);
        if (!H) return null;
        const out = new Uint8ClampedArray(outW * outH * 4);
        const px = [0, 0, 0, 0];
        for (let y = 0; y < outH; y++) {
            for (let x = 0; x < outW; x++) {
                const p = applyHomography(H, x, y);
                sampleBilinear(img, p.x, p.y, px);
                const o = (y * outW + x) * 4;
                out[o] = px[0]; out[o + 1] = px[1]; out[o + 2] = px[2]; out[o + 3] = px[3];
            }
        }
        return { width: outW, height: outH, data: out };
    }

    // ---- Canvas helpers (the only functions that need a browser) ----

    // Scales a canvas down so its longer side is at most maxDim; returns the same canvas when already small
    function downscaleCanvas(canvas, maxDim) {
        if (canvas.width <= maxDim && canvas.height <= maxDim) return { canvas, scale: 1 };
        const scale = Math.min(maxDim / canvas.width, maxDim / canvas.height);
        const out = document.createElement('canvas');
        out.width = Math.max(1, Math.round(canvas.width * scale));
        out.height = Math.max(1, Math.round(canvas.height * scale));
        const ctx = out.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(canvas, 0, 0, out.width, out.height);
        return { canvas: out, scale };
    }

    // Warps a canvas through four corners into a new canvas
    function warpPerspective(canvas, corners, outW, outH) {
        const data = warpPerspectiveData(canvasToImageData(canvas), corners, outW, outH);
        if (!data) return null;
        const out = document.createElement('canvas');
        out.width = outW;
        out.height = outH;
        out.getContext('2d').putImageData(new ImageData(data.data, outW, outH), 0, 0);
        return out;
    }

    // Draws a gray image onto a new canvas, enlarged by `scale` with smooth interpolation
    function grayToCanvas(gray, scale) {
        const base = document.createElement('canvas');
        base.width = gray.width;
        base.height = gray.height;
        const rgba = new Uint8ClampedArray(gray.width * gray.height * 4);
        for (let i = 0, p = 0; i < gray.data.length; i++, p += 4) {
            rgba[p] = rgba[p + 1] = rgba[p + 2] = gray.data[i];
            rgba[p + 3] = 255;
        }
        base.getContext('2d').putImageData(new ImageData(rgba, gray.width, gray.height), 0, 0);
        if (!scale || scale === 1) return base;
        const out = document.createElement('canvas');
        out.width = Math.max(1, Math.round(gray.width * scale));
        out.height = Math.max(1, Math.round(gray.height * scale));
        const ctx = out.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(base, 0, 0, out.width, out.height);
        return out;
    }

    return {
        VERSION: IMAGING_VERSION,
        canvasToImageData, grayFromRGBA, invert, cropGray,
        gaussianKernel, gaussianBlur, medianBlur,
        otsuThreshold, threshold, adaptiveThreshold, morphology,
        connectedComponents, hsvMask,
        solveHomography, applyHomography, warpPerspectiveData,
        downscaleCanvas, warpPerspective, grayToCanvas
    };
})();
