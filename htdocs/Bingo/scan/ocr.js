// Run Tesseract over every bingo cell and return a 5x5 grid of detected numbers.
async function runOCR(canvas) {
    // Stop early if the browser does not have OpenCV or Tesseract loaded.
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

    // Slice the cropped card into five rows and five columns.
    for (let row = 0; row < 5; row++) {
        const rowData = [];

        for (let col = 0; col < 5; col++) {
            // Allow a small row/column shift to correct for a card that is slightly misaligned.
            const sourceRow = Math.max(0, Math.min(4, row + rowOffset));
            const sourceCol = Math.max(0, Math.min(4, col + colOffset));

            const cellCanvas = document.createElement("canvas");
            cellCanvas.width = cellW;
            cellCanvas.height = cellH;

            const cellCtx = cellCanvas.getContext("2d");

            // Copy the selected portion of the card into a small cell canvas.
            cellCtx.drawImage(
                canvas,
                sourceCol * cellW, sourceRow * cellH, cellW, cellH,
                0, 0, cellW, cellH
            );

            // Prepare the cell image for OCR by converting it into a clean binary image.
            const processed = preprocessCell(cellCanvas);

            // Ask Tesseract to recognize only digits from the processed cell.
            const { data } = await Tesseract.recognize(processed, 'eng', {
                tessedit_char_whitelist: '0123456789',
                tessedit_pageseg_mode: getPageSegMode(),
                tessedit_ocr_engine_mode: getOcrEngineMode()
            });

            // Extract the first number found in the OCR text, if any.
            const num = extractNumber(data.text);
            rowData.push(num);
        }

        grid.push(rowData);
    }

    return grid;
}

// Convert a single bingo cell into a black-and-white (binary) image that is easier for OCR to read.
function preprocessCell(cellCanvas) {
    // If OpenCV is missing, fall back to the original canvas so the page still works.
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
    let binary = new cv.Mat();
    let morph = new cv.Mat();

    // Convert the image to grayscale first, because thresholding works best on a single-channel image.
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    // If the user wants dark text on a light background, invert the grayscale image before thresholding.
    if (invertColors) {
        cv.bitwise_not(gray, gray);
    }

    // Slightly blur the image to reduce noise before thresholding.
    if (blurMode === "gaussian") {
        cv.GaussianBlur(gray, blur, new cv.Size(3, 3), 0);
    } else if (blurMode === "median") {
        cv.medianBlur(gray, blur, 5);
    } else {
        blur = gray.clone();
    }

    // Create a true black-and-white image from the grayscale input.
    if (threshMode === "otsu") {
        cv.threshold(blur, binary, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    } else if (threshMode === "binary") {
        cv.threshold(blur, binary, binaryThreshold, 255, cv.THRESH_BINARY);
    } else if (threshMode === "adaptive") {
        const blockSize = Math.max(3, Math.min(31, adaptiveBlockSize + (adaptiveBlockSize % 2 === 0 ? 1 : 0)));
        cv.adaptiveThreshold(blur, binary, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, blockSize, adaptiveC);
    }

    // Optional morphology can help join broken digits or remove small specks.
    if (morphMode === "dilate") {
        const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2, 2));
        cv.dilate(binary, morph, kernel);
        binary.delete();
        binary = morph;
        morph = new cv.Mat();
        kernel.delete();
    } else if (morphMode === "erode") {
        const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2, 2));
        cv.erode(binary, morph, kernel);
        binary.delete();
        binary = morph;
        morph = new cv.Mat();
        kernel.delete();
    } else if (morphMode === "open") {
        const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2, 2));
        cv.morphologyEx(binary, morph, cv.MORPH_OPEN, kernel);
        binary.delete();
        binary = morph;
        morph = new cv.Mat();
        kernel.delete();
    } else if (morphMode === "close") {
        const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2, 2));
        cv.morphologyEx(binary, morph, cv.MORPH_CLOSE, kernel);
        binary.delete();
        binary = morph;
        morph = new cv.Mat();
        kernel.delete();
    }

    // Zoom the binary image slightly so Tesseract has larger digits to read.
    let zoomed = new cv.Mat();
    cv.resize(binary, zoomed, new cv.Size(binary.cols * zoomFactor, binary.rows * zoomFactor));

    const outCanvas = document.createElement("canvas");
    cv.imshow(outCanvas, zoomed);

    // Clean up OpenCV mats to avoid memory leaks.
    src.delete();
    gray.delete();
    blur.delete();
    binary.delete();
    morph.delete();
    zoomed.delete();

    return outCanvas;
}

// Map the user-selected page segmentation mode to the corresponding Tesseract mode.
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

// Map the user-selected OCR engine mode to the corresponding Tesseract mode.
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
