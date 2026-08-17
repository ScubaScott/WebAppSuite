// Tracking module version identifier
const VERSION = '3.2';


// ============================================================
// SESSION STATE
// ============================================================

let session = {
    word: "BINGO",
    called: [],
    lastBall: null,
    cards: [],
    gameId: null,
    inputMode: "letter",
    doubleMode: false  // double bingo: requires 2 matching patterns on one card to win
};

// ============================================================
// DOM REFS
// ============================================================

const trackingGrid = document.getElementById("trackingGrid");
const sessionWordBar = document.getElementById("sessionWordBar");
const lastSixList = document.getElementById("lastSixList");
const totalCalledSpan = document.getElementById("totalCalled");
const lastManStatus = document.getElementById("lastManStatus");
const callLogLink = document.getElementById("callLogLink");
const newSessionBtn = document.getElementById("newSessionBtn");
const clearCardsBtn = document.getElementById("clearCardsBtn");
const addCardBtn = document.getElementById("addCardBtn");

const bingoCardsList = document.getElementById("bingoCardsList");
const selectedGameNameEl = document.getElementById("selectedGameName");
const gameSection = document.getElementById("gameSection");

// Dauber selector (Settings modal)
const dauberPalette = document.getElementById("dauberPalette");
const dauberOpacitySlider = document.getElementById("dauberOpacitySlider");
const opacityValueText = document.getElementById("opacityValueText");

// Toggle
const toggleByLetter = document.getElementById("toggleByLetter");
const toggleByNumber = document.getElementById("toggleByNumber");

// By-letter panel
const byLetterPanel = document.getElementById("byLetterPanel");
const numberPicker = document.getElementById("numberPicker");

// Double mode badge in the game section
const doubleModeBadge = document.getElementById("doubleModeBadge");

// ============================================================
// CURRENT STATE
// ============================================================

let inputMode = "letter"; // "letter" | "number"
let activeLetterIdx = -1;       // BINGO column selected (-1 = none)
let openMenuCardId = null;     // card with open menu
let availableGames = [];       // loaded from server
let gameMenuOpen = false;
let shouldScrollToWinner = false;

// ============================================================
// SESSION LOAD / SAVE
// ============================================================

function saveSession() {
    localStorage.setItem("bingoSession", JSON.stringify({
        word: session.word,
        called: session.called,
        lastBall: session.lastBall,
        cards: session.cards,
        gameId: session.gameId,
        inputMode: inputMode,
        dauber: session.dauber,
        doubleMode: session.doubleMode || false
    }));
}

function loadSession() {
    const data = localStorage.getItem("bingoSession");
    if (!data) {
        session.dauber = { rgb: "26, 115, 232", opacity: 0.25 };
        return;
    }

    const obj = JSON.parse(data);
    session.word = obj.word || "BINGO";
    session.called = Array.isArray(obj.called) ? obj.called : [];
    session.lastBall = obj.lastBall || null;
    session.gameId = obj.gameId || null;
    inputMode = obj.inputMode || "letter";
    session.dauber = obj.dauber || { rgb: "26, 115, 232", opacity: 0.25 };
    session.doubleMode = obj.doubleMode || false;

    // Migrate cards: ensure editMode, active, and serial fields exist
    session.cards = Array.isArray(obj.cards)
        ? obj.cards.map(c => ({ editMode: false, active: true, serial: "", ...c }))
        : [];
}

loadSession();

// ============================================================
// MAIN UI REFRESH
// ============================================================

function updateUI() {
    // 1. Total called count and Last Man status
    if (totalCalledSpan) {
        totalCalledSpan.textContent = session.called.length;
    }

    // Last Man: Standing = at least one active card has no daubed squares.
    // Sitting = every active card has at least 1 daubed non-FREE square called.
    // Only displayed if there are active cards in the session.
    if (lastManStatus) {
        const calledSet = new Set(session.called);
        const activeCards = session.cards.filter(c => c.active !== false);

        if (activeCards.length === 0) {
            lastManStatus.classList.add("hidden");
        } else {
            lastManStatus.classList.remove("hidden");
            // A card is "standing" if none of its non-FREE squares are in the called set
            const isStanding = activeCards.some(c =>
                c.squares.every((val, idx) =>
                    idx === 12 || val === null || val === "FREE" || !calledSet.has(val)
                )
            );

            lastManStatus.textContent = `Last man: ${isStanding ? "Standing" : "Sitting"}`;
            lastManStatus.classList.toggle("standing", isStanding);
            lastManStatus.classList.toggle("sitting", !isStanding);
        }
    }

    // 2. Last 6 called balls list — displayed as bingo-square-badge tiles
    if (lastSixList) {
        lastSixList.innerHTML = "";
        const recent = session.called.slice(-6).reverse();
        
        // Render called ball badges up to 6
        recent.forEach((n, pos) => {
            const letter = session.word[Math.floor((n - 1) / 15)] || "";
            const badge = document.createElement("span");
            // Most-recent ball gets the 'newest' highlight
            badge.className = "bingo-square-badge" + (pos === 0 ? " newest" : "");
            badge.dataset.number = n;
            // Letter label above the number
            badge.innerHTML = `<span class="sq-letter">${letter}</span><span class="sq-num">${n}</span>`;
            // Clicking a badge in the Last 6 prompts to un-call it
            badge.addEventListener("click", () => {
                promptUncallNumber(n);
            });
            lastSixList.appendChild(badge);
        });

        // Fill remaining slots with placeholder badges to keep layout stable (total 6 slots)
        const emptySlotsCount = 6 - recent.length;
        for (let i = 0; i < emptySlotsCount; i++) {
            const emptyBadge = document.createElement("span");
            emptyBadge.className = "bingo-square-badge placeholder";
            emptyBadge.innerHTML = `<span class="sq-letter">&nbsp;</span><span class="sq-num">&ndash;</span>`;
            lastSixList.appendChild(emptyBadge);
        }
    }

    // 3. Word bar headers
    if (inputMode === "letter") {
        updateSessionWordBar();
    }

    // 4. Rebuild active tracking mode view
    if (inputMode === "number") {
        buildTrackingGrid();
    } else if (activeLetterIdx !== -1) {
        buildNumberPicker(activeLetterIdx);
    } else {
        if (numberPicker) {
            numberPicker.classList.add("hidden");
            numberPicker.innerHTML = "";
        }
    }

    // 5. Game mode title and double mode badge
    const selectedGame = getSelectedGame();
    if (selectedGameNameEl) {
        selectedGameNameEl.textContent = selectedGame ? selectedGame.name : "— None selected —";
    }
    // Show the Double badge only when double mode is active
    if (doubleModeBadge) {
        doubleModeBadge.classList.toggle("hidden", !session.doubleMode);
    }

    // 6. Render all bingo cards
    renderAllCards();

    // 7. Scroll to winner if new win occurred
    if (shouldScrollToWinner) {
        shouldScrollToWinner = false;
        const winnerCard = document.querySelector(".bingo-card.card-winner");
        if (winnerCard) {
            winnerCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
    }
}

// ============================================================
// SESSION WORD BAR (Letter Selector in "By Letter" Mode)
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
    saveSession();

    if (mode === "letter") {
        toggleByLetter.classList.add("active");
        toggleByNumber.classList.remove("active");
        sessionWordBar.classList.remove("hidden");
        byLetterPanel.classList.remove("hidden");
        trackingGrid.classList.add("hidden");

        activeLetterIdx = -1;
        numberPicker.classList.add("hidden");
        numberPicker.innerHTML = "";
        updateSessionWordBar();
    } else {
        toggleByNumber.classList.add("active");
        toggleByLetter.classList.remove("active");
        sessionWordBar.classList.add("hidden");
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
// BY-LETTER: NUMBER PICKER (1-tap selection & toggle)
// ============================================================

function buildNumberPicker(colIdx) {
    numberPicker.innerHTML = "";
    numberPicker.classList.remove("hidden");

    const start = colIdx * 15 + 1;

    for (let i = 0; i < 15; i++) {
        const n = start + i;
        const btn = document.createElement("button");
        btn.className = "pick-btn" + (session.called.includes(n) ? " called" : "");
        btn.textContent = n;
        btn.setAttribute("aria-label", `${session.word[colIdx]}${n}`);
        btn.addEventListener("click", () => onNumberPick(n));
        numberPicker.appendChild(btn);
    }
}

function onNumberPick(n) {
    // Use isTrueWin so double mode is respected for scroll-to-winner tracking
    const prevWinnerExists = session.cards.some(card => isTrueWin(card, getSelectedGame()));
    const letter = session.word[Math.floor((n - 1) / 15)] || "";

    if (session.called.includes(n)) {
        // Prompt before un-calling a number
        if (!confirm(`Un-call ${letter}${n}? This will remove it from the called list.`)) return;
        session.called = session.called.filter(x => x !== n);
        if (session.lastBall === n) {
            session.lastBall = session.called[session.called.length - 1] || null;
        }
    } else {
        // Toggle ON — call the number (single tap, no prompt)
        session.called.push(n);
        session.lastBall = n;
        if (!prevWinnerExists) shouldScrollToWinner = true;
    }

    // Close the input section after selecting a number
    activeLetterIdx = -1;
    saveSession();
    updateUI();
}

// ============================================================
// BY-NUMBER: TRACKING GRID (1-tap selection & toggle)
// ============================================================

function buildTrackingGrid() {
    trackingGrid.innerHTML = "";

    for (let col = 0; col < 5; col++) {
        const colDiv = document.createElement("div");
        colDiv.className = "grid-column";

        // Column letter header — circular badge at the top
        const hdr = document.createElement("div");
        hdr.className = "bingo-col-header";
        hdr.textContent = session.word[col];
        colDiv.appendChild(hdr);

        // Container for staggered overlapping balls
        const ballsDiv = document.createElement("div");
        ballsDiv.className = "grid-column-balls";

        const start = col * 15 + 1;
        for (let i = 0; i < 15; i++) {
            const n = start + i;
            const btn = document.createElement("button");
            const isCalled = session.called.includes(n);
            // Alternate horizontal offset: even indexed balls shift left, odd shift right
            const offsetClass = (i % 2 === 0) ? "offset-left" : "offset-right";
            btn.className = `bingo-cell grid-num-cell ${offsetClass}` + (isCalled ? " daubed" : "");
            btn.textContent = n;
            btn.setAttribute("aria-label", `${session.word[col]}${n}`);
            // Explicit z-index stacking so top balls sit slightly below subsequent balls cleanly
            btn.style.zIndex = 15 - i;
            // Prevent double-tap zoom on mobile — use click for instant response
            btn.addEventListener("click", (e) => { e.preventDefault(); onNumberGridClick(n); });
            ballsDiv.appendChild(btn);
        }

        colDiv.appendChild(ballsDiv);
        trackingGrid.appendChild(colDiv);
    }
}

function onNumberGridClick(n) {
    // Use isTrueWin so double mode is respected for scroll-to-winner tracking
    const prevWinnerExists = session.cards.some(card => isTrueWin(card, getSelectedGame()));
    const letter = session.word[Math.floor((n - 1) / 15)] || "";

    if (session.called.includes(n)) {
        // Prompt before un-calling a number
        if (!confirm(`Un-call ${letter}${n}? This will remove it from the called list.`)) return;
        session.called = session.called.filter(x => x !== n);
        if (session.lastBall === n) {
            session.lastBall = session.called[session.called.length - 1] || null;
        }
    } else {
        // Toggle ON — call the number (single tap, no prompt)
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
    title.className = "game-picker-title";
    title.textContent = "Called Numbers History";

    const closeBtn = document.createElement("button");
    closeBtn.className = "link-button";
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

// Change Game Name / Session Word button (does not clear called numbers or cards)
if (newSessionBtn) {
    newSessionBtn.addEventListener("click", () => {
        const currentWord = session.word || "BINGO";
        const newWord = prompt("Enter a 5-letter game name / session word:", currentWord);
        if (!newWord) return;
        if (newWord.trim().length !== 5) {
            alert("Game name must be exactly 5 letters.");
            return;
        }
        session.word = newWord.trim().toUpperCase();
        saveSession();
        updateUI();
    });
}

// Clear Cards button (resets all called numbers, keeping the game name and active cards intact)
if (clearCardsBtn) {
    clearCardsBtn.addEventListener("click", () => {
        if (session.called.length === 0) return;
        if (!confirm("Clear all called numbers? Active cards and game mode will be preserved.")) return;

        session.called = [];
        session.lastBall = null;
        activeLetterIdx = -1;

        saveSession();
        updateUI();
    });
}

// ============================================================
// DAUBER COLOR & OPACITY CONTROLS
// ============================================================

const DAUBER_PALETTE = [
    { name: "Blue", rgb: "26, 115, 232" },
    { name: "Red", rgb: "229, 57, 53" },
    { name: "Magenta", rgb: "216, 27, 96" },
    { name: "Purple", rgb: "142, 36, 170" },
    { name: "Green", rgb: "67, 160, 71" },
    { name: "Teal", rgb: "0, 137, 123" },
    { name: "Orange", rgb: "251, 140, 0" },
    { name: "Gold", rgb: "245, 124, 0" }
];

function applyDauberSettings() {
    const daub = session.dauber || { rgb: "26, 115, 232", opacity: 0.25 };
    document.documentElement.style.setProperty("--daub-rgb", daub.rgb);
    document.documentElement.style.setProperty("--daub-alpha", daub.opacity);
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
        swatch.className = "dauber-palette-item" + (c.rgb === currentRgb ? " active" : "");
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
        });
        dauberPalette.appendChild(swatch);
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
        const res = await fetch("./php/games.php");
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
    // Reset double mode whenever a DIFFERENT game is selected
    if (session.gameId !== gameId) {
        session.doubleMode = false;
    }
    session.gameId = gameId;
    saveSession();
    closeGamePicker();
    shouldScrollToWinner = true;
    updateUI();
}

if (gameSection) {
    gameSection.addEventListener("click", (e) => {
        // Prevent opening if the clearCardsBtn was clicked
        if (e.target.closest("#clearCardsBtn")) return;
        openGamePicker();
    });
}

// Global click-outside handler
document.addEventListener("click", (e) => {
    if (openMenuCardId !== null && !e.target.closest(".bingo-card")) {
        openMenuCardId = null;
        renderAllCards();
    }
});

// ============================================================
// GAME MODES — picker modal
// ============================================================

function openGamePicker() {
    const modal = document.createElement("div");
    modal.id = "gamePickerModal";
    modal.className = "game-picker-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-label", "Select Game");

    const panel = document.createElement("div");
    panel.className = "game-picker-panel";

    const hdr = document.createElement("div");
    hdr.className = "game-picker-header";

    const title = document.createElement("h2");
    title.className = "game-picker-title";
    title.textContent = "Select a Game";

    const closeBtn = document.createElement("button");
    closeBtn.className = "link-button";
    closeBtn.textContent = "✕ Close";
    closeBtn.addEventListener("click", closeGamePicker);

    hdr.appendChild(title);
    hdr.appendChild(closeBtn);
    panel.appendChild(hdr);

    const list = document.createElement("div");
    list.className = "game-picker-list";

    // "+ New Game" item at the top of the picker list
    const newGameItem = document.createElement("div");
    newGameItem.className = "game-picker-item new-game-item";
    newGameItem.setAttribute("role", "button");
    newGameItem.setAttribute("tabindex", "0");
    newGameItem.style.borderStyle = "dashed";
    newGameItem.style.borderColor = "var(--primary)";
    newGameItem.innerHTML = `
        <div class="mini-card-grid" style="display:flex; align-items:center; justify-content:center; background:var(--primary-soft); border-radius:6px; color:var(--primary); font-size:20px; font-weight:700;">
            +
        </div>
        <div class="game-picker-info">
            <span class="game-picker-name" style="color:var(--primary); font-weight:700;">+ Create New Game</span>
            <span class="game-picker-meta">Define custom bingo winning patterns</span>
        </div>
    `;
    newGameItem.addEventListener("click", (e) => {
        e.stopPropagation();
        closeGamePicker();
        openGameCreator();
    });
    newGameItem.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            closeGamePicker();
            openGameCreator();
        }
    });
    list.appendChild(newGameItem);

    if (availableGames.length > 0) {
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
    const isSelected = session.gameId === game.id;
    const firstPattern = game.patterns[0];
    const patternCells = new Set(firstPattern ? firstPattern.cells : []);

    // Outer wrapper — flex row containing everything
    const item = document.createElement("div");
    item.className = "game-picker-item" + (isSelected ? " selected" : "");
    item.setAttribute("role", "button");
    item.setAttribute("tabindex", "0");

    // Mini 5×5 card preview
    const miniGrid = document.createElement("div");
    miniGrid.className = "mini-card-grid";
    for (let i = 0; i < 25; i++) {
        const mc = document.createElement("div");
        mc.className = [
            "mini-cell",
            i === 12 ? "mini-free" : "",
            patternCells.has(i) ? "mini-pattern" : ""
        ].filter(Boolean).join(" ");
        miniGrid.appendChild(mc);
    }

    // Game name + pattern count
    const info = document.createElement("div");
    info.className = "game-picker-info";

    const name = document.createElement("span");
    name.className = "game-picker-name";
    name.textContent = game.name;

    const meta = document.createElement("span");
    meta.className = "game-picker-meta";
    meta.textContent = `${game.patterns.length} pattern${game.patterns.length !== 1 ? "s" : ""}`;

    info.appendChild(name);
    info.appendChild(meta);

    item.appendChild(miniGrid);
    item.appendChild(info);

    // Selected checkmark — spacer so it doesn't collide with double toggle
    if (isSelected) {
        const check = document.createElement("span");
        check.className = "game-picker-check";
        check.textContent = "✓";
        item.appendChild(check);
    }

    // ---- Double mode toggle (shown only for games with >1 pattern) ----
    // Lives on the far right of the row; stopping propagation here keeps
    // clicks on the toggle from also triggering game selection.
    if (game.patterns.length > 1) {
        const doubleWrap = document.createElement("div");
        doubleWrap.className = "double-cb-wrap";
        // Stop all pointer events from bubbling up to the item row
        doubleWrap.addEventListener("click", e => e.stopPropagation());
        doubleWrap.addEventListener("pointerdown", e => e.stopPropagation());

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.id = `double-cb-${game.id}`;
        cb.className = "double-cb-input";
        // Reflect doubleMode state only when this game is active
        cb.checked = (session.gameId === game.id && session.doubleMode);
        cb.setAttribute("aria-label", "Double bingo mode");

        const lbl = document.createElement("label");
        lbl.htmlFor = `double-cb-${game.id}`;
        lbl.className = "double-cb-label";
        lbl.textContent = "Double";

        // Toggling the checkbox switches doubleMode on/off WITHOUT selecting the
        // game or closing the picker — the user may want to review other games.
        cb.addEventListener("change", e => {
            e.stopPropagation();
            // If this game isn't selected yet, select it silently when enabling double
            if (cb.checked && session.gameId !== game.id) {
                session.gameId = game.id;
            }
            session.doubleMode = cb.checked;
            saveSession();
            // Refresh items in place so other checkboxes reset
            const list = document.getElementById("gamePickerModal")?.querySelector(".game-picker-list");
            if (list) {
                list.innerHTML = "";
                // Re-add new game item
                const newGameItem = document.createElement("div");
                newGameItem.className = "game-picker-item new-game-item";
                newGameItem.setAttribute("role", "button");
                newGameItem.setAttribute("tabindex", "0");
                newGameItem.style.borderStyle = "dashed";
                newGameItem.style.borderColor = "var(--primary)";
                newGameItem.innerHTML = `
                    <div class="mini-card-grid" style="display:flex; align-items:center; justify-content:center; background:var(--primary-soft); border-radius:6px; color:var(--primary); font-size:20px; font-weight:700;">
                        +
                    </div>
                    <div class="game-picker-info">
                        <span class="game-picker-name" style="color:var(--primary); font-weight:700;">+ Create New Game</span>
                        <span class="game-picker-meta">Define custom bingo winning patterns</span>
                    </div>
                `;
                newGameItem.addEventListener("click", (e) => {
                    e.stopPropagation();
                    closeGamePicker();
                    openGameCreator();
                });
                list.appendChild(newGameItem);
                for (const g of availableGames) list.appendChild(renderGamePickerItem(g));
            }
            shouldScrollToWinner = true;
            updateUI();
        });

        doubleWrap.appendChild(cb);
        doubleWrap.appendChild(lbl);
        item.appendChild(doubleWrap);
    }

    // Clicking anywhere on the item row (outside the double wrap) selects the game
    item.addEventListener("click", () => selectGame(game.id));
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

// Returns an array of every pattern that is currently completed on this card
function getWinningPatterns(card, game) {
    if (!game || !card.active) return [];
    const calledSet = new Set(session.called);
    return game.patterns.filter(pattern =>
        pattern.cells.every(cellIdx => {
            if (cellIdx === FREE_CELL) return true;
            const val = card.squares[cellIdx];
            return val !== null && val !== "FREE" && calledSet.has(val);
        })
    );
}

// Returns true if the card satisfies the win condition for the current mode.
// Normal mode: 1 pattern. Double mode: 2 or more patterns.
function isTrueWin(card, game) {
    const patterns = getWinningPatterns(card, game);
    return session.doubleMode ? patterns.length >= 2 : patterns.length >= 1;
}

// Legacy wrapper — kept for any external callers; returns first matching pattern or null
function checkCardWin(card, game) {
    const patterns = getWinningPatterns(card, game);
    return patterns.length > 0 ? patterns[0] : null;
}

// Returns a Set of cell indices that are the single missing (uncalled, non-FREE) square
// needed to complete at least one pattern. Used to trigger the "one away" pulse effect.
// Returns an empty Set if the card is already a winner or has no near-complete patterns.
function getOneAwayNeededCells(card, game) {
    const needed = new Set();
    if (!game || !card.active) return needed;

    // Do not show one-away when the card already satisfies the win condition
    if (isTrueWin(card, game)) return needed;

    const calledSet = new Set(session.called);

    for (const pattern of game.patterns) {
        // Collect the cell indices in this pattern that are NOT yet satisfied
        const missing = pattern.cells.filter(cellIdx => {
            if (cellIdx === FREE_CELL) return false;          // FREE always counts
            const val = card.squares[cellIdx];
            if (val === null || val === "FREE") return false; // empty slot — not fillable
            return !calledSet.has(val);                        // uncalled number
        });

        // Exactly one square away — mark that cell
        if (missing.length === 1) {
            needed.add(missing[0]);
        }
    }

    return needed;
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

// Navigate to card editor page to add a new blank card
function addCard() {
    window.location.href = './scan/scan.html?mode=add';
}

// ============================================================
// BINGO CARDS — tap menu actions (Edit and Remove only)
// ============================================================

function menuAction(cardId, action) {
    const card = session.cards.find(c => c.id === cardId);
    if (!card) return;

    openMenuCardId = null;

    switch (action) {
        case "edit":
            // Navigate to card editor with existing card pre-loaded
            window.location.href = `./scan/scan.html?mode=edit&cardId=${cardId}`;
            return;
        case "remove":
            if (!confirm("Remove this card from session?")) { renderAllCards(); return; }
            session.cards = session.cards.filter(c => c.id !== cardId);
            saveSession();
            renderAllCards();
            return;
    }

    saveSession();
    renderAllCards();
}

function toggleMenu(cardId) {
    // Toggle card context menu open/closed
    openMenuCardId = openMenuCardId === cardId ? null : cardId;
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
    const isActive = card.active !== false;
    const isMenuOpen = openMenuCardId === card.id;

    // Win detection — collect ALL currently-completed patterns
    const game = getSelectedGame();
    const winningPatterns = (isActive && game) ? getWinningPatterns(card, game) : [];
    // isTrueWinner: normal=1 pattern, double mode=2+ patterns on this single card
    const isTrueWinner = session.doubleMode ? winningPatterns.length >= 2 : winningPatterns.length >= 1;
    // winCells: union of all matched-pattern cells (used for highlighting even partial matches)
    const winCells = new Set();
    winningPatterns.forEach(p => p.cells.forEach(c => winCells.add(c)));

    // ---- Wrapper ----
    const wrapper = document.createElement("div");
    wrapper.className = [
        "bingo-card",
        "card-view-scaled",
        !isActive ? "card-inactive" : "",
        isTrueWinner ? "card-winner" : ""
    ].filter(Boolean).join(" ");
    wrapper.dataset.cardId = card.id;

    // Tapping anywhere on the card opens the context menu
    wrapper.style.cursor = "pointer";
    wrapper.addEventListener("click", (e) => {
        // Avoid toggling menu when interacting with the dropdown itself
        if (e.target.closest(".card-menu-dropdown")) return;
        toggleMenu(card.id);
    });

    // ---- Card header ----
    const header = document.createElement("div");
    header.className = "bingo-card-header";

    const titleWrap = document.createElement("div");
    titleWrap.className = "bingo-card-title-wrap";

    // Show card label only — serial number is visible on the editor page, not here
    const labelEl = document.createElement("span");
    labelEl.className = "bingo-card-label";
    labelEl.textContent = card.label;
    titleWrap.appendChild(labelEl);

    header.appendChild(titleWrap);

    // ---- Dropdown menu (Edit and Remove only) ----
    if (isMenuOpen) {
        const menu = document.createElement("div");
        menu.className = "card-menu-dropdown";
        menu.addEventListener("click", (e) => e.stopPropagation());

        const menuItems = [
            { action: "edit",   label: "\u270F\uFE0F  Edit card" },
            { action: "remove", label: "\uD83D\uDDD1  Remove card" }
        ];

        for (const item of menuItems) {
            const btn = document.createElement("button");
            btn.className = "card-menu-item";
            btn.textContent = item.label;
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                menuAction(card.id, item.action);
            });
            menu.appendChild(btn);
        }

        header.appendChild(menu);
    }

    wrapper.appendChild(header);

    // ---- 5x5 card grid (view-only — editing happens on the card editor page) ----
    const grid = document.createElement("div");
    grid.className = "bingo-card-grid";

    for (let col = 0; col < 5; col++) {
        const hdr = document.createElement("div");
        hdr.className = "bingo-col-header";
        hdr.textContent = session.word[col];
        grid.appendChild(hdr);
    }

    // Detect cells that are part of ANY pattern in the selected game mode
    const usedPatternCells = new Set();
    if (game && Array.isArray(game.patterns)) {
        game.patterns.forEach(p => {
            if (Array.isArray(p.cells)) {
                p.cells.forEach(c => usedPatternCells.add(c));
            }
        });
    }

    // Detect cells that are exactly one number away from completing a pattern
    const oneAwayCells = (isActive && game && !isTrueWinner)
        ? getOneAwayNeededCells(card, game)
        : new Set();

    for (let idx = 0; idx < 25; idx++) {
        const value = card.squares[idx];
        const isFree = (idx === FREE_CELL);
        const isDaubed = isActive && (isFree || (value !== null && session.called.includes(value)));
        const isEmpty = !isFree && value === null;
        // True win: cell highlighted gold. Partial win (double mode, 1 of 2 needed): blue highlight.
        const isWinCell = isTrueWinner && winCells.has(idx);
        const isPartialCell = !isTrueWinner && session.doubleMode && winCells.has(idx);
        // One away: this uncalled cell is the last needed square for at least one pattern
        const isOneAway = !isTrueWinner && !isDaubed && oneAwayCells.has(idx);
        // Unused in game mode: squares not part of any pattern are rendered in grayscale (FREE square is always considered used/daubed)
        const isUnused = !isFree && (game !== null) && !usedPatternCells.has(idx);

        const cell = document.createElement("div");
        cell.className = [
            "bingo-cell",
            isFree ? "free" : "",
            isDaubed ? "daubed" : "",
            isEmpty ? "empty" : "",
            isWinCell ? "win-cell" : "",
            isPartialCell ? "partial-win-cell" : "",
            isOneAway ? "one-away-cell" : "",
            isUnused ? "unused-cell" : ""
        ].filter(Boolean).join(" ");

        cell.textContent = isFree ? "FREE" : (value ?? "");

        // No click handler — cells are view-only; all editing happens on the card editor page

        grid.appendChild(cell);
    }

    wrapper.appendChild(grid);

    // ---- Winner overlay — only shown on a TRUE win ----
    if (isTrueWinner) {
        const overlay = document.createElement("div");
        overlay.className = "card-winner-overlay";
        // In double mode show both pattern names joined with "+"
        const patternNames = winningPatterns.map(p => p.name).join(" + ");
        overlay.innerHTML = `
            <span class="winner-bingo-text">${session.word}!</span>
            <span class="winner-game-name">${game.name}</span>
            <span class="winner-pattern-name">${patternNames}</span>
        `;
        wrapper.appendChild(overlay);
    }

    return wrapper;
}

if (addCardBtn) addCardBtn.addEventListener("click", addCard);

// ============================================================
// THEME MANAGEMENT
// ============================================================

// Valid theme identifiers
const THEMES = ["basic", "divebar"];

// DOM refs for settings modal
const settingsGearBtn = document.getElementById("settingsGearBtn");
const settingsModal = document.getElementById("settingsModal");
const settingsCloseBtn = document.getElementById("settingsCloseBtn");
const themeBasicBtn = document.getElementById("themeBasic");
const themeDiveBarBtn = document.getElementById("themeDiveBar");
const checkBasic = document.getElementById("checkBasic");
const checkDiveBar = document.getElementById("checkDiveBar");

// Apply the named theme to the <html> element and persist it
function applyTheme(name) {
    if (!THEMES.includes(name)) name = "basic";
    document.documentElement.setAttribute("data-theme", name);
    localStorage.setItem("bingoTheme", name);
    updateThemeCards(name);
}

// Update the aria-pressed state and checkmark visibility on theme picker cards
function updateThemeCards(active) {
    if (!themeBasicBtn || !themeDiveBarBtn) return;

    // Basic card
    themeBasicBtn.setAttribute("aria-pressed", active === "basic" ? "true" : "false");
    if (checkBasic) checkBasic.classList.toggle("hidden", active !== "basic");

    // Dive Bar card
    themeDiveBarBtn.setAttribute("aria-pressed", active === "divebar" ? "true" : "false");
    if (checkDiveBar) checkDiveBar.classList.toggle("hidden", active !== "divebar");
}

// Load saved theme (or default to basic) on page load
function initTheme() {
    const saved = localStorage.getItem("bingoTheme") || "basic";
    applyTheme(saved);
}

// Open the settings modal
function openSettings() {
    if (!settingsModal) return;
    settingsModal.classList.remove("hidden");
    document.body.style.overflow = "hidden"; // prevent background scroll
}

// Close the settings modal
function closeSettings() {
    if (!settingsModal) return;
    settingsModal.classList.add("hidden");
    document.body.style.overflow = "";
}

// Gear button opens the modal
if (settingsGearBtn) {
    settingsGearBtn.addEventListener("click", openSettings);
}

// Close button in modal header
if (settingsCloseBtn) {
    settingsCloseBtn.addEventListener("click", closeSettings);
}

// Clicking the backdrop (outside the panel) closes the modal
if (settingsModal) {
    settingsModal.addEventListener("click", (e) => {
        if (e.target === settingsModal) closeSettings();
    });
}

// Theme card click handlers
if (themeBasicBtn) {
    themeBasicBtn.addEventListener("click", () => {
        applyTheme("basic");
    });
}

if (themeDiveBarBtn) {
    themeDiveBarBtn.addEventListener("click", () => {
        applyTheme("divebar");
    });
}

// ============================================================
// FLASHBOARD NUMBERS LAYOUT CONFIGURATION
// ============================================================

const DEFAULT_FLASHBOARD_CONFIG = {
    ballSize: 27,   // px
    fontSize: 11,   // px
    vGap: 3,        // px
    hOffset: 6      // px
};

let flashboardConfig = { ...DEFAULT_FLASHBOARD_CONFIG };

// DOM refs for configuration sliders
const cfgBallSizeSlider = document.getElementById("cfgBallSizeSlider");
const cfgBallSizeVal = document.getElementById("cfgBallSizeVal");
const cfgFontSizeSlider = document.getElementById("cfgFontSizeSlider");
const cfgFontSizeVal = document.getElementById("cfgFontSizeVal");
const cfgVGapSlider = document.getElementById("cfgVGapSlider");
const cfgVGapVal = document.getElementById("cfgVGapVal");
const cfgHOffsetSlider = document.getElementById("cfgHOffsetSlider");
const cfgHOffsetVal = document.getElementById("cfgHOffsetVal");
const cfgResetBtn = document.getElementById("cfgResetBtn");

// Apply current configuration variables directly to document root styles
function applyFlashboardConfig() {
    const root = document.documentElement;
    root.style.setProperty("--flashboard-ball-size", `${flashboardConfig.ballSize}px`);
    root.style.setProperty("--flashboard-font-size", `${flashboardConfig.fontSize}px`);
    root.style.setProperty("--flashboard-v-gap", `${flashboardConfig.vGap}px`);
    root.style.setProperty("--flashboard-h-offset", `${flashboardConfig.hOffset}px`);

    // Sync slider input values and text readouts
    if (cfgBallSizeSlider) cfgBallSizeSlider.value = flashboardConfig.ballSize;
    if (cfgBallSizeVal) cfgBallSizeVal.textContent = `${flashboardConfig.ballSize}px`;

    if (cfgFontSizeSlider) cfgFontSizeSlider.value = flashboardConfig.fontSize;
    if (cfgFontSizeVal) cfgFontSizeVal.textContent = `${flashboardConfig.fontSize}px`;

    if (cfgVGapSlider) cfgVGapSlider.value = flashboardConfig.vGap;
    if (cfgVGapVal) cfgVGapVal.textContent = `${flashboardConfig.vGap}px`;

    if (cfgHOffsetSlider) cfgHOffsetSlider.value = flashboardConfig.hOffset;
    if (cfgHOffsetVal) cfgHOffsetVal.textContent = `${flashboardConfig.hOffset}px`;

    localStorage.setItem("bingoFlashboardConfig", JSON.stringify(flashboardConfig));
}

// Load saved flashboard configuration or fall back to defaults
function initFlashboardConfig() {
    const saved = localStorage.getItem("bingoFlashboardConfig");
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            flashboardConfig = { ...DEFAULT_FLASHBOARD_CONFIG, ...parsed };
        } catch (e) {
            flashboardConfig = { ...DEFAULT_FLASHBOARD_CONFIG };
        }
    }
    applyFlashboardConfig();
}

// Event listeners for live slider adjustments
if (cfgBallSizeSlider) {
    cfgBallSizeSlider.addEventListener("input", (e) => {
        flashboardConfig.ballSize = parseInt(e.target.value, 10);
        applyFlashboardConfig();
    });
}

if (cfgFontSizeSlider) {
    cfgFontSizeSlider.addEventListener("input", (e) => {
        flashboardConfig.fontSize = parseInt(e.target.value, 10);
        applyFlashboardConfig();
    });
}

if (cfgVGapSlider) {
    cfgVGapSlider.addEventListener("input", (e) => {
        flashboardConfig.vGap = parseInt(e.target.value, 10);
        applyFlashboardConfig();
    });
}

if (cfgHOffsetSlider) {
    cfgHOffsetSlider.addEventListener("input", (e) => {
        flashboardConfig.hOffset = parseInt(e.target.value, 10);
        applyFlashboardConfig();
    });
}

if (cfgResetBtn) {
    cfgResetBtn.addEventListener("click", () => {
        flashboardConfig = { ...DEFAULT_FLASHBOARD_CONFIG };
        applyFlashboardConfig();
    });
}

// ============================================================
// BINGO CARD SIZE (VIEW MODE) CONFIGURATION
// ============================================================

// Default slider value: 50 (maps to 2-column small view)
const DEFAULT_CARD_SIZE = 50;

// Threshold: slider values >= this switch from 2-column to 1-column layout
const CARD_SIZE_COL_THRESHOLD = 70;

let cardSizeValue = DEFAULT_CARD_SIZE;

// DOM refs for card size slider
const cardSizeSlider = document.getElementById("cardSizeSlider");
const cardSizeValueText = document.getElementById("cardSizeValueText");

// Map slider value (30–100) to a CSS scale factor for card content (0.55–1.0)
function cardSizeToScale(val) {
    const min = 30, max = 100;
    const scaleMin = 0.55, scaleMax = 1.0;
    return scaleMin + ((val - min) / (max - min)) * (scaleMax - scaleMin);
}

// Apply card size: sets CSS variables and updates column count
function applyCardSize() {
    const root = document.documentElement;
    const scale = cardSizeToScale(cardSizeValue);
    const cols = cardSizeValue >= CARD_SIZE_COL_THRESHOLD ? 1 : 2;

    root.style.setProperty("--card-view-scale", scale.toFixed(3));
    root.style.setProperty("--card-view-cols", cols);

    // Update slider UI and label
    if (cardSizeSlider) cardSizeSlider.value = cardSizeValue;
    if (cardSizeValueText) {
        cardSizeValueText.textContent = cols === 1
            ? `Large (1 col)`
            : `Small (2 col)`;
    }

    // Persist to localStorage
    localStorage.setItem("bingoCardSize", cardSizeValue);

    // Re-render cards to reflect updated column/scale classes
    renderAllCards();
}

// Load saved card size or fall back to default
function initCardSize() {
    const saved = localStorage.getItem("bingoCardSize");
    if (saved !== null) {
        const parsed = parseInt(saved, 10);
        if (!isNaN(parsed)) cardSizeValue = parsed;
    }
    applyCardSize();
}

// Card size slider event listener — live update as user drags
if (cardSizeSlider) {
    cardSizeSlider.addEventListener("input", (e) => {
        cardSizeValue = parseInt(e.target.value, 10);
        applyCardSize();
    });
}

// ============================================================
// INIT
// ============================================================

setInputMode(inputMode || "letter");
applyDauberSettings();
renderDauberPalette();
updateUI();
loadGames();
initTheme();
initFlashboardConfig();
initCardSize();
