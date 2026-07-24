// ============================================================
// SESSION STATE
// ============================================================

let session = {
    word:     "BINGO",
    called:   [],
    lastBall: null,
    cards:    [],
    gameId:   null
};

// ============================================================
// DOM REFS
// ============================================================

const trackingGrid       = document.getElementById("trackingGrid");
const sessionWordBar     = document.getElementById("sessionWordBar");
const lastFiveList       = document.getElementById("lastFiveList");
const totalCalledSpan    = document.getElementById("totalCalled");
const callLogLink        = document.getElementById("callLogLink");
const newSessionBtn      = document.getElementById("newSessionBtn");
const addCardBtn         = document.getElementById("addCardBtn");
const loadCardBtn        = document.getElementById("loadCardBtn");
const bingoCardsList     = document.getElementById("bingoCardsList");
const selectedGameNameEl = document.getElementById("selectedGameName");
const gameMenuBtn        = document.getElementById("gameMenuBtn");
const gameMenuDropdown   = document.getElementById("gameMenuDropdown");

// Dauber selector
const dauberColorBtn      = document.getElementById("dauberColorBtn");
const dauberColorPreview  = document.getElementById("dauberColorPreview");
const dauberMenuDropdown   = document.getElementById("dauberMenuDropdown");
const dauberPalette       = document.getElementById("dauberPalette");
const dauberOpacitySlider = document.getElementById("dauberOpacitySlider");
const opacityValueText    = document.getElementById("opacityValueText");

// Toggle
const toggleByLetter  = document.getElementById("toggleByLetter");
const toggleByNumber  = document.getElementById("toggleByNumber");

// By-letter panel
const byLetterPanel   = document.getElementById("byLetterPanel");
const numberPicker    = document.getElementById("numberPicker");

// ============================================================
// CURRENT STATE
// ============================================================

let inputMode       = "letter"; // "letter" | "number"
let activeLetterIdx = -1;       // BINGO column selected (-1 = none)
let activeCardEdit  = null;     // { cardId, cellIdx } | null
let openMenuCardId  = null;     // card with open menu
let availableGames  = [];       // loaded from server
let gameMenuOpen    = false;
let shouldScrollToWinner = false;

// ============================================================
// SESSION LOAD / SAVE
// ============================================================

function saveSession() {
    localStorage.setItem("bingoSession", JSON.stringify({
        word:     session.word,
        called:   session.called,
        lastBall: session.lastBall,
        cards:    session.cards,
        gameId:   session.gameId,
        dauber:   session.dauber
    }));
}

function loadSession() {
    const data = localStorage.getItem("bingoSession");
    if (!data) {
        session.dauber = { rgb: "26, 115, 232", opacity: 0.25 };
        return;
    }

    const obj        = JSON.parse(data);
    session.word     = obj.word     || "BINGO";
    session.called   = Array.isArray(obj.called) ? obj.called : [];
    session.lastBall = obj.lastBall || null;
    session.gameId   = obj.gameId   || null;
    session.dauber   = obj.dauber   || { rgb: "26, 115, 232", opacity: 0.25 };

    // Migrate cards: ensure editMode, active, and serial fields exist
    session.cards = Array.isArray(obj.cards)
        ? obj.cards.map(c => ({ editMode: false, active: true, serial: "", ...c }))
        : [];
}

loadSession();

// ============================================================
// SESSION WORD BAR  (also the letter selector in "by letter" mode)
// ============================================================

function updateSessionWordBar() {
    sessionWordBar.innerHTML = "";

    for (let i = 0; i < 5; i++) {
        const span = document.createElement("span");
        span.textContent = session.word[i];

        if (inputMode === "letter") {
            span.classList.add("word-bar-selectable");
            span.classList.toggle("active-letter", i === activeLetterIdx);
            span.setAttribute("role", "button");
            span.setAttribute("tabindex", "0");
            span.setAttribute("aria-label", `Column ${session.word[i]}`);
            span.addEventListener("click", () => onLetterClick(i));
            span.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onLetterClick(i); }
            });
        }

        sessionWordBar.appendChild(span);
    }
}

// ============================================================
// INPUT MODE TOGGLE
// ============================================================

function setInputMode(mode) {
    inputMode = mode;

    if (mode === "letter") {
        toggleByLetter.classList.add("active");
        toggleByNumber.classList.remove("active");
        byLetterPanel.classList.remove("hidden");
        trackingGrid.classList.add("hidden");

        activeLetterIdx = -1;
        numberPicker.classList.add("hidden");
        numberPicker.innerHTML = "";
        updateSessionWordBar();
    } else {
        toggleByNumber.classList.add("active");
        toggleByLetter.classList.remove("active");
        byLetterPanel.classList.add("hidden");
        trackingGrid.classList.remove("hidden");
        buildTrackingGrid();
    }
}

toggleByLetter.addEventListener("click", () => setInputMode("letter"));
toggleByNumber.addEventListener("click", () => setInputMode("number"));

// ============================================================
// BY-LETTER: WORD BAR CLICK
// ============================================================

function onLetterClick(idx) {
    if (activeLetterIdx === idx) {
        activeLetterIdx = -1;
        numberPicker.classList.add("hidden");
        numberPicker.innerHTML = "";
        updateSessionWordBar();
        return;
    }

    activeLetterIdx = idx;
    updateSessionWordBar();
    buildNumberPicker(idx);
}

// ============================================================
// BY-LETTER: NUMBER PICKER (for marking called numbers)
// ============================================================

function buildNumberPicker(colIdx) {
    numberPicker.innerHTML = "";
    numberPicker.classList.remove("hidden");

    const start = colIdx * 15 + 1;

    for (let i = 0; i < 15; i++) {
        const n   = start + i;
        const btn = document.createElement("button");
        btn.className = "pick-btn" + (session.called.includes(n) ? " called" : "");
        btn.textContent = n;
        btn.setAttribute("aria-label", `${session.word[colIdx]}${n}`);
        btn.addEventListener("click", () => onNumberPick(n));
        numberPicker.appendChild(btn);
    }
}

function onNumberPick(n) {
    const prevWinnerExists = session.cards.some(card => checkCardWin(card, getSelectedGame()));

    if (!session.called.includes(n)) {
        session.called.push(n);
        session.lastBall = n;
        if (!prevWinnerExists) shouldScrollToWinner = true;
        updateUI();
        saveSession();
    }

    activeLetterIdx = -1;
    numberPicker.classList.add("hidden");
    numberPicker.innerHTML = "";
    updateSessionWordBar();
}

// ============================================================
// BY-NUMBER: TRACKING GRID (for marking called numbers)
// ============================================================

function buildTrackingGrid() {
    trackingGrid.innerHTML = "";

    for (let col = 0; col < 5; col++) {
        const colDiv = document.createElement("div");
        colDiv.className = "grid-column";

        const hdr = document.createElement("div");
        hdr.className   = "grid-col-header";
        hdr.textContent = session.word[col];
        colDiv.appendChild(hdr);

        const start = col * 15 + 1;
        for (let i = 0; i < 15; i++) {
            const n   = start + i;
            const btn = document.createElement("button");
            btn.className = "grid-number-btn" + (session.called.includes(n) ? " called" : "");
            btn.textContent = n;
            btn.setAttribute("aria-label", `${session.word[col]}${n}`);
            btn.addEventListener("click", () => onNumberGridClick(n));
            colDiv.appendChild(btn);
        }

        trackingGrid.appendChild(colDiv);
    }
}

function onNumberGridClick(n) {
    const prevWinnerExists = session.cards.some(card => checkCardWin(card, getSelectedGame()));

    if (session.called.includes(n)) {
        session.called = session.called.filter(x => x !== n);
        if (session.lastBall === n) {
            session.lastBall = session.called[session.called.length - 1] || null;
        }
    } else {
        session.called.push(n);
        session.lastBall = n;
        if (!prevWinnerExists) shouldScrollToWinner = true;
    }

    updateUI();
    saveSession();
}

// ============================================================
// CALL LOG MODAL & NEW SESSION
// ============================================================

callLogLink.addEventListener("click", (e) => {
    e.preventDefault();
    openCallLogModal();
});

function openCallLogModal() {
    const modal = document.createElement("div");
    modal.className = "game-picker-modal";

    const panel = document.createElement("div");
    panel.className = "game-picker-panel";

    const hdr = document.createElement("div");
    hdr.className = "game-picker-header";

    const title = document.createElement("h2");
    title.className   = "game-picker-title";
    title.textContent = "Called Numbers History";

    const closeBtn = document.createElement("button");
    closeBtn.className   = "link-button";
    closeBtn.textContent = "✕ Close";
    closeBtn.addEventListener("click", () => modal.remove());

    hdr.appendChild(title);
    hdr.appendChild(closeBtn);
    panel.appendChild(hdr);

    const content = document.createElement("div");
    content.style.padding = "10px 0";

    if (session.called.length === 0) {
        content.innerHTML = '<p class="bingo-cards-placeholder">No numbers called yet in this session.</p>';
    } else {
        const list = document.createElement("div");
        list.style.display = "flex";
        list.style.flexWrap = "wrap";
        list.style.gap = "8px";

        session.called.forEach((num, idx) => {
            const chip = document.createElement("span");
            chip.style.background = "var(--primary-soft)";
            chip.style.color = "var(--primary)";
            chip.style.padding = "6px 12px";
            chip.style.borderRadius = "999px";
            chip.style.fontSize = "14px";
            chip.style.fontWeight = "600";
            chip.textContent = `#${idx + 1}: ${num}`;
            list.appendChild(chip);
        });
        content.appendChild(list);
    }

    panel.appendChild(content);
    modal.appendChild(panel);
    document.body.appendChild(modal);
    modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });
}

newSessionBtn.addEventListener("click", () => {
    if (!confirm("Start a new game session? Called numbers will be reset.")) return;

    session.called   = [];
    session.lastBall = null;
    activeLetterIdx  = -1;
    activeCardEdit   = null;

    saveSession();
    updateUI();
});

// ============================================================
// DAUBER COLOR & OPACITY CONTROLS
// ============================================================

const DAUBER_PALETTE = [
    { name: "Blue",    rgb: "26, 115, 232" },
    { name: "Red",     rgb: "229, 57, 53" },
    { name: "Magenta", rgb: "216, 27, 96" },
    { name: "Purple",  rgb: "142, 36, 170" },
    { name: "Green",   rgb: "67, 160, 71" },
    { name: "Teal",    rgb: "0, 137, 123" },
    { name: "Orange",  rgb: "251, 140, 0" },
    { name: "Gold",    rgb: "245, 124, 0" }
];

let dauberMenuOpen = false;

function applyDauberSettings() {
    const daub = session.dauber || { rgb: "26, 115, 232", opacity: 0.25 };
    document.documentElement.style.setProperty("--daub-rgb", daub.rgb);
    document.documentElement.style.setProperty("--daub-alpha", daub.opacity);
    if (dauberColorPreview) {
        dauberColorPreview.style.background = `rgb(${daub.rgb})`;
    }
    if (opacityValueText) {
        opacityValueText.textContent = `${Math.round(daub.opacity * 100)}%`;
    }
    if (dauberOpacitySlider) {
        dauberOpacitySlider.value = daub.opacity;
    }
}

function renderDauberPalette() {
    if (!dauberPalette) return;
    dauberPalette.innerHTML = "";

    const currentRgb = session.dauber ? session.dauber.rgb : "26, 115, 232";

    DAUBER_PALETTE.forEach(c => {
        const swatch = document.createElement("button");
        swatch.className = "dauber-palette-swatch" + (c.rgb === currentRgb ? " selected" : "");
        swatch.style.background = `rgb(${c.rgb})`;
        swatch.title = c.name;
        swatch.type = "button";
        swatch.addEventListener("click", (e) => {
            e.stopPropagation();
            if (!session.dauber) session.dauber = { rgb: "26, 115, 232", opacity: 0.25 };
            session.dauber.rgb = c.rgb;
            applyDauberSettings();
            saveSession();
            renderAllCards();
            renderDauberPalette();
            closeDauberMenu();
        });
        dauberPalette.appendChild(swatch);
    });
}

function toggleDauberMenu() {
    dauberMenuOpen = !dauberMenuOpen;
    if (dauberMenuDropdown) {
        dauberMenuDropdown.classList.toggle("hidden", !dauberMenuOpen);
    }
    if (dauberMenuOpen) {
        renderDauberPalette();
    }
}

function closeDauberMenu() {
    dauberMenuOpen = false;
    if (dauberMenuDropdown) {
        dauberMenuDropdown.classList.add("hidden");
    }
}

if (dauberColorBtn) {
    dauberColorBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleDauberMenu();
    });
}

if (dauberOpacitySlider) {
    dauberOpacitySlider.addEventListener("input", (e) => {
        const val = parseFloat(e.target.value);
        if (!session.dauber) session.dauber = { rgb: "26, 115, 232", opacity: 0.25 };
        session.dauber.opacity = val;
        applyDauberSettings();
        saveSession();
        renderAllCards();
    });
}

// ============================================================
// GAME MODES — server sync & menu
// ============================================================

async function loadGames() {
    try {
        const res  = await fetch("./php/games.php");
        const data = await res.json();
        if (Array.isArray(data)) {
            availableGames = data;
            if (!session.gameId && availableGames.length > 0) {
                session.gameId = availableGames[0].id;
                saveSession();
            }
        }
    } catch (err) {
        console.warn("Could not load games from server:", err);
    }
    updateUI();
}

function getSelectedGame() {
    return availableGames.find(g => g.id === session.gameId) || null;
}

function selectGame(gameId) {
    session.gameId = gameId;
    saveSession();
    closeGamePicker();
    shouldScrollToWinner = true;
    updateUI();
}

function toggleGameMenu() {
    gameMenuOpen = !gameMenuOpen;
    gameMenuDropdown.classList.toggle("hidden", !gameMenuOpen);
    gameMenuBtn.setAttribute("aria-expanded", gameMenuOpen ? "true" : "false");
    if (gameMenuOpen) renderGameMenuDropdown();
}

function closeGameMenu() {
    gameMenuOpen = false;
    gameMenuDropdown.classList.add("hidden");
    gameMenuBtn.setAttribute("aria-expanded", "false");
}

function renderGameMenuDropdown() {
    gameMenuDropdown.innerHTML = "";

    const changeBtn = document.createElement("button");
    changeBtn.className   = "card-menu-item";
    changeBtn.textContent = "🎯  Select game";
    changeBtn.addEventListener("click", openGamePicker);

    const createBtn = document.createElement("button");
    createBtn.className   = "card-menu-item";
    createBtn.textContent = "➕  Create game";
    createBtn.addEventListener("click", openGameCreator);

    gameMenuDropdown.appendChild(changeBtn);
    gameMenuDropdown.appendChild(createBtn);
}

gameMenuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleGameMenu();
});

// Global click-outside handler
document.addEventListener("click", (e) => {
    if (gameMenuOpen && !e.target.closest("#gameSection")) closeGameMenu();
    if (dauberMenuOpen && !e.target.closest(".dauber-selector-wrap")) closeDauberMenu();
    if (openMenuCardId !== null && !e.target.closest(".bingo-card")) {
        openMenuCardId = null;
        renderAllCards();
    }
});

// ============================================================
// GAME MODES — picker modal
// ============================================================

function openGamePicker() {
    closeGameMenu();

    const modal = document.createElement("div");
    modal.id        = "gamePickerModal";
    modal.className = "game-picker-modal";
    modal.setAttribute("role",       "dialog");
    modal.setAttribute("aria-label", "Select Game");

    const panel = document.createElement("div");
    panel.className = "game-picker-panel";

    const hdr = document.createElement("div");
    hdr.className = "game-picker-header";

    const title = document.createElement("h2");
    title.className   = "game-picker-title";
    title.textContent = "Select a Game";

    const closeBtn = document.createElement("button");
    closeBtn.className   = "link-button";
    closeBtn.textContent = "✕ Close";
    closeBtn.addEventListener("click", closeGamePicker);

    hdr.appendChild(title);
    hdr.appendChild(closeBtn);
    panel.appendChild(hdr);

    const list = document.createElement("div");
    list.className = "game-picker-list";

    if (availableGames.length === 0) {
        list.innerHTML = '<p class="bingo-cards-placeholder">No games yet. Use "Create Game" to make one.</p>';
    } else {
        for (const game of availableGames) {
            list.appendChild(renderGamePickerItem(game));
        }
    }

    panel.appendChild(list);
    modal.appendChild(panel);
    document.body.appendChild(modal);

    modal.addEventListener("click", (e) => { if (e.target === modal) closeGamePicker(); });
}

function renderGamePickerItem(game) {
    const isSelected     = session.gameId === game.id;
    const firstPattern   = game.patterns[0];
    const patternCells   = new Set(firstPattern ? firstPattern.cells : []);

    const item = document.createElement("div");
    item.className = "game-picker-item" + (isSelected ? " selected" : "");
    item.setAttribute("role",     "button");
    item.setAttribute("tabindex", "0");

    const miniGrid = document.createElement("div");
    miniGrid.className = "mini-card-grid";

    for (let i = 0; i < 25; i++) {
        const mc = document.createElement("div");
        mc.className = [
            "mini-cell",
            i === 12              ? "mini-free"    : "",
            patternCells.has(i)   ? "mini-pattern" : ""
        ].filter(Boolean).join(" ");
        miniGrid.appendChild(mc);
    }

    const info = document.createElement("div");
    info.className = "game-picker-info";

    const name = document.createElement("span");
    name.className   = "game-picker-name";
    name.textContent = game.name;

    const meta = document.createElement("span");
    meta.className   = "game-picker-meta";
    meta.textContent = `${game.patterns.length} pattern${game.patterns.length !== 1 ? "s" : ""}`;

    info.appendChild(name);
    info.appendChild(meta);

    item.appendChild(miniGrid);
    item.appendChild(info);

    if (isSelected) {
        const check = document.createElement("span");
        check.className   = "game-picker-check";
        check.textContent = "✓";
        item.appendChild(check);
    }

    item.addEventListener("click",   () => selectGame(game.id));
    item.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectGame(game.id); }
    });

    return item;
}

function closeGamePicker() {
    const modal = document.getElementById("gamePickerModal");
    if (modal) modal.remove();
}

// ============================================================
// GAME MODES — creator
// ============================================================

function openGameCreator() {
    closeGameMenu();
    const w = window.open("./game-creator.html", "bingoGameCreator",
        "width=500,height=740,top=60,left=120,resizable=yes");
    if (!w) alert("Please allow popups for this site to open the game creator.");
}

window.addEventListener("message", (e) => {
    if (e.data === "games-updated") loadGames();
});

// ============================================================
// GAME MODES — win detection
// ============================================================

function checkCardWin(card, game) {
    if (!game || !card.active) return null;
    const calledSet = new Set(session.called);

    for (const pattern of game.patterns) {
        const allDaubed = pattern.cells.every(cellIdx => {
            if (cellIdx === FREE_CELL) return true;
            const val = card.squares[cellIdx];
            return val !== null && val !== "FREE" && calledSet.has(val);
        });
        if (allDaubed) return pattern;
    }
    return null;
}

// ============================================================
// BINGO CARDS — helpers
// ============================================================

const FREE_CELL = 12;

function colForCell(cellIdx) { return cellIdx % 5; }

function colNumbers(col) {
    const start = col * 15 + 1;
    return Array.from({ length: 15 }, (_, i) => start + i);
}

// ============================================================
// BINGO CARDS — actions & server persistence
// ============================================================

function addCard() {
    const squares = Array(25).fill(null);
    squares[FREE_CELL] = "FREE";
    const num = session.cards.length + 1;

    session.cards.push({
        id:       Date.now(),
        label:    `Card ${num}`,
        serial:   `SN-${String(num).padStart(3, '0')}`,
        squares,
        editMode: true,
        active:   true
    });

    saveSession();
    renderAllCards();
}

// Save card to server API (htdocs/Bingo/php/cards.php)
async function saveCardToServer(card) {
    try {
        const res = await fetch("./php/cards.php", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                id: card.id,
                name: card.label,
                serial: card.serial || "",
                squares: card.squares
            })
        });
        const data = await res.json();
        if (data.success) {
            card.editMode = false;
            saveSession();
            renderAllCards();
            alert(`✓ Saved "${card.label}" ${card.serial ? '(S/N: ' + card.serial + ')' : ''} to server!`);
        } else {
            alert("Error saving card to server: " + (data.error || "Unknown error"));
        }
    } catch (err) {
        console.error(err);
        alert("Server error. Ensure PHP backend is available.");
    }
}

// Load Card Modal — fetches saved cards from server
async function openCardPicker() {
    let savedCards = [];
    try {
        const res = await fetch("./php/cards.php");
        savedCards = await res.json();
    } catch (err) {
        console.warn("Could not fetch cards from server:", err);
    }

    const modal = document.createElement("div");
    modal.id = "cardPickerModal";
    modal.className = "game-picker-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-label", "Load Card from Server");

    const panel = document.createElement("div");
    panel.className = "game-picker-panel";

    const hdr = document.createElement("div");
    hdr.className = "game-picker-header";

    const title = document.createElement("h2");
    title.className = "game-picker-title";
    title.textContent = "Saved Server Cards";

    const closeBtn = document.createElement("button");
    closeBtn.className = "link-button";
    closeBtn.textContent = "✕ Close";
    closeBtn.addEventListener("click", () => modal.remove());

    hdr.appendChild(title);
    hdr.appendChild(closeBtn);
    panel.appendChild(hdr);

    const list = document.createElement("div");
    list.className = "game-picker-list";

    if (!Array.isArray(savedCards) || savedCards.length === 0) {
        list.innerHTML = '<p class="bingo-cards-placeholder">No cards saved on server yet. Use "Save card" from card menu to store cards.</p>';
    } else {
        savedCards.forEach(savedCard => {
            list.appendChild(renderServerCardItem(savedCard, modal));
        });
    }

    panel.appendChild(list);
    modal.appendChild(panel);
    document.body.appendChild(modal);

    modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });
}

// Render single server card item in load modal
function renderServerCardItem(savedCard, modal) {
    const item = document.createElement("div");
    item.className = "game-picker-item";
    item.style.alignItems = "center";

    // Mini grid preview
    const miniGrid = document.createElement("div");
    miniGrid.className = "mini-card-grid";

    const squares = Array.isArray(savedCard.squares) ? savedCard.squares : Array(25).fill(null);
    for (let i = 0; i < 25; i++) {
        const mc = document.createElement("div");
        const val = squares[i];
        const isFree = (i === 12 || val === "FREE");
        const hasVal = !isFree && val !== null && val !== "";
        mc.className = [
            "mini-cell",
            isFree ? "mini-free" : "",
            hasVal ? "mini-pattern" : ""
        ].filter(Boolean).join(" ");
        miniGrid.appendChild(mc);
    }

    const info = document.createElement("div");
    info.className = "game-picker-info";

    const name = document.createElement("span");
    name.className = "game-picker-name";
    name.textContent = savedCard.name || "Card";

    const serialMeta = document.createElement("span");
    serialMeta.className = "game-picker-meta";
    serialMeta.textContent = savedCard.serial ? `S/N: ${savedCard.serial}` : `No Serial #`;

    info.appendChild(name);
    info.appendChild(serialMeta);

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.gap = "6px";

    const loadBtn = document.createElement("button");
    loadBtn.className = "btn btn-primary";
    loadBtn.style.padding = "6px 12px";
    loadBtn.style.fontSize = "13px";
    loadBtn.textContent = "Load";
    loadBtn.onclick = (e) => {
        e.stopPropagation();
        session.cards.push({
            id: Date.now(),
            label: savedCard.name || "Loaded Card",
            serial: savedCard.serial || "",
            squares: [...squares],
            editMode: false,
            active: true
        });
        saveSession();
        renderAllCards();
        modal.remove();
    };

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "btn btn-secondary";
    deleteBtn.style.padding = "6px 10px";
    deleteBtn.style.fontSize = "13px";
    deleteBtn.textContent = "🗑";
    deleteBtn.title = "Delete card from server";
    deleteBtn.onclick = async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete "${savedCard.name}" from server?`)) return;
        try {
            await fetch(`./php/cards.php?id=${savedCard.id}`, { method: "DELETE" });
            item.remove();
        } catch (err) {
            console.error(err);
        }
    };

    actions.appendChild(loadBtn);
    actions.appendChild(deleteBtn);

    item.appendChild(miniGrid);
    item.appendChild(info);
    item.appendChild(actions);

    return item;
}

function menuAction(cardId, action) {
    const card = session.cards.find(c => c.id === cardId);
    if (!card) return;

    openMenuCardId = null;

    switch (action) {
        case "toggleEdit":
            card.editMode = !card.editMode;
            if (!card.editMode) activeCardEdit = null;
            break;
        case "saveServer":
            saveCardToServer(card);
            return;
        case "loadServer":
            openCardPicker();
            return;
        case "scan":
            window.location.href = `./scan/scan.html?cardId=${cardId}`;
            return;
        case "remove":
            if (!confirm("Remove this card from session?")) { renderAllCards(); return; }
            session.cards = session.cards.filter(c => c.id !== cardId);
            if (activeCardEdit && activeCardEdit.cardId === cardId) activeCardEdit = null;
            saveSession();
            renderAllCards();
            return;
        case "use":
            card.active = true;
            break;
        case "unuse":
            card.active = false;
            break;
    }

    saveSession();
    renderAllCards();
}

function onCardCellClick(cardId, cellIdx) {
    const card = session.cards.find(c => c.id === cardId);
    if (!card || !card.editMode) return;

    if (openMenuCardId !== null) { openMenuCardId = null; renderAllCards(); return; }

    if (activeCardEdit && activeCardEdit.cardId === cardId && activeCardEdit.cellIdx === cellIdx) {
        activeCardEdit = null;
        renderAllCards();
        return;
    }

    activeCardEdit = { cardId, cellIdx };
    renderAllCards();
}

function onCardNumberSelect(cardId, cellIdx, number) {
    const card = session.cards.find(c => c.id === cardId);
    if (!card) return;
    card.squares[cellIdx] = number;
    activeCardEdit = null;
    saveSession();
    renderAllCards();
}

function toggleMenu(cardId) {
    openMenuCardId = openMenuCardId === cardId ? null : cardId;
    if (openMenuCardId !== null) activeCardEdit = null;
    renderAllCards();
}

// ============================================================
// BINGO CARDS — render
// ============================================================

function renderAllCards() {
    bingoCardsList.innerHTML = "";

    if (session.cards.length === 0) {
        bingoCardsList.innerHTML = '<p class="bingo-cards-placeholder">No bingo cards yet. Tap + Add Card or 📥 Load Card to get started.</p>';
        return;
    }

    for (const card of session.cards) {
        bingoCardsList.appendChild(renderCard(card));
    }
}

function renderCard(card) {
    const isEditing   = card.editMode;
    const isActive    = card.active !== false;
    const isMenuOpen  = openMenuCardId === card.id;
    const editCellIdx = (activeCardEdit && activeCardEdit.cardId === card.id)
        ? activeCardEdit.cellIdx : -1;

    // Win detection
    const game           = getSelectedGame();
    const winningPattern = (isActive && game) ? checkCardWin(card, game) : null;
    const winCells       = new Set(winningPattern ? winningPattern.cells : []);
    if (winningPattern && winningPattern.cells.includes(FREE_CELL)) winCells.add(FREE_CELL);

    // ---- Wrapper ----
    const wrapper = document.createElement("div");
    wrapper.className = [
        "bingo-card",
        isEditing       ? "card-editing"  : "",
        !isActive       ? "card-inactive" : "",
        winningPattern  ? "card-winner"   : ""
    ].filter(Boolean).join(" ");
    wrapper.dataset.cardId = card.id;

    // ---- Card header ----
    const header = document.createElement("div");
    header.className = "bingo-card-header";

    const menuBtn = document.createElement("button");
    menuBtn.className = "card-menu-btn" + (isMenuOpen ? " open" : "");
    menuBtn.setAttribute("aria-label",    "Card menu");
    menuBtn.setAttribute("aria-expanded", isMenuOpen ? "true" : "false");
    menuBtn.innerHTML = `<span></span><span></span><span></span>`;
    menuBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleMenu(card.id); });

    const titleWrap = document.createElement("div");
    titleWrap.className = "bingo-card-title-wrap";

    if (isEditing) {
        const labelInput = document.createElement("input");
        labelInput.type = "text";
        labelInput.className = "bingo-card-label-input";
        labelInput.value = card.label || "";
        labelInput.placeholder = "Card Name";
        labelInput.addEventListener("change", (e) => {
            card.label = e.target.value.trim() || card.label;
            saveSession();
        });
        labelInput.addEventListener("click", (e) => e.stopPropagation());

        const serialInput = document.createElement("input");
        serialInput.type = "text";
        serialInput.className = "bingo-card-serial-input";
        serialInput.value = card.serial || "";
        serialInput.placeholder = "Serial #";
        serialInput.addEventListener("change", (e) => {
            card.serial = e.target.value.trim();
            saveSession();
        });
        serialInput.addEventListener("click", (e) => e.stopPropagation());

        titleWrap.appendChild(labelInput);
        titleWrap.appendChild(serialInput);
    } else {
        const labelEl = document.createElement("span");
        labelEl.className = "bingo-card-label";
        labelEl.textContent = card.label;
        titleWrap.appendChild(labelEl);

        if (card.serial) {
            const serialTag = document.createElement("span");
            serialTag.className = "bingo-card-serial-tag";
            serialTag.textContent = `S/N: ${card.serial}`;
            titleWrap.appendChild(serialTag);
        }
    }

    const badge = document.createElement("span");
    badge.className = "card-status-badge";
    if (isEditing)      { badge.textContent = "editing";  badge.classList.add("badge-editing");  }
    else if (!isActive) { badge.textContent = "inactive"; badge.classList.add("badge-inactive"); }

    header.appendChild(menuBtn);
    header.appendChild(titleWrap);
    if (badge.textContent) header.appendChild(badge);

    // ---- Dropdown menu (anchored inside header) ----
    if (isMenuOpen) {
        const menu = document.createElement("div");
        menu.className = "card-menu-dropdown";
        menu.addEventListener("click", (e) => e.stopPropagation());

        const menuItems = [
            isEditing
                ? { action: "toggleEdit", label: "✓  Done editing" }
                : { action: "toggleEdit", label: "✏️  Edit card" },
            { action: "saveServer", label: "💾  Save card to server" },
            { action: "loadServer", label: "📥  Load card from server" },
            { action: "scan",       label: "📷  Scan card" },
            { action: "remove",     label: "🗑  Remove card" },
            isActive
                ? { action: "unuse", label: "🚫  Don't use card" }
                : { action: "use",   label: "✅  Use card" }
        ];

        for (const item of menuItems) {
            const btn = document.createElement("button");
            btn.className   = "card-menu-item";
            btn.textContent = item.label;
            btn.addEventListener("click", () => menuAction(card.id, item.action));
            menu.appendChild(btn);
        }

        header.appendChild(menu);
    }

    wrapper.appendChild(header);

    // ---- 5×5 card grid ----
    const grid = document.createElement("div");
    grid.className = "bingo-card-grid";

    for (let col = 0; col < 5; col++) {
        const hdr       = document.createElement("div");
        hdr.className   = "bingo-col-header";
        hdr.textContent = session.word[col];
        grid.appendChild(hdr);
    }

    for (let idx = 0; idx < 25; idx++) {
        const value       = card.squares[idx];
        const isFree      = (idx === FREE_CELL);
        const isDaubed    = isActive && (isFree || (value !== null && session.called.includes(value)));
        const isEmpty     = !isFree && value === null;
        const isCellActive = (idx === editCellIdx);
        const isWinCell   = !!winningPattern && (winCells.has(idx) || (isFree && winningPattern.cells.includes(FREE_CELL)));

        const cell = document.createElement("div");
        cell.className = [
            "bingo-cell",
            isFree       ? "free"     : "",
            isDaubed     ? "daubed"   : "",
            isEmpty      ? "empty"    : "",
            isCellActive ? "editing"  : "",
            isWinCell    ? "win-cell" : ""
        ].filter(Boolean).join(" ");

        cell.textContent = isFree ? "FREE" : (value ?? "");

        if (!isFree && isEditing) {
            cell.addEventListener("click", () => onCardCellClick(card.id, idx));
        }

        grid.appendChild(cell);
    }

    wrapper.appendChild(grid);

    // ---- Winner overlay ----
    if (winningPattern) {
        const overlay = document.createElement("div");
        overlay.className = "card-winner-overlay";
        overlay.innerHTML = `
            <span class="winner-bingo-text">BINGO!</span>
            <span class="winner-game-name">${game.name}</span>
            <span class="winner-pattern-name">${winningPattern.name}</span>
        `;
        wrapper.appendChild(overlay);
    }

    // ---- Inline column picker (edit mode only) ----
    if (isEditing && editCellIdx !== -1) {
        const col       = colForCell(editCellIdx);
        const numbers   = colNumbers(col);
        const usedInCol = card.squares
            .filter((v, i) => i !== editCellIdx && colForCell(i) === col && v !== null && v !== "FREE");

        const picker = document.createElement("div");
        picker.className = "card-number-picker";

        const pickerLabel = document.createElement("div");
        pickerLabel.className   = "card-picker-label";
        pickerLabel.textContent = `Select ${session.word[col]} number`;
        picker.appendChild(pickerLabel);

        const pickerGrid = document.createElement("div");
        pickerGrid.className = "card-picker-grid";

        for (const n of numbers) {
            const btn         = document.createElement("button");
            const alreadyUsed = usedInCol.includes(n);
            const isCalled    = session.called.includes(n);

            btn.className = [
                "pick-btn",
                alreadyUsed ? "used-on-card" : "",
                isCalled    ? "called"        : ""
            ].filter(Boolean).join(" ");

            btn.textContent = n;
            btn.disabled    = alreadyUsed;
            btn.title       = alreadyUsed ? "Already on this card" : "";
            btn.setAttribute("aria-label", `${session.word[col]}${n}`);

            if (!alreadyUsed) {
                btn.addEventListener("click", () => onCardNumberSelect(card.id, editCellIdx, n));
            }

            pickerGrid.appendChild(btn);
        }

        picker.appendChild(pickerGrid);
        wrapper.appendChild(picker);
    }

    return wrapper;
}

if (addCardBtn) addCardBtn.addEventListener("click", addCard);
if (loadCardBtn) loadCardBtn.addEventListener("click", openCardPicker);

// ============================================================
// INIT
// ============================================================

setInputMode("letter");
applyDauberSettings();
updateUI();
loadGames();
