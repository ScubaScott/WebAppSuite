let session = {
    word: "BINGO",
    called: new Set(),
    lastBall: null
};

const letterBar = document.getElementById("letterBar");
const trackingGrid = document.getElementById("trackingGrid");
const calledPanel = document.getElementById("calledPanel");
const lastBallSpan = document.getElementById("lastBall");
const totalCalledSpan = document.getElementById("totalCalled");
const toggleCalled = document.getElementById("toggleCalled");
const newSessionBtn = document.getElementById("newSessionBtn");

// ---------------------------
// SESSION LOAD / SAVE
// ---------------------------

function saveSession() {
    localStorage.setItem("bingoSession", JSON.stringify({
        word: session.word,
        called: [...session.called],
        lastBall: session.lastBall
    }));
}

function loadSession() {
    const data = localStorage.getItem("bingoSession");
    if (!data) return;

    const obj = JSON.parse(data);
    session.word = obj.word;
    session.called = new Set(obj.called);
    session.lastBall = obj.lastBall;
}

loadSession();

// ---------------------------
// BUILD LETTER BAR
// ---------------------------

function buildLetterBar() {
    letterBar.innerHTML = "";
    for (let i = 0; i < 5; i++) {
        const btn = document.createElement("button");
        btn.textContent = session.word[i];
        btn.onclick = () => openNumberPicker(i);
        letterBar.appendChild(btn);
    }
}

buildLetterBar();

// ---------------------------
// BUILD NUMBER GRID
// ---------------------------

function buildTrackingGrid() {
    trackingGrid.innerHTML = "";

    for (let col = 0; col < 5; col++) {
        const columnDiv = document.createElement("div");
        columnDiv.className = "column";

        const start = col * 15 + 1;
        const end = start + 14;

        for (let n = start; n <= end; n++) {
            const cell = document.createElement("div");
            cell.className = "numberCell";
            cell.textContent = n;

            if (session.called.has(n)) {
                cell.classList.add("called");
            }

            cell.onclick = () => toggleNumber(n);

            columnDiv.appendChild(cell);
        }

        trackingGrid.appendChild(columnDiv);
    }
}

buildTrackingGrid();

// ---------------------------
// NUMBER PICKER (simple)
// ---------------------------

function openNumberPicker(colIndex) {
    const start = colIndex * 15 + 1;
    const end = start + 14;

    const num = prompt(`Enter number (${start}-${end})`);
    if (!num) return;

    const n = parseInt(num);
    if (n < start || n > end) return;

    toggleNumber(n);
}

// ---------------------------
// TOGGLE NUMBER (call/un-call)
// ---------------------------

function toggleNumber(n) {
    if (session.called.has(n)) {
        if (!confirm(`Remove ${n}?`)) return;
        session.called.delete(n);
        session.lastBall = null;
    } else {
        session.called.add(n);
        session.lastBall = n;
    }

    updateUI();
    saveSession();
}

// ---------------------------
// UPDATE UI
// ---------------------------

function updateUI() {
    lastBallSpan.textContent = "Last: " + (session.lastBall ?? "--");
    totalCalledSpan.textContent = "Total: " + session.called.size;

    buildTrackingGrid();
    buildCalledPanel();
}

updateUI();

// ---------------------------
// CALLED PANEL
// ---------------------------

function buildCalledPanel() {
    calledPanel.innerHTML = "";

    for (let col = 0; col < 5; col++) {
        const columnDiv = document.createElement("div");
        columnDiv.className = "column";

        const start = col * 15 + 1;
        const end = start + 14;

        for (let n = start; n <= end; n++) {
            const cell = document.createElement("div");
            cell.className = "numberCell";
            cell.textContent = n;

            if (session.called.has(n)) {
                cell.classList.add("called");
            }

            columnDiv.appendChild(cell);
        }

        calledPanel.appendChild(columnDiv);
    }
}

toggleCalled.onclick = () => {
    calledPanel.classList.toggle("hidden");
};

// ---------------------------
// NEW SESSION
// ---------------------------

newSessionBtn.onclick = () => {
    if (!confirm("Start a new session? This will clear all numbers.")) return;

    session.word = "BINGO";
    session.called = new Set();
    session.lastBall = null;

    saveSession();
    updateUI();
    buildLetterBar();
};
