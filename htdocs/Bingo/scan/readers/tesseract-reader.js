// Tesseract reader version identifier
const TESSERACT_READER_VERSION = '1.0';

// CellReader adapter for Tesseract (see the reader contract in bingo-scan-redesign-spec.md, section 7.5).
//
//   id, version      identify the reader in results and training samples
//   load(onStage)    makes sure the engine files are cached, loads Tesseract and starts its worker
//   read(grays)      grays = the 24 normalized crops (gray images, row-major, FREE cell left out; an entry may be
//                    null to skip a cell). Returns one entry per input:
//                    { raw, candidates: [{ value, score }] } with score in 0-1. The array also carries `stats`.
//   dispose()        stops the worker and frees its memory
//
// All 24 crops are laid out on one sheet and recognized in a single pass; the position of each recognized word
// says which cell it belongs to. Only cells that came back empty or with low confidence are read again, one at a time.
const TesseractReader = (() => {
    // Confidence (0-100) below which a cell is read again on its own
    const RETRY_BELOW = 40;
    const PSM_SPARSE_TEXT = '11';
    const PSM_SINGLE_WORD = '8';

    // Tunable from the benchmark page to compare sheet scales
    // prep: how each crop is cleaned before reading: 'stretch' (contrast-stretched gray as given), 'otsu' (black and
    // white by one cut per crop) or 'adaptive' (black and white against the local average, which copes with glare gradients)
    // cols: tiles per sheet row; gutterX: horizontal gap between tiles in crop heights (vertical gap is one crop height);
    // cut: multiplier on Otsu's black/white threshold (below 1 keeps only the darkest pixels as ink);
    // border: pixels cleared along the edge of each cleaned crop (removes window-frame lines)
    const options = { scale: 0.7, prep: 'otsu', cols: 4, gutterX: 3, border: 0, cut: 0.75, debug: false };

    let worker = null;
    let workerPromise = null;

    // Makes sure the engine files are present, loads the Tesseract script and creates the worker
    async function load(onStage) {
        if (worker) return;
        if (!workerPromise) {
            workerPromise = (async () => {
                if (onStage) onStage('Loading text recognition…');
                await EngineLoader.load(['tesseract']);
                const w = await Tesseract.createWorker(EngineLoader.tesseractOptions());
                await w.loadLanguage('eng');
                await w.initialize('eng', Tesseract.OEM.LSTM_ONLY);
                await w.setParameters({
                    tessedit_char_whitelist: '0123456789',
                    tessedit_pageseg_mode: PSM_SPARSE_TEXT,
                    classify_bln_numeric_mode: '1'
                });
                worker = w;
            })();
            workerPromise.catch(() => { workerPromise = null; });
        }
        await workerPromise;
    }

    // Cleans one crop according to options.prep; digits end up dark on a light background
    function prepare(gray) {
        if (!gray) return gray;
        let out = gray;
        if (options.prep === 'otsu') {
            const blurred = Imaging.gaussianBlur(gray, 3);
            out = Imaging.threshold(blurred, Math.round(Imaging.otsuThreshold(blurred) * options.cut));
        } else if (options.prep === 'adaptive') {
            out = Imaging.adaptiveThreshold(Imaging.gaussianBlur(gray, 3), { method: 'gaussian', blockSize: 25, c: 10 });
        }
        return options.border > 0 ? whitenBorder(out, options.border) : out;
    }

    // Sets the outermost `px` pixels of an image to white
    function whitenBorder(gray, px) {
        const { width: w, height: h } = gray;
        const data = new Uint8Array(gray.data);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                if (x < px || y < px || x >= w - px || y >= h - px) data[y * w + x] = 255;
            }
        }
        return { width: w, height: h, data };
    }

    // Places the crops on one white sheet. Returns the sheet as a gray image plus each tile's rectangle.
    function buildSheet(grays) {
        const present = grays.filter(Boolean);
        const tw = present[0].width, th = present[0].height;
        const gutter = th;                       // at least one crop height of white between tiles
        const gutterX = Math.round(th * options.gutterX);
        const margin = gutter;
        const cols = options.cols;
        const rows = Math.ceil(grays.length / cols);
        const width = margin * 2 + cols * tw + (cols - 1) * gutterX;
        const height = margin * 2 + rows * th + (rows - 1) * gutter;
        const data = new Uint8Array(width * height).fill(255);
        const tiles = [];
        grays.forEach((g, k) => {
            const col = k % cols, row = Math.floor(k / cols);
            const x = margin + col * (tw + gutterX), y = margin + row * (th + gutter);
            tiles.push({ x, y, w: tw, h: th });
            if (!g) return;
            for (let yy = 0; yy < th; yy++) data.set(g.data.subarray(yy * tw, (yy + 1) * tw), (y + yy) * width + x);
        });
        return { sheet: { width, height, data }, tiles, gutter: Math.min(gutter, gutterX) };
    }

    // Digits of recognized text, or '' when there are none
    const digitsOf = text => (text || '').replace(/[^0-9]/g, '');

    // Turns recognized words into per-tile readings by checking which tile each word's center falls in
    function assignWords(words, tiles, gutter) {
        const perTile = tiles.map(() => []);
        const scale = options.scale;
        for (const word of words) {
            const digits = digitsOf(word.text);
            if (!digits) continue;
            const cx = (word.bbox.x0 + word.bbox.x1) / 2 / scale;
            const cy = (word.bbox.y0 + word.bbox.y1) / 2 / scale;
            const half = gutter / 2;
            const k = tiles.findIndex(t => cx >= t.x - half && cx <= t.x + t.w + half && cy >= t.y - half && cy <= t.y + t.h + half);
            if (k >= 0) {
                const symbols = (word.symbols || []).map(sy => Math.round(sy.confidence));
                perTile[k].push({ x: word.bbox.x0, digits, conf: word.confidence, symbols });
            }
        }
        return perTile.map(list => {
            if (!list.length) return null;
            list.sort((a, b) => a.x - b.x);
            return { raw: list.map(w => w.digits).join(''), conf: list.reduce((s, w) => s + w.conf, 0) / list.length, symbols: [].concat(...list.map(w => w.symbols)) };
        });
    }

    // Turns the readings of one cell (sheet pass and, when it was needed, the single-cell retry) into the contract's entry.
    // Both are kept as candidates, best score first, so a later step can choose between them (no confusion alternatives yet).
    function toEntry(sheetReading, retryReading) {
        const best = new Map();
        for (const reading of [sheetReading, retryReading]) {
            if (!reading || !reading.raw) continue;
            const value = parseInt(reading.raw, 10);
            if (isNaN(value)) continue;
            const score = Math.max(0, Math.min(1, reading.conf / 100));
            if (!best.has(value) || best.get(value) < score) best.set(value, score);
        }
        const candidates = Array.from(best, ([value, score]) => ({ value, score })).sort((a, b) => b.score - a.score);
        const raw = (retryReading && retryReading.raw) || (sheetReading && sheetReading.raw) || '';
        return { raw, candidates };
    }

    // Reads the crops; see the header for the shape of the input and result
    async function read(grays) {
        await load();
        const started = performance.now();
        const stats = { sheetMs: 0, recognizeMs: 0, retryMs: 0, retries: 0, tiles: grays.filter(Boolean).length };
        const results = grays.map(() => ({ raw: '', candidates: [] }));
        if (!stats.tiles) { results.stats = stats; return results; }

        // One pass over the whole sheet
        const t0 = performance.now();
        const prepared = grays.map(prepare);
        const { sheet, tiles, gutter } = buildSheet(prepared);
        const sheetCanvas = Imaging.grayToCanvas(sheet, options.scale);
        stats.sheetMs = Math.round(performance.now() - t0);

        const t1 = performance.now();
        const { data } = await worker.recognize(sheetCanvas);
        stats.recognizeMs = Math.round(performance.now() - t1);
        const readings = assignWords(data.words || [], tiles, gutter);
        // With options.debug the first-pass and final readings of every tile are kept for inspection
        const firstPass = options.debug ? readings.map(r => (r ? { raw: r.raw, conf: Math.round(r.conf), symbols: r.symbols } : null)) : null;

        // Cells that came back empty or weak are read again on their own as a single word
        const weak = [];
        const retryReadings = grays.map(() => null);
        grays.forEach((g, k) => { if (g && (!readings[k] || readings[k].conf < RETRY_BELOW)) weak.push(k); });
        if (weak.length) {
            const t2 = performance.now();
            await worker.setParameters({ tessedit_pageseg_mode: PSM_SINGLE_WORD });
            for (const k of weak) {
                const result = await worker.recognize(Imaging.grayToCanvas(padGray(prepared[k], 24), options.scale));
                const raw = digitsOf(result.data.text);
                if (raw) retryReadings[k] = { raw, conf: result.data.confidence };
                stats.retries++;
            }
            await worker.setParameters({ tessedit_pageseg_mode: PSM_SPARSE_TEXT });
            stats.retryMs = Math.round(performance.now() - t2);
        }

        readings.forEach((r, k) => { if (grays[k]) results[k] = toEntry(r, retryReadings[k]); });
        stats.totalMs = Math.round(performance.now() - started);
        if (options.debug) stats.debug = { wordCount: (data.words || []).length, firstPass, final: results.map(e => (e.candidates.length ? { raw: e.raw, conf: Math.round(e.candidates[0].score * 100), alts: e.candidates.map(c => c.value) } : null)), sheet: sheetCanvas.toDataURL('image/png') };
        results.stats = stats;
        return results;
    }

    // Adds a white border so a lone crop has room around its digits
    function padGray(gray, pad) {
        const w = gray.width + pad * 2, h = gray.height + pad * 2;
        const data = new Uint8Array(w * h).fill(255);
        for (let y = 0; y < gray.height; y++) data.set(gray.data.subarray(y * gray.width, (y + 1) * gray.width), (y + pad) * w + pad);
        return { width: w, height: h, data };
    }

    async function dispose() {
        if (worker) { await worker.terminate(); worker = null; }
        workerPromise = null;
    }

    return {
        id: 'tesseract',
        version: '4.1.4/eng-best_int',
        READER_VERSION: TESSERACT_READER_VERSION,
        options,
        load, read, dispose
    };
})();
