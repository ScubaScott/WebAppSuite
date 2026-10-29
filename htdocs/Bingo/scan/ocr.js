// OCR module version identifier
const OCR_VERSION = '1.6';
const VERSION = OCR_VERSION;


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
        // Worker, core and language files come from the engine cache (see engine-loader.js)
        ocrWorker = await Tesseract.createWorker(EngineLoader.tesseractOptions());
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
    if (typeof Imaging === "undefined" || typeof Tesseract === "undefined") {
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

            const binaryCell = computeBinaryCell(cellCanvas);
            const num = await ocrCellWithRetries(worker, binaryCell, sourceCol, zoomFactor, validateRanges);

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
async function ocrCellWithRetries(worker, binaryCell, sourceCol, primaryZoom, validateRanges) {
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

        // Crop to the digit ink, then enlarge it so Tesseract sees larger glyphs
        const cropped = tightCropToInk(binaryCell, attempt.paddingRatio);
        const attemptCanvas = Imaging.grayToCanvas(cropped, attempt.zoom);

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

// Convert a single bingo cell canvas into a black-and-white gray image (0 = ink, 255 = paper)
function computeBinaryCell(cellCanvas) {
    const threshMode = document.getElementById("threshMode").value;
    const blurMode = document.getElementById("blurMode").value;
    const invertColors = document.getElementById("invertColors").checked;
    const morphMode = document.getElementById("morphMode").value;
    const binaryThreshold = parseInt(document.getElementById("binaryThreshold").value, 10) || 127;
    const adaptiveBlockSize = parseInt(document.getElementById("adaptiveBlockSize").value, 10) || 11;
    const adaptiveC = parseInt(document.getElementById("adaptiveC").value, 10) || 2;

    let gray = Imaging.grayFromRGBA(Imaging.canvasToImageData(cellCanvas));

    if (invertColors) {
        gray = Imaging.invert(gray);
    }

    let blurred = gray;
    if (blurMode === "gaussian") {
        blurred = Imaging.gaussianBlur(gray, 3);
    } else if (blurMode === "median") {
        blurred = Imaging.medianBlur(gray, 5);
    }

    let binary;
    if (threshMode === "binary") {
        binary = Imaging.threshold(blurred, binaryThreshold);
    } else if (threshMode === "adaptive") {
        const blockSize = Math.max(3, Math.min(31, adaptiveBlockSize + (adaptiveBlockSize % 2 === 0 ? 1 : 0)));
        binary = Imaging.adaptiveThreshold(blurred, { method: 'gaussian', blockSize, c: adaptiveC });
    } else {
        binary = Imaging.threshold(blurred, Imaging.otsuThreshold(blurred));
    }

    if (morphMode !== "none") {
        binary = Imaging.morphology(binary, morphMode);
    }

    return binary;
}

// Crop a binary gray image to its central ink region, ignoring outer cell frame border noise
function tightCropToInk(binary, paddingRatio) {
    const data = binary.data;
    const rows = binary.height;
    const cols = binary.width;

    // Ignore 6% outer margin when looking for central digit ink bounding box
    const marginX = Math.floor(cols * 0.06);
    const marginY = Math.floor(rows * 0.06);

    let minX = cols;
    let maxX = -1;
    let minY = rows;
    let maxY = -1;

    // Ink is the dark (0) pixels of the binarized cell
    for (let y = marginY; y < rows - marginY; y++) {
        for (let x = marginX; x < cols - marginX; x++) {
            if (data[y * cols + x] === 0) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
    }

    // Fall back to full cell bounds if no ink was found in central region
    if (maxX === -1) {
        return Imaging.cropGray(binary, 0, 0, cols, rows);
    }

    const rectW = maxX - minX + 1;
    const rectH = maxY - minY + 1;

    const padX = Math.round(rectW * paddingRatio);
    const padY = Math.round(rectH * paddingRatio);
    const x = Math.max(0, minX - padX);
    const y = Math.max(0, minY - padY);
    const cropW = Math.min(cols - x, rectW + padX * 2);
    const cropH = Math.min(rows - y, rectH + padY * 2);

    return Imaging.cropGray(binary, x, y, Math.max(1, cropW), Math.max(1, cropH));
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

// State for interactive scanned grid review
let scannedGridData = Array(25).fill(null);
scannedGridData[12] = 'FREE';
let activeScannedPickerIdx = -1;

// Render the scanned 5x5 bingo numbers into an interactive editable grid with headers and column picker
function drawBingoGrid(grid) {
    const container = document.getElementById("bingoOutput");
    if (!container) return;

    // Convert 2D grid (if passed) to flat 25-element array
    if (Array.isArray(grid) && grid.length > 0 && Array.isArray(grid[0])) {
        scannedGridData = Array(25).fill(null);
        for (let r = 0; r < 5; r++) {
            for (let c = 0; c < 5; c++) {
                const idx = r * 5 + c;
                if (r === 2 && c === 2) {
                    scannedGridData[idx] = 'FREE';
                } else {
                    const v = grid[r] ? grid[r][c] : null;
                    if (v !== null && v !== undefined && v !== '' && v !== 'FREE') {
                        const parsed = parseInt(v, 10);
                        scannedGridData[idx] = isNaN(parsed) ? null : parsed;
                    } else {
                        scannedGridData[idx] = null;
                    }
                }
            }
        }
    }

    activeScannedPickerIdx = -1;
    renderScannedGridReview();
}

// Render the interactive 5x5 grid and number picker inside #bingoOutput
function renderScannedGridReview() {
    const container = document.getElementById("bingoOutput");
    if (!container) return;

    const colHeaders = ["B", "I", "N", "G", "O"];

    container.innerHTML = `
        <div class="scanned-grid-wrap">
            <div class="card-title">
                <span>Scanned Grid Numbers</span>
                <span style="font-size: 12px; font-weight: 400; color: var(--text-subtle);">Tap a cell to select number</span>
            </div>
            <div id="scannedGridElements" class="editor-grid" role="grid" aria-label="Scanned card number grid"></div>
            <div id="scannedPickerEl" class="editor-picker hidden" aria-live="polite"></div>
            <button id="applyOCRBtn" class="btn btn-success" type="button" style="margin-top: 10px;">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                </svg>
                Apply to Card Editor
            </button>
        </div>
    `;

    const gridEl = document.getElementById("scannedGridElements");
    const pickerEl = document.getElementById("scannedPickerEl");

    // Render BINGO column headers
    for (let c = 0; c < 5; c++) {
        const hdr = document.createElement('div');
        hdr.className = 'editor-col-header';
        hdr.textContent = colHeaders[c];
        gridEl.appendChild(hdr);
    }

    // Count occurrences for duplicate detection
    const valueCounts = new Map();
    for (let i = 0; i < 25; i++) {
        const val = scannedGridData[i];
        if (val !== null && val !== '' && val !== 'FREE') {
            valueCounts.set(val, (valueCounts.get(val) || 0) + 1);
        }
    }

    // Render 25 cells
    for (let idx = 0; idx < 25; idx++) {
        const col = idx % 5;
        const [lo, hi] = COLUMN_RANGES[col];
        const isFree = (idx === 12);
        const value = scannedGridData[idx];
        const isBlank = !isFree && (value === null || value === '' || value === undefined);
        const parsed = parseInt(value, 10);
        const isOutOfRange = !isFree && !isBlank && (isNaN(parsed) || parsed < lo || parsed > hi);
        const isDuplicate = !isFree && !isBlank && (valueCounts.get(value) > 1);
        const isInvalid = isOutOfRange || isDuplicate;
        const isSelected = (activeScannedPickerIdx === idx);

        const cell = document.createElement('div');
        cell.className = [
            'editor-cell',
            isFree ? 'free' : '',
            !isFree && isBlank ? 'empty invalid' : '',
            !isFree && !isBlank && isInvalid ? 'filled invalid' : '',
            !isFree && !isBlank && !isInvalid ? 'filled' : '',
            isSelected ? 'selected' : ''
        ].filter(Boolean).join(' ');

        cell.textContent = isFree ? 'FREE' : (isBlank ? '' : value);
        cell.setAttribute('role', 'gridcell');

        if (!isFree) {
            cell.setAttribute('aria-label', `${colHeaders[col]} column, ${isBlank ? 'empty (invalid)' : (isInvalid ? 'invalid value ' + value : 'value ' + value)}`);
            cell.addEventListener('click', () => {
                activeScannedPickerIdx = (activeScannedPickerIdx === idx) ? -1 : idx;
                renderScannedGridReview();
            });
        }

        gridEl.appendChild(cell);
    }

    // Render number picker dropdown if a cell is selected
    if (activeScannedPickerIdx !== -1) {
        pickerEl.classList.remove('hidden');
        const cellIdx = activeScannedPickerIdx;
        const col = cellIdx % 5;
        const [lo, hi] = COLUMN_RANGES[col];
        const currentValue = scannedGridData[cellIdx];

        // Gather numbers used in this column
        const usedInCol = new Set();
        for (let r = 0; r < 5; r++) {
            const sq = scannedGridData[r * 5 + col];
            if (r * 5 + col !== cellIdx && sq !== null && sq !== 'FREE' && sq !== '') {
                usedInCol.add(sq);
            }
        }

        // Header label
        const pickerLabel = document.createElement('div');
        pickerLabel.className = 'editor-picker-label';
        pickerLabel.textContent = `Select ${colHeaders[col]} number (${lo}–${hi})`;
        pickerEl.appendChild(pickerLabel);

        // 15 number buttons
        const pickerGrid = document.createElement('div');
        pickerGrid.className = 'editor-picker-grid';

        for (let n = lo; n <= hi; n++) {
            const isUsed = usedInCol.has(n);
            const isCurrent = (currentValue === n);

            const btn = document.createElement('button');
            btn.className = [
                'editor-pick-btn',
                isUsed ? 'used' : '',
                isCurrent ? 'current' : ''
            ].filter(Boolean).join(' ');
            btn.type = 'button';
            btn.textContent = n;
            btn.disabled = isUsed;
            btn.title = isUsed ? 'Already on this card' : '';
            btn.setAttribute('aria-label', `${colHeaders[col]}${n}`);

            if (!isUsed) {
                btn.addEventListener('click', () => {
                    scannedGridData[cellIdx] = n;
                    activeScannedPickerIdx = -1;
                    renderScannedGridReview();
                });
            }

            pickerGrid.appendChild(btn);
        }

        pickerEl.appendChild(pickerGrid);

        // Clear cell button if cell has value
        if (currentValue !== null && currentValue !== '') {
            const clearBtn = document.createElement('button');
            clearBtn.type = 'button';
            clearBtn.className = 'btn btn-secondary';
            clearBtn.style.cssText = 'margin-top: 4px; padding: 8px 20px; font-size: 13px; width: auto;';
            clearBtn.textContent = '✕ Clear Cell';
            clearBtn.addEventListener('click', () => {
                scannedGridData[cellIdx] = null;
                activeScannedPickerIdx = -1;
                renderScannedGridReview();
            });
            pickerEl.appendChild(clearBtn);
        }
    } else {
        pickerEl.classList.add('hidden');
    }

    const applyBtn = document.getElementById('applyOCRBtn');
    if (applyBtn) {
        applyBtn.onclick = () => {
            // Convert flat scannedGridData to 5x5 grid
            const grid2D = Array(5).fill(null).map((_, r) =>
                Array(5).fill(null).map((_, c) => {
                    const idx = r * 5 + c;
                    return idx === 12 ? 'FREE' : scannedGridData[idx];
                })
            );
            // Pass result to card editor
            if (typeof window.applyOCRResult === 'function') {
                window.applyOCRResult(grid2D);
            }
        };
    }
}