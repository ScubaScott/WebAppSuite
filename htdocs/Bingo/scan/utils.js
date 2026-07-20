// Auto-crop the largest visible quadrilateral in the image so the bingo card fills the preview.
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
                    biggest = approx;
                }
            }
        }

        // If no card-like contour is found, keep the original image.
        if (!biggest) {
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

        const outCanvas = document.createElement("canvas");
        cv.imshow(outCanvas, dst);

        resolve(outCanvas);

        // Clean up the temporary OpenCV objects.
        src.delete(); gray.delete(); blur.delete(); edges.delete();
        contours.delete(); hierarchy.delete(); biggest.delete();
        srcTri.delete(); dstTri.delete(); M.delete(); dst.delete();
    });
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