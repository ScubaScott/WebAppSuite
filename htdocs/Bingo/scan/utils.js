// Scanner utility functions version identifier
const UTILS_VERSION = '1.1';

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

// Warp 4 corner points into a 600x600 square canvas (imaging.js perspective transform)
function warpCorners(canvas, corners) {
    if (canvas.width && canvas.height) {
        try {
            const warped = Imaging.warpPerspective(canvas, corners, 600, 600);
            if (warped) return warped;
        } catch (err) {
            console.warn("Perspective warp failed, using fallback:", err);
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
    // Detection runs on a copy limited to 1000px on its longer side for speed and stability
    const maxDim = 1000;
    const { canvas: detectCanvas, scale } = Imaging.downscaleCanvas(canvas, maxDim);
    const src = Imaging.canvasToImageData(detectCanvas);

    // 1. Try slider shutter tab detection
    // 2. Try individual cell frame box detection
    // 3. Try wooden/card outer quad detection
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
        return gridCanvas;
    }

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
    return gridCanvas;
}

// Detect 5x5 grid on slider shutter cards by finding the red plastic sliding tabs.
// Works for upright and sideways/landscape oriented cards. `src` is RGBA ImageData.
function detectSliderTabGrid(src) {
    // Red hue ranges (HSV, hue 0-180), widened to account for varied lighting conditions
    const tabMask = Imaging.hsvMask(src, [
        [0, 40, 40, 20, 255, 255],
        [150, 40, 40, 180, 255, 255]
    ]);

    // Each connected group of red pixels is a candidate tab; its bounding box is its outline
    const blobs = Imaging.connectedComponents(tabMask, { fg: 255, connectivity: 8 });

    const totalArea = src.height * src.width;
    const candidates = [];

    for (const rect of blobs) {
        const area = rect.w * rect.h;
        const aspect = rect.w / rect.h;

        // Allow both upright tabs (aspect <= 0.9) and sideways tabs (aspect >= 1.1)
        if (area >= totalArea * 0.00015 && area <= totalArea * 0.015 &&
            ((aspect >= 0.08 && aspect <= 0.9) || (aspect >= 1.1 && aspect <= 12.0)) &&
            (rect.h >= 8 || rect.w >= 8)) {
            candidates.push({
                x: rect.x, y: rect.y, w: rect.w, h: rect.h,
                cx: rect.x + rect.w / 2, cy: rect.y + rect.h / 2
            });
        }
    }

    if (candidates.length < 10) {
        return null;
    }

    // Cluster candidate centers into grid bounds
    let minX = src.width, minY = src.height, maxX = 0, maxY = 0;
    for (const c of candidates) {
        if (c.x < minX) minX = c.x;
        if (c.y < minY) minY = c.y;
        if (c.x + c.w > maxX) maxX = c.x + c.w;
        if (c.y + c.h > maxY) maxY = c.y + c.h;
    }

    const spanW = maxX - minX;
    const spanH = maxY - minY;

    if (spanW < src.width * 0.2 || spanH < src.height * 0.2) {
        return null;
    }

    // Expand bounding box slightly to encompass the cell windows adjacent to tabs
    const padW = spanW * 0.06;
    const padH = spanH * 0.06;

    let leftX = Math.max(0, minX - padW);
    let topY = Math.max(0, minY - padH);
    let rightX = Math.min(src.width, maxX + padW);
    let bottomY = Math.min(src.height, maxY + padH);

    return {
        corners: {
            tl: { x: leftX, y: topY },
            tr: { x: rightX, y: topY },
            br: { x: rightX, y: bottomY },
            bl: { x: leftX, y: bottomY }
        }
    };
}

// Detect cell boxes: ink lines found with a local threshold, then the outlines of both the ink
// groups and the enclosed (cell interior) regions are treated as candidate boxes.
function detectCellGrid(src) {
    let gray = Imaging.grayFromRGBA(src);
    gray = Imaging.gaussianBlur(gray, 5);
    const ink = Imaging.adaptiveThreshold(gray, { method: 'gaussian', blockSize: 15, c: 2, invert: true });

    const outlines = Imaging.connectedComponents(ink, { fg: 255, connectivity: 8 });
    const interiors = Imaging.connectedComponents(ink, { fg: 0, connectivity: 4 });

    const totalArea = src.height * src.width;
    const candidates = [];

    for (const rect of outlines.concat(interiors)) {
        const area = rect.w * rect.h;
        const aspect = rect.w / rect.h;

        if (area >= totalArea * 0.001 && area <= totalArea * 0.15 &&
            aspect >= 0.4 && aspect <= 2.5 &&
            rect.w >= 12 && rect.h >= 12) {
            candidates.push({
                x: rect.x, y: rect.y, w: rect.w, h: rect.h, area: area,
                cx: rect.x + rect.w / 2, cy: rect.y + rect.h / 2
            });
        }
    }

    if (candidates.length < 8) return null;

    candidates.sort((a, b) => a.area - b.area);
    const medianArea = candidates[Math.floor(candidates.length / 2)].area;
    const gridBoxes = candidates.filter(b => b.area >= medianArea * 0.3 && b.area <= medianArea * 3.0);

    if (gridBoxes.length < 6) return null;

    let minX = src.width, minY = src.height, maxX = 0, maxY = 0;
    for (const b of gridBoxes) {
        if (b.x < minX) minX = b.x;
        if (b.y < minY) minY = b.y;
        if (b.x + b.w > maxX) maxX = b.x + b.w;
        if (b.y + b.h > maxY) maxY = b.y + b.h;
    }

    const gridW = maxX - minX;
    const gridH = maxY - minY;

    if (gridW < src.width * 0.25 || gridH < src.height * 0.25) return null;

    const padW = gridW * 0.03;
    const padH = gridH * 0.03;

    return {
        corners: {
            tl: { x: Math.max(0, minX - padW), y: Math.max(0, minY - padH) },
            tr: { x: Math.min(src.width, maxX + padW), y: Math.max(0, minY - padH) },
            br: { x: Math.min(src.width, maxX + padW), y: Math.min(src.height, maxY + padH) },
            bl: { x: Math.max(0, minX - padW), y: Math.min(src.height, maxY + padH) }
        }
    };
}

// Outer card detector (for wooden or paper cards on a contrasting surface): splits the picture into
// bright and dark regions, takes the largest region that is not the whole picture, and uses its four
// extreme corner pixels as the card outline.
function detectOuterCardContour(src) {
    let gray = Imaging.grayFromRGBA(src);
    gray = Imaging.gaussianBlur(gray, 5);
    const binary = Imaging.threshold(gray, Imaging.otsuThreshold(gray));

    const totalArea = src.height * src.width;
    let best = null;

    // Try the bright side (255) and the dark side (0); the card may be either one
    for (const fg of [255, 0]) {
        for (const region of Imaging.connectedComponents(binary, { fg, connectivity: 8 })) {
            const boxArea = region.w * region.h;
            // The card covers a good part of the picture but a region spanning almost everything is background
            if (region.area > totalArea * 0.15 && boxArea < totalArea * 0.95 && (!best || region.area > best.area)) {
                best = region;
            }
        }
    }

    if (!best) return null;

    // Trim the outer border slightly to focus on the central grid
    const minX = best.tl.x;
    const maxX = best.tr.x;
    const minY = best.tl.y;
    const maxY = best.bl.y;

    const w = maxX - minX;
    const h = maxY - minY;
    if (w <= 0 || h <= 0) return null;

    return {
        corners: {
            tl: { x: Math.round(minX + w * 0.08), y: Math.round(minY + h * 0.08) },
            tr: { x: Math.round(maxX - w * 0.08), y: Math.round(minY + h * 0.08) },
            br: { x: Math.round(maxX - w * 0.08), y: Math.round(maxY - h * 0.08) },
            bl: { x: Math.round(minX + w * 0.08), y: Math.round(maxY - h * 0.08) }
        }
    };
}
