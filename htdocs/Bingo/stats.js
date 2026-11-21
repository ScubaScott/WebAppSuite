// Bingo Stats page: bar graph of how many times each ball (1-75) was called, with filters in sheets
const STATS_PAGE_VERSION = "1.1";

// Balls shown in the zoom lens, centered on the held ball
const LENS_BALLS = 11;
// How long a press must stay still before the zoom lens opens
const HOLD_MS = 350;
// Finger travel (px) that turns a press into a scrub instead of a hold
const HOLD_SLOP_PX = 12;

// ============================================================
// STATE
// ============================================================

// true = read-only combined view of every location
let viewAll = false;
// Game filter: a Set of game keys, or null for every game. Only changes what the graph shows.
let selectedGames = null;
// Latest tallies used by the graph and the lens
let currentCounts = {};
let currentMax = 0;

// Column header letters come from the board's session word (default BINGO)
function getSessionWord() {
    try {
        const raw = localStorage.getItem("bingoSession");
        const w = raw ? (JSON.parse(raw).word || "") : "";
        if (typeof w === "string" && w.length === 5) return w;
    } catch (e) { /* fall through to default */ }
    return "BINGO";
}
const word = getSessionWord();
const letterFor = (n) => word[Math.floor((n - 1) / 15)] || "";

// Remembers the filter choices while the tab stays open
function saveViewState() {
    try {
        sessionStorage.setItem("bingoStatsView", JSON.stringify({
            viewAll,
            selectedGames: selectedGames ? [...selectedGames] : null
        }));
    } catch (e) { /* storage unavailable */ }
}

function loadViewState() {
    try {
        const raw = sessionStorage.getItem("bingoStatsView");
        if (!raw) return;
        const v = JSON.parse(raw);
        viewAll = !!v.viewAll;
        selectedGames = Array.isArray(v.selectedGames) ? new Set(v.selectedGames) : null;
    } catch (e) { /* ignore bad state */ }
}

// ============================================================
// DOM REFS
// ============================================================

const $ = (id) => document.getElementById(id);
const locBtn = $("locBtn");
const locBtnValue = $("locBtnValue");
const gamesBtn = $("gamesBtn");
const gamesBtnValue = $("gamesBtnValue");
const scopeThis = $("scopeThis");
const scopeAll = $("scopeAll");
const statsSummary = $("statsSummary");
const statsReadout = $("statsReadout");
const statsPlot = $("statsPlot");
const statsBars = $("statsBars");
const statsLens = $("statsLens");
const statsEmpty = $("statsEmpty");
const statsAxis = $("statsAxis");
const locSheet = $("locSheet");
const gamesSheet = $("gamesSheet");
const locSheetBody = $("locSheetBody");
const gamesSheetBody = $("gamesSheetBody");
const rotateBtn = $("rotateBtn");

const IDLE_TEXT = "Slide across the graph · hold to zoom";

// ============================================================
// FILTER LOGIC
// ============================================================

// Buckets the graph currently draws from
const scopeBuckets = () => (viewAll ? getAllBuckets() : [getLocationBucket()]);

// Drops selected games that have no stats in the current scope; an emptied selection becomes "all"
function normalizeSelection() {
    if (!selectedGames || selectedGames.size === 0) return;
    const present = new Set(listStatsGames(scopeBuckets()).map(g => g.key));
    selectedGames = new Set([...selectedGames].filter(k => present.has(k)));
    if (selectedGames.size === 0) selectedGames = null;
}

// Letters shown for a game, using the session word (for example "B I G O")
const lettersText = (letters) => letters.map(c => word[c] || "").join(" ");

// Quick picks worked out from the letters each game uses: "Uses all letters" and "No <letter>"
function getQuickPicks(games) {
    const picks = [];
    const allLetters = games.filter(g => ALL_LETTERS.every(c => g.letters.includes(c)));
    if (allLetters.length) picks.push({ label: "Uses all letters", keys: allLetters.map(g => g.key) });
    ALL_LETTERS.forEach(c => {
        const missing = games.filter(g => !g.letters.includes(c));
        if (missing.length) picks.push({ label: `No ${word[c] || ""}`, keys: missing.map(g => g.key) });
    });
    return picks;
}

// True if the selection is exactly the given keys
const selectionIs = (keys) => selectedGames !== null
    && selectedGames.size === keys.length && keys.every(k => selectedGames.has(k));

// Short text describing the current game filter
function filterSummary(games) {
    if (selectedGames === null) return "All games";
    if (selectedGames.size === 0) return "No games selected";
    const pick = getQuickPicks(games).find(p => selectionIs(p.keys));
    if (pick) return pick.label;
    if (selectedGames.size === 1) {
        const only = games.find(g => selectedGames.has(g.key));
        return only ? only.name : "1 game";
    }
    return `${selectedGames.size} games`;
}

// ============================================================
// GRAPH
// ============================================================

let colEls = [];
let activeIdx = -1;

// Builds the 75 columns once; heights are updated by renderGraph
function buildColumns() {
    statsBars.innerHTML = "";
    colEls = [];
    for (let n = 1; n <= 75; n++) {
        const col = document.createElement("div");
        col.className = "stats-col" + (Math.floor((n - 1) / 15) % 2 === 1 ? " band" : "");
        const bar = document.createElement("span");
        bar.className = "stats-bar";
        col.appendChild(bar);
        statsBars.appendChild(col);
        colEls.push(col);
    }
}

// X-axis labels, one per letter group, aligned with the column bands
function buildAxis() {
    statsAxis.innerHTML = "";
    for (let i = 0; i < 5; i++) {
        const tick = document.createElement("span");
        tick.textContent = `${word[i] || ""} ${i * 15 + 1}-${i * 15 + 15}`;
        statsAxis.appendChild(tick);
    }
}

// Redraws the toolbar labels, summary and bars from the current scope and filter
function renderGraph() {
    const buckets = scopeBuckets();
    const games = listStatsGames(buckets);
    const tally = sumTallies(buckets, selectedGames);
    const counts = tally.callCounts || {};
    const max = Math.max(0, ...Object.values(counts));
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const viewName = viewAll ? "All locations" : getActiveStatsName();
    const filterName = filterSummary(games);

    currentCounts = counts;
    currentMax = max;
    endHold();

    locBtnValue.textContent = viewAll ? "All locations" : viewName;
    gamesBtnValue.textContent = filterName;
    scopeThis.setAttribute("aria-pressed", viewAll ? "false" : "true");
    scopeAll.setAttribute("aria-pressed", viewAll ? "true" : "false");

    for (let n = 1; n <= 75; n++) {
        const c = counts[n] || 0;
        const bar = colEls[n - 1].firstChild;
        bar.style.height = max > 0 ? `${(c / max) * 100}%` : "0%";
        bar.classList.toggle("repeat", c > 1);
    }

    $("yMaxLabel").textContent = max;
    $("yMidLabel").textContent = max > 1 ? (max / 2) : "";

    if (total === 0) {
        statsEmpty.textContent = `No balls recorded yet for ${viewName} · ${filterName}.`;
        statsEmpty.classList.remove("hidden");
        statsSummary.textContent = `${viewName} · ${filterName}`;
    } else {
        statsEmpty.classList.add("hidden");
        const played = tally.gamesPlayed || 0;
        const repeats = Object.values(counts).filter(c => c > 1).length;
        statsSummary.textContent =
            `${viewName} · ${filterName} · ${played} game${played === 1 ? "" : "s"} · ${total} calls · ${repeats} repeated`;
    }
    setReadout(null);
}

// Readout line: the ball under the finger, or the idle hint
function setReadout(n) {
    if (n === null) {
        statsReadout.textContent = IDLE_TEXT;
        statsReadout.classList.add("idle");
        return;
    }
    const c = currentCounts[n] || 0;
    statsReadout.textContent = `${letterFor(n)}${n}: called ${c} time${c === 1 ? "" : "s"}`;
    statsReadout.classList.remove("idle");
}

// Ball number (1-75) under a pointer X position
function ballAt(clientX) {
    const first = colEls[0].getBoundingClientRect();
    const last = colEls[74].getBoundingClientRect();
    const span = last.right - first.left;
    return Math.min(75, Math.max(1, Math.floor(((clientX - first.left) / span) * 75) + 1));
}

// Highlights a ball's column and updates the readout (and the lens while it is open)
function selectBall(n) {
    if (activeIdx === n - 1) return;
    if (activeIdx >= 0) colEls[activeIdx].classList.remove("active");
    activeIdx = n - 1;
    colEls[activeIdx].classList.add("active");
    setReadout(n);
    if (lensOpen) renderLens(n);
}

function clearSelection() {
    if (activeIdx >= 0) colEls[activeIdx].classList.remove("active");
    activeIdx = -1;
    setReadout(null);
}

// ============================================================
// ZOOM LENS (hold on the graph)
// ============================================================

let lensOpen = false;
let holdTimer = null;
let holdStartX = 0;
let holdStartY = 0;

// Draws LENS_BALLS enlarged bars around ball n; bar heights use the overall max so they stay comparable
function renderLens(n) {
    const start = Math.min(75 - LENS_BALLS + 1, Math.max(1, n - Math.floor(LENS_BALLS / 2)));
    statsLens.innerHTML = "";
    for (let i = 0; i < LENS_BALLS; i++) {
        const b = start + i;
        const c = currentCounts[b] || 0;
        const cell = document.createElement("div");
        cell.className = "stats-lens-cell" + (b === n ? " center" : "");

        const count = document.createElement("div");
        count.className = "stats-lens-count";
        count.textContent = c;

        const track = document.createElement("div");
        track.className = "stats-lens-track";
        const bar = document.createElement("div");
        bar.className = "stats-lens-bar";
        bar.style.height = currentMax > 0 ? `${(c / currentMax) * 100}%` : "0%";
        track.appendChild(bar);

        const name = document.createElement("div");
        name.className = "stats-lens-name";
        name.textContent = `${letterFor(b)}${b}`;

        cell.appendChild(count);
        cell.appendChild(track);
        cell.appendChild(name);
        statsLens.appendChild(cell);
    }
    positionLens(n);
}

// Slides the lens horizontally to follow the held ball, kept inside the graph
function positionLens(n) {
    const plot = statsPlot.getBoundingClientRect();
    const col = colEls[n - 1].getBoundingClientRect();
    const half = statsLens.offsetWidth / 2;
    const center = col.left + col.width / 2 - plot.left;
    statsLens.style.left = `${Math.min(plot.width - half, Math.max(half, center)) - half}px`;
}

function openLens(n) {
    lensOpen = true;
    statsLens.classList.remove("hidden");
    renderLens(n);
    // Short buzz confirms the zoom on devices that support it
    try { if (navigator.vibrate) navigator.vibrate(10); } catch (e) { /* unsupported */ }
}

// Stops the hold timer and closes the lens
function endHold() {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    lensOpen = false;
    statsLens.classList.add("hidden");
}

// Pointer capture keeps the scrub going even if the finger drifts off the graph
statsPlot.addEventListener("pointerdown", (e) => {
    try { statsPlot.setPointerCapture(e.pointerId); } catch (err) { /* capture unsupported */ }
    holdStartX = e.clientX;
    holdStartY = e.clientY;
    selectBall(ballAt(e.clientX));
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
        holdTimer = null;
        if (activeIdx >= 0) openLens(activeIdx + 1);
    }, HOLD_MS);
});

statsPlot.addEventListener("pointermove", (e) => {
    const pressed = statsPlot.hasPointerCapture(e.pointerId);
    // Mouse hover previews bars without a press
    if (!pressed && e.pointerType !== "mouse") return;
    // Moving too far before the hold fires turns it into a plain scrub
    if (pressed && holdTimer && Math.hypot(e.clientX - holdStartX, e.clientY - holdStartY) > HOLD_SLOP_PX) {
        clearTimeout(holdTimer);
        holdTimer = null;
    }
    selectBall(ballAt(e.clientX));
});

const endScrub = () => { endHold(); clearSelection(); };
statsPlot.addEventListener("pointerup", endScrub);
statsPlot.addEventListener("pointercancel", endScrub);
statsPlot.addEventListener("pointerleave", (e) => {
    if (e.pointerType === "mouse" && !statsPlot.hasPointerCapture(e.pointerId)) endScrub();
});
// A long press must not open the browser context menu
statsPlot.addEventListener("contextmenu", (e) => e.preventDefault());

// ============================================================
// SHEETS
// ============================================================

// Small button factory used by both sheets
function makeBtn(label, onClick, cls) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "stats-act-btn" + (cls ? " " + cls : "");
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
}

// Re-renders the toolbar, graph and any open sheet after a change
function refresh() {
    normalizeSelection();
    saveViewState();
    renderGraph();
    if (locSheet.open) renderLocSheet();
    if (gamesSheet.open) renderGamesSheet();
}

// Opens a sheet; Done, Esc and a tap on the backdrop close it
function openSheet(sheet, render) {
    render();
    if (!sheet.open) sheet.showModal();
}

[locSheet, gamesSheet].forEach(sheet => {
    sheet.querySelector("[data-close]").addEventListener("click", () => sheet.close());
    sheet.addEventListener("click", (e) => { if (e.target === sheet) sheet.close(); });
});

// Asks for a location name; repeats with an explanation until valid. Resolves null if cancelled.
async function askLocationName(title, confirmLabel, initial, exceptId) {
    let message = "Enter a name for this location.";
    for (;;) {
        const raw = await SuiteDialog.prompt(message, {
            title, value: initial || "", placeholder: "Location name", confirmLabel
        });
        if (raw === null) return null;
        const name = raw.trim().slice(0, 30);
        initial = name;
        if (!name) { message = "Please enter a name."; continue; }
        if (statsNameTaken(name, exceptId)) { message = "That name is already used. Choose another."; continue; }
        return name;
    }
}

// Location sheet: pick the active location, create, rename, delete, save the Unsaved tally, reset
function renderLocSheet() {
    locSheetBody.innerHTML = "";

    const note = document.createElement("p");
    note.className = "stats-sheet-note";
    note.textContent = "Balls called on the board are recorded in the selected location.";
    locSheetBody.appendChild(note);

    const options = [["", "Unsaved"]].concat(
        Object.entries(statsStore.locations)
            .sort((a, b) => a[1].name.localeCompare(b[1].name))
            .map(([id, l]) => [id, l.name])
    );
    options.forEach(([id, name]) => {
        const selected = (statsStore.activeId || "") === id;
        const row = document.createElement("button");
        row.type = "button";
        row.className = "stats-opt" + (selected ? " selected" : "");
        row.setAttribute("role", "radio");
        row.setAttribute("aria-checked", selected ? "true" : "false");
        row.innerHTML = '<span class="stats-opt-name"></span><span class="stats-opt-mark"></span>';
        row.firstChild.textContent = name;
        row.lastChild.textContent = selected ? "✓" : "";
        row.addEventListener("click", () => {
            statsStore.activeId = id || null;
            saveStatsStore();
            refresh();
        });
        locSheetBody.appendChild(row);
    });

    const actions = document.createElement("div");
    actions.className = "stats-sheet-actions";

    actions.appendChild(makeBtn("+ New", async () => {
        const name = await askLocationName("New location", "Create", "", null);
        if (name === null) return;
        createStatsLocation(name);
        refresh();
    }));

    if (statsStore.activeId) {
        const id = statsStore.activeId;
        actions.appendChild(makeBtn("Rename", async () => {
            const name = await askLocationName("Rename location", "Rename", statsStore.locations[id].name, id);
            if (name === null) return;
            statsStore.locations[id].name = name;
            saveStatsStore();
            refresh();
        }));
        actions.appendChild(makeBtn("Delete", async () => {
            const ok = await SuiteDialog.confirm(`"${statsStore.locations[id].name}" and all of its stats will be removed.`, {
                title: "Delete location?", confirmLabel: "Delete location", danger: true, defaultCancel: true
            });
            if (!ok) return;
            delete statsStore.locations[id];
            statsStore.activeId = null;
            saveStatsStore();
            refresh();
        }, "danger"));
    } else if (bucketHasCalls(statsStore.unsaved)) {
        actions.appendChild(makeBtn("Save as location…", async () => {
            const name = await askLocationName("Save as location", "Save", "", null);
            if (name === null) return;
            createStatsLocation(name, statsStore.unsaved);
            statsStore.unsaved = emptyBucket();
            saveStatsStore();
            refresh();
        }));
    }
    locSheetBody.appendChild(actions);

    // Reset: clears only the games the filter shows, never in the combined view
    const bucket = getLocationBucket();
    const resetKeys = selectedGames === null
        ? Object.keys(bucket.games)
        : [...selectedGames].filter(k => bucket.games[k]);
    const resetBtn = makeBtn("Reset stats", async () => {
        if (viewAll || resetKeys.length === 0) return;
        const what = selectedGames === null ? "all games" : resetKeys.map(k => bucket.games[k].name).join(", ");
        const ok = await SuiteDialog.confirm(
            `Ball call stats for "${getActiveStatsName()}" (${what}) will be cleared.\nThe call log and board are not affected.`,
            { title: "Reset stats?", confirmLabel: "Reset stats", danger: true, defaultCancel: true });
        if (!ok) return;
        resetKeys.forEach(k => { delete bucket.games[k]; });
        saveStatsStore();
        refresh();
    }, "danger");
    resetBtn.disabled = viewAll || resetKeys.length === 0;
    if (viewAll) resetBtn.title = "Switch to This location to reset";
    const resetRow = document.createElement("div");
    resetRow.className = "stats-sheet-actions";
    resetRow.appendChild(resetBtn);
    locSheetBody.appendChild(resetRow);
}

// Games sheet: All / None, quick picks and a checklist of the games with recorded stats
function renderGamesSheet() {
    gamesSheetBody.innerHTML = "";
    const games = listStatsGames(scopeBuckets());
    if (games.length === 0) {
        gamesSheetBody.innerHTML = '<p class="stats-game-empty">No games recorded here yet.</p>';
        return;
    }

    // A change to the selection redraws the sheet and the graph
    const apply = (next) => {
        selectedGames = (next && next.size === games.length) ? null : next;
        refresh();
    };

    const bulk = document.createElement("div");
    bulk.className = "stats-sheet-actions";
    bulk.appendChild(makeBtn("All", () => apply(null), selectedGames === null ? "active" : ""));
    bulk.appendChild(makeBtn("None", () => apply(new Set()), selectedGames && selectedGames.size === 0 ? "active" : ""));
    getQuickPicks(games).forEach(pick => {
        bulk.appendChild(makeBtn(pick.label, () => apply(new Set(pick.keys)), selectionIs(pick.keys) ? "active" : ""));
    });
    gamesSheetBody.appendChild(bulk);

    games.forEach(g => {
        const row = document.createElement("label");
        row.className = "stats-game-row";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = selectedGames === null || selectedGames.has(g.key);
        box.addEventListener("change", () => {
            const next = new Set(selectedGames === null ? games.map(x => x.key) : selectedGames);
            if (box.checked) next.add(g.key);
            else next.delete(g.key);
            apply(next);
        });
        const name = document.createElement("span");
        name.className = "stats-game-name";
        name.textContent = g.name;
        const letters = document.createElement("span");
        letters.className = "stats-game-letters";
        letters.textContent = lettersText(g.letters);
        row.appendChild(box);
        row.appendChild(name);
        row.appendChild(letters);
        gamesSheetBody.appendChild(row);
    });
}

locBtn.addEventListener("click", () => openSheet(locSheet, renderLocSheet));
gamesBtn.addEventListener("click", () => openSheet(gamesSheet, renderGamesSheet));
scopeThis.addEventListener("click", () => { viewAll = false; refresh(); });
scopeAll.addEventListener("click", () => { viewAll = true; refresh(); });

// ============================================================
// LANDSCAPE (fullscreen + orientation lock)
// ============================================================

// Releases the orientation lock when it exists
function unlockOrientation() {
    try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) { /* not locked */ }
}

async function toggleLandscape() {
    try {
        if (document.fullscreenElement) {
            unlockOrientation();
            await document.exitFullscreen();
            return;
        }
        await document.documentElement.requestFullscreen();
        await screen.orientation.lock("landscape");
    } catch (e) {
        // Fullscreen or the lock is unsupported or refused: leave fullscreen and stay as-is
        try { if (document.fullscreenElement) await document.exitFullscreen(); } catch (err) { /* already out */ }
    }
}

rotateBtn.addEventListener("click", toggleLandscape);
document.addEventListener("fullscreenchange", () => {
    const on = !!document.fullscreenElement;
    rotateBtn.setAttribute("aria-pressed", on ? "true" : "false");
    if (!on) unlockOrientation();
});

// Keep the lens position and graph correct when the device rotates or the window resizes
window.addEventListener("resize", () => { if (lensOpen && activeIdx >= 0) positionLens(activeIdx + 1); });

// ============================================================
// INIT
// ============================================================

// Another tab or the board page may have changed the store since this page was cached
window.addEventListener("pageshow", () => { loadStatsStore(); refresh(); });

loadViewState();
buildColumns();
buildAxis();
refresh();

const versionEl = $("appVersion");
if (versionEl) versionEl.textContent = STATS_PAGE_VERSION;
if (window.SuiteProfile && SuiteProfile.renderFooterIndicator) {
    SuiteProfile.renderFooterIndicator(document.querySelector(".app-footer p"));
}
