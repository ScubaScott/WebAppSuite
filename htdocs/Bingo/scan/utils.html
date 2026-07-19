async function autoCrop(canvas) {
    return new Promise(resolve => {
        const src = cv.imread(canvas);
        const gray = new cv.Mat();
        const blur = new cv.Mat();
        const edges = new cv.Mat();

        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
        cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
        cv.Canny(blur, edges, 75, 200);

        // Find contours
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
                    biggest = approx;
                }
            }
        }

        if (!biggest) {
            resolve(canvas); // fallback
            return;
        }

        // Perspective warp
        const pts = [];
        for (let i = 0; i < 4; i++) {
            pts.push({
                x: biggest.intPtr(i, 0)[0],
                y: biggest.intPtr(i, 0)[1]
            });
        }

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

        const outCanvas = document.createElement("canvas");
        cv.imshow(outCanvas, dst);

        resolve(outCanvas);

        src.delete(); gray.delete(); blur.delete(); edges.delete();
        contours.delete(); hierarchy.delete(); biggest.delete();
        srcTri.delete(); dstTri.delete(); M.delete(); dst.delete();
    });
}

function orderPoints(pts) {
    pts.sort((a, b) => a.x + a.y - (b.x + b.y));
    const tl = pts[0];
    const br = pts[3];

    pts.sort((a, b) => a.x - b.x);
    const bl = pts[0] === tl ? pts[1] : pts[0];
    const tr = pts[3] === br ? pts[2] : pts[3];

    return { tl, tr, br, bl };
}