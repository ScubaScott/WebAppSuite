async function runOCR(canvas) {
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;

    // Bingo cards are 5x5 grid
    const cellW = w / 5;
    const cellH = h / 5;

    const grid = [];

    for (let row = 0; row < 5; row++) {
        const rowData = [];

        for (let col = 0; col < 5; col++) {
            const cellCanvas = document.createElement("canvas");
            cellCanvas.width = cellW;
            cellCanvas.height = cellH;

            const cellCtx = cellCanvas.getContext("2d");

            // Extract cell
            cellCtx.drawImage(
                canvas,
                col * cellW, row * cellH, cellW, cellH,
                0, 0, cellW, cellH
            );

            // Preprocess cell
            const processed = preprocessCell(cellCanvas);

            // OCR the cell
            const { data } = await Tesseract.recognize(processed, 'eng', {
                tessedit_char_whitelist: '0123456789',
                tessedit_pageseg_mode: 10
            });

            const num = extractNumber(data.text);
            rowData.push(num);
        }

        grid.push(rowData);
    }

    return grid;
}

function preprocessCell(cellCanvas) {
    // Convert to OpenCV Mat
    let src = cv.imread(cellCanvas);
    let gray = new cv.Mat();
    let thresh = new cv.Mat();

    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.threshold(gray, thresh, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);

    const outCanvas = document.createElement("canvas");
    cv.imshow(outCanvas, thresh);

    src.delete();
    gray.delete();
    thresh.delete();

    return outCanvas;
}

function extractNumber(text) {
    const match = text.match(/\d+/);
    return match ? parseInt(match[0]) : null;
}
