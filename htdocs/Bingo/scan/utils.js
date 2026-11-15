// Scanner utility functions version identifier
const UTILS_VERSION = '1.2';

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

// Corner handle positions to start from when the windows could not be found: a centered square covering
// about the middle 60% of the picture's shorter side. The user drags these onto the four corner windows.
function defaultWindowCenters(width, height) {
    const cx = width / 2, cy = height / 2;
    const half = Math.min(width, height) * 0.3;
    return {
        tl: { x: Math.round(cx - half), y: Math.round(cy - half) },
        tr: { x: Math.round(cx + half), y: Math.round(cy - half) },
        br: { x: Math.round(cx + half), y: Math.round(cy + half) },
        bl: { x: Math.round(cx - half), y: Math.round(cy + half) }
    };
}

// Straightens a photo given the centers of the four corner number windows ({ tl, tr, br, bl } in photo pixels).
// The result is a 600x600 canvas on which the 25 cells fall on an exact 5x5 grid of equal squares.
function warpFromCenters(canvas, centers) {
    const grid = Geometry.fromCorners(centers);
    if (!grid.ok) return null;
    return Geometry.rectifiedGrid(canvas, grid, 600);
}

// Finds the 5x5 grid of number windows in a photo and straightens it into a 600x600 canvas.
// The returned canvas carries:
//   corners  - centers of the four corner windows (found, or default handle positions when detection failed)
//   geometry - the detection result (geometry.ok is false when the windows could not be found)
async function autoCrop(canvas) {
    const geometry = Geometry.analyze(canvas);
    const corners = geometry.ok ? Geometry.cornerCenters(geometry) : defaultWindowCenters(canvas.width, canvas.height);

    // When detection failed the picture is still straightened around the default handles so the preview shows something
    const grid = geometry.ok ? geometry : Geometry.fromCorners(corners);
    const gridCanvas = Geometry.rectifiedGrid(canvas, grid, 600);
    gridCanvas.corners = corners;
    gridCanvas.geometry = geometry;
    return gridCanvas;
}
