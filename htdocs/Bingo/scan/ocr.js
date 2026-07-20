async function runOCR(canvas) {
    if (typeof cv === "undefined" || typeof Tesseract === "undefined") {
        return [];
    }

    const w = canvas.width;
    const h = canvas.height;
    const cellW = Math.max(1, w / 5);
    const cellH = Math.max(1, h / 5);
    const rowOffset = parseInt(document.getElementById("rowOffset").value, 10) || 0;
    const colOffset = parseInt(document.getElementById("colOffset").value, 10) || 0;

    const grid = [];

    for (let row = 0; row < 5; row++) {
        const rowData = [];

        for (let col = 0; col < 5; col++) {
            const sourceRow = Math.max(0, Math.min(4, row + rowOffset));
            const sourceCol = Math.max(0, Math.min(4, col + colOffset));

            const cellCanvas = document.createElement("canvas");
            cellCanvas.width = cellW;
            cellCanvas.height = cellH;

            const cellCtx = cellCanvas.getContext("2d");

            cellCtx.drawImage(
                canvas,
                sourceCol * cellW, sourceRow * cellH, cellW, cellH,
                0, 0, cellW, cellH
            );

            const processed = preprocessCell(cellCanvas);
            const { data } = await Tesseract.recognize(processed, 'eng', {
                tessedit_char_whitelist: '0123456789',
                tessedit_pageseg_mode: getPageSegMode(),
                tessedit_ocr_engine_mode: getOcrEngineMode()
            });

            const num = extractNumber(data.text);
            rowData.push(num);
        }

        grid.push(rowData);
    }

    return grid;
}

function preprocessCell(cellCanvas) {
    if (typeof cv === "undefined") {
        return cellCanvas;
    }

    const threshMode = document.getElementById("threshMode").value;
    const blurMode = document.getElementById("blurMode").value;
    const zoomFactor = parseInt(document.getElementById("zoomFactor").value, 10) || 2;
    const invertColors = document.getElementById("invertColors").checked;
    const morphMode = document.getElementById("morphMode").value;
    const binaryThreshold = parseInt(document.getElementById("binaryThreshold").value, 10) || 127;
    const adaptiveBlockSize = parseInt(document.getElementById("adaptiveBlockSize").value, 10) || 11;
    const adaptiveC = parseInt(document.getElementById("adaptiveC").value, 10) || 2;

    let src = cv.imread(cellCanvas);
    let gray = new cv.Mat();
    let blur = new cv.Mat();
    let thresh = new cv.Mat();
    let morph = new cv.Mat();

    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    if (invertColors) {
        cv.bitwise_not(gray, gray);
    }

    if (blurMode === "gaussian") {
        cv.GaussianBlur(gray, blur, new cv.Size(3, 3), 0);
    } else if (blurMode === "median") {
        cv.medianBlur(gray, blur, 5);
    } else {
        blur = gray.clone();
    }

    if (threshMode === "otsu") {
        cv.threshold(blur, thresh, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    } else if (threshMode === "binary") {
        cv.threshold(blur, thresh, binaryThreshold, 255, cv.THRESH_BINARY);
    } else if (threshMode === "adaptive") {
        const blockSize = Math.max(3, Math.min(31, adaptiveBlockSize + (adaptiveBlockSize % 2 === 0 ? 1 : 0)));
        cv.adaptiveThreshold(blur, thresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, blockSize, adaptiveC);
    }

    if (morphMode === "dilate") {
        const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2, 2));
        cv.dilate(thresh, morph, kernel);
        thresh.delete();
        thresh = morph;
        morph = new cv.Mat();
        kernel.delete();
    } else if (morphMode === "erode") {
        const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2, 2));
        cv.erode(thresh, morph, kernel);
        thresh.delete();
        thresh = morph;
        morph = new cv.Mat();
        kernel.delete();
    } else if (morphMode === "open") {
        const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2, 2));
        cv.morphologyEx(thresh, morph, cv.MORPH_OPEN, kernel);
        thresh.delete();
        thresh = morph;
        morph = new cv.Mat();
        kernel.delete();
    } else if (morphMode === "close") {
        const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2, 2));
        cv.morphologyEx(thresh, morph, cv.MORPH_CLOSE, kernel);
        thresh.delete();
        thresh = morph;
        morph = new cv.Mat();
        kernel.delete();
    }

    let zoomed = new cv.Mat();
    cv.resize(thresh, zoomed, new cv.Size(thresh.cols * zoomFactor, thresh.rows * zoomFactor));

    const outCanvas = document.createElement("canvas");
    cv.imshow(outCanvas, zoomed);

    src.delete();
    gray.delete();
    blur.delete();
    thresh.delete();
    morph.delete();
    zoomed.delete();

    return outCanvas;
}

function getPageSegMode() {
    const mode = document.getElementById("pageSegMode").value;
    switch (mode) {
        case "single_block": return 6;
        case "single_line": return 7;
        case "single_word": return 8;
        case "single_char": return 10;
        default: return 3;
    }
}

function getOcrEngineMode() {
    const mode = document.getElementById("ocrEngineMode").value;
    switch (mode) {
        case "legacy": return 1;
        case "lstm": return 2;
        default: return 3;
    }
}

function extractNumber(text) {
    const match = text.match(/\d+/);
    return match ? parseInt(match[0]) : null;
}

function drawBingoGrid(grid) {
    const container = document.getElementById("bingoOutput");
    container.innerHTML = "";

    const table = document.createElement("table");
    table.style.borderCollapse = "collapse";

    for (let r = 0; r < 5; r++) {
        const tr = document.createElement("tr");

        for (let c = 0; c < 5; c++) {
            const td = document.createElement("td");
            td.style.border = "1px solid #333";
            td.style.padding = "10px";
            td.style.fontSize = "20px";
            td.style.textAlign = "center";

            td.textContent = grid[r][c] ?? "?";

            tr.appendChild(td);
        }

        table.appendChild(tr);
    }

    container.appendChild(table);
}
