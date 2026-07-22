let session = {
    word: "BINGO",
    called: [],
    lastBall: null
};

const trackingGrid = document.getElementById("trackingGrid");
const sessionWordBar = document.getElementById("sessionWordBar");
const lastFiveList = document.getElementById("lastFiveList");
const totalCalledSpan = document.getElementById("totalCalled");
const callLogLink = document.getElementById("callLogLink");
const newSessionBtn = document.getElementById("newSessionBtn");

// ---------------------------
// SESSION LOAD / SAVE
// ---------------------------

function saveSession() {
    localStorage.setItem("bingoSession", JSON.stringify({
        word: session.word,
        called: session.called,
        lastBall: session.lastBall
    }));
}

function loadSession() {
    const data = localStorage.getItem("bingoSession");
    if (!data) return;

    const obj = JSON.parse(data);
    session.word = obj.word;
    session.called = Array.isArray(obj.called) ? obj.called : [];
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

            if ([...session.called].includes(n)) {
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
    const existingIndex = [...session.called].indexOf(n);
    if (existingIndex !== -1) {
        if (!confirm(`Remove ${n}?`)) return;
        session.called.splice(existingIndex, 1);
        session.lastBall = session.called.length ? session.called[session.called.length - 1] : null;
    } else {
        session.called.push(n);
        session.lastBall = n;
    }

    updateUI();
    saveSession();
}

function openCallLogWindow() {
    const logWindow = window.open("", "bingoCallLog", "width=320,height=420,top=100,left=100");
    if (!logWindow) {
        alert("Unable to open call log window. Please allow popups for this site.");
        return;
    }

    const listItems = session.called
        .map((value, index) => `<li>${value}</li>`)
        .join("");

    logWindow.document.write(`<!DOCTYPE html><html><head><title>Call Log</title><style>body{font-family:Arial,Helvetica,sans-serif;margin:20px;color:#202124;background:#f8f9fa;}h1{font-size:20px;margin-bottom:12px;}ol{padding-left:18px;}li{margin-bottom:6px;}button{margin-top:18px;padding:10px 14px;border:none;border-radius:10px;background:#1a73e8;color:#fff;cursor:pointer;}</style></head><body><h1>Call Log</h1><ol>${listItems || '<li>No numbers called yet</li>'}</ol><button onclick="window.close()">Close</button></body></html>`);
    logWindow.document.close();
}

// ---------------------------
// UPDATE UI
// ---------------------------

function updateUI() {
    const lastFive = [...session.called].slice(-5);
    lastFiveList.innerHTML = "";

    for (let i = 4; i >= 0; i--) {
        const item = document.createElement("div");
        item.className = "last-five-item" + (lastFive[i] === undefined ? " empty" : "");
        item.textContent = lastFive[i] ?? "—";
        lastFiveList.appendChild(item);
    }

    totalCalledSpan.textContent = `${session.called.length} called`;

    buildTrackingGrid();
    updateSessionWordBar();
}

callLogLink.onclick = openCallLogWindow;

updateUI();

// ---------------------------
// NEW SESSION
// ---------------------------

newSessionBtn.onclick = () => {

    const newWord = prompt("Enter a 5-letter session word:", "BINGO");
    if (!newWord || newWord.length !== 5) {
        alert("Invalid word. Using BINGO.");
        session.word = "BINGO";
    } else {
        session.word = newWord.toUpperCase();
    }

    session.called = [];
    session.lastBall = null;

    saveSession();
    updateUI();
};
