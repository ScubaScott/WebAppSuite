// Domino scanner page controller version identifier
const SCAN_PAGE_VERSION = '1.2';

// Photo to score: gets a photo (live camera, or a file the user picks), shows the detected tile outlines for the
// user to confirm, straightens and counts each tile, lets the user correct the result in the review grid, then hands the hand's score back to the
// game. The game page records it (see consumePendingScan in ../app.js), so there is one writer of game state.

const SCAN_STORAGE = { game: 'dominoGame', pending: 'dominoPendingScan', prefs: 'dominoScanPrefs' };
const MAX_PHOTO_DIM = 3000;          // photos are reduced to this size before analysis
const OUTLINE_MAX_WIDTH = 1200;      // width of the picture shown on the outline step

const scanEl = id => document.getElementById(id);

let scanGame = null;                 // the game this scan belongs to
let scanPlayer = null;               // the player whose hand is scanned
let scanRound = 0;                   // round index being scored
let photo = null;                    // { canvas, img } the loaded photo and its pixels
let detection = null;                // result of DominoTiles.detect for the current photo
const excluded = new Set();          // detected tiles the user tapped to leave out
let review = null;                   // DominoReview controller
let live = null;                     // DominoLive controller

// ───────────────────────── Steps ─────────────────────────

// Shows one step section (and the sticky review bar only on the review step)
function showStep(name) {
    // Leaving the live step always turns the camera off
    if (name !== 'stepLive' && live && live.isRunning()) live.stop();
    ['stepError', 'stepPhoto', 'stepLive', 'stepOutline', 'stepReview'].forEach(id => {
        scanEl(id).hidden = id !== name;
    });
    scanEl('reviewBar').hidden = name !== 'stepReview';
    window.scrollTo(0, 0);
}

function setPhotoStatus(message) {
    const node = scanEl('photoStatus');
    node.textContent = message || '';
    node.hidden = !message;
}

// ───────────────────────── Photo and detection ─────────────────────────

// Reads an image file into a canvas no larger than MAX_PHOTO_DIM and returns its pixels
async function readPhoto(file) {
    let bitmap;
    if (window.createImageBitmap) {
        bitmap = await createImageBitmap(file);
    } else {
        bitmap = await new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const image = new Image();
            image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
            image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('The photo could not be read.')); };
            image.src = url;
        });
    }
    const width = bitmap.width || bitmap.naturalWidth;
    const height = bitmap.height || bitmap.naturalHeight;
    const k = Math.min(1, MAX_PHOTO_DIM / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * k));
    canvas.height = Math.max(1, Math.round(height * k));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (bitmap.close) bitmap.close();
    return { canvas, img: ctx.getImageData(0, 0, canvas.width, canvas.height) };
}

// A file picked from either file input (the photo step's or the live step's)
async function onPhotoChosen(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    showStep('stepPhoto');
    setPhotoStatus('Reading photo...');
    try {
        photo = await readPhoto(file);
    } catch (err) {
        setPhotoStatus('That photo could not be opened. Try another one.');
        return;
    }
    setPhotoStatus('');
    openOutlineStep();
}

// Shows the outline step for the current photo
function openOutlineStep() {
    showStep('stepOutline');
    // Clear the previous photo's summary until this photo's tiles are found
    scanEl('outlineSummary').textContent = 'Finding tiles...';
    scanEl('outlineWarn').hidden = true;
    // Let the outline step paint before the (brief) detection work starts
    setTimeout(runDetection, 30);
}

// ───────────────────────── Live camera ─────────────────────────

function readPrefs() {
    try { return JSON.parse(localStorage.getItem(SCAN_STORAGE.prefs)) || {}; } catch (err) { return {}; }
}

function writePrefs(patch) {
    try { localStorage.setItem(SCAN_STORAGE.prefs, JSON.stringify(Object.assign(readPrefs(), patch))); } catch (err) { /* kept for this visit only */ }
}

// Opens the camera; on failure the reason is shown on the photo step, where choosing a photo still works
async function startLive() {
    scanEl('liveColorSelect').value = scanEl('tileColorSelect').value;
    scanEl('autoShutter').checked = readPrefs().auto !== false;
    showStep('stepLive');
    scanEl('liveStatus').textContent = 'Starting the camera...';
    try {
        await live.start();
    } catch (err) {
        showStep('stepPhoto');
        setPhotoStatus(err.message);
    }
}

// The live camera took the picture: use the frame exactly like a chosen photo
function onLiveCaptured(canvas) {
    photo = { canvas, img: canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height) };
    scanEl('tileColorSelect').value = scanEl('liveColorSelect').value;
    setPhotoStatus('');
    openOutlineStep();
}

// Downloads the current photo as a JPEG, so it can be kept for tuning the scanner
function savePhoto() {
    if (!photo) return;
    photo.canvas.toBlob(blob => {
        if (!blob) return;
        const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'dominoes-' + stamp + '.jpg';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    }, 'image/jpeg', 0.92);
}

// Finds the tiles in the current photo and draws the outlines
function runDetection() {
    if (!photo) return;
    detection = DominoTiles.detect(photo.img, { tileColor: scanEl('tileColorSelect').value });
    excluded.clear();
    drawOutlines();
}

// Draws the photo with a polygon around every detected tile; excluded tiles are dimmed, touching tiles boxed
function drawOutlines() {
    const canvas = scanEl('photoCanvas');
    const k = Math.min(1, OUTLINE_MAX_WIDTH / photo.canvas.width);
    canvas.width = Math.round(photo.canvas.width * k);
    canvas.height = Math.round(photo.canvas.height * k);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(photo.canvas, 0, 0, canvas.width, canvas.height);

    const line = Math.max(2, canvas.width / 300);
    ctx.lineWidth = line;
    ctx.font = 'bold ' + Math.round(line * 8) + 'px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    detection.tiles.forEach((tile, i) => {
        const c = tile.corners;
        const pts = [c.tl, c.tr, c.br, c.bl].map(p => ({ x: p.x * k, y: p.y * k }));
        const off = excluded.has(i);
        ctx.beginPath();
        pts.forEach((p, n) => (n ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.closePath();
        ctx.fillStyle = off ? 'rgba(0,0,0,0.35)' : 'rgba(240,180,41,0.18)';
        ctx.fill();
        ctx.setLineDash(off ? [line * 3, line * 2] : []);
        ctx.strokeStyle = off ? '#9aa4b2' : (tile.split ? '#4da3ff' : '#f0b429');
        ctx.stroke();
        ctx.setLineDash([]);
        // Number on a dark outline so it reads on both pale and dark tiles
        ctx.lineJoin = 'round';
        ctx.lineWidth = line * 2;
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.strokeText(String(i + 1), tile.center.x * k, tile.center.y * k);
        ctx.lineWidth = line;
        ctx.fillStyle = off ? '#c3cad4' : '#ffffff';
        ctx.fillText(String(i + 1), tile.center.x * k, tile.center.y * k);
    });

    detection.uncertain.forEach(u => {
        ctx.setLineDash([line * 3, line * 2]);
        ctx.strokeStyle = '#ff6b6b';
        ctx.strokeRect(u.box.x * k, u.box.y * k, u.box.w * k, u.box.h * k);
        ctx.setLineDash([]);
    });

    updateOutlineText();
}

function updateOutlineText() {
    const used = detection.tiles.length - excluded.size;
    scanEl('outlineSummary').textContent = detection.tiles.length
        ? used + ' of ' + detection.tiles.length + ' tiles will be counted. Tap an outline to leave a tile out.'
        : 'No tiles found. Try the Light or Dark setting, or retake the photo.';
    const warn = scanEl('outlineWarn');
    const notes = [];
    if (detection.uncertain.length) notes.push('Tiles in the red box are touching side by side. Spread them apart and retake, or add them by hand.');
    if (detection.tiles.some(t => t.split)) notes.push('Blue outlines are tiles that touched end to end and were separated by size.');
    warn.textContent = notes.join(' ');
    warn.hidden = !notes.length;
    scanEl('useTilesBtn').disabled = false;
}

// Tapping inside a tile outline toggles whether that tile is counted
function onOutlineTap(event) {
    if (!detection) return;
    const canvas = scanEl('photoCanvas');
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width * photo.canvas.width;
    const y = (event.clientY - rect.top) / rect.height * photo.canvas.height;
    const index = detection.tiles.findIndex(t => insideQuad(x, y, t.corners));
    if (index < 0) return;
    if (excluded.has(index)) excluded.delete(index); else excluded.add(index);
    drawOutlines();
}

// True when the point lies inside the four-cornered shape (all cross products share a sign)
function insideQuad(x, y, c) {
    const pts = [c.tl, c.tr, c.br, c.bl];
    let sign = 0;
    for (let i = 0; i < 4; i++) {
        const a = pts[i], b = pts[(i + 1) % 4];
        const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
        if (cross === 0) continue;
        const s = cross > 0 ? 1 : -1;
        if (sign && s !== sign) return false;
        sign = s;
    }
    return true;
}

// Straightens and counts every counted tile, then opens the review grid
function useTiles() {
    const tileColor = scanEl('tileColorSelect').value;
    const items = [];
    detection.tiles.forEach((tile, i) => {
        if (excluded.has(i)) return;
        const crop = DominoTiles.extractTile(photo.img, tile);
        if (!crop) return;
        const result = DominoPips.analyze(crop, { tileColor });
        const canvas = document.createElement('canvas');
        canvas.width = crop.width;
        canvas.height = crop.height;
        canvas.getContext('2d').putImageData(new ImageData(crop.data, crop.width, crop.height), 0, 0);
        items.push({ canvas, dividerX: result.dividerX, left: result.left, right: result.right });
    });
    review.setTiles(items);
    showStep('stepReview');
}

// ───────────────────────── Hand total and hand-off ─────────────────────────

function onReviewChange(summary) {
    scanEl('handPoints').textContent = String(summary.points);
    scanEl('handInfo').textContent = summary.tiles + (summary.tiles === 1 ? ' tile' : ' tiles') +
        (summary.flagged ? ' · ' + summary.flagged + ' to check' : '');
    scanEl('reviewEmpty').hidden = summary.tiles > 0;
    scanEl('useScoreBtn').disabled = summary.tiles === 0;
}

// Hands the score to the game page, which records it for the player and round
function useScore() {
    const summary = review.summary();
    if (!summary.tiles) return;
    if (summary.flagged && !confirm(summary.flagged + ' tile(s) still need a second look. Use this score anyway?')) return;
    try {
        localStorage.setItem(SCAN_STORAGE.pending, JSON.stringify({
            gameId: scanGame.id,
            playerId: scanPlayer.id,
            round: scanRound,
            points: summary.points,
            tiles: summary.items,
            at: Date.now()
        }));
    } catch (err) {
        alert('The score could not be saved on this device.');
        return;
    }
    window.location.href = '../index.html';
}

function startOver() {
    photo = null;
    detection = null;
    excluded.clear();
    setPhotoStatus('');
    showStep('stepPhoto');
}

// ───────────────────────── Start-up ─────────────────────────

// Reads the saved game and picks out the player and round named in the address
function loadContext() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(SCAN_STORAGE.game)); } catch (err) { raw = null; }
    const game = DominoCore.normalizeGame(raw);
    if (!game) return false;
    const params = new URLSearchParams(window.location.search);
    const player = game.players.find(p => p.id === params.get('player'));
    const round = Number(params.get('round'));
    if (!player || !Number.isInteger(round) || round < 0 || round >= game.rounds.length) return false;
    scanGame = game;
    scanPlayer = player;
    scanRound = round;
    return true;
}

function initScan() {
    scanEl('scanVersion').textContent = SCAN_PAGE_VERSION;
    if (!loadContext()) {
        showStep('stepError');
        return;
    }
    const double = DominoCore.roundDouble(scanGame.settings, scanRound);
    scanEl('scanWho').textContent = scanPlayer.name;
    scanEl('scanWhat').textContent = 'Round ' + (scanRound + 1) + ' · Engine ' + double + '|' + double;
    scanEl('tileColorSelect').value = scanGame.settings.tileColor;

    review = DominoReview.create({
        grid: scanEl('tileGrid'),
        setMax: scanGame.settings.setMax,
        blankValue: scanGame.settings.doubleBlankValue,
        onChange: onReviewChange,
        editor: {
            dialog: scanEl('tileDlg'),
            stage: scanEl('edStage'),
            title: scanEl('edTitle'),
            readout: scanEl('edReadout'),
            flags: scanEl('edFlags'),
            prev: scanEl('edPrev'),
            next: scanEl('edNext'),
            remove: scanEl('edRemove'),
            done: scanEl('edDone'),
            left: { minus: scanEl('edLeftMinus'), plus: scanEl('edLeftPlus'), blank: scanEl('edLeftBlank'), count: scanEl('edLeftCount') },
            right: { minus: scanEl('edRightMinus'), plus: scanEl('edRightPlus'), blank: scanEl('edRightBlank'), count: scanEl('edRightCount') }
        }
    });

    live = DominoLive.create({
        video: scanEl('liveVideo'),
        overlay: scanEl('liveOverlay'),
        status: scanEl('liveStatus'),
        getTileColor: () => scanEl('liveColorSelect').value,
        isAuto: () => scanEl('autoShutter').checked,
        onCapture: onLiveCaptured
    });

    scanEl('photoInput').addEventListener('change', onPhotoChosen);
    scanEl('liveFileInput').addEventListener('change', onPhotoChosen);
    scanEl('cameraBtn').addEventListener('click', startLive);
    scanEl('shutterBtn').addEventListener('click', () => live.capture());
    scanEl('liveCancelBtn').addEventListener('click', () => showStep('stepPhoto'));
    scanEl('autoShutter').addEventListener('change', e => writePrefs({ auto: e.target.checked }));
    scanEl('savePhotoBtn').addEventListener('click', savePhoto);
    window.addEventListener('pagehide', () => live.stop());
    scanEl('manualBtn').addEventListener('click', () => {
        review.setTiles([]);
        showStep('stepReview');
        review.addManual();
    });
    scanEl('tileColorSelect').addEventListener('change', runDetection);
    scanEl('photoCanvas').addEventListener('click', onOutlineTap);
    scanEl('retakeBtn').addEventListener('click', startOver);
    scanEl('reviewRetakeBtn').addEventListener('click', startOver);
    scanEl('useTilesBtn').addEventListener('click', useTiles);
    scanEl('addTileBtn').addEventListener('click', () => review.addManual());
    scanEl('useScoreBtn').addEventListener('click', useScore);
    showStep('stepPhoto');
}

initScan();
