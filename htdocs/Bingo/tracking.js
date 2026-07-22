// ============================================================
// SESSION STATE
// ============================================================

let session = {
    word:     "BINGO",
    called:   [],
    lastBall: null,
    cards:    []
};

// ============================================================
// DOM REFS
// ============================================================

const trackingGrid    = document.getElementById("trackingGrid");
const sessionWordBar  = document.getElementById("sessionWordBar");
const lastFiveList    = document.getElementById("lastFiveList");
const totalCalledSpan = document.getElementById("totalCalled");
const callLogLink     = document.getElementById("callLogLink");
const newSessionBtn   = document.getElementById("newSessionBtn");
const addCardBtn      = document.getElementById("addCardBtn");
const bingoCardsList  = document.getElementById("bingoCardsList");

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
let openMenuCardId  = null;     // card whose menu is currently open

// ============================================================
// SESSION LOAD / SAVE
// ============================================================

function saveSession() {
    localStorage.setItem("bingoSession", JSON.stringify({
        word:     session.word,
        called:   session.called,
        lastBall: session.lastBall,
        cards:    session.cards
    }));
}

function loadSession() {
    const data = localStorage.getItem("bingoSession");
    if (!data) return;

    const obj    = JSON.parse(data);
    session.word     = obj.word    || "BINGO";
    session.called   = Array.isArray(obj.called) ? obj.called : [];
    session.lastBall = obj.lastBall || null;

    // Migrate cards: ensure editMode and active fields exist
    session.cards = Array.isArray(obj.cards)
        ? obj.cards.map(c => ({
            editMode: false,
            active:   true,
            ...c
          }))
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
    if (!session.called.includes(n)) {
        session.called.push(n);
        session.lastBall = n;
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
    const existingIndex = session.called.indexOf(n);
    if (existingIndex !== -1) {
        if (!confirm(`Remove ${n}?`)) return;
        session.called.splice(existingIndex, 1);
        session.lastBall = session.called.length
            ? session.called[session.called.length - 1] : null;
    } else {
        session.called.push(n);
        session.lastBall = n;
    }

    updateUI();
    saveSession();
}

// ============================================================
// CALL LOG
// ============================================================

function openCallLogWindow() {
    const logWindow = window.open("", "bingoCallLog", "width=320,height=420,top=100,left=100");
    if (!logWindow) {
        alert("Unable to open call log window. Please allow popups for this site.");
        return;
    }

    const listItems = session.called.map((v) => `<li>${v}</li>`).join("");

    logWindow.document.write(`<!DOCTYPE html><html><head><title>Call Log</title><style>body{font-family:Arial,Helvetica,sans-serif;margin:20px;color:#202124;background:#f8f9fa;}h1{font-size:20px;margin-bottom:12px;}ol{padding-left:18px;}li{margin-bottom:6px;}button{margin-top:18px;padding:10px 14px;border:none;border-radius:10px;background:#1a73e8;color:#fff;cursor:pointer;}</style></head><body><h1>Call Log</h1><ol>${listItems || '<li>No numbers called yet</li>'}</ol><button onclick="window.close()">Close</button></body></html>`);
    logWindow.document.close();
}

// ============================================================
// UPDATE UI
// ============================================================

function updateUI() {
    const lastFive = session.called.slice(-5);
    lastFiveList.innerHTML = "";

    for (let i = 4; i >= 0; i--) {
        const item = document.createElement("div");
        item.className = "last-five-item" + (lastFive[i] === undefined ? " empty" : "");
        item.textContent = lastFive[i] ?? "—";
        lastFiveList.appendChild(item);
    }

    totalCalledSpan.textContent = `${session.called.length} called`;

    if (inputMode === "number") buildTrackingGrid();

    updateSessionWordBar();
    renderAllCards();
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
// BINGO CARDS — helpers
// ============================================================

const FREE_CELL = 12; // row 2, col 2

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
        editMode: true,   // new cards start in edit mode
        active:   true
    });

    saveSession();
    renderAllCards();
}

function menuAction(cardId, action) {
    const card = session.cards.find(c => c.id === cardId);
    if (!card) return;

    openMenuCardId = null; // close menu regardless

    switch (action) {
        case "save":
            card.editMode = false;
            activeCardEdit = null;
            break;

        case "edit":
            card.editMode = true;
            break;

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

    // Close any open menu
    if (openMenuCardId !== null) { openMenuCardId = null; renderAllCards(); return; }

    // Tap same cell again → close picker
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
    // Close any cell picker when opening a menu
    if (openMenuCardId !== null) activeCardEdit = null;
    renderAllCards();
}

// Close any open menu when clicking outside a card
document.addEventListener("click", (e) => {
    if (openMenuCardId !== null && !e.target.closest(".bingo-card")) {
        openMenuCardId = null;
        renderAllCards();
    }
});

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
    const isActive    = card.active !== false; // default true
    const isMenuOpen  = openMenuCardId === card.id;
    const editCellIdx = (activeCardEdit && activeCardEdit.cardId === card.id)
        ? activeCardEdit.cellIdx : -1;

    // ---- Wrapper ----
    const wrapper = document.createElement("div");
    wrapper.className = [
        "bingo-card",
        isEditing ? "card-editing" : "",
        !isActive ? "card-inactive" : ""
    ].filter(Boolean).join(" ");
    wrapper.dataset.cardId = card.id;

    // ---- Card header ----
    const header = document.createElement("div");
    header.className = "bingo-card-header";

    // Hamburger menu button
    const menuBtn = document.createElement("button");
    menuBtn.className = "card-menu-btn" + (isMenuOpen ? " open" : "");
    menuBtn.setAttribute("aria-label", "Card menu");
    menuBtn.setAttribute("aria-expanded", isMenuOpen ? "true" : "false");
    menuBtn.innerHTML = `<span></span><span></span><span></span>`;
    menuBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleMenu(card.id); });

    // Card name — editable when in edit mode
    let labelEl;
    if (isEditing) {
        labelEl = document.createElement("input");
        labelEl.type = "text";
        labelEl.className = "bingo-card-label-input";
        labelEl.value = card.label;
        labelEl.addEventListener("change", (e) => {
            card.label = e.target.value.trim() || card.label;
            saveSession();
        });
        labelEl.addEventListener("click", (e) => e.stopPropagation());
    } else {
        labelEl = document.createElement("span");
        labelEl.className = "bingo-card-label";
        labelEl.textContent = card.label;
    }

    // Status badge
    const badge = document.createElement("span");
    badge.className = "card-status-badge";
    if (isEditing) {
        badge.textContent = "editing";
        badge.classList.add("badge-editing");
    } else if (!isActive) {
        badge.textContent = "inactive";
        badge.classList.add("badge-inactive");
    }

    header.appendChild(menuBtn);
    header.appendChild(labelEl);
    if (badge.textContent) header.appendChild(badge);
    wrapper.appendChild(header);

    // ---- Dropdown menu ----
    if (isMenuOpen) {
        const menu = document.createElement("div");
        menu.className = "card-menu-dropdown";
        menu.addEventListener("click", (e) => e.stopPropagation());

        const menuItems = isEditing
            ? [{ action: "save",  label: "💾  Save card" },
               { action: "remove",label: "🗑  Remove card" }]
            : [{ action: "edit",  label: "✏️  Edit card" },
               { action: "remove",label: "🗑  Remove card" },
               isActive
                   ? { action: "unuse", label: "🚫  Don't use card" }
                   : { action: "use",   label: "✅  Use card" }
              ];

        for (const item of menuItems) {
            const btn = document.createElement("button");
            btn.className = "card-menu-item";
            btn.textContent = item.label;
            btn.addEventListener("click", () => menuAction(card.id, item.action));
            menu.appendChild(btn);
        }

        header.appendChild(menu);
    }

    // ---- 5×5 card grid ----
    const grid = document.createElement("div");
    grid.className = "bingo-card-grid";

    // Column headers
    for (let col = 0; col < 5; col++) {
        const hdr = document.createElement("div");
        hdr.className = "bingo-col-header";
        hdr.textContent = session.word[col];
        grid.appendChild(hdr);
    }

    // 25 cells
    for (let idx = 0; idx < 25; idx++) {
        const value    = card.squares[idx];
        const isFree   = (idx === FREE_CELL);
        const isDaubed = isActive && (isFree || (value !== null && session.called.includes(value)));
        const isEmpty  = !isFree && value === null;
        const isCellActive = (idx === editCellIdx);

        const cell = document.createElement("div");
        cell.className = [
            "bingo-cell",
            isFree       ? "free"    : "",
            isDaubed     ? "daubed"  : "",
            isEmpty      ? "empty"   : "",
            isCellActive ? "editing" : ""
        ].filter(Boolean).join(" ");

        cell.textContent = isFree ? "FREE" : (value ?? "");

        if (!isFree && isEditing) {
            cell.addEventListener("click", () => onCardCellClick(card.id, idx));
        }

        grid.appendChild(cell);
    }

    wrapper.appendChild(grid);

    // ---- Inline column picker (edit mode only) ----
    if (isEditing && editCellIdx !== -1) {
        const col      = colForCell(editCellIdx);
        const numbers  = colNumbers(col);
        const usedInCol = card.squares
            .filter((v, i) => i !== editCellIdx && colForCell(i) === col && v !== null && v !== "FREE");

        const picker = document.createElement("div");
        picker.className = "card-number-picker";

        const pickerLabel = document.createElement("div");
        pickerLabel.className = "card-picker-label";
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
updateUI();
