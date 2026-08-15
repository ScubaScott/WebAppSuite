// OCR module version identifier
const VERSION = '1.1';

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

// Absolute valid range for any 75-ball bingo number.
// Used by extractNumber to reject garbage OCR output before column-specific checks.
const BINGO_MIN = 1;
const BINGO_MAX = 75;

// A single, reused Tesseract worker.
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

// Retries for cell OCR
const RETRY_ATTEMPTS = [
    { paddingRatio: 0.25, zoom: 3, psm: 6 },
    { paddingRatio: 0.25, zoom: 3, psm: 8 },
    { paddingRatio: 0.35, zoom: 4, psm: 7 },
    { paddingRatio: 0.15, zoom: 3, psm: 13 },
];

// Run Tesseract over every bingo cell and return a 5x5 grid of detected numbers.
async function runOCR(canvas) {
    if (typeof cv === "undefined" || typeof Tesseract === "undefined") {
        return [];
    }

    const oem = getOcrEngineMode();
    const worker = await getWorker(oem);

    // Initial pass on current orientation
    let result = await evaluateCanvasGrid(canvas, worker);

    // Check if initial pass passed column range validation
    if (result.validCount >= 14 || !document.getElementById("validateColumnRanges").checked) {
        return deduplicateGrid(result.grid);
    }

    console.warn(`Initial orientation validity low (${result.validCount}/24). Testing rotations...`);

    // Test 90°, 180°, 270° rotations to automatically fix sideways or upside-down photos
    let bestResult = result;
    let bestRotatedCanvas = canvas;
    let currentRotatedCanvas = canvas;

    for (let rot = 1; rot <= 3; rot++) {
        currentRotatedCanvas = rotateCanvas90(currentRotatedCanvas, true);
        const evalRes = await evaluateCanvasGrid(currentRotatedCanvas, worker);
        if (evalRes.validCount > bestResult.validCount) {
            bestResult = evalRes;
            bestRotatedCanvas = currentRotatedCanvas;
        }
        if (bestResult.validCount >= 18) break;
    }

    if (bestResult.validCount > result.validCount) {
        console.log(`Auto-rotated photo by ${(bestResult.rotationAngle || 90)}° for optimal OCR (${bestResult.validCount}/24 valid cells)`);
        // Update global preview canvas to reflect the auto-rotated photo
        if (typeof drawCanvasToPreview === "function") {
            drawCanvasToPreview(bestRotatedCanvas);
        } else {
            canvas.width = bestRotatedCanvas.width;
            canvas.height = bestRotatedCanvas.height;
            canvas.getContext("2d").drawImage(bestRotatedCanvas, 0, 0);
        }
    }

    bestResult.grid = deduplicateGrid(bestResult.grid);
    return bestResult.grid;
}

// Slice canvas into 5x5 cells and run OCR
async function evaluateCanvasGrid(canvas, worker) {
    const w = canvas.width;
    const h = canvas.height;
    const cellW = Math.max(1, w / 5);
    const cellH = Math.max(1, h / 5);
    const rowOffset = parseInt(document.getElementById("rowOffset").value, 10) || 0;
    const colOffset = parseInt(document.getElementById("colOffset").value, 10) || 0;
    const zoomFactor = parseInt(document.getElementById("zoomFactor").value, 10) || 3;
    const validateRanges = document.getElementById("validateColumnRanges").checked;

    const grid = [];
    let validCount = 0;

    for (let row = 0; row < 5; row++) {
        const rowData = [];

        for (let col = 0; col < 5; col++) {
            const sourceRow = Math.max(0, Math.min(4, row + rowOffset));
            const sourceCol = Math.max(0, Math.min(4, col + colOffset));

            // FREE space at center cell
            if (sourceRow === 2 && sourceCol === 2) {
                rowData.push("FREE");
                continue;
            }

            // Trim 8% margin off cell edges to avoid grid frame lines and shutter tab borders
            const marginW = cellW * 0.08;
            const marginH = cellH * 0.08;

            const cellCanvas = document.createElement("canvas");
            cellCanvas.width = Math.max(1, Math.round(cellW - marginW * 2));
            cellCanvas.height = Math.max(1, Math.round(cellH - marginH * 2));

            const cellCtx = cellCanvas.getContext("2d");
            cellCtx.drawImage(
                canvas,
                sourceCol * cellW + marginW, sourceRow * cellH + marginH,
                cellCanvas.width, cellCanvas.height,
                0, 0, cellCanvas.width, cellCanvas.height
            );

            const binaryMat = computeBinaryCell(cellCanvas);
            const num = await ocrCellWithRetries(worker, binaryMat, sourceCol, zoomFactor, validateRanges);
            binaryMat.delete();

            rowData.push(num);

            const [lo, hi] = COLUMN_RANGES[sourceCol];
            if (num !== null && num >= lo && num <= hi) {
                validCount++;
            }
        }

        grid.push(rowData);
    }

    return { grid, validCount };
}

// Try the user's configured settings first, then fall back through alternate combinations
async function ocrCellWithRetries(worker, binaryMat, sourceCol, primaryZoom, validateRanges) {
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

    if (candidates.length === 0) return null;
    const counts = new Map();
    for (const c of candidates) counts.set(c, (counts.get(c) || 0) + 1);
    let best = candidates[0], bestCount = 0;
    for (const [val, count] of counts) {
        if (count > bestCount) { best = val; bestCount = count; }
    }
    return best;
}

// Convert a single bingo cell canvas into a black-and-white (binary) OpenCV Mat
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
        cv.threshold(blur, binary, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    } else if (threshMode === "binary") {
        cv.threshold(blur, binary, binaryThreshold, 255, cv.THRESH_BINARY);
    } else if (threshMode === "adaptive") {
        const blockSize = Math.max(3, Math.min(31, adaptiveBlockSize + (adaptiveBlockSize % 2 === 0 ? 1 : 0)));
        cv.adaptiveThreshold(blur, binary, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, blockSize, adaptiveC);
    }

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

// Crop binary Mat to central ink region, ignoring outer cell frame border noise
function tightCropToInk(binaryMat, paddingRatio) {
    const inverted = new cv.Mat();
    cv.bitwise_not(binaryMat, inverted); // ink (originally dark) becomes non-zero

    const data = inverted.data;
    const rows = inverted.rows;
    const cols = inverted.cols;

    // Ignore 6% outer margin when looking for central digit ink bounding box
    const marginX = Math.floor(cols * 0.06);
    const marginY = Math.floor(rows * 0.06);

    let minX = cols;
    let maxX = -1;
    let minY = rows;
    let maxY = -1;

    for (let y = marginY; y < rows - marginY; y++) {
        for (let x = marginX; x < cols - marginX; x++) {
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

    // Fall back to full cell bounds if no ink was found in central region
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
        case "legacy": return Tesseract.OEM.TESSERACT_ONLY;
        case "lstm": return Tesseract.OEM.LSTM_ONLY;
        default: return Tesseract.OEM.DEFAULT;
    }
}

// Parse OCR text to a valid bingo number (1–75). Any value outside that range is rejected.
function extractNumber(text) {
    if (!text) return null;
    const digits = text.replace(/[^0-9]/g, "");
    if (!digits) return null;
    const num = parseInt(digits, 10);
    if (isNaN(num)) return null;
    // Hard-reject anything outside the legal bingo range — catches misreads like 144, 0, etc.
    if (num < BINGO_MIN || num > BINGO_MAX) return null;
    return num;
}

// Remove duplicate numbers from the OCR grid. Each valid bingo number should appear only once.
// When a duplicate is found, the later occurrence is cleared to null.
// FREE cells and null/empty cells are ignored during deduplication.
function deduplicateGrid(grid) {
    const seen = new Set();
    for (let r = 0; r < grid.length; r++) {
        for (let c = 0; c < grid[r].length; c++) {
            const val = grid[r][c];
            if (val === "FREE" || val === null || val === undefined) continue;
            if (seen.has(val)) {
                console.warn(`OCR dedup: removed duplicate ${val} at [${r},${c}]`);
                grid[r][c] = null;
            } else {
                seen.add(val);
            }
        }
    }
    return grid;
}

// Render the scanned 5x5 bingo numbers into an interactive editable grid with headers and a "Use These Numbers" button
function drawBingoGrid(grid) {
    const container = document.getElementById("bingoOutput");
    if (!container) return;

    if (!grid || !Array.isArray(grid) || grid.length === 0) {
        grid = Array(5).fill(null).map((_, r) =>
            Array(5).fill(null).map((_, c) => (r === 2 && c === 2) ? "FREE" : "")
        );
    }

    const colHeaders = ["B", "I", "N", "G", "O"];

    let html = `
        <div class="scanned-grid-wrap">
            <div class="card-title">
                <span>Scanned Grid Numbers (Editable)</span>
                <span style="font-size: 12px; font-weight: 400; color: var(--text-subtle);">Verify & adjust any misreads</span>
            </div>
            <div class="scanned-grid">
    `;

    for (let c = 0; c < 5; c++) {
        html += `<div class="scanned-col-header">${colHeaders[c]}</div>`;
    }

    for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 5; c++) {
            const val    = (grid[r] && grid[r][c] !== undefined && grid[r][c] !== null) ? grid[r][c] : "";
            const isFree = (r === 2 && c === 2);

            if (isFree) {
                html += `<input type="text" class="scanned-cell-input free-cell" data-row="${r}" data-col="${c}" value="FREE" readonly>`;
            } else {
                const numVal = (val === "FREE") ? "" : val;

                // Flag cells whose value falls outside the expected BINGO column range
                const [lo, hi] = COLUMN_RANGES[c];
                const parsedNum = parseInt(numVal, 10);
                const isInvalid = numVal !== "" && !isNaN(parsedNum) && (parsedNum < lo || parsedNum > hi);
                const invalidClass = isInvalid ? " invalid-cell" : "";

                html += `<input type="number" class="scanned-cell-input${invalidClass}" data-row="${r}" data-col="${c}" value="${numVal}" min="1" max="75">`;
            }
        }
    }

    html += `
            </div>
            <button id="saveScannedCardBtn" class="btn btn-success" type="button" style="margin-top: 10px;">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                </svg>
                Use These Numbers
            </button>
        </div>
    `;

    container.innerHTML = html;

    const saveBtn = document.getElementById("saveScannedCardBtn");
    if (saveBtn) {
        saveBtn.onclick = saveScannedCard;
    }
}

// Save the edited scanned 5x5 grid numbers to localStorage and return to main bingo page
function saveScannedCard() {
    const urlParams = new URLSearchParams(window.location.search);
    const targetCardId = urlParams.get("cardId");

    const inputs = document.querySelectorAll(".scanned-cell-input");
    const squares = Array(25).fill("");

    inputs.forEach(input => {
        const r = parseInt(input.getAttribute("data-row"), 10);
        const c = parseInt(input.getAttribute("data-col"), 10);
        const index = r * 5 + c;

        if (r === 2 && c === 2) {
            squares[index] = "FREE";
        } else {
            const val = parseInt(input.value, 10);
            squares[index] = isNaN(val) ? "" : val;
        }
    });

    let sessionData = localStorage.getItem("bingoSession");
    let sessionObj = sessionData ? JSON.parse(sessionData) : null;

    if (!sessionObj || !Array.isArray(sessionObj.cards)) {
        alert("No active session found. Returning to main page.");
        window.location.href = "../index.html";
        return;
    }

    let cardToUpdate = null;
    if (targetCardId) {
        cardToUpdate = sessionObj.cards.find(c => String(c.id) === String(targetCardId));
    }
    if (!cardToUpdate && sessionObj.cards.length > 0) {
        cardToUpdate = sessionObj.cards[0];
    }

    if (cardToUpdate) {
        cardToUpdate.squares = squares;
        localStorage.setItem("bingoSession", JSON.stringify(sessionObj));
    }

    window.location.href = "../index.html";
}