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

    // Migrate cards: ensure editMode / active fields exist
    session.cards = Array.isArray(obj.cards)
        ? obj.cards.map(c => ({ editMode: false, active: true, ...c }))
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
// BY-NUMBER: TRACKING GRID
// ============================================================

function buildTrackingGrid() {
    trackingGrid.innerHTML = "";

    for (let col = 0; col < 5; col++) {
        const columnDiv = document.createElement("div");
        columnDiv.className = "column";

        const start = col * 15 + 1;
        const end   = start + 14;

        for (let n = start; n <= end; n++) {
            const cell = document.createElement("div");
            cell.className = "numberCell" + (session.called.includes(n) ? " called" : "");
            cell.textContent = n;
            cell.onclick = () => toggleNumber(n);
            columnDiv.appendChild(cell);
        }

        trackingGrid.appendChild(columnDiv);
    }
}

// ============================================================
// TOGGLE NUMBER (by-number mode)
// ============================================================

function toggleNumber(n) {
    const prevWinnerExists = session.cards.some(card => checkCardWin(card, getSelectedGame()));
    const idx = session.called.indexOf(n);
    if (idx !== -1) {
        if (!confirm(`Remove ${n}?`)) return;
        session.called.splice(idx, 1);
        session.lastBall = session.called.length
            ? session.called[session.called.length - 1] : null;
    } else {
        session.called.push(n);
        session.lastBall = n;
        if (!prevWinnerExists) shouldScrollToWinner = true;
    }
    updateUI();
    saveSession();
}

// ============================================================
// CALL LOG
// ============================================================

function openCallLogWindow() {
    const w = window.open("", "bingoCallLog", "width=320,height=420,top=100,left=100");
    if (!w) { alert("Please allow popups for this site."); return; }

    const listItems = session.called.map(v => `<li>${v}</li>`).join("");
    w.document.write(`<!DOCTYPE html><html><head><title>Call Log</title><style>body{font-family:Arial,sans-serif;margin:20px;color:#202124;background:#f8f9fa;}h1{font-size:20px;margin-bottom:12px;}ol{padding-left:18px;}li{margin-bottom:6px;}button{margin-top:18px;padding:10px 14px;border:none;border-radius:10px;background:#1a73e8;color:#fff;cursor:pointer;}</style></head><body><h1>Call Log</h1><ol>${listItems || '<li>No numbers called yet</li>'}</ol><button onclick="window.close()">Close</button></body></html>`);
    w.document.close();
}

// ============================================================
// UPDATE UI
// ============================================================

function updateUI() {
    const lastFive = session.called.slice(-6);
    lastFiveList.innerHTML = "";

    for (let i = 5; i >= 0; i--) {
        const item = document.createElement("div");
        item.className = "last-five-item" + (lastFive[i] === undefined ? " empty" : "");
        item.textContent = lastFive[i] ?? "—";
        lastFiveList.appendChild(item);
    }

    totalCalledSpan.textContent = `${session.called.length} called`;

    if (inputMode === "number") buildTrackingGrid();

    updateSessionWordBar();
    renderGameSection();
    renderAllCards();

    if (shouldScrollToWinner) {
        const firstWinner = bingoCardsList.querySelector(".bingo-card.card-winner");
        if (firstWinner) {
            firstWinner.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        shouldScrollToWinner = false;
    }
}

callLogLink.onclick = openCallLogWindow;

// ============================================================
// NEW SESSION
// ============================================================

newSessionBtn.onclick = () => {
    const newWord = prompt("Enter a 5-letter session word:", "BINGO");
    if (!newWord || newWord.length !== 5) {
        alert("Invalid word. Using BINGO.");
        session.word = "BINGO";
    } else {
        session.word = newWord.toUpperCase();
    }

    session.called   = [];
    session.lastBall = null;

    activeLetterIdx = -1;
    numberPicker.classList.add("hidden");
    numberPicker.innerHTML = "";

    saveSession();
    updateUI();
};

// ============================================================
// GAME MODES — load
// ============================================================

const GAMES_API = "./php/games.php";

async function loadGames() {
    try {
        const res = await fetch(GAMES_API);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        availableGames = await res.json();
    } catch (e) {
        console.warn("Could not load games:", e);
        availableGames = [];
    }
    renderGameSection();
    renderAllCards();
}

function getSelectedGame() {
    if (!session.gameId) return null;
    return availableGames.find(g => g.id === session.gameId) || null;
}

function selectGame(gameId) {
    session.gameId = gameId;
    saveSession();
    closeGameMenu();
    closeGamePicker();
    renderGameSection();
    renderAllCards();
}

// ============================================================
// GAME MODES — section & menu
// ============================================================

function renderGameSection() {
    const game = getSelectedGame();
    selectedGameNameEl.textContent = game ? game.name : "— None selected —";
    selectedGameNameEl.classList.toggle("game-selected", !!game);

    if (gameMenuOpen) {
        gameMenuDropdown.innerHTML = "";
        gameMenuDropdown.classList.remove("hidden");

        const items = [
            { label: "🎮  Change Game", fn: openGamePicker  },
            { label: "✏️  Create Game", fn: openGameCreator }
        ];

        for (const item of items) {
            const btn = document.createElement("button");
            btn.className = "card-menu-item";
            btn.textContent = item.label;
            btn.addEventListener("click", (e) => { e.stopPropagation(); item.fn(); });
            gameMenuDropdown.appendChild(btn);
        }
    } else {
        gameMenuDropdown.innerHTML = "";
        gameMenuDropdown.classList.add("hidden");
    }
}

function toggleGameMenu() {
    gameMenuOpen = !gameMenuOpen;
    gameMenuBtn.classList.toggle("open", gameMenuOpen);
    gameMenuBtn.setAttribute("aria-expanded", gameMenuOpen ? "true" : "false");
    renderGameSection();
}

function closeGameMenu() {
    if (!gameMenuOpen) return;
    gameMenuOpen = false;
    gameMenuBtn.classList.remove("open");
    gameMenuBtn.setAttribute("aria-expanded", "false");
    renderGameSection();
}

gameMenuBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleGameMenu(); });

// ============================================================
// DAUBER COLOR & OPACITY SELECTOR
// ============================================================

const DAUBER_PALETTE = [
    { name: "Blue",    rgb: "26, 115, 232",  hex: "#1a73e8" },
    { name: "Red",     rgb: "229, 57, 53",   hex: "#e53935" },
    { name: "Magenta", rgb: "216, 27, 96",   hex: "#d81b60" },
    { name: "Purple",  rgb: "142, 36, 170",  hex: "#8e24aa" },
    { name: "Green",   rgb: "43, 168, 74",   hex: "#2ba84a" },
    { name: "Teal",    rgb: "0, 172, 193",   hex: "#00acc1" },
    { name: "Orange",  rgb: "245, 124, 0",   hex: "#f57c00" },
    { name: "Gold",    rgb: "249, 168, 37",  hex: "#f9a825" }
];

let dauberMenuOpen = false;

function applyDauberSettings() {
    if (!session.dauber) {
        session.dauber = { rgb: "26, 115, 232", opacity: 0.25 };
    }
    const rgb = session.dauber.rgb || "26, 115, 232";
    const opacity = (session.dauber.opacity !== undefined) ? session.dauber.opacity : 0.25;

    document.documentElement.style.setProperty("--daub-rgb", rgb);
    document.documentElement.style.setProperty("--daub-alpha", opacity);

    if (opacityValueText) {
        opacityValueText.textContent = `${Math.round(opacity * 100)}%`;
    }
    if (dauberOpacitySlider) {
        dauberOpacitySlider.value = opacity;
    }

    renderDauberPalette();
}

function renderDauberPalette() {
    if (!dauberPalette) return;
    dauberPalette.innerHTML = "";

    const currentRgb = (session.dauber && session.dauber.rgb) || "26, 115, 232";

    for (const item of DAUBER_PALETTE) {
        const btn = document.createElement("button");
        btn.type = "button";
        const isActive = (item.rgb === currentRgb);
        btn.className = "dauber-palette-item" + (isActive ? " active" : "");
        btn.style.background = item.hex;
        btn.title = item.name;
        btn.setAttribute("aria-label", `Select dauber color ${item.name}`);

        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (!session.dauber) session.dauber = {};
            session.dauber.rgb = item.rgb;
            applyDauberSettings();
            saveSession();
            closeDauberMenu();
        });

        dauberPalette.appendChild(btn);
    }
}

function toggleDauberMenu() {
    dauberMenuOpen = !dauberMenuOpen;
    dauberColorBtn.classList.toggle("open", dauberMenuOpen);
    dauberColorBtn.setAttribute("aria-expanded", dauberMenuOpen ? "true" : "false");
    dauberMenuDropdown.classList.toggle("hidden", !dauberMenuOpen);
}

function closeDauberMenu() {
    if (!dauberMenuOpen) return;
    dauberMenuOpen = false;
    dauberColorBtn.classList.remove("open");
    dauberColorBtn.setAttribute("aria-expanded", "false");
    dauberMenuDropdown.classList.add("hidden");
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
        if (!session.dauber) session.dauber = {};
        session.dauber.opacity = val;
        applyDauberSettings();
        saveSession();
    });
}

// Global click-outside handler (closes game menu, dauber menu, AND card menus)
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

    // Mini 5×5 grid showing first pattern
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
// GAME MODES — creator (popup window)
// ============================================================

function openGameCreator() {
    closeGameMenu();
    const w = window.open("./game-creator.html", "bingoGameCreator",
        "width=500,height=740,top=60,left=120,resizable=yes");
    if (!w) alert("Please allow popups for this site to open the game creator.");
}

// When the creator window posts a message, reload the games list
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
            if (cellIdx === FREE_CELL) return true;               // FREE always daubed
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

const FREE_CELL = 12; // center square: row 2, col 2

function colForCell(cellIdx) { return cellIdx % 5; }

function colNumbers(col) {
    const start = col * 15 + 1;
    return Array.from({ length: 15 }, (_, i) => start + i);
}

// ============================================================
// BINGO CARDS — actions
// ============================================================

function addCard() {
    const squares = Array(25).fill(null);
    squares[FREE_CELL] = "FREE";

    session.cards.push({
        id:       Date.now(),
        label:    `Card ${session.cards.length + 1}`,
        squares,
        editMode: true,
        active:   true
    });

    saveSession();
    renderAllCards();
}

function menuAction(cardId, action) {
    const card = session.cards.find(c => c.id === cardId);
    if (!card) return;

    openMenuCardId = null;

    switch (action) {
        case "save":
            card.editMode  = false;
            activeCardEdit = null;
            break;
        case "edit":
            card.editMode = true;
            break;
        case "scan":
            window.location.href = `./scan/scan.html?cardId=${cardId}`;
            return;
        case "remove":
            if (!confirm("Remove this card?")) { renderAllCards(); return; }
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
        bingoCardsList.innerHTML = '<p class="bingo-cards-placeholder">No bingo cards yet. Tap + Add Card to get started.</p>';
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
    // FREE is always part of a winning pattern that includes it
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

    let labelEl;
    if (isEditing) {
        labelEl          = document.createElement("input");
        labelEl.type     = "text";
        labelEl.className = "bingo-card-label-input";
        labelEl.value    = card.label;
        labelEl.addEventListener("change", (e) => { card.label = e.target.value.trim() || card.label; saveSession(); });
        labelEl.addEventListener("click",  (e) => e.stopPropagation());
    } else {
        labelEl           = document.createElement("span");
        labelEl.className = "bingo-card-label";
        labelEl.textContent = card.label;
    }

    const badge = document.createElement("span");
    badge.className = "card-status-badge";
    if (isEditing)      { badge.textContent = "editing";  badge.classList.add("badge-editing");  }
    else if (!isActive) { badge.textContent = "inactive"; badge.classList.add("badge-inactive"); }

    header.appendChild(menuBtn);
    header.appendChild(labelEl);
    if (badge.textContent) header.appendChild(badge);

    // ---- Dropdown menu (anchored inside header) ----
    if (isMenuOpen) {
        const menu = document.createElement("div");
        menu.className = "card-menu-dropdown";
        menu.addEventListener("click", (e) => e.stopPropagation());

        const menuItems = isEditing
            ? [{ action: "save",  label: "💾  Save card"    },
               { action: "scan",  label: "📷  Scan card"    },
               { action: "remove",label: "🗑  Remove card"  }]
            : [{ action: "edit",  label: "✏️  Edit card"    },
               { action: "scan",  label: "📷  Scan card"    },
               { action: "remove",label: "🗑  Remove card"  },
               isActive
                   ? { action: "unuse", label: "🚫  Don't use card" }
                   : { action: "use",   label: "✅  Use card"        }
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

addCardBtn.addEventListener("click", addCard);

// ============================================================
// INIT
// ============================================================

setInputMode("letter");
applyDauberSettings();
updateUI();
loadGames(); // async — updates game section & cards when done
