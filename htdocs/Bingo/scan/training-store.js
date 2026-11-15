// Training store version identifier
const TRAINING_STORE_VERSION = '1.1';

// Collects confirmed card scans as training samples and sends them to the server in the background.
// A sample is the 25 number crops of a scan (tiled on one sheet) plus the numbers the user confirmed and what the
// scanner had guessed. Samples are kept in IndexedDB until the server accepts them (an outbox, as in sync.js), so
// scanning works offline and nothing is lost when the connection drops. See bingo-scan-redesign-spec.md, section 9.
const TrainingStore = (() => {
    const DB_NAME = 'bingo-scan-training';
    const STORE = 'samples';
    const SETTINGS_KEY = 'bingoScanTrainingSettings';
    const SCHEMA = 1;

    // Retry waits after a failed upload, doubling up to one hour
    const BACKOFF_MS = [30000, 60000, 120000, 300000, 900000, 3600000];
    // A scan with fewer confirmed numbers than this is not worth keeping
    const MIN_LABELS = 8;
    // Standard 75-ball column ranges
    const RANGES = [[1, 15], [16, 30], [31, 45], [46, 60], [61, 75]];
    const FREE_INDEX = 12;

    const DEFAULTS = {
        contribute: true,        // on by default for everyone
        includePhoto: false,     // the full photo is only sent when this is switched on
        noticeSeen: false,       // the one-time explanation before the first Apply
        uploaded: 0,             // samples the server has accepted (count only; the data is deleted locally)
        blocked: null            // { reason, appVersion } when the server said it is full, until the next app version
    };

    const listeners = new Set();
    let memorySettings = null;
    let dbPromise = null;
    let draining = false;
    let drainTimer = null;
    let currentAppVersion = '';

    // ---- Settings (localStorage, with an in-memory fallback when storage is unavailable) ----

    function getSettings() {
        let stored = null;
        try { stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch (e) { stored = null; }
        if (!stored && memorySettings) stored = memorySettings;
        return Object.assign({}, DEFAULTS, stored || {});
    }

    function setSettings(patch) {
        const next = Object.assign(getSettings(), patch);
        memorySettings = next;
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch (e) { /* kept in memory */ }
        notify();
        return next;
    }

    function notify() {
        listeners.forEach(fn => { try { fn(); } catch (e) { /* a listener must not break the others */ } });
    }

    // ---- IndexedDB ----

    function openDb() {
        if (!dbPromise) {
            dbPromise = new Promise((resolve, reject) => {
                if (!window.indexedDB) { reject(new Error('IndexedDB is not available')); return; }
                const req = indexedDB.open(DB_NAME, 1);
                req.onupgradeneeded = () => {
                    const db = req.result;
                    const store = db.createObjectStore(STORE, { keyPath: 'id' });
                    store.createIndex('status', 'status', { unique: false });
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
            dbPromise.catch(() => { dbPromise = null; });
        }
        return dbPromise;
    }

    async function withStore(mode, fn) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, mode);
            const result = fn(tx.objectStore(STORE));
            tx.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    }

    const putEntry = entry => withStore('readwrite', s => s.put(entry));
    const deleteEntry = id => withStore('readwrite', s => s.delete(id));
    const allEntries = () => withStore('readonly', s => s.getAll());

    // ---- Building a sample ----

    // Short description of the browser and screen, at most 100 characters
    function deviceString(userAgent, screenInfo) {
        const ua = userAgent || '';
        const browser = (/(Edg|OPR|Firefox|CriOS|FxiOS)\/(\d+)/.exec(ua) || /(Chrome|Safari)\/(\d+)/.exec(ua) || [])
            .slice(1, 3).join(' ');
        // Most specific first: an Android user agent also contains "Linux", and an iPhone's contains "Mac OS"
        const os = ['Android', 'iPhone', 'iPad', 'CrOS', 'Windows', 'Macintosh', 'Linux'].find(name => ua.includes(name)) || 'unknown';
        const screenText = screenInfo ? `${screenInfo.width}x${screenInfo.height}@${screenInfo.ratio}` : '';
        return `${browser || 'browser'} / ${os}; ${screenText}`.slice(0, 100);
    }

    // The 25 per-cell records. `labels` is the 25-value grid the user confirmed (numbers, null for blank/FREE);
    // `decodedCells` is the decoder's per-cell output. A confirmed number that cannot be right (outside its column
    // range, or repeated) is dropped, because a label that breaks the card rules would poison the training data.
    function buildCellRecords(labels, decodedCells) {
        const byIndex = new Map((decodedCells || []).map(c => [c.index, c]));
        const seen = new Set();
        const cells = [];
        for (let i = 0; i < 25; i++) {
            if (i === FREE_INDEX) {
                cells.push({ label: null, predicted: null, score: null, corrected: false, covered: false, glare: false });
                continue;
            }
            let label = Number.isInteger(labels[i]) ? labels[i] : null;
            if (label !== null) {
                const [lo, hi] = RANGES[i % 5];
                if (label < lo || label > hi || seen.has(label)) label = null;
                else seen.add(label);
            }
            const d = byIndex.get(i);
            const predicted = d && Number.isInteger(d.value) ? d.value : null;
            cells.push({
                label,
                predicted,
                score: d && typeof d.score === 'number' ? Math.round(d.score * 1000) / 1000 : null,
                corrected: label !== predicted,
                covered: !!(d && d.covered),
                glare: !!(d && d.glare)
            });
        }
        return cells;
    }

    const round2 = v => (typeof v === 'number' ? Math.round(v * 100) / 100 : v);

    // What the window finder saw, small enough to store with every sample
    function geometrySummary(g) {
        return {
            windows: g.windows, err: typeof g.err === 'number' ? Math.round(g.err * 10000) / 10000 : null, mode: g.mode || null, ms: g.ms || null,
            scale: round2(g.scale), pitchX: round2(g.pitchX), pitchY: round2(g.pitchY),
            windowFrac: typeof g.windowFrac === 'number' ? Math.round(g.windowFrac * 1000) / 1000 : null,
            windowFracY: typeof g.windowFracY === 'number' ? Math.round(g.windowFracY * 1000) / 1000 : null,
            H: (g.H || []).map(v => Math.round(v * 1e6) / 1e6),
            used: (g.used || []).map(u => ({ col: u.col, row: u.row, x: round2(u.x), y: round2(u.y) })),
            photo: g.photo || null
        };
    }

    function canvasToBlob(canvas, quality) {
        return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not encode image'))), 'image/jpeg', quality));
    }

    // A 1000 px copy of the photo, JPEG, no larger than the server accepts
    async function photoBlob(photoCanvas) {
        const { canvas } = Imaging.downscaleCanvas(photoCanvas, 1000);
        for (const quality of [0.8, 0.65, 0.5]) {
            const blob = await canvasToBlob(canvas, quality);
            if (blob.size <= 290 * 1024) return blob;
        }
        return null;
    }

    // Builds the sample for one confirmed scan. Returns { record, sheet, photo } or null when it is not worth keeping.
    async function buildSample({ read, geometry, photoCanvas, labels, appVersion }) {
        const cells = buildCellRecords(labels, read.decoded.cells);
        if (cells.filter(c => c.label !== null).length < MIN_LABELS) return null;

        // Clean crops, no debug outlines: exactly what the readers saw
        const sheetCanvas = Geometry.drawCellSheet(read.cells, { marks: false });
        if (!sheetCanvas) return null;
        const sheet = await canvasToBlob(sheetCanvas, 0.9);

        const settings = getSettings();
        const photo = settings.includePhoto && photoCanvas ? await photoBlob(photoCanvas) : null;

        const id = (crypto.randomUUID ? crypto.randomUUID() : fallbackUuid());
        const record = {
            schema: SCHEMA,
            id,
            createdAt: new Date().toISOString(),
            appVersion: String(appVersion || currentAppVersion),
            profile: geometry.profileId,
            reader: { id: read.reader.id, version: read.reader.version },
            device: deviceString(navigator.userAgent, { width: screen.width, height: screen.height, ratio: window.devicePixelRatio || 1 }),
            cells,
            meta: {
                profileScores: geometry.profileScores || {},
                geometry: geometrySummary(geometry),
                versions: {
                    ocr: typeof OCR_VERSION !== 'undefined' ? OCR_VERSION : null,
                    geometry: typeof GEOMETRY_VERSION !== 'undefined' ? GEOMETRY_VERSION : null,
                    decoder: typeof DECODER_VERSION !== 'undefined' ? DECODER_VERSION : null,
                    profiles: typeof PROFILES_VERSION !== 'undefined' ? PROFILES_VERSION : null,
                    imaging: typeof IMAGING_VERSION !== 'undefined' ? IMAGING_VERSION : null,
                    store: TRAINING_STORE_VERSION
                },
                decoderScore: read.decoded && typeof read.decoded.score === 'number' ? Math.round(read.decoded.score * 1000) / 1000 : null
            }
        };
        return { record, sheet, photo };
    }

    function fallbackUuid() {
        const b = crypto.getRandomValues(new Uint8Array(16));
        b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
        const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    }

    // ---- Queue and upload ----

    function blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
        });
    }

    function apiUrl(path) {
        if (window.BingoSync && BingoSync.resolveApiUrl) return BingoSync.resolveApiUrl(path);
        return (window.location.pathname.includes('/scan/') ? '../../' : '/') + path;
    }

    function authHeader() {
        try {
            if (window.SuiteProfile && !SuiteProfile.isGuest()) {
                const user = SuiteProfile.getUser();
                if (user && user.token) return { Authorization: 'Bearer ' + user.token };
            }
        } catch (e) { /* guest */ }
        return {};
    }

    // Fast reachability check so a drain does not wait on a dead connection
    async function serverReachable() {
        if (!navigator.onLine) return false;
        if (window.BingoSync && BingoSync.pingHealth) return BingoSync.pingHealth();
        try { return (await fetch(apiUrl('api/health'), { method: 'HEAD', cache: 'no-store' })).ok; } catch (e) { return false; }
    }

    // Saves a built sample in the outbox
    async function enqueue(built) {
        await putEntry({
            id: built.record.id, status: 'queued', createdAt: built.record.createdAt, attempts: 0, nextTry: 0,
            appVersion: built.record.appVersion, record: built.record, sheet: built.sheet, photo: built.photo, exported: false
        });
        notify();
    }

    // Records a confirmed scan (when contributing is on) and starts sending it. Returns the sample id or null.
    async function recordScan(args) {
        if (!getSettings().contribute) return null;
        const built = await buildSample(args);
        if (!built) return null;
        await enqueue(built);
        drain();           // runs in the background
        return built.record.id;
    }

    function backoffFor(attempts) {
        return BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1] || BACKOFF_MS[BACKOFF_MS.length - 1];
    }

    function scheduleDrain(entries) {
        clearTimeout(drainTimer);
        const waiting = entries.filter(e => e.status === 'queued' && e.nextTry > Date.now());
        if (!waiting.length) return;
        const wait = Math.max(1000, Math.min(...waiting.map(e => e.nextTry)) - Date.now());
        drainTimer = setTimeout(drain, Math.min(wait, 3600000));
    }

    // Sends queued samples one at a time. Stops at the first sign the server cannot take more right now.
    async function drain() {
        if (draining) return;
        const settings = getSettings();
        if (settings.blocked) {
            // A full server stays blocked until the app is updated
            if (settings.blocked.appVersion === currentAppVersion) return;
            setSettings({ blocked: null });
        }
        draining = true;
        try {
            let entries = await allEntries();
            const due = entries.filter(e => e.status === 'queued' && e.nextTry <= Date.now()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
            if (!due.length) { scheduleDrain(entries); return; }
            if (!(await serverReachable())) {
                for (const e of due) { e.nextTry = Date.now() + backoffFor(e.attempts + 1); e.attempts++; await putEntry(e); }
                scheduleDrain(await allEntries());
                return;
            }

            for (const entry of due) {
                const body = Object.assign({}, entry.record, { sheet: await blobToBase64(entry.sheet) });
                if (entry.photo) body.photo = await blobToBase64(entry.photo);
                let res;
                try {
                    res = await fetch(apiUrl('api/training'), {
                        method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, authHeader()), body: JSON.stringify(body)
                    });
                } catch (err) {
                    // Network trouble: try again later, with a longer wait each time
                    entry.attempts++; entry.nextTry = Date.now() + backoffFor(entry.attempts); await putEntry(entry);
                    break;
                }
                if (res.ok) {
                    // Accepted (or already stored): the local images are no longer needed
                    await deleteEntry(entry.id);
                    setSettings({ uploaded: getSettings().uploaded + 1 });
                } else if (res.status === 429) {
                    const wait = (parseInt(res.headers.get('Retry-After'), 10) || 3600) * 1000;
                    entry.nextTry = Date.now() + wait; await putEntry(entry);
                    break;
                } else if (res.status === 507) {
                    setSettings({ blocked: { reason: 'full', appVersion: currentAppVersion } });
                    break;
                } else if (res.status >= 500) {
                    entry.attempts++; entry.nextTry = Date.now() + backoffFor(entry.attempts); await putEntry(entry);
                    break;
                } else {
                    // The server refused this sample (400, 413...): keep it for export, retry only after an app update
                    let message = '';
                    try { message = (await res.json()).error || ''; } catch (e) { /* no body */ }
                    entry.status = 'failed'; entry.error = `${res.status} ${message}`.trim(); await putEntry(entry);
                }
                notify();
            }
            scheduleDrain(await allEntries());
        } catch (err) {
            console.warn('Training upload paused:', err);
        } finally {
            draining = false;
            notify();
        }
    }

    // ---- Counts, export, housekeeping ----

    async function counts() {
        let entries = [];
        try { entries = await allEntries(); } catch (e) { /* storage unavailable */ }
        const settings = getSettings();
        return {
            queued: entries.filter(e => e.status === 'queued').length,
            failed: entries.filter(e => e.status === 'failed').length,
            exported: entries.filter(e => e.exported).length,
            uploaded: settings.uploaded,
            blocked: settings.blocked,
            nextTry: Math.min(Infinity, ...entries.filter(e => e.status === 'queued' && e.nextTry > Date.now()).map(e => e.nextTry))
        };
    }

    // Samples that are still on this device (waiting or refused) as the exact bodies the server accepts, in one JSON file
    async function exportQueued() {
        const entries = (await allEntries()).filter(e => e.status !== 'uploaded');
        if (!entries.length) return { count: 0 };
        const samples = [];
        for (const e of entries) {
            const sample = Object.assign({}, e.record, { sheet: await blobToBase64(e.sheet) });
            if (e.photo) sample.photo = await blobToBase64(e.photo);
            samples.push(sample);
        }
        const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const name = `bingo-scan-samples-${day}.json`;
        const file = new File([JSON.stringify({ schema: SCHEMA, exportedAt: new Date().toISOString(), samples })], name, { type: 'application/json' });

        let shared = false;
        try {
            if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'Bingo scan samples' }); shared = true; }
        } catch (err) {
            if (err && err.name === 'AbortError') return { count: 0, cancelled: true };
        }
        if (!shared) {
            const url = URL.createObjectURL(file);
            const a = document.createElement('a');
            a.href = url; a.download = name;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 10000);
        }
        for (const e of entries) { e.exported = true; await putEntry(e); }
        notify();
        return { count: samples.length, name };
    }

    // Removes samples that were exported (the user has them saved elsewhere)
    async function clearExported() {
        const entries = (await allEntries()).filter(e => e.exported);
        for (const e of entries) await deleteEntry(e.id);
        notify();
        return entries.length;
    }

    // Starts the store: remembers the app version, retries refused samples after an update, resumes sending
    async function init(appVersion) {
        currentAppVersion = String(appVersion || '');
        window.addEventListener('online', () => drain());
        try {
            const entries = await allEntries();
            for (const e of entries) {
                // A newer app may fix what the server refused, so refused samples get another chance once per version
                if (e.status === 'failed' && e.appVersion !== currentAppVersion) { e.status = 'queued'; e.nextTry = 0; e.attempts = 0; e.appVersion = currentAppVersion; await putEntry(e); }
            }
        } catch (err) { /* no storage: nothing to resume */ }
        drain();
    }

    return {
        VERSION: TRAINING_STORE_VERSION,
        // settings
        getSettings, setSettings,
        shouldShowNotice: () => getSettings().contribute && !getSettings().noticeSeen,
        onChange: fn => listeners.add(fn),
        // building and sending
        buildCellRecords, deviceString, buildSample, recordScan, drain,
        // housekeeping
        counts, exportQueued, clearExported, init
    };
})();
