// Domino live camera version identifier
const DOMINO_LIVE_VERSION = '1.0';

// Live camera for the scanner: shows the camera, outlines the tiles it finds a few times a second, and takes the picture
// either when the shutter is pressed or by itself once the camera and the tiles have held still for about a second.
// The picture is cut from a full-size video frame and handed back as a canvas; the page then runs it through the same
// outline check and review as an uploaded photo. Depends on DominoTiles (tiles.js).
const DominoLive = (() => {

    const DETECT_DIM = 640;            // frames are analysed at this size (long side), which keeps detection near five per second
    const DETECT_EVERY_MS = 200;       // pause between one detection finishing and the next starting
    const STEADY_TICKS = 5;            // consecutive steady detections needed before the picture is taken by itself
    const DIFF_LIMIT = 5;              // mean brightness change between two frames (0-255) that still counts as held still
    const MOVE_LIMIT = 0.03;           // a tile may move this fraction of the frame width between detections and still be steady
    const FULL_MAX_DIM = 3000;         // the captured picture is at most this large on its long side
    const GRID = 32;                   // frames are compared on a GRID x GRID sample of brightness

    // Creates a live camera.
    // options: { video, overlay, status, getTileColor(), isAuto(), onCapture(canvas), onProgress?(state) }
    function create(options) {
        const { video, overlay } = options;
        const small = document.createElement('canvas');
        const smallCtx = small.getContext('2d', { willReadFrequently: true });
        let stream = null;
        let running = false;
        let timer = null;
        let previousGrid = null;
        let previousCenters = null;
        let steadyTicks = 0;
        let cooldownUntil = 0;

        function setStatus(text, state) {
            options.status.textContent = text;
            options.status.dataset.state = state || '';
        }

        // Explains why the camera could not be opened, in words a player can act on
        function describeError(err) {
            if (!window.isSecureContext) return 'The camera needs a secure (https) page. Choose a photo instead.';
            if (err && err.name === 'NotAllowedError') return 'Camera permission was denied. Allow it in the browser, or choose a photo instead.';
            if (err && (err.name === 'NotFoundError' || err.name === 'OverconstrainedError')) return 'No camera was found. Choose a photo instead.';
            return 'The camera could not be started. Choose a photo instead.';
        }

        // Opens the camera and starts the detection loop. Rejects with an Error whose message is ready to show.
        async function start() {
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error(describeError(null));
            try {
                stream = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
                    audio: false
                });
                video.muted = true;
                video.srcObject = stream;
                await video.play();
            } catch (err) {
                stop();
                throw new Error(describeError(err));
            }
            running = true;
            previousGrid = null;
            previousCenters = null;
            steadyTicks = 0;
            cooldownUntil = Date.now() + 800;
            setStatus('Looking for tiles...', 'searching');
            timer = setTimeout(tick, DETECT_EVERY_MS);
        }

        // Turns the camera off and stops the loop
        function stop() {
            running = false;
            clearTimeout(timer);
            if (stream) stream.getTracks().forEach(track => track.stop());
            stream = null;
            video.srcObject = null;
            const ctx = overlay.getContext('2d');
            ctx.clearRect(0, 0, overlay.width, overlay.height);
        }

        // Mean brightness change since the previous detection, on a coarse grid (255 on the first frame)
        function frameChange(img) {
            const grid = new Float32Array(GRID * GRID);
            for (let gy = 0; gy < GRID; gy++) {
                for (let gx = 0; gx < GRID; gx++) {
                    const x = Math.floor((gx + 0.5) * img.width / GRID), y = Math.floor((gy + 0.5) * img.height / GRID);
                    const p = (y * img.width + x) * 4;
                    grid[gy * GRID + gx] = (img.data[p] + img.data[p + 1] + img.data[p + 2]) / 3;
                }
            }
            let change = 255;
            if (previousGrid) {
                change = 0;
                for (let i = 0; i < grid.length; i++) change += Math.abs(grid[i] - previousGrid[i]);
                change /= grid.length;
            }
            previousGrid = grid;
            return change;
        }

        // True when every tile center is close to a tile center from the previous detection (and there are as many)
        function tilesHeldStill(centers, width) {
            if (!previousCenters || previousCenters.length !== centers.length || !centers.length) return false;
            return centers.every(c => previousCenters.some(p => Math.hypot(c.x - p.x, c.y - p.y) <= MOVE_LIMIT * width));
        }

        // Draws the tile outlines over the video; (frameW, frameH) is the size of the analysed frame
        function draw(result, frameW, frameH) {
            const dpr = window.devicePixelRatio || 1;
            const w = Math.round(video.clientWidth * dpr), h = Math.round(video.clientHeight * dpr);
            if (overlay.width !== w || overlay.height !== h) { overlay.width = w; overlay.height = h; }
            const ctx = overlay.getContext('2d');
            ctx.clearRect(0, 0, w, h);
            const k = w / frameW;
            ctx.lineWidth = Math.max(2, w / 220);
            result.tiles.forEach(t => {
                const c = t.corners;
                ctx.beginPath();
                [c.tl, c.tr, c.br, c.bl].forEach((p, i) => (i ? ctx.lineTo(p.x * k, p.y * k) : ctx.moveTo(p.x * k, p.y * k)));
                ctx.closePath();
                ctx.fillStyle = 'rgba(240,180,41,0.16)';
                ctx.fill();
                ctx.strokeStyle = t.split ? '#4da3ff' : '#f0b429';
                ctx.stroke();
            });
            result.uncertain.forEach(u => {
                ctx.setLineDash([ctx.lineWidth * 3, ctx.lineWidth * 2]);
                ctx.strokeStyle = '#ff6b6b';
                ctx.strokeRect(u.box.x * k, u.box.y * k, u.box.w * k, u.box.h * k);
                ctx.setLineDash([]);
            });
        }

        // One detection: analyse the current frame, draw it, update the steady count and the status line, and take the
        // picture when auto is on and everything has held still long enough
        function tick() {
            if (!running) return;
            const next = () => { if (running) timer = setTimeout(tick, DETECT_EVERY_MS); };
            if (document.hidden || video.readyState < 2 || !video.videoWidth) { next(); return; }

            const k = Math.min(1, DETECT_DIM / Math.max(video.videoWidth, video.videoHeight));
            small.width = Math.max(1, Math.round(video.videoWidth * k));
            small.height = Math.max(1, Math.round(video.videoHeight * k));
            smallCtx.drawImage(video, 0, 0, small.width, small.height);
            const img = smallCtx.getImageData(0, 0, small.width, small.height);

            const change = frameChange(img);
            const result = DominoTiles.detect(img, { tileColor: options.getTileColor() });
            draw(result, small.width, small.height);

            const centers = result.tiles.map(t => t.center);
            const still = change <= DIFF_LIMIT && tilesHeldStill(centers, small.width);
            steadyTicks = still ? steadyTicks + 1 : 0;
            previousCenters = centers;

            const count = result.tiles.length;
            if (!count) {
                setStatus('No tiles found. Spread them out on a plain surface.', 'searching');
            } else if (result.uncertain.length) {
                setStatus(count + (count === 1 ? ' tile' : ' tiles') + '. Some touch side by side: spread them apart.', 'warn');
            } else if (steadyTicks > 0) {
                const hold = options.isAuto() ? ' Hold steady...' : ' Steady.';
                setStatus(count + (count === 1 ? ' tile.' : ' tiles.') + hold, 'steady');
            } else {
                setStatus(count + (count === 1 ? ' tile.' : ' tiles.') + ' Hold the camera still.', 'moving');
            }

            if (options.isAuto() && steadyTicks >= STEADY_TICKS && Date.now() >= cooldownUntil && !result.uncertain.length) {
                capture();
                return;
            }
            next();
        }

        // Takes the picture now: a full-size frame (at most FULL_MAX_DIM on its long side) as a canvas, then stops the camera
        function capture() {
            if (!running || !video.videoWidth) return null;
            const k = Math.min(1, FULL_MAX_DIM / Math.max(video.videoWidth, video.videoHeight));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(video.videoWidth * k));
            canvas.height = Math.max(1, Math.round(video.videoHeight * k));
            canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
            cooldownUntil = Infinity;
            stop();
            options.onCapture(canvas);
            return canvas;
        }

        return { start, stop, capture, isRunning: () => running };
    }

    return { VERSION: DOMINO_LIVE_VERSION, create };
})();
