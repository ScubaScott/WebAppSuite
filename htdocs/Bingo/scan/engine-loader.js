// Engine loader version identifier
const ENGINE_LOADER_VERSION = '1.2';

// Downloads the scanner engine files listed in engine/manifest.json into a dedicated Cache Storage
// bucket, verifies them, and loads the scripts from that cache. The service worker serves the same
// bucket cache-first, so a file is downloaded once and reused until the manifest names a new file.
const EngineLoader = (() => {
    // Cache bucket name; must match ENGINE_CACHE in sw.js
    const CACHE_NAME = 'bingo-scan-engine';

    // The engine folder sits next to this script
    const BASE_URL = new URL('engine/', document.currentScript.src);
    const MANIFEST_URL = new URL('manifest.json', BASE_URL).href;

    let manifest = null;
    let loaded = false;
    let persisted = null;
    const loadedEngines = new Set();

    // Detects WebAssembly SIMD support to pick the matching Tesseract core file
    function supportsSimd() {
        try {
            return WebAssembly.validate(new Uint8Array([
                0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11
            ]));
        } catch (err) {
            return false;
        }
    }

    // Fetches the manifest (always revalidated); falls back to a copy cached by the service worker when offline
    async function getManifest() {
        if (manifest) return manifest;
        try {
            const res = await fetch(MANIFEST_URL, { cache: 'no-cache' });
            if (res.ok) {
                manifest = await res.json();
                return manifest;
            }
        } catch (err) {
            // Offline: try the cached copy below
        }
        try {
            const cached = await caches.match(MANIFEST_URL, { ignoreSearch: true });
            if (cached) {
                manifest = await cached.json();
                return manifest;
            }
        } catch (err) {
            // No cache available
        }
        const error = new Error('Scanner file list unavailable. Connect to the internet once to download the scanner.');
        error.code = 'needs-download';
        throw error;
    }

    // Absolute URL of a manifest file entry
    function fileUrl(file) {
        return file.url || new URL(file.path, BASE_URL).href;
    }

    // Files an engine needs on this device (skips the core variant this browser cannot run)
    function requiredFiles(engine) {
        const simd = supportsSimd();
        return engine.files.filter(f => !f.requires || (f.requires === 'simd') === simd);
    }

    function engineIds(ids) {
        return ids && ids.length ? ids : Object.keys(manifest.engines);
    }

    // Reports which required files are cached and how many bytes remain to download
    async function status(ids) {
        await getManifest();
        const cache = await caches.open(CACHE_NAME);
        const result = { ready: true, totalBytes: 0, missingBytes: 0, missing: [], engines: {} };
        for (const id of engineIds(ids)) {
            const engine = manifest.engines[id];
            const entry = { label: engine.label, ready: true, missing: [] };
            for (const file of requiredFiles(engine)) {
                const size = file.bytes || file.approxBytes || 0;
                result.totalBytes += size;
                const hit = await cache.match(fileUrl(file));
                if (!hit) {
                    entry.ready = false;
                    entry.missing.push(fileUrl(file));
                    result.missing.push(fileUrl(file));
                    result.missingBytes += size;
                }
            }
            if (!entry.ready) result.ready = false;
            result.engines[id] = entry;
        }
        return result;
    }

    // Hex SHA-256 of a buffer, or null when the Web Crypto API is unavailable
    async function sha256Hex(buffer) {
        if (!window.crypto || !crypto.subtle) return null;
        const digest = await crypto.subtle.digest('SHA-256', buffer);
        return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    // Downloads one file into the cache, reporting bytes as they arrive
    async function downloadFile(cache, file, onBytes) {
        const url = fileUrl(file);

        // External files are fetched without CORS and stored as opaque responses (size and hash cannot be read)
        if (file.external) {
            const res = await fetch(url, { mode: 'no-cors' });
            await cache.put(url, res);
            onBytes(file.approxBytes || 0);
            return;
        }

        const res = await fetch(url, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`Download failed (${res.status}): ${file.path}`);

        // Read the body in chunks so the progress bar moves during large files
        const chunks = [];
        let received = 0;
        const reader = res.body && res.body.getReader ? res.body.getReader() : null;
        if (reader) {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                received += value.length;
                onBytes(value.length);
            }
        } else {
            const buf = new Uint8Array(await res.arrayBuffer());
            chunks.push(buf);
            received = buf.length;
            onBytes(buf.length);
        }
        const blob = new Blob(chunks, { type: res.headers.get('Content-Type') || 'application/octet-stream' });

        // Reject truncated or tampered downloads before they reach the cache
        if (file.bytes && received !== file.bytes) {
            throw new Error(`Size mismatch for ${file.path}: expected ${file.bytes}, got ${received}`);
        }
        if (file.sha256) {
            const actual = await sha256Hex(await blob.arrayBuffer());
            if (actual && actual !== file.sha256) throw new Error(`Checksum mismatch for ${file.path}`);
        }

        await cache.put(url, new Response(blob, {
            status: 200,
            headers: { 'Content-Type': blob.type, 'Content-Length': String(received) }
        }));
    }

    // Removes cached files that no engine in the manifest lists any more (old versions)
    async function cleanup() {
        const cache = await caches.open(CACHE_NAME);
        const keep = new Set();
        for (const engine of Object.values(manifest.engines)) {
            for (const file of engine.files) keep.add(fileUrl(file));
        }
        for (const request of await cache.keys()) {
            if (!keep.has(request.url)) await cache.delete(request);
        }
    }

    // Downloads every missing file for the requested engines. onProgress(loadedBytes, totalBytes, label)
    async function ensure(ids, onProgress) {
        await getManifest();
        const cache = await caches.open(CACHE_NAME);
        const st = await status(ids);
        if (st.ready) return st;

        let loadedBytes = 0;
        const total = st.missingBytes;
        const report = label => { if (onProgress) onProgress(Math.min(loadedBytes, total), total, label); };
        report('Starting');

        for (const id of engineIds(ids)) {
            for (const file of requiredFiles(manifest.engines[id])) {
                if (await cache.match(fileUrl(file))) continue;
                const label = manifest.engines[id].label;
                await downloadFile(cache, file, n => { loadedBytes += n; report(label); });
            }
        }

        // Ask the browser to keep the files through storage pressure. Some browsers show a permission
        // prompt, so the answer is recorded when it arrives and is never awaited here.
        try {
            if (navigator.storage && navigator.storage.persist) {
                navigator.storage.persist().then(granted => { persisted = granted; }, () => { persisted = false; });
            }
        } catch (err) {
            persisted = false;
        }
        await cleanup();
        return status(ids);
    }

    // Adds a classic script tag and resolves once it has executed
    function injectScript(url) {
        return new Promise((resolve, reject) => {
            const tag = document.createElement('script');
            tag.src = url;
            tag.onload = () => resolve();
            tag.onerror = () => reject(new Error('Could not load ' + url));
            document.head.appendChild(tag);
        });
    }

    // Waits until the OpenCV runtime has finished initializing
    async function waitForOpenCv() {
        const started = Date.now();
        while (Date.now() - started < 60000) {
            if (typeof cv !== 'undefined' && cv) {
                if (typeof cv.Mat === 'function') return;
                // Only a real Promise is awaited. The OpenCV module object itself has a .then method that
                // resolves to itself, so awaiting it would loop forever; it is polled for cv.Mat instead.
                if (cv instanceof Promise) {
                    try { window.cv = await cv; continue; } catch (err) { /* keep polling */ }
                }
            }
            await new Promise(r => setTimeout(r, 100));
        }
        throw new Error('The image engine did not start');
    }

    // Loads the scripts of the requested engines (their files must already be cached)
    async function load(ids) {
        await getManifest();
        for (const id of engineIds(ids)) {
            if (loadedEngines.has(id)) continue;
            const engine = manifest.engines[id];
            for (const script of engine.scripts) {
                await injectScript(script.startsWith('http') ? script : new URL(script, BASE_URL).href);
            }
            if (id === 'opencv') await waitForOpenCv();
            loadedEngines.add(id);
        }
        loaded = true;
    }

    // Options for Tesseract.createWorker() that point it at the cached local files
    function tesseractOptions() {
        const opts = manifest && manifest.engines.tesseract && manifest.engines.tesseract.options;
        if (!opts) return {};
        return {
            workerPath: new URL(opts.workerPath, BASE_URL).href,
            corePath: new URL(opts.corePath, BASE_URL).href,
            langPath: new URL(opts.langPath, BASE_URL).href,
            // The language file is stored uncompressed and already lives in the engine cache
            gzip: false,
            cacheMethod: 'none'
        };
    }

    return {
        VERSION: ENGINE_LOADER_VERSION,
        CACHE_NAME,
        getManifest,
        status,
        ensure,
        load,
        tesseractOptions,
        isLoaded: () => loaded,
        isPersisted: () => persisted
    };
})();
