// Benchmark runner version identifier
const BENCH_VERSION = '1.5';
const APP_VERSION = BENCH_VERSION;

// Cells compared per card: the 24 numbered squares (index 12 is the FREE space)
const FREE_INDEX = 12;

// Where the automatic mode fetches the test set from (a local dev server rooted at the repo root)
const AUTO_BASE = '/tools/bingo-scan-testset/';

const statusEl = document.getElementById('status');
const runBtn = document.getElementById('runBtn');
const copyBtn = document.getElementById('copyBtn');
const pickInput = document.getElementById('pickFiles');
const summaryEl = document.getElementById('summary');
const detailsEl = document.getElementById('details');

document.getElementById('appVersion').textContent = BENCH_VERSION;

// Test set: labels.json content plus a function that returns an image Blob for a photo name
let labelsDoc = null;
let getPhotoBlob = null;
let lastResults = null;

function setStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.className = isError ? 'status error' : 'status';
}

// Post progress or results to the local dev server (automatic mode only)
function report(path, payload) {
    if (!autoMode) return;
    fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        .catch(() => { });
}

const params = new URLSearchParams(location.search);
const autoMode = params.get('auto') === '1' && location.hostname === 'localhost';
// Optional comma-separated profile filter, e.g. ?profiles=slider
const profileFilter = (params.get('profiles') || '').split(',').filter(Boolean);
// ?geometry=1 runs only the window detector (no OCR) for quick checks of the grid finder
const geometryOnly = params.get('geometry') === '1';
// ?mask=<mode> replaces each overlay with the detector's mask for that mode (for tuning the window finder)
const maskDebugMode = params.get('mask');
// ?sheet=1 replaces each overlay with the 5x5 sheet of canonical cell crops
const sheetMode = params.get('sheet') === '1';
// ?sheetScale=1.5 sets the enlargement of the sheet the reader recognizes (for comparing settings)
if (params.get('sheetScale')) TesseractReader.options.scale = Number(params.get('sheetScale'));
// ?readerDebug=1 keeps each cell's raw reading in the results (first pass and final)
if (params.get('readerDebug') === '1') TesseractReader.options.debug = true;
// ?prep=stretch|otsu|adaptive picks how each crop is cleaned before reading
if (params.get('prep')) TesseractReader.options.prep = params.get('prep');
// ?cols=4&gutterX=2&border=3 change the sheet layout and edge cleaning; ?inset=-0.1 changes the cell crop size
for (const key of ['cols', 'gutterX', 'border', 'cut']) if (params.get(key)) TesseractReader.options[key] = Number(params.get(key));
if (params.get('inset')) CardProfiles.slider.cell.inset = Number(params.get('inset'));

// Download any missing engine files, then load Tesseract from the engine cache
async function waitForLibraries() {
    await EngineLoader.ensure(null, (loaded, total) => {
        setStatus(`Downloading scanner… ${Math.round(100 * loaded / Math.max(1, total))}%`);
    });
    await EngineLoader.load();
}

// Load an image Blob into a full-resolution canvas, applying the photo's EXIF rotation
async function blobToCanvas(blob) {
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close();
    return canvas;
}

// Score a recognized 5x5 grid against the 25 labels
function scoreGrid(grid, labels) {
    let correct = 0, wrong = 0, missing = 0;
    const cells = [];
    for (let i = 0; i < 25; i++) {
        if (i === FREE_INDEX) continue;
        const got = grid && grid[Math.floor(i / 5)] ? grid[Math.floor(i / 5)][i % 5] : null;
        const want = labels[i];
        if (got === null || got === undefined || got === '') {
            missing++;
            cells.push({ i, want, got: null });
        } else if (Number(got) === want) {
            correct++;
        } else {
            wrong++;
            cells.push({ i, want, got: Number(got) });
        }
    }
    return { correct, wrong, missing, exact: correct === 24, errors: cells };
}

// Run the current pipeline (auto-crop, then OCR) on one photo
async function runPhoto(name, entry) {
    const blob = await getPhotoBlob(name);
    const raw = await blobToCanvas(blob);

    const t0 = performance.now();
    let cropped;
    try {
        cropped = await autoCrop(raw);
    } catch (err) {
        cropped = raw;
    }
    const t1 = performance.now();
    const geometry = cropped.geometry || null;
    const geometryOk = !!(geometry && geometry.ok);
    // Small picture of what the window detector saw, for the results table
    let overlay = null;
    try {
        if (maskDebugMode) overlay = Geometry.debugMask(raw, maskDebugMode, 360).toDataURL('image/jpeg', 0.6);
        else if (sheetMode && geometry && geometry.ok) overlay = Geometry.drawCellSheet(Geometry.extractCells(raw, geometry)).toDataURL('image/png');
        else if (geometry) overlay = Geometry.drawOverlay(raw, geometry, 360).toDataURL('image/jpeg', 0.6);
    } catch (err) { /* overlay is optional */ }

    let grid = null, readerGrid = null, decodedCells = null, error = null, readStats = null, readerInfo = null, readings = null;
    if (!geometryOnly) {
        try {
            // Same choice the Scan page makes: the detected grid, or the default corner handles when detection failed
            const useGeometry = geometryOk ? geometry : Geometry.fromCorners(cropped.corners);
            const read = await readCardFromPhoto(raw, useGeometry);
            grid = read.grid;
            readerGrid = read.readerGrid;
            decodedCells = read.decoded.cells.map(c => ({ index: c.index, value: c.value, kind: c.kind, score: Math.round(c.score * 1000) / 1000, changed: c.changedByDecoder }));
            readStats = read.stats;
            readerInfo = read.reader;
            // What the reader returned for each of the 24 numbered cells, plus the cell flags, so the decoder
            // can be developed and checked offline against real readings
            readings = read.numbered.map((c, k) => ({
                index: c.index, raw: read.readings[k].raw, candidates: read.readings[k].candidates,
                covered: c.covered, glare: c.glare, found: c.found
            }));
        } catch (err) {
            error = String(err && err.message ? err.message : err);
        }
    }
    const t2 = performance.now();

    return {
        name,
        card: entry.card,
        profile: entry.profile,
        split: entry.split,
        labelStatus: entry.labelStatus,
        fallbackCrop: !geometryOk,
        geometryOk,
        windows: geometry ? geometry.windows : 0,
        geometryErr: geometry && geometry.err !== null ? Math.round(geometry.err * 1000) / 10 : null,
        geometryReason: geometry ? geometry.reason : null,
        geometryMode: geometry ? geometry.mode : null,
        geometryMs: geometry ? geometry.ms : null,
        windowFrac: geometry && geometry.windowFrac ? Math.round(geometry.windowFrac * 1000) / 1000 : null,
        windowFracY: geometry && geometry.windowFracY ? Math.round(geometry.windowFracY * 1000) / 1000 : null,
        pitchRatio: geometry && geometry.pitchX ? Math.round(geometry.pitchX / geometry.pitchY * 1000) / 1000 : null,
        overlay,
        cropMs: Math.round(t1 - t0),
        ocrMs: Math.round(t2 - t1),
        read: readStats,
        readings,
        reader: readerInfo,
        // Time a user waits: finding the windows plus reading the numbers
        scanMs: (geometry ? geometry.ms : 0) + (readStats ? readStats.totalMs : 0),
        error,
        ...scoreGrid(grid, entry.labels),
        // Same photo scored on the reader's own answers (no decoder), and what the decoder did to each cell
        readerOnly: readerGrid ? (({ correct, wrong, missing, exact }) => ({ correct, wrong, missing, exact }))(scoreGrid(readerGrid, entry.labels)) : null,
        decoded: decodedCells
    };
}

// Combine per-photo results into one summary row
function summarize(label, rows) {
    const n = rows.length;
    const cells = n * 24;
    const correct = rows.reduce((a, r) => a + r.correct, 0);
    const readerCorrect = rows.reduce((a, r) => a + (r.readerOnly ? r.readerOnly.correct : 0), 0);
    const readerExact = rows.filter(r => r.readerOnly && r.readerOnly.exact).length;
    const exact = rows.filter(r => r.exact).length;
    const fallback = rows.filter(r => r.fallbackCrop).length;
    const geomOk = rows.length - fallback;
    const times = rows.map(r => r.scanMs).sort((a, b) => a - b);
    const median = n ? times[Math.floor(n / 2)] : 0;
    return { label, n, correct, readerCorrect, readerExact, cells, exact, fallback, geomOk, medianMs: median };
}

// Summary groups: scored slider photos first, then everything that is not scored yet
function buildSummary(results) {
    const slider = r => r.profile === 'slider';
    const checked = r => r.labelStatus === 'checked';
    return [
        summarize('Slider, checked labels (headline)', results.filter(r => slider(r) && checked(r))),
        summarize('  of which tune photos', results.filter(r => slider(r) && checked(r) && r.split === 'tune')),
        summarize('  of which holdout photos', results.filter(r => slider(r) && checked(r) && r.split === 'holdout')),
        summarize('Slider, needs-review labels', results.filter(r => slider(r) && !checked(r))),
        summarize('Other formats (not scored yet)', results.filter(r => !slider(r)))
    ];
}

function pct(a, b) { return b ? (100 * a / b).toFixed(1) + '%' : '–'; }

function renderResults(results) {
    const sum = buildSummary(results);
    summaryEl.innerHTML = '';
    const table = document.createElement('table');
    table.innerHTML = '<thead><tr><th>Group</th><th class="num">Photos</th><th class="num">Cells correct</th>' +
        '<th class="num">Reader alone</th><th class="num">Cards exact</th><th class="num">Windows found</th><th class="num">Median scan time</th></tr></thead>';
    const body = document.createElement('tbody');
    for (const s of sum) {
        const tr = document.createElement('tr');
        const cls = s.n && s.correct / s.cells >= 0.8 ? 'good' : (s.n && s.correct / s.cells >= 0.4 ? 'warn' : 'bad');
        tr.innerHTML = `<td></td><td class="num">${s.n}</td><td class="num ${cls}">${s.correct}/${s.cells} (${pct(s.correct, s.cells)})</td>` +
            `<td class="num">${s.readerCorrect}/${s.cells}</td><td class="num">${s.exact}/${s.n}</td><td class="num">${s.geomOk}/${s.n} (${pct(s.geomOk, s.n)})</td><td class="num">${(s.medianMs / 1000).toFixed(1)} s</td>`;
        tr.firstChild.textContent = s.label;
        body.appendChild(tr);
    }
    table.appendChild(body);
    summaryEl.appendChild(table);

    detailsEl.innerHTML = '';
    const dt = document.createElement('table');
    dt.innerHTML = '<thead><tr><th>Photo</th><th>Profile</th><th>Split</th><th class="num">Correct</th><th class="num">Reader alone</th>' +
        '<th class="num">Wrong</th><th class="num">Missing</th><th>Windows</th><th class="num">Time</th><th>Detection</th></tr></thead>';
    const db = document.createElement('tbody');
    for (const r of results) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td></td><td></td><td></td>' +
            `<td class="num">${r.correct}</td><td class="num">${r.readerOnly ? r.readerOnly.correct : '–'}</td><td class="num">${r.wrong}</td><td class="num">${r.missing}</td>` +
            `<td>${r.geometryOk ? r.windows + '/25, err ' + r.geometryErr + '%' : 'not found'}</td><td class="num">${(r.scanMs / 1000).toFixed(1)} s${r.read ? ' (' + r.read.retries + ' retries)' : ''}</td><td></td>`;
        if (r.overlay) {
            const img = document.createElement('img');
            img.src = r.overlay;
            img.alt = 'Detection overlay for ' + r.name;
            img.className = 'overlay-thumb';
            tr.children[9].appendChild(img);
        }
        tr.children[0].textContent = r.name;
        tr.children[1].textContent = r.profile + (r.labelStatus === 'checked' ? '' : ' *');
        tr.children[2].textContent = r.split;
        db.appendChild(tr);
    }
    dt.appendChild(db);
    detailsEl.appendChild(dt);
    const note = document.createElement('p');
    note.className = 'status';
    note.textContent = '* labels still marked needs-review. "Windows" is how many of the 25 number windows the detector matched; "not found" means the grid could not be located and the scanner would ask for manual corners.';
    detailsEl.appendChild(note);
}

// Run every photo in the loaded test set, one at a time
async function runAll() {
    runBtn.disabled = true;
    copyBtn.disabled = true;
    const names = Object.keys(labelsDoc.photos).filter(n =>
        !profileFilter.length || profileFilter.includes(labelsDoc.photos[n].profile));
    const results = [];
    // Start the recognizer before timing any photo, and record how long that takes
    let readerLoadMs = null;
    if (!geometryOnly) {
        setStatus('Starting the text recognizer…');
        const tl = performance.now();
        await getActiveReader().load();
        readerLoadMs = Math.round(performance.now() - tl);
    }
    for (let i = 0; i < names.length; i++) {
        setStatus(`Photo ${i + 1} of ${names.length}: ${names[i]}…`);
        report('/bench-progress', { index: i + 1, total: names.length, name: names[i] });
        try {
            results.push(await runPhoto(names[i], labelsDoc.photos[names[i]]));
        } catch (err) {
            results.push({
                name: names[i], ...pick(labelsDoc.photos[names[i]]), fallbackCrop: true, cropMs: 0, ocrMs: 0,
                error: String(err), correct: 0, wrong: 0, missing: 24, exact: false, errors: []
            });
        }
        renderResults(results);
    }
    lastResults = {
        benchVersion: BENCH_VERSION,
        ocrVersion: typeof OCR_VERSION !== 'undefined' ? OCR_VERSION : null,
        utilsVersion: typeof UTILS_VERSION !== 'undefined' ? UTILS_VERSION : null,
        geometryVersion: typeof GEOMETRY_VERSION !== 'undefined' ? GEOMETRY_VERSION : null,
        reader: typeof TesseractReader !== 'undefined' ? { id: TesseractReader.id, version: TesseractReader.version, options: TesseractReader.options } : null,
        readerLoadMs,
        ranAt: new Date().toISOString(),
        summary: buildSummary(results),
        photos: results
    };
    setStatus(`Done: ${results.length} photos.`);
    runBtn.disabled = false;
    copyBtn.disabled = false;
    report('/bench-result', lastResults);
}

function pick(entry) {
    return { card: entry.card, profile: entry.profile, split: entry.split, labelStatus: entry.labelStatus };
}

// Manual mode: labels.json and photos chosen through the file picker
pickInput.addEventListener('change', async () => {
    const files = Array.from(pickInput.files);
    const labelsFile = files.find(f => f.name === 'labels.json');
    if (!labelsFile) { setStatus('Include labels.json in the selection.', true); return; }
    labelsDoc = JSON.parse(await labelsFile.text());
    const byName = new Map(files.map(f => [f.name, f]));
    getPhotoBlob = async name => {
        const f = byName.get(name);
        if (!f) throw new Error('Photo not selected: ' + name);
        return f;
    };
    const missing = Object.keys(labelsDoc.photos).filter(n => !byName.has(n));
    setStatus(`${Object.keys(labelsDoc.photos).length} labeled photos` + (missing.length ? `, ${missing.length} not selected` : '') + '.');
    runBtn.disabled = false;
});

runBtn.addEventListener('click', runAll);

copyBtn.addEventListener('click', async () => {
    if (!lastResults) return;
    try {
        await navigator.clipboard.writeText(JSON.stringify(lastResults, null, 2));
        setStatus('Results copied to the clipboard.');
    } catch (err) {
        setStatus('Copy failed; allow clipboard access and try again.', true);
    }
});

// Startup: wait for libraries, then in automatic mode fetch the test set and run it
(async () => {
    try {
        // Detection-only runs do not need the OCR engine files
        if (!geometryOnly) await waitForLibraries();
    } catch (err) {
        setStatus(err.message, true);
        report('/bench-result', { error: err.message });
        return;
    }
    setStatus('Libraries ready. Choose the test set to begin.');
    if (!autoMode) return;
    try {
        labelsDoc = await (await fetch(AUTO_BASE + 'labels.json')).json();
        getPhotoBlob = async name => (await fetch(AUTO_BASE + 'photos/' + encodeURIComponent(name))).blob();
        await runAll();
    } catch (err) {
        setStatus('Automatic run failed: ' + err.message, true);
        report('/bench-result', { error: String(err) });
    }
})();
