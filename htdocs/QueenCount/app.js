// QueenCount main screen: game lifecycle, fast guess entry, name pool and result locking.
// Depends on qc-shared.js (global `QC`) for storage, result math and result rendering.
const APP_VERSION = "1.2";

// Soft typo-guard range for guesses and the actual count
const TYPO_MIN = 50;
const TYPO_MAX = 300;
const NAME_MAX = 30;

// In-memory mirror of what is persisted in IndexedDB
let pool = [];            // PoolName records
let game = null;          // the single current Game record, or null
let editPool = false;     // Edit pool mode toggle
let editingId = null;     // id of the guess being edited, or null for add mode
let nameFromPool = false; // true when the name field was filled by tapping a pool chip (disables pool filtering)
let previewActual = null; // actual count being previewed before lock (never persisted), or null
let ackValue = null;      // guess value for which the out-of-range warning was already acknowledged

const $ = id => document.getElementById(id);
const el = {
  fatal: $('fatalMsg'), header: $('gameHeader'), entryBar: $('entryBar'),
  name: $('nameInput'), guess: $('guessInput'), addBtn: $('addBtn'),
  editActions: $('editActions'), removeBtn: $('removeBtn'), cancelEditBtn: $('cancelEditBtn'), entryMsg: $('entryMsg'),
  poolCard: $('poolCard'), editPoolBtn: $('editPoolBtn'), poolAdd: $('poolAdd'), poolAddInput: $('poolAddInput'),
  poolAddBtn: $('poolAddBtn'), poolMsg: $('poolMsg'), poolGrid: $('poolGrid'), poolEmpty: $('poolEmpty'),
  noGame: $('noGame'), newGameBtn: $('newGameBtn'), openView: $('openView'), listCount: $('listCount'),
  guessList: $('guessList'), listEmpty: $('listEmpty'), enterActualBtn: $('enterActualBtn'), needNote: $('needNote'),
  previewView: $('previewView'), previewList: $('previewList'), previewMsg: $('previewMsg'),
  backBtn: $('backBtn'), confirmLockBtn: $('confirmLockBtn'), lockedView: $('lockedView'), resultList: $('resultList'), newGameBtn2: $('newGameBtn2'), overlay: $('overlay')
};

// ── Helpers ──────────────────────────────────────────────────────────────

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
const isOpen = () => !!game && game.status === 'Open';
const isLocked = () => !!game && game.status === 'Locked';
const outOfRange = v => v < TYPO_MIN || v > TYPO_MAX;

// Local calendar day key used to detect games left over from an earlier day
const dayKey = iso => { const d = new Date(iso); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); };

function setMsg(node, text, kind) {
  node.textContent = text || '';
  node.className = 'entry-msg' + (kind ? ' ' + kind : '');
}

// Reads the guess field as a whole number, or null when empty
function guessValue() {
  const t = el.guess.value.trim();
  return t === '' ? null : parseInt(t, 10);
}

// ── Modal helpers ────────────────────────────────────────────────────────

function closeModal() {
  el.overlay.hidden = true;
  el.overlay.innerHTML = '';
}

// Shows a modal with a title, body nodes and buttons [{label, cls, onClick}]; returns the modal element
function openModal(title, bodyNodes, buttons) {
  el.overlay.innerHTML = '';
  const m = document.createElement('div');
  m.className = 'modal';
  m.setAttribute('role', 'dialog');
  m.setAttribute('aria-modal', 'true');
  const h = document.createElement('h2');
  h.textContent = title;
  m.appendChild(h);
  bodyNodes.forEach(n => m.appendChild(n));
  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  buttons.forEach(b => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = b.label;
    if (b.cls) btn.className = b.cls;
    btn.addEventListener('click', () => b.onClick(btn));
    actions.appendChild(btn);
  });
  m.appendChild(actions);
  el.overlay.appendChild(m);
  el.overlay.hidden = false;
  return m;
}

const para = text => { const p = document.createElement('p'); p.textContent = text; return p; };

// Yes/No confirmation; resolves true when confirmed
function confirmDialog(title, message, okLabel) {
  return new Promise(resolve => {
    openModal(title, [para(message)], [
      { label: 'Cancel', onClick: () => { closeModal(); resolve(false); } },
      { label: okLabel, cls: 'btn-danger', onClick: () => { closeModal(); resolve(true); } }
    ]);
  });
}

// Text prompt with validation; resolves with the accepted trimmed text or null if cancelled.
// validate(text) returns an error string or '' when acceptable.
function promptDialog(title, initial, validate) {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = NAME_MAX;
    input.value = initial;
    input.autocomplete = 'off';
    const msg = document.createElement('p');
    msg.className = 'entry-msg error';
    const submit = () => {
      const t = input.value.trim();
      const err = validate(t);
      if (err) { msg.textContent = err; return; }
      closeModal();
      resolve(t);
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    openModal(title, [input, msg], [
      { label: 'Cancel', onClick: () => { closeModal(); resolve(null); } },
      { label: 'Save', cls: 'btn-primary', onClick: submit }
    ]);
    input.focus();
    input.select();
  });
}

// ── Pool ─────────────────────────────────────────────────────────────────

// Names available for tapping: pool minus names already in tonight's open game
function poolView() {
  const used = new Set(isOpen() ? game.guesses.map(g => QC.nameKey(g.name)) : []);
  return pool.filter(p => !used.has(QC.nameKey(p.name))).sort(byName);
}

// Validates a pool name; excludeId lets a rename ignore the record being renamed
function poolNameError(text, excludeId) {
  if (text.length < 1 || text.length > NAME_MAX) return 'Name must be 1–' + NAME_MAX + ' characters';
  if (pool.some(p => p.id !== excludeId && QC.nameKey(p.name) === QC.nameKey(text))) return 'Already in pool';
  return '';
}

function renderPool() {
  const showPool = !isLocked() && previewActual === null;
  el.poolCard.hidden = !showPool;
  if (!showPool) return;

  el.editPoolBtn.textContent = editPool ? 'Done' : 'Edit pool';
  el.poolAdd.hidden = !editPool;

  let names = poolView();
  // Live filter from the name field while adding (not when the name came from a chip tap)
  if (!editPool && isOpen() && editingId === null && !nameFromPool) {
    const f = QC.nameKey(el.name.value);
    if (f) names = names.filter(p => QC.nameKey(p.name).includes(f));
  }

  el.poolGrid.innerHTML = '';
  names.forEach(p => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'pool-chip' + (!editPool && QC.nameKey(el.name.value) === QC.nameKey(p.name) ? ' selected' : '');
    chip.textContent = p.name;
    if (editPool) {
      chip.addEventListener('click', () => renamePoolName(p));
      const wrap = document.createElement('div');
      wrap.className = 'pool-item';
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'pool-del';
      x.textContent = '×';
      x.setAttribute('aria-label', 'Remove ' + p.name);
      x.addEventListener('click', () => removePoolName(p));
      wrap.append(chip, x);
      el.poolGrid.appendChild(wrap);
    } else {
      chip.addEventListener('click', () => pickPoolName(p));
      el.poolGrid.appendChild(chip);
    }
  });

  // Empty-state hint only when the pool itself has no names
  el.poolEmpty.hidden = pool.length > 0;
}

// Loads a tapped pool name into the entry bar and moves focus to the guess field
function pickPoolName(p) {
  if (!isOpen() || editingId !== null) return;
  el.name.value = p.name;
  nameFromPool = true;
  ackValue = null;
  updateEntryUI();
  renderPool();
  el.guess.focus();
}

async function renamePoolName(p) {
  const t = await promptDialog('Rename', p.name, text => poolNameError(text, p.id));
  if (t === null || t === p.name) return;
  try {
    await QC.put('pool', { ...p, name: t, updatedAt: new Date().toISOString() });
    p.name = t;
    p.updatedAt = new Date().toISOString();
    setMsg(el.poolMsg, '');
  } catch (e) {
    setMsg(el.poolMsg, 'Could not save the change', 'error');
  }
  renderPool();
}

async function removePoolName(p) {
  if (!(await confirmDialog('Remove name', 'Remove "' + p.name + '" from the pool? Past games are not affected.', 'Remove'))) return;
  try {
    await QC.del('pool', p.id);
    pool = pool.filter(x => x.id !== p.id);
    setMsg(el.poolMsg, '');
  } catch (e) {
    setMsg(el.poolMsg, 'Could not remove the name', 'error');
  }
  renderPool();
}

async function addPoolName() {
  const t = el.poolAddInput.value.trim();
  const err = poolNameError(t, null);
  if (err) { setMsg(el.poolMsg, err, 'error'); return; }
  const now = new Date().toISOString();
  const rec = { id: QC.uid(), name: t, createdAt: now, updatedAt: now };
  try {
    await QC.put('pool', rec);
    pool.push(rec);
    el.poolAddInput.value = '';
    setMsg(el.poolMsg, '');
  } catch (e) {
    setMsg(el.poolMsg, 'Could not save the name', 'error');
  }
  renderPool();
}

function setEditPool(on) {
  editPool = on;
  if (on) cancelEdit();
  setMsg(el.poolMsg, '');
  render();
  if (on) el.poolAddInput.focus();
}

// ── Entry bar ────────────────────────────────────────────────────────────

// Re-evaluates the entry fields: inline errors/warnings and the submit button state/label
function updateEntryUI() {
  const editing = editingId !== null;
  const name = el.name.value.trim();
  const v = guessValue();
  let error = '';
  let warn = '';

  if (!editing && name && game.guesses.some(g => QC.nameKey(g.name) === QC.nameKey(name))) {
    error = 'Already entered';
  }
  if (!error && v !== null) {
    const other = game.guesses.find(g => g.value === v && g.id !== editingId);
    if (other) error = 'Taken by ' + other.name;
    else if (outOfRange(v)) warn = 'Unusual number (outside ' + TYPO_MIN + '–' + TYPO_MAX + ')';
  }

  const acked = v !== null && ackValue === v;
  el.addBtn.disabled = editPool || !(name && v !== null && !error);
  el.addBtn.textContent = (editing ? 'Save' : 'Add') + (acked ? ' anyway' : '');
  setMsg(el.entryMsg, error || (warn ? warn + ' — tap again to confirm' : ''), error ? 'error' : warn ? 'warn' : '');
}

function cancelEdit() {
  if (editingId === null) return;
  editingId = null;
  el.name.value = '';
  el.guess.value = '';
  el.name.readOnly = false;
  nameFromPool = false;
  ackValue = null;
  render();
}

function clearEntry() {
  el.name.value = '';
  el.guess.value = '';
  nameFromPool = false;
  ackValue = null;
  editingId = null;
  el.name.readOnly = false;
  // Dismiss the on-screen keyboard so the whole pool is visible for the next tap
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}

// Starts editing an existing guess: name read-only, guess editable
function startEdit(g) {
  if (!isOpen()) return;
  editingId = g.id;
  el.name.value = g.name;
  el.name.readOnly = true;
  el.guess.value = String(g.value);
  nameFromPool = false;
  ackValue = null;
  render();
  el.guess.focus();
  el.guess.select();
}

// Handles Add / Save, including the second-tap confirmation for out-of-range values
async function submitEntry() {
  if (!isOpen() || el.addBtn.disabled) return;
  const v = guessValue();
  if (outOfRange(v) && ackValue !== v) {
    ackValue = v;
    updateEntryUI();
    return;
  }
  const now = new Date().toISOString();

  if (editingId !== null) {
    const guesses = game.guesses.map(g => g.id === editingId ? { ...g, value: v, updatedAt: now } : g);
    const next = { ...game, guesses, updatedAt: now };
    try {
      await QC.put('game', next);
    } catch (e) { setMsg(el.entryMsg, 'Could not save the change', 'error'); return; }
    const id = editingId;
    game = next;
    clearEntry();
    render();
    highlightRow(id);
    return;
  }

  const typed = el.name.value.trim();
  const match = pool.find(p => QC.nameKey(p.name) === QC.nameKey(typed));
  const name = match ? match.name : typed;
  const rec = { id: QC.uid(), name, value: v, createdAt: now, updatedAt: now };
  const next = { ...game, guesses: [...game.guesses, rec], updatedAt: now };
  const newPool = match ? null : { id: QC.uid(), name, createdAt: now, updatedAt: now };
  try {
    // Guess and any auto-added pool name are written together
    await QC.withTx(['game', 'pool'], 'readwrite', (g, p) => { g.put(next); if (newPool) p.put(newPool); });
  } catch (e) { setMsg(el.entryMsg, 'Could not save the guess', 'error'); return; }
  game = next;
  if (newPool) pool.push(newPool);
  clearEntry();
  render();
  highlightRow(rec.id);
}

async function removeGuess() {
  if (editingId === null) return;
  const g = game.guesses.find(x => x.id === editingId);
  if (!g) return;
  if (!(await confirmDialog('Remove guess', 'Remove ' + g.name + "'s guess of " + g.value + '?', 'Remove'))) return;
  const next = { ...game, guesses: game.guesses.filter(x => x.id !== editingId), updatedAt: new Date().toISOString() };
  try {
    await QC.put('game', next);
  } catch (e) { setMsg(el.entryMsg, 'Could not remove the guess', 'error'); return; }
  game = next;
  clearEntry();
  render();
}

// Briefly highlights a row in tonight's list and scrolls it into view
function highlightRow(id) {
  const li = el.guessList.querySelector('[data-id="' + id + '"]');
  if (!li) return;
  li.classList.add('flash');
  li.scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(() => li.classList.remove('flash'), 1700);
}

// ── Rendering ────────────────────────────────────────────────────────────

function render() {
  const preview = isOpen() && previewActual !== null;
  const open = isOpen() && !preview;
  const locked = isLocked();

  // Game header
  el.header.hidden = !game;
  if (game) {
    const pot = QC.money(game.guesses.length * QC.ENTRY_FEE);
    const right = locked || preview
      ? '<span>Actual <strong>' + (locked ? game.actual : previewActual) + '</strong> · Pot <span class="pot">' + pot + '</span></span>'
      : '<span><strong>' + game.guesses.length + '</strong> entries · Pot <span class="pot">' + pot + '</span></span>';
    el.header.innerHTML = '<strong>' + QC.fmtDate(game.startedAt) + '</strong>' + right;
  }

  el.noGame.hidden = !!game;
  el.openView.hidden = !open;
  el.previewView.hidden = !preview;
  el.lockedView.hidden = !locked;
  el.entryBar.hidden = !open;
  el.entryBar.classList.toggle('disabled', editPool);
  el.name.disabled = editPool;
  el.guess.disabled = editPool;

  if (open) {
    const editing = editingId !== null;
    el.editActions.hidden = !editing;
    el.name.readOnly = editing;
    renderList();
    updateEntryUI();
  }
  if (preview) {
    const res = QC.computeResult(game.guesses, previewActual);
    QC.renderResultList(el.previewList, res.rows, res.winners, previewActual);
  }
  if (locked) {
    const res = QC.computeResult(game.guesses, game.actual);
    QC.renderResultList(el.resultList, res.rows, res.winners, game.actual);
  }
  renderPool();
}

// Tonight's list, sorted by guess ascending; each row is tappable to edit
function renderList() {
  const sorted = [...game.guesses].sort((a, b) => a.value - b.value);
  el.guessList.innerHTML = '';
  sorted.forEach(g => {
    const li = document.createElement('li');
    li.dataset.id = g.id;
    li.className = 'list-item';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'row';
    const n = document.createElement('span'); n.className = 'name'; n.textContent = g.name;
    const v = document.createElement('span'); v.className = 'val'; v.textContent = g.value;
    btn.append(n, v);
    btn.addEventListener('click', () => startEdit(g));
    li.appendChild(btn);
    el.guessList.appendChild(li);
  });
  el.listEmpty.hidden = sorted.length > 0;
  el.listCount.textContent = sorted.length + ' · ' + QC.money(sorted.length * QC.ENTRY_FEE);
  const enough = sorted.length >= 2;
  el.enterActualBtn.disabled = !enough || editPool;
  el.needNote.hidden = enough;
}

// ── Game lifecycle ───────────────────────────────────────────────────────

// Replaces any locked/previous game record with a fresh Open game (history entries are untouched)
async function newGame() {
  const now = new Date().toISOString();
  const rec = { id: QC.uid(), status: 'Open', startedAt: now, actual: null, lockedAt: null, guesses: [], createdAt: now, updatedAt: now };
  try {
    await QC.withTx(['game'], 'readwrite', g => { g.clear(); g.put(rec); });
  } catch (e) {
    setMsg(el.fatal, 'Could not start a new game: ' + e.message, 'error');
    el.fatal.hidden = false;
    return;
  }
  el.fatal.hidden = true;
  game = rec;
  editPool = false;
  clearEntry();
  render();
}

// Step 1 of lock: enter the actual count (soft typo guard outside 50–300)
function openActualModal(prefill) {
  const input = document.createElement('input');
  input.type = 'text';
  input.inputMode = 'numeric';
  input.pattern = '[0-9]*';
  input.maxLength = 5;
  input.placeholder = 'Actual count';
  input.value = prefill == null ? '' : String(prefill);
  const msg = document.createElement('p');
  msg.className = 'entry-msg';
  let acked = null;
  let nextBtn;

  const read = () => input.value.trim() === '' ? null : parseInt(input.value, 10);
  const refresh = () => {
    const v = read();
    nextBtn.disabled = v === null;
    const bad = v !== null && outOfRange(v);
    nextBtn.textContent = bad && acked === v ? 'Continue anyway' : 'Preview';
    setMsg(msg, bad ? 'Unusual number (outside ' + TYPO_MIN + '–' + TYPO_MAX + ') — tap again to confirm' : '', bad ? 'warn' : '');
  };
  const go = () => {
    const v = read();
    if (v === null) return;
    if (outOfRange(v) && acked !== v) { acked = v; refresh(); return; }
    enterPreview(v);
  };

  input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, ''); refresh(); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  openModal('Enter actual', [input, msg], [
    { label: 'Cancel', onClick: closeModal },
    { label: 'Preview', cls: 'btn-primary', onClick: go }
  ]);
  nextBtn = el.overlay.querySelector('.btn-primary');
  refresh();
  input.focus();
}

// Step 2 of lock: the main screen shows the sorted list with the result (UI only, nothing saved until Confirm)
function enterPreview(actual) {
  closeModal();
  previewActual = actual;
  editPool = false;
  setMsg(el.previewMsg, '');
  el.confirmLockBtn.disabled = false;
  render();
  window.scrollTo({ top: 0 });
}

// Back from preview: return to the open game with the actual pre-filled in the entry modal
function backFromPreview() {
  const actual = previewActual;
  previewActual = null;
  render();
  openActualModal(actual);
}

// Atomically writes the HistoryEntry and flips the game to Locked; on failure stays in preview
async function confirmLock() {
  const actual = previewActual;
  const res = QC.computeResult(game.guesses, actual);
  el.confirmLockBtn.disabled = true;
  const now = new Date().toISOString();
  const entry = {
    id: QC.uid(), gameId: game.id, date: game.startedAt, actual,
    entryCount: res.rows.length, pot: res.pot,
    winners: res.winners, guesses: res.rows, lockedAt: now, createdAt: now, updatedAt: now
  };
  const locked = { ...game, status: 'Locked', actual, lockedAt: now, updatedAt: now };
  try {
    await QC.withTx(['game', 'history'], 'readwrite', (g, h) => { g.put(locked); h.put(entry); });
  } catch (e) {
    setMsg(el.previewMsg, 'Could not save the result. Nothing was locked — try again.', 'error');
    el.confirmLockBtn.disabled = false;
    return;
  }
  game = locked;
  previewActual = null;
  editPool = false;
  render();
  window.scrollTo({ top: 0 });
}

// Launch-time check: an Open game from an earlier calendar day prompts Discard / Keep
function checkUnfinished() {
  if (!isOpen() || dayKey(game.startedAt) === dayKey(new Date().toISOString())) return;
  const n = game.guesses.length;
  openModal('Unfinished game', [para('Unfinished game from ' + QC.fmtDate(game.startedAt) + ' with ' + n + (n === 1 ? ' guess' : ' guesses') + '. Discard or Keep?')], [
    {
      label: 'Discard', cls: 'btn-danger', onClick: async () => {
        try {
          await QC.del('game', game.id);
          game = null;
          closeModal();
          render();
        } catch (e) { closeModal(); }
      }
    },
    { label: 'Keep', cls: 'btn-primary', onClick: closeModal }
  ]);
}

// ── Wiring ───────────────────────────────────────────────────────────────

el.name.addEventListener('input', () => {
  // Typing a name drops any pool selection and re-filters the pool
  nameFromPool = false;
  updateEntryUI();
  renderPool();
});
el.name.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); el.guess.focus(); } });
el.guess.addEventListener('input', () => {
  el.guess.value = el.guess.value.replace(/\D/g, '');
  updateEntryUI();
});
el.guess.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitEntry(); } });
el.addBtn.addEventListener('click', submitEntry);
el.removeBtn.addEventListener('click', removeGuess);
el.cancelEditBtn.addEventListener('click', cancelEdit);
el.editPoolBtn.addEventListener('click', () => setEditPool(!editPool));
el.poolAddBtn.addEventListener('click', addPoolName);
el.poolAddInput.addEventListener('keydown', e => { if (e.key === 'Enter') addPoolName(); });
el.backBtn.addEventListener('click', backFromPreview);
el.confirmLockBtn.addEventListener('click', confirmLock);
el.newGameBtn.addEventListener('click', newGame);
el.newGameBtn2.addEventListener('click', newGame);
el.enterActualBtn.addEventListener('click', () => { if (game.guesses.length >= 2) openActualModal(null); });

async function init() {
  document.getElementById('appVersion').textContent = APP_VERSION;
  QC.requestPersistence();
  try {
    pool = await QC.getAll('pool');
    const games = await QC.getAll('game');
    game = games[0] || null;
  } catch (e) {
    el.fatal.textContent = 'Storage is unavailable in this browser, so QueenCount cannot save data. (' + e.message + ')';
    el.fatal.hidden = false;
    return;
  }
  render();
  checkUnfinished();
}

init();
