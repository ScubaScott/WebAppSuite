// Benchmark runner version identifier
const BENCH_VERSION = '1.0';
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

// Wait until OpenCV and Tesseract are both usable
async function waitForLibraries() {
    const started = Date.now();
    while (Date.now() - started < 120000) {
        const cvReady = typeof cv !== 'undefined' && cv && typeof cv.Mat === 'function';
        const tessReady = typeof Tesseract !== 'undefined';
        if (cvReady && tessReady) return;
        // Newer OpenCV builds expose a thenable that resolves to the module
        if (typeof cv !== 'undefined' && cv && typeof cv.then === 'function' && !cvReady) {
            try { window.cv = await cv; continue; } catch (e) { /* keep polling */ }
        }
        await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('OpenCV or Tesseract failed to load (network blocked?)');
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

// True when auto-crop returned the central-85% fallback instead of a detected grid
function isFallbackCrop(rawCanvas, corners) {
    if (!corners) return true;
    const w = rawCanvas.width, h = rawCanvas.height;
    return corners.tl.x === Math.round(w * 0.075) && corners.tl.y === Math.round(h * 0.075) &&
        corners.br.x === Math.round(w * 0.925) && corners.br.y === Math.round(h * 0.925);
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
    const fallbackCrop = isFallbackCrop(raw, cropped.corners);

    const work = document.createElement('canvas');
    work.width = cropped.width;
    work.height = cropped.height;
    work.getContext('2d').drawImage(cropped, 0, 0);

    let grid = null, error = null;
    try {
        grid = await runOCR(work);
    } catch (err) {
        error = String(err && err.message ? err.message : err);
    }
    const t2 = performance.now();

    return {
        name,
        card: entry.card,
        profile: entry.profile,
        split: entry.split,
        labelStatus: entry.labelStatus,
        fallbackCrop,
        cropMs: Math.round(t1 - t0),
        ocrMs: Math.round(t2 - t1),
        error,
        ...scoreGrid(grid, entry.labels)
    };
}

// Combine per-photo results into one summary row
function summarize(label, rows) {
    const n = rows.length;
    const cells = n * 24;
    const correct = rows.reduce((a, r) => a + r.correct, 0);
    const exact = rows.filter(r => r.exact).length;
    const fallback = rows.filter(r => r.fallbackCrop).length;
    const times = rows.map(r => r.cropMs + r.ocrMs).sort((a, b) => a - b);
    const median = n ? times[Math.floor(n / 2)] : 0;
    return { label, n, correct, cells, exact, fallback, medianMs: median };
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
        '<th class="num">Cards exact</th><th class="num">Grid not found</th><th class="num">Median time</th></tr></thead>';
    const body = document.createElement('tbody');
    for (const s of sum) {
        const tr = document.createElement('tr');
        const cls = s.n && s.correct / s.cells >= 0.8 ? 'good' : (s.n && s.correct / s.cells >= 0.4 ? 'warn' : 'bad');
        tr.innerHTML = `<td></td><td class="num">${s.n}</td><td class="num ${cls}">${s.correct}/${s.cells} (${pct(s.correct, s.cells)})</td>` +
            `<td class="num">${s.exact}/${s.n}</td><td class="num">${s.fallback}/${s.n}</td><td class="num">${(s.medianMs / 1000).toFixed(1)} s</td>`;
        tr.firstChild.textContent = s.label;
        body.appendChild(tr);
    }
    table.appendChild(body);
    summaryEl.appendChild(table);

    detailsEl.innerHTML = '';
    const dt = document.createElement('table');
    dt.innerHTML = '<thead><tr><th>Photo</th><th>Profile</th><th>Split</th><th class="num">Correct</th>' +
        '<th class="num">Wrong</th><th class="num">Missing</th><th>Grid</th><th class="num">Time</th></tr></thead>';
    const db = document.createElement('tbody');
    for (const r of results) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td></td><td></td><td></td>' +
            `<td class="num">${r.correct}</td><td class="num">${r.wrong}</td><td class="num">${r.missing}</td>` +
            `<td>${r.fallbackCrop ? 'not found' : 'found'}</td><td class="num">${((r.cropMs + r.ocrMs) / 1000).toFixed(1)} s</td>`;
        tr.children[0].textContent = r.name;
        tr.children[1].textContent = r.profile + (r.labelStatus === 'checked' ? '' : ' *');
        tr.children[2].textContent = r.split;
        db.appendChild(tr);
    }
    dt.appendChild(db);
    detailsEl.appendChild(dt);
    const note = document.createElement('p');
    note.className = 'status';
    note.textContent = '* labels still marked needs-review. "Grid not found" means auto-crop fell back to the central 85% of the photo.';
    detailsEl.appendChild(note);
}

// Run every photo in the loaded test set, one at a time
async function runAll() {
    runBtn.disabled = true;
    copyBtn.disabled = true;
    const names = Object.keys(labelsDoc.photos).filter(n =>
        !profileFilter.length || profileFilter.includes(labelsDoc.photos[n].profile));
    const results = [];
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
        await waitForLibraries();
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
