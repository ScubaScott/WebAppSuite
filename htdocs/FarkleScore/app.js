// ─── Storage keys ────────────────────────────────────────────────────────────
const STORAGE_KEYS = {
  players:  'farkle-players',
  settings: 'farkle-settings',
  game:     'farkle-game'
};

// ─── Defaults ────────────────────────────────────────────────────────────────
const defaultSettings = {
  single1:          100,
  single5:           50,
  threeKind:        100,   // multiplied by face value
  threeOnes:       1000,
  fourKind:        1000,
  fiveKind:        2000,
  sixKind:         3000,
  straight:        1500,
  threePairs:      1500,
  winningScore:   10000,
  openingThreshold: 500
};

const defaultPlayers = ['Player 1', 'Player 2', 'Player 3'];

// ─── State ───────────────────────────────────────────────────────────────────
let players  = [];
let settings = { ...defaultSettings };

/*
  game.field: Array of "roll rows". Each row:
    { dice: number[], locked: boolean }
    - dice: the values entered so far for this roll
    - locked: true once Roll is pressed again (previous rows can't be edited)

  game.turnScore accumulates the running points for this turn.
  game.playerOpened: array of booleans, whether each player has passed opening threshold
*/
let game = freshGame();

function freshGame() {
  return {
    started:              false,
    currentPlayerIndex:   0,
    scores:               [],
    turnScore:            0,
    field:                [],   // array of roll rows
    turnActive:           false,
    lastRoundTriggered:   false,
    lastRoundStartIndex:  -1,   // player index who triggered the last round
    gameOver:             false,
    playerOpened:         []    // has each player passed opening threshold
  };
}

// ─── Page detection ──────────────────────────────────────────────────────────
const page = document.body.dataset.page;

// ─── Boot ────────────────────────────────────────────────────────────────────
function init() {
  loadState();
  bindEvents();
  render();
}

// ─── Persistence ─────────────────────────────────────────────────────────────
function loadState() {
  try {
    const sp = JSON.parse(localStorage.getItem(STORAGE_KEYS.players));
    const ss = JSON.parse(localStorage.getItem(STORAGE_KEYS.settings));
    const sg = JSON.parse(localStorage.getItem(STORAGE_KEYS.game));

    players  = Array.isArray(sp) && sp.length ? sp : defaultPlayers.slice();
    settings = { ...defaultSettings, ...(ss || {}) };

    if (sg && sg.started) {
      game = { ...freshGame(), ...sg };
      // ensure arrays are arrays
      if (!Array.isArray(game.field))         game.field         = [];
      if (!Array.isArray(game.scores))        game.scores        = players.map(() => 0);
      if (!Array.isArray(game.playerOpened))  game.playerOpened  = players.map(() => false);
    } else {
      game = freshGame();
      game.scores       = players.map(() => 0);
      game.playerOpened = players.map(() => false);
    }
  } catch (e) {
    players  = defaultPlayers.slice();
    settings = { ...defaultSettings };
    game     = freshGame();
    game.scores       = players.map(() => 0);
    game.playerOpened = players.map(() => false);
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEYS.players,  JSON.stringify(players));
  localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
  localStorage.setItem(STORAGE_KEYS.game,     JSON.stringify(game));
}

// ─── Event binding ───────────────────────────────────────────────────────────
function bindEvents() {
  if (page === 'game') {
    document.getElementById('rollButton').addEventListener('click',   handleRoll);
    document.getElementById('bankButton').addEventListener('click',   handleBank);
    document.getElementById('farkleButton').addEventListener('click', handleFarkle);

    // Die input buttons — each tap adds one die to the current roll row
    document.querySelectorAll('.die-input-btn').forEach(btn => {
      btn.addEventListener('click', () => addDieToCurrentRoll(Number(btn.dataset.value)));
    });
  }

  if (page === 'players') {
    document.getElementById('addPlayerButton').addEventListener('click',    addPlayer);
    document.getElementById('startNewGameButton').addEventListener('click', startNewGame);
  }

  if (page === 'settings') {
    document.getElementById('saveSettingsButton').addEventListener('click',  saveSettings);
    document.getElementById('resetSettingsButton').addEventListener('click', resetSettings);
    populateSettingsForm();
  }
}

// ─── Render dispatcher ───────────────────────────────────────────────────────
function render() {
  if (page === 'game')      renderGame();
  if (page === 'players')   renderPlayers();
  if (page === 'settings')  populateSettingsForm();
  if (page === 'standings') renderStandings();
}

// ═══════════════════════════════════════════════════════════════════════════
//  GAME PAGE
// ═══════════════════════════════════════════════════════════════════════════

function renderGame() {
  if (!players.length) {
    document.getElementById('currentPlayerInfo').innerHTML =
      '<p>No players yet. <a href="players.html">Add players</a> to begin.</p>';
    return;
  }

  // Auto-start
  if (!game.started) {
    game.started      = true;
    game.scores       = players.map(() => 0);
    game.playerOpened = players.map(() => false);
    saveState();
  }

  const idx           = game.currentPlayerIndex;
  const currentPlayer = players[idx] || players[0];
  const currentScore  = game.scores[idx] || 0;
  const rankings      = getRankings();
  const place         = rankings.findIndex(e => e.index === idx) + 1;
  const opened        = game.playerOpened[idx] || false;

  // Player hero
  document.getElementById('currentPlayerInfo').innerHTML = `
    <span class="player-name">${escHtml(currentPlayer)}</span>
  `;
  document.getElementById('playerScore').textContent = currentScore.toLocaleString();
  document.getElementById('playerPlace').textContent = place ? `${place}${ordinal(place)}` : '--';
  document.getElementById('turnScore').textContent   = game.turnScore.toLocaleString();

  // Status pill
  const statusEl = document.getElementById('gameStatus');
  if (game.gameOver)        { statusEl.textContent = 'Game over';  statusEl.className = 'status-pill pill-over'; }
  else if (!game.turnActive){ statusEl.textContent = 'Ready';      statusEl.className = 'status-pill pill-ready'; }
  else                      { statusEl.textContent = 'In turn';    statusEl.className = 'status-pill pill-active'; }

  // Opening threshold message
  const openMsg = document.getElementById('openingMessage');
  if (!opened && game.turnActive) {
    openMsg.textContent = `Must score at least ${settings.openingThreshold.toLocaleString()} pts this turn to open.`;
    openMsg.classList.remove('hidden');
  } else {
    openMsg.classList.add('hidden');
  }

  renderField();
  renderDiceButtons();
  renderValidation();
  renderActionButtons();
  saveState();
}

// ─── Field rendering ─────────────────────────────────────────────────────────
function renderField() {
  const container = document.getElementById('fieldArea');
  if (!container) return;

  if (!game.field.length) {
    container.innerHTML = '<p class="field-empty">No dice yet. Press Roll to start your turn, then tap dice to add them.</p>';
    return;
  }

  container.innerHTML = game.field.map((row, rowIndex) => {
    const isCurrentRow = rowIndex === game.field.length - 1;
    const rowScore     = scoreForSelection(row.dice);
    const valid        = rowScore > 0 || row.dice.length === 0;

    return `
      <div class="roll-row ${isCurrentRow ? 'roll-row-active' : 'roll-row-locked'}">
        <div class="roll-row-label">
          Roll ${rowIndex + 1}
          ${row.dice.length ? `<span class="row-score ${valid ? '' : 'row-score-invalid'}">${valid ? '+' + rowScore.toLocaleString() : 'No score'}</span>` : ''}
        </div>
        <div class="roll-row-dice">
          ${row.dice.length
            ? row.dice.map((val, dieIndex) => `
                <button
                  class="field-die ${isCurrentRow ? 'field-die-removable' : 'field-die-locked'}"
                  ${isCurrentRow ? `data-row="${rowIndex}" data-die="${dieIndex}"` : 'disabled'}
                  aria-label="${isCurrentRow ? 'Remove ' : ''}${val}"
                >
                  ${dieSVG(val)}
                </button>
              `).join('')
            : '<span class="no-dice-yet">No dice</span>'
          }
        </div>
      </div>
    `;
  }).join('');

  // Bind remove clicks on current row
  container.querySelectorAll('.field-die-removable').forEach(btn => {
    btn.addEventListener('click', () => {
      removeDieFromCurrentRoll(Number(btn.dataset.die));
    });
  });
}

// ─── Dice input buttons ───────────────────────────────────────────────────────
function renderDiceButtons() {
  const totalDiceInTurn = game.field.reduce((sum, row) => sum + row.dice.length, 0);
  const diceInCurrentRow = currentRow() ? currentRow().dice.length : 0;

  // Count dice used in locked rows
  const lockedDice = game.field.slice(0, -1).reduce((sum, row) => sum + row.dice.length, 0);
  const maxForCurrentRow = 6 - lockedDice;

  document.querySelectorAll('.die-input-btn').forEach(btn => {
    const disabled = !game.turnActive || game.gameOver || diceInCurrentRow >= maxForCurrentRow;
    btn.disabled = disabled;
    btn.classList.toggle('die-btn-disabled', disabled);
  });
}

// ─── Validation message ───────────────────────────────────────────────────────
function renderValidation() {
  const el = document.getElementById('rollValidation');
  if (!el) return;

  const row = currentRow();
  if (!row || !row.dice.length) {
    el.classList.add('hidden');
    return;
  }

  const score = scoreForSelection(row.dice);
  if (score > 0) {
    el.classList.add('hidden');
  } else {
    el.textContent = `⚠ Those dice don't score. Remove non-scoring dice or press Farkle.`;
    el.classList.remove('hidden');
  }
}

// ─── Action button state ──────────────────────────────────────────────────────
function renderActionButtons() {
  const rollBtn   = document.getElementById('rollButton');
  const bankBtn   = document.getElementById('bankButton');
  const farkleBtn = document.getElementById('farkleButton');

  const row             = currentRow();
  const rowDice         = row ? row.dice : [];
  const rowScore        = scoreForSelection(rowDice);
  const rowIsValid      = rowDice.length === 0 || rowScore > 0;
  const totalDiceUsed   = game.field.reduce((s, r) => s + r.dice.length, 0);
  const lockedDice      = game.field.slice(0, -1).reduce((s, r) => s + r.dice.length, 0);
  const currentRowDice  = rowDice.length;
  const allDiceUsed     = lockedDice + currentRowDice === 6;
  const turnHasScore    = game.turnScore > 0 || rowScore > 0;

  const idx    = game.currentPlayerIndex;
  const opened = game.playerOpened[idx] || false;
  const projectedTotal = game.turnScore + rowScore;
  const meetsOpening   = opened || projectedTotal >= settings.openingThreshold;

  // Roll: allowed when turn is active, current row is valid (or empty), and not all 6 dice locked
  const canRoll = game.turnActive && rowIsValid && (lockedDice < 6);
  rollBtn.disabled = game.gameOver || (!game.turnActive ? false : !rowIsValid);
  rollBtn.textContent = game.turnActive ? 'Re-roll' : 'Roll';

  // Bank: turn must be active, there must be a score, and opening threshold must be met
  bankBtn.disabled = !game.turnActive || projectedTotal === 0 || !meetsOpening || !rowIsValid;

  // Farkle: always available while turn is active
  farkleBtn.disabled = !game.turnActive;
}

// ─── Die manipulation ─────────────────────────────────────────────────────────

function addDieToCurrentRoll(value) {
  if (!game.turnActive || game.gameOver) return;

  // Ensure there's a current row
  if (!game.field.length) return;

  const row = currentRow();

  // How many dice are locked (in previous rows)
  const lockedDice = game.field.slice(0, -1).reduce((s, r) => s + r.dice.length, 0);
  if (lockedDice + row.dice.length >= 6) return; // can't add more than 6 total

  row.dice.push(value);
  recalcTurnScore();
  renderGame();
}

function removeDieFromCurrentRoll(dieIndex) {
  if (!game.turnActive || game.gameOver) return;
  const row = currentRow();
  if (!row) return;
  row.dice.splice(dieIndex, 1);
  recalcTurnScore();
  renderGame();
}

function currentRow() {
  return game.field.length ? game.field[game.field.length - 1] : null;
}

// ─── Turn score ───────────────────────────────────────────────────────────────

function recalcTurnScore() {
  // Sum scores of all LOCKED rows (all except the current one)
  const lockedScore = game.field
    .slice(0, -1)
    .reduce((sum, row) => sum + scoreForSelection(row.dice), 0);

  // Current row score is shown live but NOT added to turnScore until Roll is pressed
  // turnScore = locked rows only; we add current row score when displaying "projected"
  game.turnScore = lockedScore;
}

// ─── Roll button ──────────────────────────────────────────────────────────────

function handleRoll() {
  if (game.gameOver) return;

  // Not yet started a turn — begin one
  if (!game.turnActive) {
    startTurn();
    return;
  }

  const row      = currentRow();
  const rowDice  = row ? row.dice : [];
  const rowScore = scoreForSelection(rowDice);

  // Current row must either be empty or score
  if (rowDice.length > 0 && rowScore === 0) {
    // invalid — do nothing (validation message is shown)
    return;
  }

  // Lock the current row — its score is now committed to turnScore
  if (rowDice.length > 0) {
    game.turnScore += rowScore;
  }

  // Check hot-dice: if all 6 dice have been used (across all rows) and we're rolling again
  const totalDiceUsed = game.field.reduce((s, r) => s + r.dice.length, 0);

  if (totalDiceUsed === 6) {
    // Hot dice! Clear the field and start fresh, but keep turnScore
    game.field = [];
  }
  // else: normal re-roll — just add a new empty row
  game.field.push({ dice: [], locked: false });

  renderGame();
}

function startTurn() {
  game.turnActive = true;
  game.turnScore  = 0;
  game.field      = [{ dice: [], locked: false }];
  renderGame();
}

// ─── Bank ─────────────────────────────────────────────────────────────────────

function handleBank() {
  if (!game.turnActive || game.gameOver) return;

  const row      = currentRow();
  const rowScore = row ? scoreForSelection(row.dice) : 0;

  // Validate current row
  if (row && row.dice.length > 0 && rowScore === 0) return;

  const finalScore = game.turnScore + rowScore;
  const idx        = game.currentPlayerIndex;

  // Opening threshold check
  if (!game.playerOpened[idx]) {
    if (finalScore < settings.openingThreshold) return; // button should be disabled, but guard anyway
    game.playerOpened[idx] = true;
  }

  game.scores[idx] = (game.scores[idx] || 0) + finalScore;
  completeTurn();
}

// ─── Farkle ───────────────────────────────────────────────────────────────────

function handleFarkle() {
  if (!game.turnActive || game.gameOver) return;
  // No points awarded — just end the turn
  completeTurn();
}

// ─── End of turn ─────────────────────────────────────────────────────────────

function completeTurn() {
  game.turnActive = false;
  game.turnScore  = 0;
  game.field      = [];

  const prevIndex = game.currentPlayerIndex;
  game.currentPlayerIndex = (game.currentPlayerIndex + 1) % players.length;

  // Check if someone has hit the winning score
  if (!game.lastRoundTriggered) {
    const winners = game.scores.map((s, i) => ({ score: s, index: i })).filter(e => e.score >= settings.winningScore);
    if (winners.length) {
      game.lastRoundTriggered  = true;
      game.lastRoundStartIndex = game.currentPlayerIndex; // next player begins the last round
      showLastRoundBanner(players[prevIndex]);
    }
  } else {
    // We're in the last round — check if we've cycled back to the trigger player
    if (game.currentPlayerIndex === game.lastRoundStartIndex) {
      game.gameOver = true;
      showGameOverSummary();
    }
  }

  // Check if it's the end of a full round (back to player 0 or first player)
  // Show round summary when wrapping back to the first player (and not game over)
  if (!game.gameOver && game.currentPlayerIndex === 0 && !game.lastRoundTriggered) {
    showRoundSummary();
  } else if (!game.gameOver && game.currentPlayerIndex === 0 && game.lastRoundTriggered
             && game.lastRoundStartIndex !== 0) {
    // still in last round, wrapped to 0 but not the trigger player
    // no summary yet
  }

  saveState();
  renderGame();
}

// ─── Round / game-over summaries ─────────────────────────────────────────────

function showRoundSummary() {
  const overlay   = document.getElementById('summaryOverlay');
  if (!overlay) return;
  const rankings  = getRankings();

  overlay.innerHTML = `
    <div class="summary-card">
      <h2>Round complete</h2>
      <ol class="summary-list">
        ${rankings.map(e => `
          <li>
            <span class="summary-name">${escHtml(e.name)}</span>
            <span class="summary-score">${e.score.toLocaleString()}</span>
          </li>
        `).join('')}
      </ol>
      <div class="button-row" style="justify-content:center">
        <button class="btn btn-primary" onclick="closeSummary()">Continue</button>
      </div>
    </div>
  `;
  overlay.classList.remove('hidden');
}

function showLastRoundBanner(triggerName) {
  const banner = document.getElementById('lastRoundBanner');
  if (!banner) return;
  banner.textContent = `🎲 ${escHtml(triggerName)} hit ${settings.winningScore.toLocaleString()}! Last round — everyone gets one more turn.`;
  banner.classList.remove('hidden');
  setTimeout(() => banner.classList.add('hidden'), 6000);
}

function showGameOverSummary() {
  const overlay  = document.getElementById('summaryOverlay');
  if (!overlay) return;
  const rankings = getRankings();
  const winner   = rankings[0];

  overlay.innerHTML = `
    <div class="summary-card">
      <h2>🏆 Game over!</h2>
      <p class="summary-winner">${escHtml(winner.name)} wins with ${winner.score.toLocaleString()} points!</p>
      <ol class="summary-list">
        ${rankings.map(e => `
          <li>
            <span class="summary-name">${escHtml(e.name)}</span>
            <span class="summary-score">${e.score.toLocaleString()}</span>
          </li>
        `).join('')}
      </ol>
      <div class="button-row" style="justify-content:center">
        <a href="players.html" class="btn btn-primary">New game</a>
      </div>
    </div>
  `;
  overlay.classList.remove('hidden');
}

function closeSummary() {
  const overlay = document.getElementById('summaryOverlay');
  if (overlay) overlay.classList.add('hidden');
}

// ═══════════════════════════════════════════════════════════════════════════
//  PLAYERS PAGE
// ═══════════════════════════════════════════════════════════════════════════

function renderPlayers() {
  const list = document.getElementById('playersList');
  if (!list) return;

  if (!players.length) {
    list.innerHTML = '<p class="subtle">No players yet. Add one above.</p>';
    return;
  }

  list.innerHTML = players.map((name, i) => `
    <div class="player-row">
      <input type="text" value="${escHtml(name)}" data-index="${i}" aria-label="Player ${i+1} name" />
      <div class="player-actions">
        <button class="btn icon-btn" data-action="up"     data-index="${i}" aria-label="Move up"    ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn icon-btn" data-action="down"   data-index="${i}" aria-label="Move down"  ${i === players.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn icon-btn btn-danger" data-action="remove" data-index="${i}" aria-label="Remove player">×</button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('change', () => updatePlayerName(Number(inp.dataset.index), inp.value));
  });
  list.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', () => handlePlayerAction(btn.dataset.action, Number(btn.dataset.index)));
  });
}

function addPlayer() {
  players.push(`Player ${players.length + 1}`);
  game.scores.push(0);
  game.playerOpened.push(false);
  saveState();
  renderPlayers();
}

function updatePlayerName(index, value) {
  players[index] = value.trim() || `Player ${index + 1}`;
  saveState();
  renderPlayers();
}

function handlePlayerAction(action, i) {
  if (action === 'remove') {
    players.splice(i, 1);
    game.scores.splice(i, 1);
    if (Array.isArray(game.playerOpened)) game.playerOpened.splice(i, 1);
    if (game.currentPlayerIndex >= players.length) game.currentPlayerIndex = 0;
    saveState();
    renderPlayers();
    return;
  }
  if (action === 'up' && i > 0) {
    [players[i-1], players[i]] = [players[i], players[i-1]];
    [game.scores[i-1], game.scores[i]] = [game.scores[i], game.scores[i-1]];
    saveState(); renderPlayers();
  }
  if (action === 'down' && i < players.length - 1) {
    [players[i], players[i+1]] = [players[i+1], players[i]];
    [game.scores[i], game.scores[i+1]] = [game.scores[i+1], game.scores[i]];
    saveState(); renderPlayers();
  }
}

function startNewGame() {
  game = freshGame();
  game.scores       = players.map(() => 0);
  game.playerOpened = players.map(() => false);
  game.started      = true;
  saveState();
  window.location.href = 'index.html';
}

// ═══════════════════════════════════════════════════════════════════════════
//  SETTINGS PAGE
// ═══════════════════════════════════════════════════════════════════════════

function populateSettingsForm() {
  const form = document.getElementById('settingsForm');
  if (!form) return;
  Object.entries(settings).forEach(([key, val]) => {
    const inp = form.querySelector(`[name="${key}"]`);
    if (inp) inp.value = val;
  });
}

function saveSettings() {
  const form = document.getElementById('settingsForm');
  if (!form) return;
  Object.keys(defaultSettings).forEach(key => {
    const inp = form.querySelector(`[name="${key}"]`);
    if (inp) settings[key] = Number(inp.value) || 0;
  });
  saveState();
  showToast('Settings saved.');
}

function resetSettings() {
  settings = { ...defaultSettings };
  saveState();
  populateSettingsForm();
  showToast('Settings reset to defaults.');
}

// ═══════════════════════════════════════════════════════════════════════════
//  STANDINGS PAGE
// ═══════════════════════════════════════════════════════════════════════════

function renderStandings() {
  const list = document.getElementById('standingsList');
  if (!list) return;
  const rankings = getRankings();
  const winning  = settings.winningScore;

  if (!rankings.length) {
    list.innerHTML = '<p class="subtle">No players yet.</p>';
    return;
  }

  list.innerHTML = rankings.map((entry, i) => {
    const pct = Math.min(100, winning > 0 ? (entry.score / winning) * 100 : 0);
    return `
      <div class="standing-row">
        <div class="standing-info">
          <span class="standing-place">${i+1}${ordinal(i+1)}</span>
          <span class="standing-name">${escHtml(entry.name)}</span>
          <div class="progress-bar"><span style="width:${pct.toFixed(1)}%"></span></div>
        </div>
        <span class="standing-score">${entry.score.toLocaleString()}</span>
      </div>
    `;
  }).join('');
}

// ═══════════════════════════════════════════════════════════════════════════
//  SCORING ENGINE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Score a set of dice values.
 * Returns 0 if any dice are present but don't form a valid scoring combination.
 * Important: we must score ALL dice in the selection. If leftover dice exist
 * that score nothing, return 0.
 */
function scoreForSelection(dice) {
  if (!dice || !dice.length) return 0;

  const values = dice.slice().sort((a, b) => a - b);
  const counts = {};
  values.forEach(v => { counts[v] = (counts[v] || 0) + 1; });

  // ── 6-dice combos (must use all 6) ───────────────────────────────────────
  if (values.length === 6) {
    // Straight 1-2-3-4-5-6
    if (values.every((v, i) => v === i + 1)) return settings.straight;

    // Three pairs
    const countVals = Object.values(counts);
    if (countVals.length === 3 && countVals.every(c => c === 2)) return settings.threePairs;
    if (countVals.length === 2 && countVals.every(c => c === 3)) return settings.threePairs; // two sets of 3 also counts as three pairs in some variants — keep for safety
  }

  // ── Multi-of-a-kind (all dice of one face, possibly with extra scoring dice)
  // We need to tally the score of ALL dice and ensure none are wasted.
  return scoreAllDice(values, counts);
}

/**
 * Try to score every die in `values`. Returns total score or 0 if any
 * die cannot be scored.
 */
function scoreAllDice(values, counts) {
  let score         = 0;
  const remaining   = { ...counts };

  // Score three-or-more-of-a-kind first (greedily largest group first)
  const faces = Object.keys(remaining).map(Number).sort((a, b) => b - a);

  for (const face of faces) {
    const count = remaining[face] || 0;
    if (count >= 6) { score += settings.sixKind;  remaining[face] = 0; continue; }
    if (count >= 5) { score += settings.fiveKind; remaining[face] -= 5; continue; }
    if (count >= 4) { score += settings.fourKind; remaining[face] -= 4; continue; }
    if (count >= 3) {
      score += face === 1 ? settings.threeOnes : settings.threeKind * face;
      remaining[face] -= 3;
    }
  }

  // Now handle singles: only 1s and 5s score alone
  for (const face of Object.keys(remaining).map(Number)) {
    const leftover = remaining[face] || 0;
    if (leftover === 0) continue;
    if (face === 1) { score += leftover * settings.single1; remaining[face] = 0; }
    else if (face === 5) { score += leftover * settings.single5; remaining[face] = 0; }
    else {
      // Non-scoring die left over — whole selection is invalid
      return 0;
    }
  }

  return score;
}

// ═══════════════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function getRankings() {
  return players
    .map((name, index) => ({ name, score: game.scores[index] || 0, index }))
    .sort((a, b) => b.score - a.score);
}

function ordinal(n) {
  const s = ['th','st','nd','rd'];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showToast(msg) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('toast-show');
  setTimeout(() => toast.classList.remove('toast-show'), 2500);
}

// ─── Pip SVG for dice buttons ─────────────────────────────────────────────────

function dieSVG(value) {
  const pipPositions = {
    1: [[20,20]],
    2: [[11,11],[29,29]],
    3: [[11,11],[20,20],[29,29]],
    4: [[11,11],[29,11],[11,29],[29,29]],
    5: [[11,11],[29,11],[20,20],[11,29],[29,29]],
    6: [[11,10],[29,10],[11,20],[29,20],[11,30],[29,30]]
  };
  const pips = (pipPositions[value] || []).map(([cx,cy]) => `<circle cx="${cx}" cy="${cy}" r="4"/>`).join('');
  return `<svg viewBox="0 0 40 40" class="pip-svg">${pips}</svg>`;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
init();
