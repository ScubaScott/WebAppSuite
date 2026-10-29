// OCR module version identifier
const OCR_VERSION = '2.2';
const VERSION = OCR_VERSION;


// Index of the FREE space in the 25-cell grid
const FREE_CELL = 12;

// Reader used to turn cell crops into numbers (see readers/tesseract-reader.js for the reader contract)
let activeReader = null;

function getActiveReader() {
    if (!activeReader) activeReader = TesseractReader;
    return activeReader;
}

// Reads a card from the original photo and its window geometry (Geometry.analyze / Geometry.fromCorners result).
// Returns { grid, cells, reader, stats }:
//   grid   5x5 array of numbers (null where nothing valid was read, 'FREE' in the center)
//   cells  per-cell info from Geometry.extractCells (covered / glare flags, whether the window was seen)
//   stats  timings in ms (extractMs, sheetMs, recognizeMs, retryMs, totalMs) and the number of single-cell retries
async function readCardFromPhoto(photoCanvas, geometry, onStage) {
    const started = performance.now();
    const reader = getActiveReader();
    if (onStage) onStage('Cutting out the numbers…');
    const cells = Geometry.extractCells(photoCanvas, geometry);
    const extractMs = Math.round(performance.now() - started);

    // The reader gets the 24 numbered cells (FREE left out), contrast-stretched. Cells hidden by a closed
    // shutter or without a usable crop are skipped.
    const numbered = cells.filter(c => c.index !== FREE_CELL);
    const grays = numbered.map(c => (c.image && !c.covered ? Geometry.normalizeCrop(c.image) : null));

    if (onStage) onStage('Reading the numbers…');
    const readings = await reader.read(grays);

    // The decoder picks the most likely valid card: each number inside its column's range, none repeated in a column,
    // look-alike digits and missing digits corrected where one reading clearly stands out
    if (onStage) onStage('Checking the numbers against the card rules…');
    const decodeInput = numbered.map((c, k) => ({
        index: c.index, col: c.col, row: c.row,
        raw: readings[k].raw, candidates: readings[k].candidates, covered: c.covered, glare: c.glare
    }));
    const decoded = Decoder.decode(decodeInput);
    // What the reader's own best answers would give without the decoder, for comparison
    const readerGrid = Decoder.baseline(decodeInput);

    return {
        grid: decoded.grid, readerGrid, decoded, cells, numbered, readings,
        reader: { id: reader.id, version: reader.version },
        stats: { extractMs, ...readings.stats, totalMs: Math.round(performance.now() - started) }
    };
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
            <div id="contributeNotice" class="contribute-notice hidden" role="note">
                <span>Scans help train the scanner. When you apply a card, its number crops (not the whole photo) and the numbers you confirmed are sent anonymously. You can change this under "Help improve the scanner" below.</span>
                <button id="contributeNoticeOk" class="btn btn-secondary" type="button">OK</button>
            </div>
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

    // One-time explanation of what contributing sends, shown above the Apply button until it is dismissed
    const notice = document.getElementById('contributeNotice');
    if (notice && typeof TrainingStore !== 'undefined' && TrainingStore.shouldShowNotice()) {
        notice.classList.remove('hidden');
        document.getElementById('contributeNoticeOk').onclick = () => {
            TrainingStore.setSettings({ noticeSeen: true });
            notice.classList.add('hidden');
        };
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
            // Confirming the card also records it as a training sample (when contributing is on)
            if (typeof window.recordTrainingSample === 'function') window.recordTrainingSample(scannedGridData.slice());
            // Pass result to card editor
            if (typeof window.applyOCRResult === 'function') {
                window.applyOCRResult(grid2D);
            }
        };
    }
}