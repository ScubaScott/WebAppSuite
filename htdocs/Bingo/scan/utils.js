// Scanner utility functions version identifier
const VERSION = '1.0';

// Helper: Rotate canvas by 90 degrees (clockwise or counter-clockwise)
function rotateCanvas90(sourceCanvas, clockwise = true) {
    const dst = document.createElement("canvas");
    dst.width = sourceCanvas.height;
    dst.height = sourceCanvas.width;
    const ctx = dst.getContext("2d");

    if (clockwise) {
        ctx.translate(dst.width, 0);
        ctx.rotate(Math.PI / 2);
    } else {
        ctx.translate(0, dst.height);
        ctx.rotate(-Math.PI / 2);
    }

    ctx.drawImage(sourceCanvas, 0, 0);
    return dst;
}

// Warp 4 corner points into a 600x600 square canvas
function warpCorners(canvas, corners) {
    if (typeof cv !== "undefined" && canvas.width && canvas.height) {
        try {
            const src = cv.imread(canvas);
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

            const resultCanvas = document.createElement("canvas");
            cv.imshow(resultCanvas, dst);

            src.delete(); srcTri.delete(); dstTri.delete(); M.delete(); dst.delete();
            return resultCanvas;
        } catch (err) {
            console.warn("OpenCV warpCorners failed, using fallback:", err);
        }
    }

    // 2D canvas bounding box fallback
    const minX = Math.max(0, Math.min(corners.tl.x, corners.bl.x));
    const minY = Math.max(0, Math.min(corners.tl.y, corners.tr.y));
    const maxX = Math.min(canvas.width, Math.max(corners.tr.x, corners.br.x));
    const maxY = Math.min(canvas.height, Math.max(corners.bl.y, corners.br.y));
    const cropW = Math.max(1, maxX - minX);
    const cropH = Math.max(1, maxY - minY);

    const resultCanvas = document.createElement("canvas");
    resultCanvas.width = 600;
    resultCanvas.height = 600;
    const ctx = resultCanvas.getContext("2d");
    ctx.drawImage(canvas, minX, minY, cropW, cropH, 0, 0, 600, 600);
    return resultCanvas;
}

// Auto-crop the 5x5 bingo grid (supporting slider cards, wooden shutter cards, and paper cards),
// then warp/crop to isolate the 25 number cells cleanly.
async function autoCrop(canvas) {
    return new Promise(resolve => {
        if (typeof cv === "undefined") {
            resolve(canvas);
            return;
        }

        // Downscale high-resolution images to max 1000px for OpenCV feature detection to improve speed & accuracy
        const maxDim = 1000;
        let scale = 1.0;
        let detectCanvas = canvas;

        if (canvas.width > maxDim || canvas.height > maxDim) {
            scale = Math.min(maxDim / canvas.width, maxDim / canvas.height);
            detectCanvas = document.createElement("canvas");
            detectCanvas.width = Math.round(canvas.width * scale);
            detectCanvas.height = Math.round(canvas.height * scale);
            const ctx = detectCanvas.getContext("2d");
            ctx.drawImage(canvas, 0, 0, detectCanvas.width, detectCanvas.height);
        }

        const src = cv.imread(detectCanvas);

        // 1. Try slider shutter tab detection
        // 2. Try individual cell frame box detection
        // 3. Try wooden/card outer quad contour detection
        const gridInfo = detectSliderTabGrid(src) || detectCellGrid(src) || detectOuterCardContour(src);

        if (gridInfo && gridInfo.corners) {
            // Map corner coordinates back to original full-resolution canvas space
            const origCorners = {
                tl: { x: Math.round(gridInfo.corners.tl.x / scale), y: Math.round(gridInfo.corners.tl.y / scale) },
                tr: { x: Math.round(gridInfo.corners.tr.x / scale), y: Math.round(gridInfo.corners.tr.y / scale) },
                br: { x: Math.round(gridInfo.corners.br.x / scale), y: Math.round(gridInfo.corners.br.y / scale) },
                bl: { x: Math.round(gridInfo.corners.bl.x / scale), y: Math.round(gridInfo.corners.bl.y / scale) }
            };

            const gridCanvas = warpCorners(canvas, origCorners);
            gridCanvas.corners = origCorners;
            src.delete();
            resolve(gridCanvas);
            return;
        }

        src.delete();

        // Fallback: Default to framing central 85% of image
        const origW = canvas.width;
        const origH = canvas.height;
        const defaultCorners = {
            tl: { x: Math.round(origW * 0.075), y: Math.round(origH * 0.075) },
            tr: { x: Math.round(origW * 0.925), y: Math.round(origH * 0.075) },
            br: { x: Math.round(origW * 0.925), y: Math.round(origH * 0.925) },
            bl: { x: Math.round(origW * 0.075), y: Math.round(origH * 0.925) }
        };

        const gridCanvas = warpCorners(canvas, defaultCorners);
        gridCanvas.corners = defaultCorners;
        resolve(gridCanvas);
    });
}

// Detect 5x5 grid on slider shutter cards by finding the red plastic sliding tabs.
// Works for upright and sideways/landscape oriented cards.
function detectSliderTabGrid(src) {
    const rgb = new cv.Mat();
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    const hsv = new cv.Mat();
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    rgb.delete();

    // Red HSV ranges (expanded to account for varied lighting conditions)
    const low1 = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), new cv.Scalar(0, 40, 40, 0));
    const high1 = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), new cv.Scalar(20, 255, 255, 255));
    const low2 = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), new cv.Scalar(150, 40, 40, 0));
    const high2 = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), new cv.Scalar(180, 255, 255, 255));

    const mask1 = new cv.Mat();
    const mask2 = new cv.Mat();
    cv.inRange(hsv, low1, high1, mask1);
    cv.inRange(hsv, low2, high2, mask2);
    const tabMask = new cv.Mat();
    cv.bitwise_or(mask1, mask2, tabMask);

    hsv.delete(); low1.delete(); high1.delete(); low2.delete(); high2.delete();
    mask1.delete(); mask2.delete();

    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(tabMask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    tabMask.delete();
    hierarchy.delete();

    const totalArea = src.rows * src.cols;
    const candidates = [];

    for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i);
        const rect = cv.boundingRect(cnt);
        cnt.delete();

        const area = rect.width * rect.height;
        const aspect = rect.width / rect.height;

        // Allow both upright tabs (aspect <= 0.9) and sideways tabs (aspect >= 1.1)
        if (area >= totalArea * 0.00015 && area <= totalArea * 0.015 &&
            ((aspect >= 0.08 && aspect <= 0.9) || (aspect >= 1.1 && aspect <= 12.0)) &&
            (rect.height >= 8 || rect.width >= 8)) {
            candidates.push({
                x: rect.x, y: rect.y, w: rect.width, h: rect.height,
                cx: rect.x + rect.width / 2, cy: rect.y + rect.height / 2
            });
        }
    }
    contours.delete();

    if (candidates.length < 10) {
        return null;
    }

    // Cluster candidate centers into grid bounds
    let minX = src.cols, minY = src.rows, maxX = 0, maxY = 0;
    for (const c of candidates) {
        if (c.x < minX) minX = c.x;
        if (c.y < minY) minY = c.y;
        if (c.x + c.w > maxX) maxX = c.x + c.w;
        if (c.y + c.h > maxY) maxY = c.y + c.h;
    }

    const spanW = maxX - minX;
    const spanH = maxY - minY;

    if (spanW < src.cols * 0.2 || spanH < src.rows * 0.2) {
        return null;
    }

    // Expand bounding box slightly to encompass the cell windows adjacent to tabs
    const padW = spanW * 0.06;
    const padH = spanH * 0.06;

    let leftX = Math.max(0, minX - padW);
    let topY = Math.max(0, minY - padH);
    let rightX = Math.min(src.cols, maxX + padW);
    let bottomY = Math.min(src.rows, maxY + padH);

    return {
        corners: {
            tl: { x: leftX, y: topY },
            tr: { x: rightX, y: topY },
            br: { x: rightX, y: bottomY },
            bl: { x: leftX, y: bottomY }
        }
    };
}

// Detect cell boxes using adaptive thresholding and contour hierarchy
function detectCellGrid(src) {
    const gray = new cv.Mat();
    const thresh = new cv.Mat();
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();

    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    cv.adaptiveThreshold(gray, thresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 15, 2);

    cv.findContours(thresh, contours, hierarchy, cv.RETR_TREE, cv.CHAIN_APPROX_SIMPLE);

    const totalArea = src.rows * src.cols;
    const candidates = [];

    for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i);
        const rect = cv.boundingRect(cnt);
        cnt.delete();

        const area = rect.width * rect.height;
        const aspect = rect.width / rect.height;

        if (area >= totalArea * 0.001 && area <= totalArea * 0.15 &&
            aspect >= 0.4 && aspect <= 2.5 &&
            rect.width >= 12 && rect.height >= 12) {
            candidates.push({
                x: rect.x, y: rect.y, w: rect.width, h: rect.height, area: area,
                cx: rect.x + rect.width / 2, cy: rect.y + rect.height / 2
            });
        }
    }

    gray.delete(); thresh.delete(); contours.delete(); hierarchy.delete();

    if (candidates.length < 8) return null;

    candidates.sort((a, b) => a.area - b.area);
    const medianArea = candidates[Math.floor(candidates.length / 2)].area;
    const gridBoxes = candidates.filter(b => b.area >= medianArea * 0.3 && b.area <= medianArea * 3.0);

    if (gridBoxes.length < 6) return null;

    let minX = src.cols, minY = src.rows, maxX = 0, maxY = 0;
    for (const b of gridBoxes) {
        if (b.x < minX) minX = b.x;
        if (b.y < minY) minY = b.y;
        if (b.x + b.w > maxX) maxX = b.x + b.w;
        if (b.y + b.h > maxY) maxY = b.y + b.h;
    }

    const gridW = maxX - minX;
    const gridH = maxY - minY;

    if (gridW < src.cols * 0.25 || gridH < src.rows * 0.25) return null;

    const padW = gridW * 0.03;
    const padH = gridH * 0.03;

    return {
        corners: {
            tl: { x: Math.max(0, minX - padW), y: Math.max(0, minY - padH) },
            tr: { x: Math.min(src.cols, maxX + padW), y: Math.max(0, minY - padH) },
            br: { x: Math.min(src.cols, maxX + padW), y: Math.min(src.rows, maxY + padH) },
            bl: { x: Math.max(0, minX - padW), y: Math.min(src.rows, maxY + padH) }
        }
    };
}

// Outer card contour detector (for wooden or paper cards on contrasting surface)
function detectOuterCardContour(src) {
    const gray = new cv.Mat();
    const blur = new cv.Mat();
    const edges = new cv.Mat();

    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
    cv.Canny(blur, edges, 50, 150);

    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    let biggest = null;
    let maxArea = 0;
    const totalArea = src.rows * src.cols;

    for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i);
        const area = cv.contourArea(cnt);
        if (area > totalArea * 0.15 && area > maxArea) {
            const peri = cv.arcLength(cnt, true);
            const approx = new cv.Mat();
            cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
            if (approx.rows === 4) {
                maxArea = area;
                if (biggest) biggest.delete();
                biggest = approx;
            } else {
                approx.delete();
            }
        }
        cnt.delete();
    }

    gray.delete(); blur.delete(); edges.delete(); contours.delete(); hierarchy.delete();

    if (!biggest) return null;

    const pts = [];
    for (let i = 0; i < 4; i++) {
        pts.push({
            x: biggest.intPtr(i, 0)[0],
            y: biggest.intPtr(i, 0)[1]
        });
    }
    biggest.delete();

    const ordered = orderPoints(pts);

    // If this is a wooden card with a side header, trim the outer border slightly to focus on central grid
    const minX = ordered.tl.x;
    const maxX = ordered.tr.x;
    const minY = ordered.tl.y;
    const maxY = ordered.bl.y;

    const w = maxX - minX;
    const h = maxY - minY;

    return {
        corners: {
            tl: { x: Math.round(minX + w * 0.08), y: Math.round(minY + h * 0.08) },
            tr: { x: Math.round(maxX - w * 0.08), y: Math.round(minY + h * 0.08) },
            br: { x: Math.round(maxX - w * 0.08), y: Math.round(maxY - h * 0.08) },
            bl: { x: Math.round(minX + w * 0.08), y: Math.round(maxY - h * 0.08) }
        }
    };
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