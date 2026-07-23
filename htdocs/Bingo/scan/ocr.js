// Standard 75-ball bingo column ranges (B-I-N-G-O). Used as a sanity check: if a recognized
// number falls outside the range for its column, it's almost certainly a misread, so we retry
// with different crop/zoom/PSM combinations rather than accepting the first guess.
const COLUMN_RANGES = [
    [1, 15],   // B
    [16, 30],  // I
    [31, 45],  // N
    [46, 60],  // G
    [61, 75],  // O
];

// A single, reused Tesseract worker. Creating a fresh worker per cell (25+ times per scan)
// is slow and can reload language data inconsistently, so we keep one alive and only
// recreate it if the OCR engine mode changes.
let ocrWorker = null;
let ocrWorkerOem = null;

async function getWorker(oem) {
    if (ocrWorker && ocrWorkerOem !== oem) {
        await ocrWorker.terminate();
        ocrWorker = null;
    }
    if (!ocrWorker) {
        ocrWorker = await Tesseract.createWorker();
        await ocrWorker.loadLanguage('eng');
        await ocrWorker.initialize('eng', oem);
        ocrWorkerOem = oem;
    }
    return ocrWorker;
}

// Extra (paddingRatio, zoomFactor, pageSegMode) combinations to retry, in priority order, when
// the primary user-configured settings don't produce a number that fits the expected column
// range. These were chosen empirically as the combination most likely to recover a correct read.
const RETRY_ATTEMPTS = [
    { paddingRatio: 0.25, zoom: 3, psm: 6 },
    { paddingRatio: 0.25, zoom: 3, psm: 8 },
    { paddingRatio: 0.40, zoom: 4, psm: 7 },
    { paddingRatio: 0.15, zoom: 3, psm: 13 },
];

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
    const zoomFactor = parseInt(document.getElementById("zoomFactor").value, 10) || 3;
    const validateRanges = document.getElementById("validateColumnRanges").checked;

    const oem = getOcrEngineMode();
    const worker = await getWorker(oem);

    const grid = [];

    // Slice the cropped card into five rows and five columns.
    for (let row = 0; row < 5; row++) {
        const rowData = [];

        for (let col = 0; col < 5; col++) {
            // Allow a small row/column shift to correct for a card that is slightly misaligned.
            const sourceRow = Math.max(0, Math.min(4, row + rowOffset));
            const sourceCol = Math.max(0, Math.min(4, col + colOffset));

            // Standard 5x5 bingo cards have a FREE SPACE in the center cell. It has no
            // number, so running OCR on it only wastes time and can produce garbage output.
            if (sourceRow === 2 && sourceCol === 2) {
                rowData.push("FREE");
                continue;
            }

            // Trim a small margin off each edge of the raw cell so grid lines and slivers
            // of neighboring cells (from imperfect crop/warp alignment) don't get included.
            const marginW = cellW * 0.045;
            const marginH = cellH * 0.045;

            const cellCanvas = document.createElement("canvas");
            cellCanvas.width = Math.max(1, cellW - marginW * 2);
            cellCanvas.height = Math.max(1, cellH - marginH * 2);

            const cellCtx = cellCanvas.getContext("2d");
            cellCtx.drawImage(
                canvas,
                sourceCol * cellW + marginW, sourceRow * cellH + marginH,
                cellCanvas.width, cellCanvas.height,
                0, 0, cellCanvas.width, cellCanvas.height
            );

            // Threshold the cell once using the user's tuning settings; every OCR attempt
            // below re-crops/zooms/re-reads this same binary image rather than re-thresholding.
            const binaryMat = computeBinaryCell(cellCanvas);

            const num = await ocrCellWithRetries(worker, binaryMat, sourceCol, zoomFactor, validateRanges);
            binaryMat.delete();

            rowData.push(num);
        }

        grid.push(rowData);
    }

    return grid;
}

// Try the user's configured settings first, then fall back through a fixed set of alternate
// crop/zoom/PSM combinations until a result lands inside the expected column range (or we run
// out of attempts, in which case we return the most common candidate seen).
async function ocrCellWithRetries(worker, binaryMat, sourceCol, primaryZoom, validateRanges) {
    // The fixed RETRY_ATTEMPTS sequence was tuned empirically to be reliable across lighting
    // conditions. The user's manual tuning-panel PSM/zoom choice is tried last, as an extra
    // fallback, rather than first — trying it first can occasionally lock in a wrong-but-still
    // -in-range guess before the reliable combos get a chance to run.
    const userPsm = getPageSegMode();
    const attempts = [...RETRY_ATTEMPTS, { paddingRatio: 0.20, zoom: primaryZoom, psm: userPsm }];

    const [lo, hi] = COLUMN_RANGES[sourceCol];
    const candidates = [];
    let lastPsm = null;

    for (const attempt of attempts) {
        if (attempt.psm !== lastPsm) {
            await worker.setParameters({
                tessedit_char_whitelist: '0123456789',
                tessedit_pageseg_mode: String(attempt.psm),
                classify_bln_numeric_mode: '1'
            });
            lastPsm = attempt.psm;
        }

        const cropped = tightCropToInk(binaryMat, attempt.paddingRatio);
        const zoomed = new cv.Mat();
        cv.resize(cropped, zoomed, new cv.Size(
            Math.max(1, cropped.cols * attempt.zoom),
            Math.max(1, cropped.rows * attempt.zoom)
        ));
        cropped.delete();

        const attemptCanvas = document.createElement("canvas");
        cv.imshow(attemptCanvas, zoomed);
        zoomed.delete();

        const { data } = await worker.recognize(attemptCanvas);
        const num = extractNumber(data.text);

        if (num !== null) {
            candidates.push(num);
            if (!validateRanges || (num >= lo && num <= hi)) {
                return num;
            }
        }
    }

    // Nothing landed inside the expected range (or validation is off and we just want a
    // best guess). Fall back to whichever candidate came up most often, if any.
    if (candidates.length === 0) return null;
    const counts = new Map();
    for (const c of candidates) counts.set(c, (counts.get(c) || 0) + 1);
    let best = candidates[0], bestCount = 0;
    for (const [val, count] of counts) {
        if (count > bestCount) { best = val; bestCount = count; }
    }
    return best;
}

// Convert a single bingo cell canvas into a black-and-white (binary) OpenCV Mat using the
// current tuning settings. Caller owns the returned Mat and must delete() it.
function computeBinaryCell(cellCanvas) {
    const threshMode = document.getElementById("threshMode").value;
    const blurMode = document.getElementById("blurMode").value;
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

    // If the user wants light text on a dark background, invert the grayscale image before thresholding.
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
    if (morphMode !== "none") {
        const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2, 2));
        if (morphMode === "dilate") cv.dilate(binary, morph, kernel);
        else if (morphMode === "erode") cv.erode(binary, morph, kernel);
        else if (morphMode === "open") cv.morphologyEx(binary, morph, cv.MORPH_OPEN, kernel);
        else if (morphMode === "close") cv.morphologyEx(binary, morph, cv.MORPH_CLOSE, kernel);
        kernel.delete();
        binary.delete();
        binary = morph;
    } else {
        morph.delete();
    }

    src.delete();
    gray.delete();
    blur.delete();

    return binary;
}

// Crop a binary (black text on white background) Mat down to a padded bounding box around
// the dark ink pixels. Falls back to a clone of the full image if no ink is found (e.g. a
// blank cell). Returns a new Mat that the caller must delete().
function tightCropToInk(binaryMat, paddingRatio) {
    const inverted = new cv.Mat();
    cv.bitwise_not(binaryMat, inverted); // ink (originally dark) becomes non-zero

    const data = inverted.data;
    const rows = inverted.rows;
    const cols = inverted.cols;
    let minX = cols;
    let maxX = -1;
    let minY = rows;
    let maxY = -1;

    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            const idx = y * cols + x;
            if (data[idx] > 0) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
    }

    inverted.delete();

    if (maxX === -1) {
        return binaryMat.clone();
    }

    const rectW = maxX - minX + 1;
    const rectH = maxY - minY + 1;

    const padX = Math.round(rectW * paddingRatio);
    const padY = Math.round(rectH * paddingRatio);
    const x = Math.max(0, minX - padX);
    const y = Math.max(0, minY - padY);
    const cropW = Math.min(cols - x, rectW + padX * 2);
    const cropH = Math.min(rows - y, rectH + padY * 2);

    const roi = binaryMat.roi(new cv.Rect(x, y, Math.max(1, cropW), Math.max(1, cropH)));
    const result = roi.clone();
    roi.delete();
    return result;
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
    if (!container) return;
    container.innerHTML = "";

    const wrap = document.createElement("div");
    wrap.className = "scanned-grid-wrap";

    const titleEl = document.createElement("div");
    titleEl.className = "card-title";
    titleEl.innerHTML = "<span>Scanned Card Grid</span><span style='font-size:12px;font-weight:400;color:var(--text-subtle);'>Verify & tap any cell to edit</span>";
    wrap.appendChild(titleEl);

    const gridDiv = document.createElement("div");
    gridDiv.className = "scanned-grid";

    // Column headers (B I N G O)
    const sessionData = localStorage.getItem("bingoSession");
    const sessionObj = sessionData ? JSON.parse(sessionData) : null;
    const word = (sessionObj && sessionObj.word && sessionObj.word.length === 5) ? sessionObj.word : "BINGO";

    for (let c = 0; c < 5; c++) {
        const hdr = document.createElement("div");
        hdr.className = "scanned-col-header";
        hdr.textContent = word[c];
        gridDiv.appendChild(hdr);
    }

    const cellInputs = [];

    for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 5; c++) {
            const isFree = (r === 2 && c === 2);
            const val = isFree ? "FREE" : (grid && grid[r] && grid[r][c] !== null && grid[r][c] !== undefined ? grid[r][c] : "");

            const input = document.createElement("input");
            input.type = "text";
            input.className = "scanned-cell-input" + (isFree ? " free-cell" : "");
            input.value = val;
            input.readOnly = isFree;

            if (!isFree) {
                input.maxLength = 2;
                input.inputMode = "numeric";
                input.pattern = "[0-9]*";
            }

            cellInputs.push(input);
            gridDiv.appendChild(input);
        }
    }

    wrap.appendChild(gridDiv);

    // "Use" button
    const useBtn = document.createElement("button");
    useBtn.className = "btn btn-success";
    useBtn.type = "button";
    useBtn.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
        </svg>
        Use These Numbers
    `;
    useBtn.addEventListener("click", () => saveScannedCard(cellInputs));

    wrap.appendChild(useBtn);
    container.appendChild(wrap);
}

function saveScannedCard(cellInputs) {
    const scannedSquares = [];
    for (let i = 0; i < 25; i++) {
        if (i === 12) {
            scannedSquares.push("FREE");
        } else {
            const raw = cellInputs[i].value.trim();
            const val = parseInt(raw, 10);
            scannedSquares.push(isNaN(val) ? null : val);
        }
    }

    const urlParams = new URLSearchParams(window.location.search);
    const targetCardId = urlParams.get("cardId");

    let sessionData = localStorage.getItem("bingoSession");
    let sessionObj = sessionData ? JSON.parse(sessionData) : null;

    if (!sessionObj) {
        sessionObj = { word: "BINGO", called: [], lastBall: null, cards: [] };
    }
    if (!Array.isArray(sessionObj.cards)) sessionObj.cards = [];

    if (targetCardId) {
        const card = sessionObj.cards.find(c => String(c.id) === String(targetCardId));
        if (card) {
            card.squares = scannedSquares;
        } else {
            sessionObj.cards.push({
                id: Date.now(),
                label: `Card ${sessionObj.cards.length + 1}`,
                squares: scannedSquares,
                editMode: false,
                active: true
            });
        }
    } else {
        if (sessionObj.cards.length > 0) {
            sessionObj.cards[0].squares = scannedSquares;
        } else {
            sessionObj.cards.push({
                id: Date.now(),
                label: "Card 1",
                squares: scannedSquares,
                editMode: false,
                active: true
            });
        }
    }

    localStorage.setItem("bingoSession", JSON.stringify(sessionObj));

    const statusDiv = document.getElementById("status");
    if (statusDiv) {
        statusDiv.className = "status-box success";
        statusDiv.textContent = "✓ Scanned numbers applied to card!";
    }

    setTimeout(() => {
        window.location.href = "../index.html";
    }, 500);
}