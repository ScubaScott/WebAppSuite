async function runOCR(canvas) {
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;

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

            cellCtx.drawImage(
                canvas,
                col * cellW, row * cellH, cellW, cellH,
                0, 0, cellW, cellH
            );

            const processed = preprocessCell(cellCanvas);

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
    const threshMode = document.getElementById("threshMode").value;
    const blurMode = document.getElementById("blurMode").value;
    const zoomFactor = parseInt(document.getElementById("zoomFactor").value);

    let src = cv.imread(cellCanvas);
    let gray = new cv.Mat();
    let blur = new cv.Mat();
    let thresh = new cv.Mat();

    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    if (blurMode === "gaussian") {
        cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
    } else if (blurMode === "median") {
        cv.medianBlur(gray, blur, 5);
    } else {
        blur = gray.clone();
    }

    if (threshMode === "otsu") {
        cv.threshold(blur, thresh, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    } else if (threshMode === "binary") {
        cv.threshold(blur, thresh, 128, 255, cv.THRESH_BINARY);
    } else if (threshMode === "adaptive") {
        cv.adaptiveThreshold(blur, thresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C,
                             cv.THRESH_BINARY, 11, 2);
    }

    let zoomed = new cv.Mat();
    cv.resize(thresh, zoomed, new cv.Size(thresh.cols * zoomFactor, thresh.rows * zoomFactor));

    const outCanvas = document.createElement("canvas");
    cv.imshow(outCanvas, zoomed);

    src.delete();
    gray.delete();
    blur.delete();
    thresh.delete();
    zoomed.delete();

    return outCanvas;
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
