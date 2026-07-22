let session = {
    word: "BINGO",
    called: new Set(),
    lastBall: null
};

const trackingGrid = document.getElementById("trackingGrid");
const sessionWordBar = document.getElementById("sessionWordBar");
const lastBallSpan = document.getElementById("lastBall");
const totalCalledSpan = document.getElementById("totalCalled");
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
// DISPLAY SESSION WORD
// ---------------------------

function updateSessionWordBar() {
    sessionWordBar.innerHTML = "";

    for (let i = 0; i < 5; i++) {
        const span = document.createElement("span");
        span.textContent = session.word[i];
        sessionWordBar.appendChild(span);
    }
}

updateSessionWordBar();

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
// TOGGLE NUMBER
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
    updateSessionWordBar();
}

updateUI();

// ---------------------------
// NEW SESSION
// ---------------------------

newSessionBtn.onclick = () => {
    if (!confirm("Start a new session? This will clear all numbers.")) return;

    const newWord = prompt("Enter a 5-letter session word:", "BINGO");
    if (!newWord || newWord.length !== 5) {
        alert("Invalid word. Using BINGO.");
        session.word = "BINGO";
    } else {
        session.word = newWord.toUpperCase();
    }

    session.called = new Set();
    session.lastBall = null;

    saveSession();
    updateUI();
};
