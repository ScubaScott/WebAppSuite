// Auto-crop the largest visible quadrilateral in the image so the bingo card fills the preview,
// then crop again to isolate just the number grid (excluding any header, border, or footer text).
async function autoCrop(canvas) {
    return new Promise(resolve => {
        // Read the current canvas into an OpenCV matrix.
        const src = cv.imread(canvas);
        const gray = new cv.Mat();
        const blur = new cv.Mat();
        const edges = new cv.Mat();

        // Convert the image to grayscale so edge detection can work reliably.
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
        cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);

        // Detect strong edges around the card border.
        cv.Canny(blur, edges, 75, 200);

        // Find contours in the edge image and keep the largest quadrilateral.
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

            // Only keep contours that look like a rectangle or four-sided shape.
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

        // Clean up detection-stage Mats now that we're done with them.
        gray.delete();
        blur.delete();
        edges.delete();
        contours.delete();
        hierarchy.delete();

        // If no card-like contour is found, keep the original image.
        if (!biggest) {
            src.delete();
            resolve(canvas);
            return;
        }

        // Convert the contour points into a simple list of corners.
        const pts = [];
        for (let i = 0; i < 4; i++) {
            pts.push({
                x: biggest.intPtr(i, 0)[0],
                y: biggest.intPtr(i, 0)[1]
            });
        }
        biggest.delete();

        // Sort the corners so the perspective transform is applied in a consistent order.
        const ordered = orderPoints(pts);

        const width = 600;
        const height = 800;

        // Create the source and destination points for a perspective transform.
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

        // Warp the card so it appears front-on and rectangular.
        const M = cv.getPerspectiveTransform(srcTri, dstTri);
        const dst = new cv.Mat();
        cv.warpPerspective(src, dst, M, new cv.Size(width, height));

        const warpedCanvas = document.createElement("canvas");
        cv.imshow(warpedCanvas, dst);

        // Clean up the remaining temporary OpenCV objects.
        src.delete();
        srcTri.delete();
        dstTri.delete();
        M.delete();
        dst.delete();

        // The warped card still includes any header/title text, the colored border, and
        // any footer/credit text around the actual number grid. Crop again to isolate
        // just the grid itself so cell slicing lines up with real cells.
        const gridCanvas = cropToGrid(warpedCanvas);
        resolve(gridCanvas || warpedCanvas);
    });
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