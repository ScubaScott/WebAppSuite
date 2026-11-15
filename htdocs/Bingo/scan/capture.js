// Live capture version identifier
const CAPTURE_VERSION = '1.0';

// Guided capture for the Scan tab: draws the 5x5 window outline over the live camera picture, checks the picture a
// few times a second for the card's windows, and takes the photo by itself once the picture has been steady for a
// moment with enough windows in view. The decision rules (Capture.createShutter, Capture.frameDifference) are pure
// and testable without a browser; Capture.start wires them to a <video> and an overlay <canvas>.
const Capture = (() => {
    // Mean absolute difference between two consecutive thumbnails (0-255 gray levels) at or below this counts as steady.
    // Sensor noise on a still scene is about 1-2 levels; a hand-held shift of a fraction of a percent of the width is above 5.
    const STEADY_DIFF = 5;
    // The picture must stay steady this long before the photo is taken
    const STEADY_HOLD_MS = 600;
    // Windows that must be matched for the shutter to fire
    const MIN_WINDOWS = 16;
    // Pause after a photo was taken or the user went back to the camera, so the same card is not captured twice
    const COOLDOWN_MS = 1500;
    // Side of the gray thumbnails compared for steadiness
    const THUMB = 64;
    // Time between checks, and between window searches (a search costs tens of milliseconds)
    const TICK_MS = 100;
    const DETECT_EVERY_MS = 300;
    // The outline fills this share of the picture's width
    const OUTLINE_FILL = 0.8;

    // ---- Pure rules ----

    // Mean absolute difference of two equally long gray arrays
    function frameDifference(a, b) {
        if (!a || !b || a.length !== b.length || !a.length) return Infinity;
        let sum = 0;
        for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
        return sum / a.length;
    }

    // Decides when the photo is taken. Feed it every thumbnail difference (frame) and every window search (detection),
    // then ask for the state. Times are in milliseconds from any clock.
    //   state 'idle'      nothing to do (disabled, or cooling down after a photo)
    //   state 'moving'    the picture is not steady
    //   state 'searching' steady, but the card's windows are not (yet) seen
    //   state 'holding'   steady with enough windows; progress (0-1) counts up to the photo
    //   state 'fire'      take the photo now
    function createShutter(options) {
        const o = { diffLimit: STEADY_DIFF, holdMs: STEADY_HOLD_MS, minWindows: MIN_WINDOWS, cooldownMs: COOLDOWN_MS, ...options };
        let steadySince = null;
        let detection = null;
        let cooldownUntil = 0;

        return {
            frame(now, diff) {
                // During the cooldown nothing counts, so the steady wait starts only after it ends
                if (now < cooldownUntil) { steadySince = null; return; }
                if (diff <= o.diffLimit) { if (steadySince === null) steadySince = now; } else steadySince = null;
            },
            detection(now, result) { detection = { at: now, ok: !!(result && result.ok), windows: result && result.windows ? result.windows : 0 }; },
            // Forget the steady period and start the cooldown (after a photo, or when the camera is shown again)
            cooldown(now) { steadySince = null; detection = null; cooldownUntil = now + o.cooldownMs; },
            reset() { steadySince = null; detection = null; },
            // Whether the window search is worth running now: the picture is steady or nearly so
            wantsDetection(diff) { return diff <= o.diffLimit * 3; },
            state(now, enabled) {
                if (!enabled || now < cooldownUntil) return { state: 'idle', progress: 0, windows: detection ? detection.windows : 0 };
                const seen = detection && detection.ok && detection.windows >= o.minWindows;
                if (steadySince === null) return { state: 'moving', progress: 0, windows: detection ? detection.windows : 0 };
                // A search only counts when it was made during the current steady period
                const fresh = seen && detection.at >= steadySince;
                if (!fresh) return { state: 'searching', progress: 0, windows: detection ? detection.windows : 0 };
                const held = now - steadySince;
                return { state: held >= o.holdMs ? 'fire' : 'holding', progress: Math.min(1, held / o.holdMs), windows: detection.windows };
            }
        };
    }

    // Window rectangles of the default outline in a unit square, from the profile's window size. Returns
    // [{ x, y, w, h }] (25 entries, row-major, x/y of the top-left corner) with the outline filling OUTLINE_FILL of the width.
    function outlineRects(profile) {
        const cell = (profile || CardProfiles.slider).cell;
        // Width of the lattice in cell spacings: 4 spacings between the outer centers plus one window
        const span = 4 + cell.windowFrac;
        const pitch = OUTLINE_FILL / span;
        const w = cell.windowFrac * pitch, h = cell.windowFracY * pitch;
        const start = (1 - OUTLINE_FILL) / 2 + w / 2;
        const rects = [];
        for (let r = 0; r < 5; r++) {
            for (let c = 0; c < 5; c++) {
                const cx = start + c * pitch, cy = 0.5 + (r - 2) * pitch;
                rects.push({ x: cx - w / 2, y: cy - h / 2, w, h });
            }
        }
        return rects;
    }

    // ---- Browser wiring ----

    // Starts the guided capture loop. options:
    //   video       the live <video> element (shown as the center square of its picture)
    //   overlay     <canvas> laid over the video, same size
    //   hintEl      element that shows the hint line
    //   isActive()  true while the live picture is on screen (Scan tab open, no photo taken yet)
    //   isEnabled() true while auto-capture is switched on
    //   onFire()    called when the photo should be taken
    //   getProfile() id of the profile whose outline is drawn
    // Returns { stop(), cooldown(), state() }.
    function start(options) {
        const { video, overlay, hintEl } = options;
        const shutter = createShutter();
        const thumb = document.createElement('canvas');
        thumb.width = thumb.height = THUMB;
        const thumbCtx = thumb.getContext('2d', { willReadFrequently: true });
        let detectCanvas = null, detectCtx = null;
        let previous = null, lastDiff = Infinity, lastTime = -1, lastDetectAt = 0;
        let lastResult = null, lastState = { state: 'idle', progress: 0, windows: 0 };
        let timer = null;
        const HINT_DEFAULT = 'Flash off · open all windows · fill the outline';

        // Center square of the video picture, in video pixels
        function squareOf() {
            const m = Math.min(video.videoWidth, video.videoHeight);
            return { sx: (video.videoWidth - m) / 2, sy: (video.videoHeight - m) / 2, m };
        }

        function grayOf(img) {
            const g = new Uint8Array(img.width * img.height);
            for (let i = 0, p = 0; i < g.length; i++, p += 4) g[i] = (img.data[p] * 77 + img.data[p + 1] * 150 + img.data[p + 2] * 29) >> 8;
            return g;
        }

        function setHint(text) { if (hintEl && hintEl.textContent !== text) hintEl.textContent = text; }

        // Draws the outline (or the matched windows) and the state color
        function drawOverlay(state) {
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            const cssW = overlay.clientWidth, cssH = overlay.clientHeight;
            if (!cssW || !cssH) return;
            if (overlay.width !== Math.round(cssW * dpr) || overlay.height !== Math.round(cssH * dpr)) {
                overlay.width = Math.round(cssW * dpr);
                overlay.height = Math.round(cssH * dpr);
            }
            const g = overlay.getContext('2d');
            g.setTransform(dpr, 0, 0, dpr, 0, 0);
            g.clearRect(0, 0, cssW, cssH);
            if (!options.isActive()) return;

            const found = state.state === 'holding' || state.state === 'fire' || (lastResult && lastResult.ok && lastResult.windows >= MIN_WINDOWS);
            const color = state.state === 'holding' || state.state === 'fire' ? '46, 204, 113' : (found ? '255, 193, 7' : '255, 255, 255');
            g.lineWidth = 2;
            g.strokeStyle = `rgba(${color}, 0.9)`;
            g.fillStyle = `rgba(${color}, ${found ? 0.14 : 0.08})`;

            if (found && lastResult.H) {
                // Windows as the finder placed them (matched ones filled, predicted ones only outlined)
                const scale = cssW / lastResult.size;
                const seen = new Set(lastResult.used.map(u => u.col + ',' + u.row));
                const profile = CardProfiles[options.getProfile ? options.getProfile() : 'slider'] || CardProfiles.slider;
                const pitch = (lastResult.pitchX + lastResult.pitchY) / 2;
                const halfW = profile.cell.windowFrac * pitch / 2, halfH = profile.cell.windowFracY * pitch / 2;
                for (let r = 0; r < 5; r++) {
                    for (let c = 0; c < 5; c++) {
                        const p = Imaging.applyHomography(lastResult.H, c, r);
                        g.beginPath();
                        g.rect((p.x - halfW) * scale, (p.y - halfH) * scale, halfW * 2 * scale, halfH * 2 * scale);
                        if (seen.has(c + ',' + r)) g.fill();
                        g.stroke();
                    }
                }
            } else {
                const rects = outlineRects(CardProfiles[options.getProfile ? options.getProfile() : 'slider']);
                for (const rc of rects) {
                    g.beginPath();
                    g.rect(rc.x * cssW, rc.y * cssH, rc.w * cssW, rc.h * cssH);
                    g.fill();
                    g.stroke();
                }
            }
        }

        // Runs the quick window search on the center square of the picture
        function detect(now) {
            const profile = CardProfiles[options.getProfile ? options.getProfile() : 'slider'] || CardProfiles.slider;
            if (!profile.live) { shutter.detection(now, null); lastResult = null; return; }
            const size = profile.live.size;
            if (!detectCanvas) {
                detectCanvas = document.createElement('canvas');
                detectCtx = detectCanvas.getContext('2d', { willReadFrequently: true });
            }
            detectCanvas.width = detectCanvas.height = size;
            const q = squareOf();
            detectCtx.drawImage(video, q.sx, q.sy, q.m, q.m, 0, 0, size, size);
            const res = Geometry.detectLive(detectCtx.getImageData(0, 0, size, size), profile.id);
            res.size = size;
            lastResult = res;
            shutter.detection(now, res);
        }

        function tick() {
            if (!options.isActive() || document.hidden || !video.videoWidth || video.readyState < 2) {
                // Not looking: forget the last picture so a later steady spell starts fresh
                previous = null; lastDiff = Infinity; lastResult = null; shutter.reset();
                lastState = { state: 'idle', progress: 0, windows: 0 };
                drawOverlay(lastState);
                return;
            }
            // Only look at new frames: a stalled picture would otherwise count as perfectly steady
            if (video.currentTime === lastTime) return;
            lastTime = video.currentTime;

            const now = performance.now();
            const q = squareOf();
            thumbCtx.drawImage(video, q.sx, q.sy, q.m, q.m, 0, 0, THUMB, THUMB);
            const gray = grayOf(thumbCtx.getImageData(0, 0, THUMB, THUMB));
            lastDiff = frameDifference(previous, gray);
            previous = gray;
            shutter.frame(now, lastDiff);

            if (now - lastDetectAt >= DETECT_EVERY_MS && shutter.wantsDetection(lastDiff)) {
                lastDetectAt = now;
                detect(now);
            } else if (!shutter.wantsDetection(lastDiff)) {
                lastResult = null;
            }

            const state = shutter.state(now, options.isEnabled());
            lastState = state;
            if (state.state === 'moving' || state.state === 'idle' || state.state === 'searching') {
                setHint(state.state === 'moving' && lastResult ? 'Hold steady…' : HINT_DEFAULT);
            } else if (state.state === 'holding') {
                setHint(`Found ${state.windows} of 25 windows · hold steady…`);
            }
            drawOverlay(state);
            if (state.state === 'fire') {
                shutter.cooldown(now);
                setHint('Taking the photo…');
                options.onFire();
            }
        }

        timer = setInterval(tick, TICK_MS);
        return {
            stop() { clearInterval(timer); timer = null; },
            // Called when the camera is shown again after a photo
            cooldown() { shutter.cooldown(performance.now()); previous = null; lastResult = null; setHint(HINT_DEFAULT); },
            state() { return { ...lastState, diff: lastDiff, windows: lastResult && lastResult.ok ? lastResult.windows : 0 }; }
        };
    }

    return {
        VERSION: CAPTURE_VERSION, STEADY_DIFF, STEADY_HOLD_MS, MIN_WINDOWS, COOLDOWN_MS,
        frameDifference, createShutter, outlineRects, start
    };
})();
