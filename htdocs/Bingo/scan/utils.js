// Auto-crop the 5x5 bingo grid (supporting slider cards without outer borders as well as paper cards),
// then warp/crop to isolate the 25 number cells cleanly.
async function autoCrop(canvas) {
    return new Promise(resolve => {
        const src = cv.imread(canvas);

        // Primary approach: Detect the 5x5 grid by looking directly for the 25 cell boxes/frames.
        // This is ideal for bar bingo slider cards (shutter cards) which lack a prominent outer border.
        const gridInfo = detectCellGrid(src);
        if (gridInfo) {
            const { corners } = gridInfo;
            const width = 600;
            const height = 600;

            const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
                corners.tl.x, corners.tl.y,
                corners.tr.x, corners.tr.y,
                corners.br.x, corners.br.y,
                corners.bl.x, corners.bl.y
            ]);

            const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
                0, 0,
                width, 0,
                width, height,
                0, height
            ]);

            const M = cv.getPerspectiveTransform(srcTri, dstTri);
            const dst = new cv.Mat();
            cv.warpPerspective(src, dst, M, new cv.Size(width, height));

            const gridCanvas = document.createElement("canvas");
            cv.imshow(gridCanvas, dst);

            src.delete(); srcTri.delete(); dstTri.delete(); M.delete(); dst.delete();
            resolve(gridCanvas);
            return;
        }

        // Secondary approach: Fall back to detecting the largest outer 4-sided card contour.
        const gray = new cv.Mat();
        const blur = new cv.Mat();
        const edges = new cv.Mat();

        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
        cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
        cv.Canny(blur, edges, 75, 200);

        const contours = new cv.MatVector();
        const hierarchy = new cv.Mat();
        cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

        let biggest = null;
        let maxArea = 0;

        for (let i = 0; i < contours.size(); i++) {
            const cnt = contours.get(i);
            const peri = cv.arcLength(cnt, true);
            const approx = new cv.Mat();
            cv.approxPolyDP(cnt, approx, 0.02 * peri, true);

            if (approx.rows === 4) {
                const area = cv.contourArea(cnt);
                if (area > maxArea) {
                    maxArea = area;
                    if (biggest) biggest.delete();
                    biggest = approx;
                } else {
                    approx.delete();
                }
            } else {
                approx.delete();
            }
            cnt.delete();
        }

        gray.delete(); blur.delete(); edges.delete(); contours.delete(); hierarchy.delete();

        if (!biggest) {
            src.delete();
            resolve(canvas);
            return;
        }

        const pts = [];
        for (let i = 0; i < 4; i++) {
            pts.push({
                x: biggest.intPtr(i, 0)[0],
                y: biggest.intPtr(i, 0)[1]
            });
        }
        biggest.delete();

        const ordered = orderPoints(pts);
        const width = 600;
        const height = 800;

        const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
            ordered.tl.x, ordered.tl.y,
            ordered.tr.x, ordered.tr.y,
            ordered.br.x, ordered.br.y,
            ordered.bl.x, ordered.bl.y
        ]);

        const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
            0, 0,
            width, 0,
            width, height,
            0, height
        ]);

        const M = cv.getPerspectiveTransform(srcTri, dstTri);
        const dst = new cv.Mat();
        cv.warpPerspective(src, dst, M, new cv.Size(width, height));

        const warpedCanvas = document.createElement("canvas");
        cv.imshow(warpedCanvas, dst);

        src.delete(); srcTri.delete(); dstTri.delete(); M.delete(); dst.delete();

        const gridCanvas = cropToGrid(warpedCanvas);
        resolve(gridCanvas || warpedCanvas);
    });
}

// Detect the 5x5 bingo grid by finding the 25 individual cell boxes (or a cluster of cell boxes)
// directly in the image. Works on both standard paper cards and bar bingo slider cards
// where there is no defined outer card border.
function detectCellGrid(src) {
    const gray = new cv.Mat();
    const thresh = new cv.Mat();
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();

    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);

    // Adaptive thresholding brings out cell borders for both plastic slider frames and grid lines.
    cv.adaptiveThreshold(gray, thresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 11, 2);

    cv.findContours(thresh, contours, hierarchy, cv.RETR_TREE, cv.CHAIN_APPROX_SIMPLE);

    const totalArea = src.rows * src.cols;
    const candidates = [];

    for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i);
        const rect = cv.boundingRect(cnt);
        cnt.delete();

        const area = rect.width * rect.height;
        const aspect = rect.width / rect.height;

        // Filter for cell-like shapes: area between 0.15% and 15% of canvas, aspect ratio near 1.0.
        if (area >= totalArea * 0.0015 && area <= totalArea * 0.15 &&
            aspect >= 0.45 && aspect <= 2.2 &&
            rect.width >= 15 && rect.height >= 15) {
            candidates.push({
                x: rect.x,
                y: rect.y,
                w: rect.width,
                h: rect.height,
                area: area,
                cx: rect.x + rect.width / 2,
                cy: rect.y + rect.height / 2
            });
        }
    }

    gray.delete();
    thresh.delete();
    contours.delete();
    hierarchy.delete();

    if (candidates.length < 8) {
        return null;
    }

    // Sort candidate boxes by area to cluster boxes of similar size (the 25 cell frames).
    candidates.sort((a, b) => a.area - b.area);
    const medianArea = candidates[Math.floor(candidates.length / 2)].area;

    // Keep candidates whose area is within 0.35x to 2.5x of the median cell area.
    const gridBoxes = candidates.filter(b => b.area >= medianArea * 0.35 && b.area <= medianArea * 2.5);

    if (gridBoxes.length < 8) {
        return null;
    }

    // Find extreme corners from all detected grid cell boxes.
    let minX = src.cols, minY = src.rows, maxX = 0, maxY = 0;
    let tlBox = gridBoxes[0], brBox = gridBoxes[0], trBox = gridBoxes[0], blBox = gridBoxes[0];
    let minSum = Infinity, maxSum = -Infinity, minDiff = Infinity, maxDiff = -Infinity;

    for (const b of gridBoxes) {
        if (b.x < minX) minX = b.x;
        if (b.y < minY) minY = b.y;
        if (b.x + b.w > maxX) maxX = b.x + b.w;
        if (b.y + b.h > maxY) maxY = b.y + b.h;

        const sum = b.cx + b.cy;
        const diff = b.cx - b.cy;

        if (sum < minSum) { minSum = sum; tlBox = b; }
        if (sum > maxSum) { maxSum = sum; brBox = b; }
        if (diff > maxDiff) { maxDiff = diff; trBox = b; }
        if (diff < minDiff) { minDiff = diff; blBox = b; }
    }

    const gridW = maxX - minX;
    const gridH = maxY - minY;

    // Must span a reasonable portion of the canvas to be a real 5x5 bingo grid.
    if (gridW < src.cols * 0.25 || gridH < src.rows * 0.25) {
        return null;
    }

    // Add a slight margin (2% padding) around extreme cell box edges so edge numbers aren't clipped.
    const padW = gridW * 0.02;
    const padH = gridH * 0.02;

    const corners = {
        tl: { x: Math.max(0, tlBox.x - padW), y: Math.max(0, tlBox.y - padH) },
        tr: { x: Math.min(src.cols, trBox.x + trBox.w + padW), y: Math.max(0, trBox.y - padH) },
        br: { x: Math.min(src.cols, brBox.x + brBox.w + padW), y: Math.min(src.rows, brBox.y + brBox.h + padH) },
        bl: { x: Math.max(0, blBox.x - padW), y: Math.min(src.rows, blBox.y + blBox.h + padH) }
    };

    return { corners };
}

// Crop a front-on card image down to just the number grid, excluding any surrounding
// header text, colored borders, or footer text. Most bingo cards use a light, low-saturation
// grid background against a more saturated (often colored) border/header, so this scans for
// the region where pixels are consistently low-saturation across most of each row/column.
function cropToGrid(canvas) {
    const src = cv.imread(canvas);
    const rgb = new cv.Mat();
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);

    const channels = new cv.MatVector();
    cv.split(rgb, channels);
    const r = channels.get(0);
    const g = channels.get(1);
    const b = channels.get(2);

    // True HSV saturation: (max-min)/max, scaled to 0-255. Low-saturation (grayish/tan)
    // pixels belong to the grid; high-saturation pixels belong to a colored border, header,
    // or footer. Using the normalized ratio (rather than the raw max-min difference) keeps
    // this threshold stable across different lighting/exposure conditions.
    const maxc = new cv.Mat();
    cv.max(r, g, maxc);
    cv.max(maxc, b, maxc);

    const minc = new cv.Mat();
    cv.min(r, g, minc);
    cv.min(minc, b, minc);

    const diff = new cv.Mat();
    cv.subtract(maxc, minc, diff);

    const maxcFloat = new cv.Mat();
    maxc.convertTo(maxcFloat, cv.CV_32F);
    const diffFloat = new cv.Mat();
    diff.convertTo(diffFloat, cv.CV_32F);

    // Avoid divide-by-zero on pure black pixels by adding a tiny epsilon.
    const maxcSafe = new cv.Mat();
    cv.add(maxcFloat, new cv.Mat(maxcFloat.rows, maxcFloat.cols, maxcFloat.type(), new cv.Scalar(1)), maxcSafe);

    const satFloat = new cv.Mat();
    cv.divide(diffFloat, maxcSafe, satFloat, 255);

    const sat = new cv.Mat();
    satFloat.convertTo(sat, cv.CV_8U);

    maxcFloat.delete(); diffFloat.delete(); maxcSafe.delete(); satFloat.delete();

    const mask = new cv.Mat();
    const SAT_THRESHOLD = 90;
    cv.threshold(sat, mask, SAT_THRESHOLD, 255, cv.THRESH_BINARY_INV);
    sat.delete();

    // Average the mask along each axis to get, per row/column, what fraction of
    // pixels look like grid background versus border/header/footer.
    const rowProfile = new cv.Mat();
    const colProfile = new cv.Mat();
    cv.reduce(mask, rowProfile, 1, cv.REDUCE_AVG, -1);
    cv.reduce(mask, colProfile, 0, cv.REDUCE_AVG, -1);

    const rowData = rowProfile.data;
    const colData = colProfile.data;
    const FRACTION_THRESHOLD = 255 * 0.5;

    let top = -1, bottom = -1, left = -1, right = -1;
    for (let i = 0; i < rowData.length; i++) {
        if (rowData[i] > FRACTION_THRESHOLD) { top = i; break; }
    }
    for (let i = rowData.length - 1; i >= 0; i--) {
        if (rowData[i] > FRACTION_THRESHOLD) { bottom = i; break; }
    }
    for (let i = 0; i < colData.length; i++) {
        if (colData[i] > FRACTION_THRESHOLD) { left = i; break; }
    }
    for (let i = colData.length - 1; i >= 0; i--) {
        if (colData[i] > FRACTION_THRESHOLD) { right = i; break; }
    }

    channels.delete();
    r.delete(); g.delete(); b.delete();
    maxc.delete(); minc.delete(); diff.delete(); mask.delete();
    rowProfile.delete(); colProfile.delete();
    rgb.delete();

    // (sat and its float intermediates were already deleted above)

    // Bail out and keep the full card if detection didn't find a sensible box.
    if (top < 0 || bottom <= top || left < 0 || right <= left) {
        src.delete();
        return null;
    }

    const rect = new cv.Rect(left, top, right - left + 1, bottom - top + 1);
    const roi = src.roi(rect);

    const outCanvas = document.createElement("canvas");
    cv.imshow(outCanvas, roi);

    src.delete();
    roi.delete();

    return outCanvas;
}

// Order four corner points so they map to top-left, top-right, bottom-right, and bottom-left.
function orderPoints(pts) {
    pts.sort((a, b) => a.x + a.y - (b.x + b.y));
    const tl = pts[0];
    const br = pts[3];

    pts.sort((a, b) => a.x - b.x);
    const bl = pts[0] === tl ? pts[1] : pts[0];
    const tr = pts[3] === br ? pts[2] : pts[3];

    return { tl, tr, br, bl };
}