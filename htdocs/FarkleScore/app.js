const STORAGE_KEYS = {
  players: 'farkle-players',
  settings: 'farkle-settings',
  game: 'farkle-game'
};

const defaultSettings = {
  single1: 100,
  single5: 50,
  threeKind: 100,
  threeOnes: 1000,
  fourKind: 1000,
  fiveKind: 2000,
  sixKind: 3000,
  straight: 1500,
  threePairs: 1500,
  winningScore: 10000,
  openingThreshold: 500
};

const defaultPlayers = ['Player 1', 'Player 2', 'Player 3'];

let players = [];
let settings = { ...defaultSettings };
let game = {
  started: false,
  currentPlayerIndex: 0,
  scores: [],
  turnScore: 0,
  field: [],
  roll: [],
  turnActive: false,
  canRoll: true,
  lastRoundTriggered: false,
  gameOver: false,
  roundSummaryVisible: false
};

const page = document.body.dataset.page;

function init() {
  loadState();
  bindEvents();
  render();
}

function loadState() {
  try {
    const storedPlayers = JSON.parse(localStorage.getItem(STORAGE_KEYS.players));
    const storedSettings = JSON.parse(localStorage.getItem(STORAGE_KEYS.settings));
    const storedGame = JSON.parse(localStorage.getItem(STORAGE_KEYS.game));

    players = Array.isArray(storedPlayers) && storedPlayers.length ? storedPlayers : defaultPlayers.slice();
    settings = { ...defaultSettings, ...(storedSettings || {}) };

    if (storedGame && storedGame.started) {
      game = { ...game, ...storedGame };
      game.field = Array.isArray(storedGame.field) ? storedGame.field : [];
      game.roll = Array.isArray(storedGame.roll) ? storedGame.roll : [];
    } else {
      resetTurnState();
    }

    if (!Array.isArray(game.scores)) game.scores = players.map(() => 0);
    if (!Array.isArray(game.field)) game.field = [];
    if (!Array.isArray(game.roll)) game.roll = [];
  } catch (error) {
    players = defaultPlayers.slice();
    settings = { ...defaultSettings };
    game.scores = players.map(() => 0);
    resetTurnState();
  }
}

function resetTurnState() {
  game.started = false;
  game.currentPlayerIndex = 0;
  game.scores = players.map(() => 0);
  game.turnScore = 0;
  game.field = [];
  game.roll = [];
  game.turnActive = false;
  game.canRoll = true;
  game.lastRoundTriggered = false;
  game.gameOver = false;
  game.roundSummaryVisible = false;
}

function saveState() {
  localStorage.setItem(STORAGE_KEYS.players, JSON.stringify(players));
  localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
  localStorage.setItem(STORAGE_KEYS.game, JSON.stringify(game));
}

function bindEvents() {
  if (page === 'game') {
    document.getElementById('rollButton').addEventListener('click', handleRoll);
    document.getElementById('bankButton').addEventListener('click', handleBank);
    document.getElementById('farkleButton').addEventListener('click', handleFarkle);
  }

  if (page === 'players') {
    document.getElementById('addPlayerButton').addEventListener('click', addPlayer);
    document.getElementById('startNewGameButton').addEventListener('click', startNewGame);
  }

  if (page === 'settings') {
    document.getElementById('saveSettingsButton').addEventListener('click', saveSettings);
    document.getElementById('resetSettingsButton').addEventListener('click', resetSettings);
    populateSettingsForm();
  }

  if (page === 'standings') {
    renderStandings();
  }
}

function render() {
  if (page === 'game') renderGame();
  if (page === 'players') renderPlayers();
  if (page === 'settings') populateSettingsForm();
  if (page === 'standings') renderStandings();
}

function renderGame() {
  if (!players.length) {
    document.getElementById('currentPlayerInfo').innerHTML = '<p>No players added yet.</p>';
    return;
  }

  if (!game.started) {
    game.started = true;
    game.scores = players.map(() => 0);
    game.currentPlayerIndex = 0;
    game.turnActive = false;
    saveState();
  }

  const currentPlayer = players[game.currentPlayerIndex] || players[0];
  const currentScore = game.scores[game.currentPlayerIndex] || 0;
  const ranking = getRankings();
  const place = ranking.findIndex(entry => entry.name === currentPlayer) + 1;

  document.getElementById('currentPlayerInfo').innerHTML = `
    <h3>${currentPlayer}</h3>
    <p>It is ${currentPlayer}'s turn.</p>
  `;
  document.getElementById('playerScore').textContent = currentScore;
  document.getElementById('playerPlace').textContent = place ? `${place}${ordinal(place)}` : '--';
  document.getElementById('turnScore').textContent = game.turnScore;
  document.getElementById('gameStatus').textContent = game.gameOver ? 'Game over' : (game.turnActive ? 'In turn' : 'Ready');

  renderRollArea();
  renderField();
  renderRollHint();
  saveState();
}

function renderRollArea() {
  const container = document.getElementById('rollArea');
  if (!container) return;

  const activeRoll = getActiveRoll();
  if (!activeRoll || !activeRoll.available.length) {
    container.innerHTML = '<div class="die-chip">No dice available right now.</div>';
    return;
  }

  container.innerHTML = activeRoll.available.map((value, index) => `
    <button class="die-button" data-index="${index}">
      ${value}
    </button>
  `).join('');

  container.querySelectorAll('.die-button').forEach(button => {
    button.addEventListener('click', () => saveDie(button.dataset.index));
  });
}

function renderField() {
  const container = document.getElementById('fieldArea');
  if (!container) return;

  if (!game.field.length) {
    container.innerHTML = '<div class="die-chip">No rolls yet</div>';
    return;
  }

  container.innerHTML = game.field.map((roll, index) => {
    const savedText = roll.saved.length ? roll.saved.join(', ') : '—';
    const remainingText = roll.available.length ? roll.available.join(', ') : '—';
    const scoreText = scoreForSelection(roll.saved);
    return `
      <div class="roll-history-item">
        <div class="roll-history-header">Roll ${index + 1}</div>
        <div class="roll-history-line"><span class="saved-pill">Saved: ${savedText}</span></div>
        <div class="roll-history-line"><span class="remaining-pill">Remaining: ${remainingText}</span></div>
        <div class="roll-history-score">${scoreText > 0 ? `+${scoreText}` : 'No score yet'}</div>
      </div>
    `;
  }).join('');
}

function renderRollHint() {
  const hint = document.getElementById('rollHint');
  if (!hint) return;

  if (!game.turnActive) {
    hint.textContent = 'Press Roll to begin the turn.';
    return;
  }

  const activeRoll = getActiveRoll();
  if (!activeRoll) {
    hint.textContent = 'Press Roll to begin the turn.';
    return;
  }

  if (activeRoll.available.length) {
    hint.textContent = `Tap a die to save it for the turn, then press Roll to roll the remaining ${activeRoll.available.length} dice.`;
  } else {
    hint.textContent = 'All dice from that roll were saved. Press Roll again for a fresh six-die turn.';
  }
}

function getActiveRoll() {
  return game.field[game.field.length - 1] || null;
}

function createRollEntry(values) {
  return {
    rolled: values.slice(),
    available: values.slice(),
    saved: []
  };
}

function rollDice(count) {
  return Array.from({ length: count }, () => Math.floor(Math.random() * 6) + 1);
}

function saveDie(index) {
  const activeRoll = getActiveRoll();
  if (!activeRoll || !activeRoll.available.length) return;

  const selectedIndex = Number(index);
  const die = activeRoll.available.splice(selectedIndex, 1)[0];
  if (die === undefined) return;

  activeRoll.saved.push(die);
  updateTurnScore();
  renderGame();
}

function handleRoll() {
  if (!players.length) return;

  if (!game.turnActive) {
    startTurn();
    return;
  }

  const activeRoll = getActiveRoll();
  if (!activeRoll) {
    startTurn();
    return;
  }

  if (activeRoll.available.length) {
    const nextRoll = createRollEntry(rollDice(activeRoll.available.length));
    game.field.push(nextRoll);
    renderGame();
    return;
  }

  const hotDiceRoll = createRollEntry(rollDice(6));
  game.field.push(hotDiceRoll);
  renderGame();
}

function startTurn() {
  game.turnActive = true;
  game.turnScore = 0;
  game.field = [];
  game.roll = [];
  const firstRoll = createRollEntry(rollDice(6));
  game.field.push(firstRoll);
  renderGame();
}

function updateTurnScore() {
  game.turnScore = game.field.reduce((total, roll) => total + scoreForSelection(roll.saved), 0);
}

function handleBank() {
  if (!game.turnActive || !game.turnScore) return;
  const playerIndex = game.currentPlayerIndex;
  game.scores[playerIndex] += game.turnScore;
  completeTurn();
  renderGame();
}

function handleFarkle() {
  if (!game.turnActive) return;
  completeTurn();
  renderGame();
}

function completeTurn() {
  game.turnActive = false;
  game.turnScore = 0;
  game.field = [];
  game.roll = [];
  game.currentPlayerIndex = (game.currentPlayerIndex + 1) % players.length;
  checkGameEnd();
  saveState();
}

function checkGameEnd() {
  const rankings = getRankings();
  const leader = rankings[0];
  if (leader && leader.score >= settings.winningScore) {
    game.lastRoundTriggered = true;
    game.gameOver = true;
    showSummary();
  }
}

function showSummary() {
  const overlay = document.getElementById('summaryOverlay');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  const rankings = getRankings();
  overlay.innerHTML = `
    <div class="summary-card">
      <h2>Round summary</h2>
      <ul>
        ${rankings.map(entry => `<li>${entry.name}: ${entry.score} points</li>`).join('')}
      </ul>
      <div class="button-row">
        <button class="btn btn-primary" onclick="closeSummary()">Close</button>
      </div>
    </div>
  `;
}

function closeSummary() {
  document.getElementById('summaryOverlay').classList.add('hidden');
}

function renderPlayers() {
  const list = document.getElementById('playersList');
  if (!list) return;
  list.innerHTML = players.map((player, index) => `
    <div class="player-row">
      <input value="${player}" data-index="${index}" />
      <div class="player-actions">
        <button class="btn icon-btn" data-action="up" data-index="${index}">↑</button>
        <button class="btn icon-btn" data-action="down" data-index="${index}">↓</button>
        <button class="btn icon-btn btn-danger" data-action="remove" data-index="${index}">×</button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('input').forEach(input => {
    input.addEventListener('change', () => updatePlayerName(input.dataset.index, input.value));
  });

  list.querySelectorAll('button').forEach(button => {
    button.addEventListener('click', () => handlePlayerAction(button.dataset.action, button.dataset.index));
  });
}

function addPlayer() {
  players.push(`Player ${players.length + 1}`);
  game.scores.push(0);
  saveState();
  renderPlayers();
}

function updatePlayerName(index, value) {
  players[index] = value.trim() || `Player ${Number(index) + 1}`;
  saveState();
  render();
}

function handlePlayerAction(action, index) {
  const i = Number(index);
  if (action === 'remove') {
    players.splice(i, 1);
    game.scores.splice(i, 1);
    if (game.currentPlayerIndex >= players.length) game.currentPlayerIndex = 0;
    saveState();
    renderPlayers();
    return;
  }
  if (action === 'up' && i > 0) {
    [players[i - 1], players[i]] = [players[i], players[i - 1]];
    saveState();
    renderPlayers();
  }
  if (action === 'down' && i < players.length - 1) {
    [players[i], players[i + 1]] = [players[i + 1], players[i]];
    saveState();
    renderPlayers();
  }
}

function startNewGame() {
  game.started = true;
  game.currentPlayerIndex = 0;
  game.scores = players.map(() => 0);
  game.turnScore = 0;
  game.field = [];
  game.roll = [];
  game.turnActive = false;
  game.canRoll = true;
  game.lastRoundTriggered = false;
  game.gameOver = false;
  game.roundSummaryVisible = false;
  saveState();
  window.location.href = 'index.html';
}

function populateSettingsForm() {
  const form = document.getElementById('settingsForm');
  if (!form) return;
  Object.entries(settings).forEach(([key, value]) => {
    const input = form.querySelector(`[name="${key}"]`);
    if (input) input.value = value;
  });
}

function saveSettings() {
  const form = document.getElementById('settingsForm');
  if (!form) return;
  Object.keys(defaultSettings).forEach(key => {
    const input = form.querySelector(`[name="${key}"]`);
    if (input) settings[key] = Number(input.value) || 0;
  });
  saveState();
  alert('Settings saved.');
}

function resetSettings() {
  settings = { ...defaultSettings };
  saveState();
  populateSettingsForm();
  alert('Settings reset to defaults.');
}

function renderStandings() {
  const list = document.getElementById('standingsList');
  if (!list) return;
  const rankings = getRankings();
  list.innerHTML = rankings.map((entry, index) => `
    <div class="standing-row">
      <div>
        <strong>${index + 1}${ordinal(index + 1)}. ${entry.name}</strong>
        <div class="bar"><span style="width:${Math.min(100, (entry.score / settings.winningScore) * 100)}%"></span></div>
      </div>
      <div>${entry.score} pts</div>
    </div>
  `).join('');
}

function getRankings() {
  return players
    .map((name, index) => ({ name, score: game.scores[index] || 0 }))
    .sort((a, b) => b.score - a.score);
}

function scoreForSelection(selection) {
  const values = selection.slice().sort((a, b) => a - b);
  if (!values.length) return 0;
  const counts = values.reduce((acc, value) => { acc[value] = (acc[value] || 0) + 1; return acc; }, {});

  if (values.length === 6 && values.every((value, index) => value === index + 1)) return settings.straight;
  if (values.length === 6 && Object.values(counts).every(count => count === 2)) return settings.threePairs;

  const sortedCounts = Object.values(counts).sort((a, b) => b - a);
  if (sortedCounts[0] === 6) return settings.sixKind;
  if (sortedCounts[0] === 5) return settings.fiveKind;
  if (sortedCounts[0] === 4) return settings.fourKind;
  if (sortedCounts[0] === 3) {
    const tripleValue = Number(Object.keys(counts).find(key => counts[key] === 3));
    return tripleValue === 1 ? settings.threeOnes : settings.threeKind * tripleValue;
  }
  return values.filter(v => v === 1).length * settings.single1 + values.filter(v => v === 5).length * settings.single5;
}

function ordinal(value) {
  const suffixes = ['th', 'st', 'nd', 'rd'];
  const v = value % 100;
  return suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0];
}

init();
