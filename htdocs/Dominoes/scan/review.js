// Domino review grid version identifier
const DOMINO_REVIEW_VERSION = '1.2';

// The review step of the scanner: a grid of straightened tiles with a marker over every counted pip, and an
// editor dialog for correcting a tile (add or remove pips, mark a half blank, delete the tile, add a missed tile).
// Depends on core.js (DominoCore) and pips.js (DominoPips).
//
// A tile is { id, canvas, dividerX, manual, flags, left: { pips, flags }, right: { pips, flags } } where pips are
// { x, y, r, merged?, manual? } in 240x120 crop coordinates. Each half's count is its pips.length.
const DominoReview = (() => {

    const CROP_W = 240;
    const CROP_H = 120;
    const DEFAULT_PIP_R = 7;
    const EDGE = 12;                   // keep added pips this far inside the tile

    // Explanations for the flags set by DominoPips.flagTiles
    const FLAG_TEXT = {
        'duplicate': 'The same tile appears twice, which a real set cannot have. Check both.',
        'over-max': 'A half has more pips than this set allows.',
        'merged': 'Touching pips were split by size. Check the count.',
        'uneven': 'Pip sizes differ. Check the count.'
    };
    const FLAG_SHORT = { 'duplicate': 'Duplicate', 'over-max': 'Too many pips', 'merged': 'Check count', 'uneven': 'Check count' };

    let uid = 0;

    // Creates the review controller.
    // options: { grid, editor: { dialog, stage, title, readout, flags, left, right, prev, next, remove, done },
    //            setMax, blankValue, onChange(summary) }
    function create(options) {
        const ed = options.editor;
        let tiles = [];
        let current = -1;              // tile open in the editor, or -1

        // ---- Model helpers ----

        const counts = t => [t.left.pips.length, t.right.pips.length];
        const pointsOf = t => DominoCore.tileScore(counts(t), options.blankValue);

        function summary() {
            const flagged = tiles.filter(t => t.flags.length).length;
            return {
                tiles: tiles.length,
                points: tiles.reduce((sum, t) => sum + pointsOf(t), 0),
                flagged,
                items: tiles.map(counts)
            };
        }

        // Recomputes flags and redraws everything that shows counts
        function refresh() {
            DominoPips.flagTiles(tiles, options.setMax);
            renderGrid();
            if (current >= 0) renderEditor();
            if (options.onChange) options.onChange(summary());
        }

        // A free spot for a new pip in a half: as far from the existing pips and the rivet as the half allows,
        // preferring the middle of the half
        function freeSpot(tile, side) {
            const half = tile[side];
            const dx = tile.dividerX;
            const x0 = side === 'left' ? EDGE : dx + 10;
            const x1 = side === 'left' ? dx - 10 : CROP_W - EDGE;
            const cx = (x0 + x1) / 2;
            let best = { x: cx, y: CROP_H / 2 }, bestScore = -Infinity;
            for (let y = EDGE; y <= CROP_H - EDGE; y += 5) {
                for (let x = x0; x <= x1; x += 5) {
                    let nearest = 60;
                    half.pips.forEach(p => { nearest = Math.min(nearest, Math.hypot(p.x - x, p.y - y)); });
                    nearest = Math.min(nearest, Math.hypot(dx - x, CROP_H / 2 - y) * 1.5);
                    const score = nearest - 0.15 * Math.hypot(x - cx, y - CROP_H / 2);
                    if (score > bestScore) { bestScore = score; best = { x, y }; }
                }
            }
            return best;
        }

        function typicalRadius(tile) {
            const radii = tile.left.pips.concat(tile.right.pips).map(p => p.r).sort((a, b) => a - b);
            return radii.length ? radii[radii.length >> 1] : DEFAULT_PIP_R;
        }

        function addPip(tile, side, at) {
            const spot = at || freeSpot(tile, side);
            tile[side].pips.push({ x: spot.x, y: spot.y, r: typicalRadius(tile), manual: true });
        }

        // Removes the pip most likely to be wrong: a guessed split of touching pips, then the smallest, then the last
        function removeLikelyWrong(tile, side) {
            const pips = tile[side].pips;
            if (!pips.length) return;
            let pick = pips.length - 1;
            const merged = pips.findIndex(p => p.merged);
            if (merged >= 0) pick = merged;
            else {
                let smallest = 0;
                pips.forEach((p, i) => { if (p.r < pips[smallest].r) smallest = i; });
                if (!pips.every(p => p.r === pips[0].r)) pick = smallest;
            }
            pips.splice(pick, 1);
        }

        // ---- Drawing ----

        // Draws a blank ivory tile with its divider for tiles that were added by hand
        function manualCanvas() {
            const c = document.createElement('canvas');
            c.width = CROP_W;
            c.height = CROP_H;
            const g = c.getContext('2d');
            g.fillStyle = '#ece6d6';
            g.fillRect(0, 0, CROP_W, CROP_H);
            g.fillStyle = '#6b665a';
            g.fillRect(CROP_W / 2 - 1, 6, 2, CROP_H - 12);
            return c;
        }

        // Copies a tile's picture into a new canvas so each place that shows it has its own
        function pictureOf(tile) {
            const c = document.createElement('canvas');
            c.width = CROP_W;
            c.height = CROP_H;
            c.getContext('2d').drawImage(tile.canvas, 0, 0);
            return c;
        }

        // Builds the stage: the picture plus a layer of pip markers. Markers are positioned in percent of the stage.
        function buildStage(tile, interactive) {
            const stage = document.createElement('span');
            stage.className = 'tile-stage';
            stage.appendChild(pictureOf(tile));
            const layer = document.createElement('span');
            layer.className = 'pip-layer' + (interactive ? ' interactive' : '');
            ['left', 'right'].forEach(side => {
                tile[side].pips.forEach((p, i) => {
                    const m = document.createElement('span');
                    m.className = 'pip-marker' + (p.merged ? ' merged' : '') + (p.manual ? ' manual' : '');
                    m.dataset.side = side;
                    m.dataset.index = String(i);
                    m.style.left = (p.x / CROP_W * 100) + '%';
                    m.style.top = (p.y / CROP_H * 100) + '%';
                    m.style.width = (Math.max(p.r, 4) * 2.1 / CROP_W * 100) + '%';
                    layer.appendChild(m);
                });
            });
            stage.appendChild(layer);
            return { stage, layer };
        }

        function readoutText(tile) {
            const [a, b] = counts(tile);
            return a + ' | ' + b + ' = ' + pointsOf(tile);
        }

        function renderGrid() {
            const grid = options.grid;
            grid.replaceChildren();
            tiles.forEach((tile, i) => {
                const [a, b] = counts(tile);
                const li = document.createElement('li');
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'tile-card' + (tile.flags.length ? ' flagged' : '');
                btn.setAttribute('aria-label', 'Tile ' + (i + 1) + ': ' + a + ' and ' + b + ', ' + pointsOf(tile) + ' points. Edit');
                btn.appendChild(buildStage(tile, false).stage);
                const read = document.createElement('span');
                read.className = 'tile-readout';
                read.textContent = readoutText(tile);
                btn.appendChild(read);
                if (tile.flags.length) {
                    const note = document.createElement('span');
                    note.className = 'tile-flag';
                    note.textContent = FLAG_SHORT[tile.flags[0]];
                    btn.appendChild(note);
                }
                btn.addEventListener('click', () => openEditor(i));
                li.appendChild(btn);
                grid.appendChild(li);
            });
        }

        // ---- Editor ----

        function renderEditor() {
            const tile = tiles[current];
            if (!tile) { closeEditor(); return; }
            ed.title.textContent = 'Tile ' + (current + 1) + ' of ' + tiles.length;
            ed.readout.textContent = readoutText(tile);
            ed.stage.replaceChildren();
            const built = buildStage(tile, true);
            ed.stage.appendChild(built.stage);
            built.layer.addEventListener('click', e => onStageClick(e, built.layer, tile));
            ed.flags.textContent = tile.flags.map(f => FLAG_TEXT[f]).join(' ');
            ed.flags.hidden = !tile.flags.length;
            ed.left.count.textContent = String(tile.left.pips.length);
            ed.right.count.textContent = String(tile.right.pips.length);
            ed.prev.disabled = current === 0;
            ed.next.disabled = current >= tiles.length - 1;
        }

        // Tapping a marker removes that pip; tapping empty tile adds a pip there
        function onStageClick(event, layer, tile) {
            const marker = event.target.closest('.pip-marker');
            if (marker) {
                tile[marker.dataset.side].pips.splice(Number(marker.dataset.index), 1);
                refresh();
                return;
            }
            const rect = layer.getBoundingClientRect();
            const x = (event.clientX - rect.left) / rect.width * CROP_W;
            const y = (event.clientY - rect.top) / rect.height * CROP_H;
            if (Math.abs(x - tile.dividerX) < 8) return;
            addPip(tile, x < tile.dividerX ? 'left' : 'right', { x, y });
            refresh();
        }

        function openEditor(index) {
            current = index;
            renderEditor();
            if (typeof ed.dialog.showModal === 'function') {
                if (!ed.dialog.open) ed.dialog.showModal();
            } else {
                ed.dialog.setAttribute('open', '');
            }
        }

        function closeEditor() {
            current = -1;
            if (typeof ed.dialog.close === 'function') { if (ed.dialog.open) ed.dialog.close(); }
            else ed.dialog.removeAttribute('open');
        }

        ['left', 'right'].forEach(side => {
            ed[side].minus.addEventListener('click', () => { removeLikelyWrong(tiles[current], side); refresh(); });
            ed[side].plus.addEventListener('click', () => { addPip(tiles[current], side); refresh(); });
            ed[side].blank.addEventListener('click', () => { tiles[current][side].pips = []; refresh(); });
        });
        ed.prev.addEventListener('click', () => { if (current > 0) openEditor(current - 1); });
        ed.next.addEventListener('click', () => { if (current < tiles.length - 1) openEditor(current + 1); });
        ed.done.addEventListener('click', closeEditor);
        ed.remove.addEventListener('click', () => {
            tiles.splice(current, 1);
            const next = Math.min(current, tiles.length - 1);
            if (next < 0) closeEditor(); else current = next;
            refresh();
        });
        ed.dialog.addEventListener('close', () => { current = -1; });
        ed.dialog.addEventListener('click', e => { if (e.target === ed.dialog) closeEditor(); });

        // ---- Public ----

        return {
            // Replaces the tiles with scanner results (each has canvas, dividerX, left, right)
            setTiles(list) {
                tiles = list.map(t => Object.assign({ id: ++uid, manual: false, flags: [] }, t));
                closeEditor();
                refresh();
            },
            // Adds a tile the scanner missed and opens it for editing
            addManual() {
                const tile = {
                    id: ++uid, manual: true, flags: [], canvas: manualCanvas(), dividerX: CROP_W / 2,
                    left: { pips: [], flags: [] }, right: { pips: [], flags: [] }
                };
                tiles.push(tile);
                refresh();
                openEditor(tiles.length - 1);
            },
            summary,
            count: () => tiles.length
        };
    }

    return { VERSION: DOMINO_REVIEW_VERSION, create, FLAG_TEXT };
})();
