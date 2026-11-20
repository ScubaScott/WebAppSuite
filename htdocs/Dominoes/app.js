// Dominoes score keeper: page controller (state, rendering, dialogs, persistence and cloud sync).
// Scoring rules live in core.js and the line chart in chart.js.
const APP_VERSION = "1.6";

const Core = DominoCore;

const SYNC_APP_ID = 'dominoes';
const STORAGE = { game: 'dominoGame', history: 'dominoHistory', prefs: 'dominoPrefs', pendingScan: 'dominoPendingScan', scanPrefs: 'dominoScanPrefs' };
const UNDO_LIMIT = 20;
const CLOUD_TIMEOUT_MS = 3000;
const PENDING_SCAN_MAX_AGE_MS = 60 * 60 * 1000;

// Shows the per-player Scan button that opens scan/scan.html
const SCAN_ENABLED = true;

let game;                 // the current game (see DominoCore.newGame)
let history = [];         // finished and abandoned games, newest first
let prefs;                // { sort, chartMode, lastRoster }
let viewRound = 0;        // round shown in the status strip and used by the player buttons
let selectedId = null;    // player whose scoring buttons are shown; everyone else is a compact row
const undoStack = [];     // { game: JSON string, view: round index, sel: player id } snapshots, most recent last
let scoreCtx = null;      // { pid, ri, advance } while the score dialog is open
let draftPlayers = [];    // roster being edited in the settings dialog: { id, name, color }
let colorPickerId = null; // id of the draft player whose color choices are open in the roster
let wakeLock = null;

const $ = id => document.getElementById(id);

// ───────────────────────── DOM helpers ─────────────────────────

// Builds an element: attrs support class, text, on<event> handlers and plain attributes; null/false are skipped
function h(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(key => {
        const value = attrs[key];
        if (value === null || value === undefined || value === false) return;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, value === true ? '' : value);
    });
    kids.flat().forEach(kid => { if (kid) node.append(kid); });
    return node;
}

// Opens a dialog, falling back to the open attribute where showModal is unsupported
function openDialog(dlg) {
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
}

function closeDialog(dlg) {
    if (typeof dlg.close === 'function') dlg.close();
    else dlg.removeAttribute('open');
}

let toastTimer = null;
// Shows a short message at the bottom of the screen
function toast(message) {
    const node = $('toast');
    node.textContent = message;
    node.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('show'), 2600);
}

// Color of the player sitting at a seat index (each player has their own preset color, see DominoCore.PLAYER_COLORS)
function colorFor(seat) {
    const player = game.players[seat];
    return player ? player.color : Core.PLAYER_COLORS[0].hex;
}

// ───────────────────────── Persistence and sync ─────────────────────────

function readJSON(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
        return fallback;
    }
}

function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage full or blocked: keep running in memory */ }
}

// Loads game, history and preferences from localStorage; a missing game becomes a pristine
// default (updatedAt 0) so a newer cloud game always wins over it
function loadLocal() {
    game = Core.normalizeGame(readJSON(STORAGE.game, null));
    if (!game) {
        game = Core.newGame();
        game.updatedAt = 0;
        // Saved right away (not synced) so the scanner page, which reads the saved game, works before any score is entered
        writeJSON(STORAGE.game, game);
    }
    const savedHistory = readJSON(STORAGE.history, []);
    history = Array.isArray(savedHistory) ? savedHistory : [];
    const p = readJSON(STORAGE.prefs, {});
    prefs = {
        sort: ['seat', 'name', 'score'].includes(p.sort) ? p.sort : 'seat',
        chartMode: p.chartMode === 'perRound' ? 'perRound' : 'cumulative',
        lastRoster: Array.isArray(p.lastRoster) ? p.lastRoster.slice(0, 20) : []
    };
}

function savePrefs() {
    writeJSON(STORAGE.prefs, prefs);
}

// Queues the game and history for cloud backup (no-op for guests)
function syncToCloud() {
    if (window.SuiteProfile && !SuiteProfile.isGuest()) {
        SuiteProfile.saveAppData(SYNC_APP_ID, { game, history });
    }
}

// Keeps history in step with the game: a final game has a record, an unfinished one does not
function syncHistory() {
    if (Core.isFinal(game)) history = Core.upsertHistory(history, Core.historyRecord(game, true));
    else history = Core.removeHistory(history, game.id);
}

// Stamps the game, saves it locally, then queues the cloud backup
function persist() {
    game.updatedAt = Date.now();
    syncHistory();
    writeJSON(STORAGE.game, game);
    writeJSON(STORAGE.history, history);
    syncToCloud();
}

// Pulls the cloud copy and keeps whichever game was changed most recently
async function pullFromCloud() {
    if (!window.SuiteProfile || SuiteProfile.isGuest()) return;
    let remote = null;
    try {
        remote = await Promise.race([
            SuiteProfile.loadAppData(SYNC_APP_ID),
            new Promise(resolve => setTimeout(() => resolve(null), CLOUD_TIMEOUT_MS))
        ]);
    } catch (e) {
        remote = null;
    }
    if (!remote) return;

    const merged = Core.mergeRemote({ game, history }, remote);
    history = merged.history;
    if (merged.adopted) {
        game = merged.game;
        undoStack.length = 0;
        initView();
    }
    writeJSON(STORAGE.game, game);
    writeJSON(STORAGE.history, history);
    renderAll();

    // The local copy is newer than the cloud copy: bring the cloud up to date
    const remoteStamp = remote.game ? Number(remote.game.updatedAt) || 0 : 0;
    if (!merged.adopted && game.updatedAt > remoteStamp) syncToCloud();
}

// ───────────────────────── View state ─────────────────────────

// Chooses the round to show: the first one still missing a score, or the last round when finished
function initView() {
    const next = Core.firstIncompleteRound(game);
    viewRound = next === -1 ? game.rounds.length - 1 : next;
    selectedId = defaultSelection();
}

function clampView() {
    viewRound = Math.min(Math.max(0, viewRound), game.rounds.length - 1);
}

// The first player in seat order without a score in the viewed round, or the first seat when all are scored
function defaultSelection() {
    if (!game.players.length) return null;
    const open = game.players.find(p => !game.rounds[viewRound].scores[p.id]);
    return (open || game.players[0]).id;
}

// The next player in seat order after the given one (wrapping from the last seat to the first) who has no
// score in the round; scores are often entered out of order, so scored players are skipped.
// When everyone in the round has a score, the seat right after the given player is used.
function nextOpenSeatId(playerId, round) {
    const count = game.players.length;
    const seat = game.players.findIndex(p => p.id === playerId);
    for (let step = 1; step <= count; step++) {
        const candidate = game.players[(seat + step) % count];
        if (!game.rounds[round].scores[candidate.id]) return candidate.id;
    }
    return game.players[(seat + 1) % count].id;
}

// Shows another round and selects the player who should score next in it
function setView(round) {
    viewRound = round;
    clampView();
    selectedId = defaultSelection();
    renderAll();
}

function selectPlayer(playerId) {
    selectedId = playerId;
    renderPlayers();
}

// ───────────────────────── Score actions ─────────────────────────

// Saves the game and the viewed round so undo returns to exactly what was on screen
function pushUndo() {
    undoStack.push({ game: JSON.stringify(game), view: viewRound, sel: selectedId });
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}

function undo() {
    const snapshot = undoStack.pop();
    if (!snapshot) return;
    game = Core.normalizeGame(JSON.parse(snapshot.game));
    viewRound = snapshot.view;
    selectedId = snapshot.sel;
    persist();
    renderAll();
    toast('Undone');
}

// Saves after a score change. When the score came from the player list (advance): the viewed round moves on
// if it was just completed, and the next player without a score in the round shown becomes selected.
function afterScoreChange(ri, advance, scorerId) {
    persist();
    if (advance && ri === viewRound && Core.isRoundComplete(game, ri)) {
        const next = Core.firstIncompleteRound(game);
        if (next !== -1) {
            viewRound = next;
            toast('Round ' + (ri + 1) + ' complete');
        }
    }
    if (advance && scorerId) selectedId = nextOpenSeatId(scorerId, viewRound);
    renderAll();
}

function applyScore(pid, ri, points, source, advance, tiles) {
    pushUndo();
    Core.setScore(game, ri, pid, { points, source, tiles });
    afterScoreChange(ri, advance, pid);
}

// Records the score handed over by the scanner page (scan/scan.js) as a scanned entry that keeps its tiles,
// so it is re-scored if the double-blank value changes. A result for another game or player is dropped.
function consumePendingScan() {
    const pending = readJSON(STORAGE.pendingScan, null);
    if (!pending) return;
    try { localStorage.removeItem(STORAGE.pendingScan); } catch (e) { /* storage blocked: nothing to clear */ }

    const valid = pending.gameId === game.id &&
        Date.now() - Number(pending.at) < PENDING_SCAN_MAX_AGE_MS &&
        game.players.some(p => p.id === pending.playerId) &&
        Number.isInteger(pending.round) && game.rounds[pending.round] &&
        Number.isInteger(pending.points) && Array.isArray(pending.tiles);
    if (!valid) {
        toast('The scan could not be added to this game');
        return;
    }
    viewRound = pending.round;
    const tiles = pending.tiles.map(t => [Number(t[0]) | 0, Number(t[1]) | 0]);
    applyScore(pending.playerId, pending.round, Core.tilesScore(tiles, game.settings.doubleBlankValue), 'scan', true, tiles);
    toast('Scanned ' + tiles.length + (tiles.length === 1 ? ' tile' : ' tiles'));
}

function clearScoreFor(pid, ri) {
    pushUndo();
    Core.clearScore(game, ri, pid);
    afterScoreChange(ri, false);
}

// ───────────────────────── Rendering ─────────────────────────

function renderAll() {
    clampView();
    if (!game.players.some(p => p.id === selectedId)) selectedId = defaultSelection();
    renderStatus();
    renderChart();
    renderPlayers();
    renderSheet();
    syncSegments();
}

// Round title, engine double, starting player, final banner and undo state
function renderStatus() {
    const total = game.rounds.length;
    const double = Core.roundDouble(game.settings, viewRound);
    const starter = game.players.length ? game.players[viewRound % game.players.length].name : '-';
    $('roundTitle').textContent = 'Round ' + (viewRound + 1) + ' of ' + total;
    $('roundSub').textContent = 'Engine ' + double + '|' + double + ' · Starts: ' + starter;
    $('prevRoundBtn').disabled = viewRound === 0;
    $('nextRoundBtn').disabled = viewRound >= total - 1;
    $('undoBtn').disabled = undoStack.length === 0;

    const banner = $('finalBanner');
    banner.replaceChildren();
    if (Core.isFinal(game)) {
        const totals = Core.totals(game);
        const winners = Core.winnerIds(game).map(id => game.players.find(p => p.id === id));
        const names = winners.map(p => p.name).join(' & ');
        const text = winners.length > 1 ? 'Game over — tie: ' + names : 'Game over — ' + names + ' wins';
        banner.append(
            h('span', { text: text + ' (' + totals[winners[0].id] + ')' }),
            h('button', { type: 'button', class: 'btn btn-primary', text: 'New game', onclick: () => confirmNewGame() })
        );
        banner.hidden = false;
    } else {
        banner.hidden = true;
    }
}

// Line chart and legend
function renderChart() {
    const data = prefs.chartMode === 'perRound' ? Core.perRound(game) : Core.cumulative(game);
    const totals = Core.totals(game);
    const series = game.players.map((p, seat) => ({ id: p.id, name: p.name, color: colorFor(seat), values: data[p.id] }));

    DominoChart.render($('chart'), {
        rounds: game.rounds.length,
        series,
        selected: viewRound,
        onRoundClick: index => setView(index)
    });

    const legend = $('legend');
    legend.replaceChildren();
    series.forEach(s => {
        const chip = h('li', { class: 'legend-item' },
            h('span', { class: 'swatch' }),
            h('span', { class: 'legend-name', text: s.name }),
            h('span', { class: 'legend-total', text: String(totals[s.id]) }));
        chip.style.setProperty('--pc', s.color);
        legend.append(chip);
    });
}

// Player list in the chosen sort order: the selected player is an expanded card with scoring buttons,
// the others are compact lines that select that player when tapped
function renderPlayers() {
    const list = $('playerList');
    list.replaceChildren();
    const totals = Core.totals(game);
    const ranks = Core.ranks(game);
    const anyScores = Core.hasScores(game);
    const round = game.rounds[viewRound];

    Core.sortPlayers(game, prefs.sort).forEach(p => {
        const seat = game.players.indexOf(p);
        const entry = round.scores[p.id];
        const isLeader = anyScores && ranks[p.id] === 1;
        const rankText = anyScores ? String(ranks[p.id]) : String(seat + 1);

        // Everyone except the selected player is a compact line: position, name and total
        if (p.id !== selectedId) {
            const row = h('li', { class: 'player-card compact' + (isLeader ? ' leader' : '') },
                h('button', {
                    type: 'button', class: 'pc-row', 'aria-label': 'Select ' + p.name,
                    onclick: () => selectPlayer(p.id)
                },
                    h('span', { class: 'rank', text: rankText }),
                    h('span', { class: 'swatch' }),
                    h('strong', { class: 'pc-row-name', text: p.name }),
                    h('span', { class: 'pc-row-score', text: String(totals[p.id]) })));
            row.style.setProperty('--pc', colorFor(seat));
            list.append(row);
            return;
        }

        const roundText = entry
            ? 'R' + (viewRound + 1) + ': ' + entry.points + ' pts' + (entry.source === 'out' ? ' · out' : '') +
                (entry.source === 'scan' ? ' · scanned' : '')
            : 'R' + (viewRound + 1) + ': not scored';

        const actions = h('div', { class: 'pc-actions' });
        if (SCAN_ENABLED) {
            actions.append(h('a', {
                class: 'btn btn-primary',
                href: 'scan/scan.html?player=' + encodeURIComponent(p.id) + '&round=' + viewRound,
                text: 'Scan'
            }));
        }
        actions.append(
            h('button', {
                type: 'button', class: 'btn btn-ghost', text: entry ? 'Edit' : 'Enter',
                onclick: () => openScoreDialog(p.id, viewRound, true)
            }),
            h('button', {
                type: 'button', class: 'btn btn-ghost', text: 'Out (0)',
                onclick: () => applyScore(p.id, viewRound, 0, 'out', true)
            })
        );

        const card = h('li', { class: 'player-card selected' + (isLeader ? ' leader' : '') },
            h('div', { class: 'pc-main' },
                h('span', { class: 'rank', text: rankText }),
                h('span', { class: 'swatch' }),
                h('div', { class: 'pc-name' },
                    h('strong', { text: p.name }),
                    h('small', { text: roundText })),
                h('div', { class: 'pc-total' },
                    h('span', { class: 'pc-total-num', text: String(totals[p.id]) }),
                    h('small', { text: 'total' }))),
            actions);
        card.style.setProperty('--pc', colorFor(seat));
        list.append(card);
    });
}

// Paper-style sheet: rounds down, players across, totals at the bottom
function renderSheet() {
    const table = $('sheet');
    table.replaceChildren();
    const totals = Core.totals(game);

    const headRow = h('tr', null, h('th', { class: 'corner', text: 'Round' }));
    game.players.forEach((p, seat) => {
        const th = h('th', null, h('span', { class: 'swatch' }), h('span', { text: p.name }));
        th.style.setProperty('--pc', colorFor(seat));
        headRow.append(th);
    });
    table.append(h('thead', null, headRow));

    const body = h('tbody');
    game.rounds.forEach((round, ri) => {
        const double = Core.roundDouble(game.settings, ri);
        const rowHead = h('th', { class: 'row-head', scope: 'row' },
            h('button', { type: 'button', class: 'row-btn', onclick: () => setView(ri) },
                h('span', { text: 'R' + (ri + 1) }),
                h('small', { text: double + '|' + double })));
        const row = h('tr', { class: ri === viewRound ? 'current' : null }, rowHead);
        game.players.forEach(p => {
            const entry = round.scores[p.id];
            row.append(h('td', null, h('button', {
                type: 'button',
                class: 'cell' + (entry ? '' : ' empty'),
                'aria-label': p.name + ', round ' + (ri + 1) + (entry ? ': ' + entry.points : ': not scored'),
                text: entry ? String(entry.points) : '·',
                onclick: () => openScoreDialog(p.id, ri, false)
            })));
        });
        body.append(row);
    });
    table.append(body);

    const footRow = h('tr', null, h('th', { class: 'row-head', text: 'Total' }));
    game.players.forEach(p => footRow.append(h('td', { class: 'total-cell', text: String(totals[p.id]) })));
    table.append(h('tfoot', null, footRow));
}

// Reflects the saved sort and chart choices on the segmented controls
function syncSegments() {
    $('sortSeg').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.sort === prefs.sort)));
    $('chartModeSeg').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === prefs.chartMode)));
}

// ───────────────────────── Score dialog ─────────────────────────

function openScoreDialog(pid, ri, advance) {
    const player = game.players.find(p => p.id === pid);
    if (!player) return;
    const entry = game.rounds[ri].scores[pid];
    const double = Core.roundDouble(game.settings, ri);
    scoreCtx = { pid, ri, advance };
    $('scoreDlgTitle').textContent = player.name;
    $('scoreDlgSub').textContent = 'Round ' + (ri + 1) + ' · Engine ' + double + '|' + double;
    $('scoreInput').value = entry ? String(entry.points) : '';
    $('scoreClearBtn').hidden = !entry;
    $('scoreError').hidden = true;
    openDialog($('scoreDlg'));
    $('scoreInput').focus();
    $('scoreInput').select();
}

function submitScoreDialog(event) {
    event.preventDefault();
    if (!scoreCtx) return;
    const raw = $('scoreInput').value.trim();
    const points = Number(raw);
    if (raw === '' || !Number.isInteger(points) || points < 0 || points > 9999) {
        $('scoreError').textContent = 'Enter a whole number from 0 to 9999.';
        $('scoreError').hidden = false;
        return;
    }
    const ctx = scoreCtx;
    closeDialog($('scoreDlg'));
    applyScore(ctx.pid, ctx.ri, points, 'type', ctx.advance);
}

// ───────────────────────── Settings dialog ─────────────────────────

function openSettings() {
    draftPlayers = game.players.map(p => ({ id: p.id, name: p.name, color: p.color }));
    colorPickerId = null;
    $('setMaxSelect').value = String(game.settings.setMax);
    $('roundsInput').value = String(game.settings.rounds);
    $('directionSelect').value = game.settings.direction;
    $('blankInput').value = String(game.settings.doubleBlankValue);
    // The scanner's last choice on this device, when it has one, is what Settings shows
    const scanChoice = readJSON(STORAGE.scanPrefs, {}).tileColor;
    $('tileColorSelect').value = ['auto', 'light', 'dark'].includes(scanChoice) ? scanChoice : game.settings.tileColor;
    $('settingsError').hidden = true;
    $('newPlayerInput').value = '';
    renderRoster();
    renderNameSuggestions();
    renderHistory();
    openDialog($('settingsDlg'));
}

// Roster rows: drag handle, seat number, color, name and remove. The handle reorders by dragging (or the arrow keys when
// it has focus); the color button opens the preset colors, where a color another player has is disabled.
function renderRoster() {
    const list = $('rosterList');
    list.replaceChildren();
    draftPlayers.forEach((d, i) => {
        const label = d.name.trim() || 'Player ' + (i + 1);
        const colorName = presetName(d.color);
        const open = colorPickerId === d.id;
        const dot = h('span', { class: 'color-dot' });
        dot.style.setProperty('--pc', d.color);
        const row = h('li', { class: 'roster-row', 'data-id': d.id },
            h('button', {
                type: 'button', class: 'drag-handle', text: '≡',
                'aria-label': 'Move ' + label + '. Drag, or press the up and down arrow keys.',
                onpointerdown: e => startRosterDrag(e, e.currentTarget.closest('li')),
                onkeydown: e => onHandleKey(e, d.id)
            }),
            h('span', { class: 'roster-seat', text: String(i + 1) }),
            h('button', {
                type: 'button', class: 'color-btn', 'aria-label': label + ' color: ' + colorName + '. Change color.',
                'aria-expanded': String(open),
                onclick: () => { colorPickerId = open ? null : d.id; renderRoster(); }
            }, dot),
            h('input', {
                type: 'text', maxlength: '20', value: d.name, 'aria-label': 'Player ' + (i + 1) + ' name',
                oninput: e => { d.name = e.target.value; }
            }),
            h('button', {
                type: 'button', class: 'icon-btn danger', 'aria-label': 'Remove ' + d.name, text: '✕',
                disabled: draftPlayers.length <= 1,
                onclick: () => removeDraft(draftPlayers.indexOf(d))
            }));
        if (open) row.append(colorGrid(d));
        list.append(row);
    });
}

// Display name of a preset color hex
function presetName(hex) {
    const found = Core.PLAYER_COLORS.find(c => c.hex === hex);
    return found ? found.name : 'Custom';
}

// The preset colors for one draft player; a color that another player has is disabled, so no two share one
function colorGrid(d) {
    const grid = h('div', { class: 'color-grid', role: 'group', 'aria-label': 'Choose a color' });
    Core.PLAYER_COLORS.forEach(c => {
        const owner = draftPlayers.find(p => p !== d && p.color === c.hex);
        const swatch = h('button', {
            type: 'button', class: 'color-swatch', title: c.name,
            'aria-label': c.name + (owner ? ', used by ' + (owner.name.trim() || 'another player') : ''),
            'aria-pressed': String(d.color === c.hex),
            disabled: !!owner,
            onclick: () => { d.color = c.hex; colorPickerId = null; renderRoster(); }
        });
        swatch.style.setProperty('--pc', c.hex);
        grid.append(swatch);
    });
    return grid;
}

// Starts dragging a roster row by its handle. The row follows the pointer and swaps places with the rows it passes; the
// new order is read back from the list when the pointer is released.
function startRosterDrag(e, row) {
    if (e.button) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const list = row.parentElement;
    colorPickerId = null;
    list.querySelectorAll('.color-grid').forEach(g => g.remove());
    list.querySelectorAll('.color-btn').forEach(b => b.setAttribute('aria-expanded', 'false'));
    try { handle.setPointerCapture(e.pointerId); } catch (err) { /* the move events still arrive on the handle without capture */ }
    const grabOffset = e.clientY - row.getBoundingClientRect().top;
    row.classList.add('dragging');
    let finished = false;

    // Swaps the row past neighbors whose middle the pointer has crossed, then offsets it to sit under the pointer
    const follow = clientY => {
        row.style.transform = '';
        let moved = true;
        while (moved) {
            moved = false;
            const prev = row.previousElementSibling;
            const next = row.nextElementSibling;
            if (prev) {
                const r = prev.getBoundingClientRect();
                if (clientY < r.top + r.height / 2) { list.insertBefore(row, prev); moved = true; continue; }
            }
            if (next) {
                const r = next.getBoundingClientRect();
                if (clientY > r.top + r.height / 2) { list.insertBefore(next, row); moved = true; }
            }
        }
        row.style.transform = 'translateY(' + (clientY - grabOffset - row.getBoundingClientRect().top) + 'px)';
        [...list.children].forEach((li, n) => { li.querySelector('.roster-seat').textContent = String(n + 1); });
    };

    const onMove = ev => follow(ev.clientY);
    const finish = () => {
        if (finished) return;
        finished = true;
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', finish);
        handle.removeEventListener('pointercancel', finish);
        handle.removeEventListener('lostpointercapture', finish);
        row.classList.remove('dragging');
        row.style.transform = '';
        const order = [...list.children].map(li => li.dataset.id);
        draftPlayers = order.map(id => draftPlayers.find(d => d.id === id));
        renderRoster();
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    handle.addEventListener('lostpointercapture', finish);
}

// Arrow keys on a focused handle move that player up or down one seat
function onHandleKey(e, id) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    moveDraft(draftPlayers.findIndex(d => d.id === id), e.key === 'ArrowUp' ? -1 : 1);
    const handle = $('rosterList').querySelector('[data-id="' + id + '"] .drag-handle');
    if (handle) handle.focus();
}

function moveDraft(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= draftPlayers.length) return;
    [draftPlayers[index], draftPlayers[target]] = [draftPlayers[target], draftPlayers[index]];
    renderRoster();
}

async function removeDraft(index) {
    const d = draftPlayers[index];
    const hasScores = game.rounds.some(r => r.scores[d.id]);
    if (hasScores) {
        const remove = await SuiteDialog.confirm('Every score they have in every round is deleted too.', {
            title: 'Remove ' + (d.name || 'this player') + '?', confirmLabel: 'Remove player', cancelLabel: 'Keep player', danger: true
        });
        if (!remove) return;
    }
    const at = draftPlayers.indexOf(d);
    if (at >= 0) draftPlayers.splice(at, 1);
    renderRoster();
}

function addDraftPlayer() {
    const input = $('newPlayerInput');
    if (draftPlayers.length >= Core.MAX_PLAYERS) {
        toast('Up to ' + Core.MAX_PLAYERS + ' players');
        return;
    }
    const name = input.value.trim() || 'Player ' + (draftPlayers.length + 1);
    draftPlayers.push({ id: Core.uuid(), name: name.slice(0, 20), color: Core.freeColor(draftPlayers) || Core.PLAYER_COLORS[0].hex });
    input.value = '';
    renderRoster();
}

// Name suggestions from the last roster and past games
function renderNameSuggestions() {
    const names = new Set(prefs.lastRoster);
    history.forEach(rec => rec.players.forEach(p => names.add(p.name)));
    const list = $('nameList');
    list.replaceChildren();
    names.forEach(n => list.append(h('option', { value: n })));
}

function renderHistory() {
    const list = $('historyList');
    list.replaceChildren();
    if (!history.length) {
        list.append(h('li', { class: 'history-empty', text: 'No finished games yet.' }));
        return;
    }
    history.forEach(rec => {
        const players = rec.players.slice().sort((a, b) => a.total - b.total)
            .map(p => (p.winner ? '★ ' : '') + p.name + ' ' + p.total).join(' · ');
        const status = rec.complete ? 'Final' : 'Unfinished (' + rec.roundsPlayed + '/' + rec.roundsTotal + ' rounds)';
        list.append(h('li', null,
            h('strong', { text: new Date(rec.finishedAt).toLocaleDateString() + ' — ' + status }),
            h('small', { text: players })));
    });
}

function showSettingsError(message) {
    $('settingsError').textContent = message;
    $('settingsError').hidden = false;
}

// Validates the dialog fields and applies them to the game
function submitSettings(event) {
    event.preventDefault();
    const rounds = Number($('roundsInput').value);
    const blank = Number($('blankInput').value);
    const minRounds = Math.max(1, Core.lastScoredRound(game) + 1);

    if (!Number.isInteger(rounds) || rounds < 1 || rounds > Core.MAX_ROUNDS) {
        showSettingsError('Rounds must be a whole number from 1 to ' + Core.MAX_ROUNDS + '.');
        return;
    }
    if (rounds < minRounds) {
        showSettingsError('Round ' + minRounds + ' already has scores, so there must be at least ' + minRounds + ' rounds.');
        return;
    }
    if (!Number.isInteger(blank) || blank < 0 || blank > 999) {
        showSettingsError('The double-blank value must be a whole number from 0 to 999.');
        return;
    }

    pushUndo();
    const keep = new Set(draftPlayers.map(d => d.id));
    game.players.filter(p => !keep.has(p.id)).forEach(p => Core.removePlayer(game, p.id));
    game.players = Core.ensureColors(draftPlayers.map((d, i) => ({ id: d.id, name: (d.name.trim() || 'Player ' + (i + 1)).slice(0, 20), color: d.color })));
    game.settings = Core.normalizeSettings({
        setMax: Number($('setMaxSelect').value),
        rounds,
        direction: $('directionSelect').value,
        doubleBlankValue: blank,
        tileColor: $('tileColorSelect').value
    });
    Core.ensureRounds(game);
    Core.rescore(game);
    // The scanner remembers its own tile color choice; choosing one here sets that too
    const scanPrefs = readJSON(STORAGE.scanPrefs, {});
    scanPrefs.tileColor = game.settings.tileColor;
    writeJSON(STORAGE.scanPrefs, scanPrefs);

    prefs.lastRoster = game.players.map(p => p.name);
    savePrefs();
    persist();
    clampView();
    renderAll();
    closeDialog($('settingsDlg'));
}

// Starts a fresh game with the same players and settings; an unfinished game is kept in Past games
async function confirmNewGame() {
    const saved = Core.hasScores(game) && !Core.isFinal(game);
    const start = await SuiteDialog.confirm(
        'Everyone keeps their seat and the settings stay the same.' + (saved ? '\nThis game is kept under Past games.' : ''),
        { title: 'Start a new game?', confirmLabel: 'Start new game', cancelLabel: 'Keep playing' });
    if (!start) return;
    if (Core.hasScores(game) && !Core.isFinal(game)) {
        history = Core.upsertHistory(history, Core.historyRecord(game, false));
    }
    game = Core.newGame(game.players.map(p => ({ name: p.name, color: p.color })), game.settings);
    undoStack.length = 0;
    initView();
    persist();
    renderAll();
    closeDialog($('settingsDlg'));
    toast('New game started');
}

// ───────────────────────── Screen wake lock ─────────────────────────

// Keeps the screen on while the page is visible; silently skipped where unsupported or denied
async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator && document.visibilityState === 'visible' && !wakeLock) {
            wakeLock = await navigator.wakeLock.request('screen');
            wakeLock.addEventListener('release', () => { wakeLock = null; });
        }
    } catch (e) {
        wakeLock = null;
    }
}

// ───────────────────────── Wiring ─────────────────────────

function bindEvents() {
    $('settingsBtn').addEventListener('click', openSettings);
    $('prevRoundBtn').addEventListener('click', () => setView(viewRound - 1));
    $('nextRoundBtn').addEventListener('click', () => setView(viewRound + 1));
    $('undoBtn').addEventListener('click', undo);

    $('sortSeg').addEventListener('click', e => {
        const btn = e.target.closest('button[data-sort]');
        if (!btn) return;
        prefs.sort = btn.dataset.sort;
        savePrefs();
        renderPlayers();
        syncSegments();
    });
    $('chartModeSeg').addEventListener('click', e => {
        const btn = e.target.closest('button[data-mode]');
        if (!btn) return;
        prefs.chartMode = btn.dataset.mode;
        savePrefs();
        renderChart();
        syncSegments();
    });

    $('scoreForm').addEventListener('submit', submitScoreDialog);
    $('scoreCancelBtn').addEventListener('click', () => closeDialog($('scoreDlg')));
    $('scoreClearBtn').addEventListener('click', () => {
        if (!scoreCtx) return;
        const ctx = scoreCtx;
        closeDialog($('scoreDlg'));
        clearScoreFor(ctx.pid, ctx.ri);
    });

    $('settingsForm').addEventListener('submit', submitSettings);
    $('settingsCancelBtn').addEventListener('click', () => closeDialog($('settingsDlg')));
    $('addPlayerBtn').addEventListener('click', addDraftPlayer);
    $('newPlayerInput').addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); addDraftPlayer(); }
    });
    $('newGameBtn').addEventListener('click', confirmNewGame);
    // A full set size has one more round than its highest double, so suggest that when the set changes
    $('setMaxSelect').addEventListener('change', e => { $('roundsInput').value = String(Number(e.target.value) + 1); });

    // Tapping the dimmed backdrop closes a dialog
    ['scoreDlg', 'settingsDlg'].forEach(id => {
        $(id).addEventListener('click', e => { if (e.target === $(id)) closeDialog($(id)); });
    });

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') requestWakeLock();
    });

    // Sign-in pulls the cloud game; sign-out leaves a fresh local game because the suite clears the saved keys
    window.addEventListener('suite-profile-changed', e => {
        const action = e.detail && e.detail.action;
        if (action === 'login') {
            pullFromCloud();
        } else if (action === 'logout') {
            loadLocal();
            undoStack.length = 0;
            initView();
            renderAll();
        }
    });
}

function init() {
    $('appVersion').textContent = APP_VERSION;
    loadLocal();
    initView();
    bindEvents();
    renderAll();
    consumePendingScan();
    if (window.SuiteProfile) SuiteProfile.renderFooterIndicator($('syncSlot'));
    requestWakeLock();
    pullFromCloud();
}

init();
