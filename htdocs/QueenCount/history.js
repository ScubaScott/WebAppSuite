// QueenCount history screen: read-only list of locked games, newest first.
// Each entry is an immutable text snapshot written at lock time; tapping a summary expands the full result list.
const APP_VERSION = "1.3";

const listEl = document.getElementById('historyList');
const emptyEl = document.getElementById('historyEmpty');
const editBtn = document.getElementById('editHistoryBtn');
const overlay = document.getElementById('overlay');

let entries = [];        // HistoryEntry records, newest first
let editMode = false;    // Edit history mode: each entry shows a delete button

// Yes/No confirmation modal; resolves true when the delete is confirmed
function confirmDelete(entry) {
  return new Promise(resolve => {
    const finish = result => { overlay.hidden = true; overlay.innerHTML = ''; resolve(result); };
    overlay.innerHTML = '<div class="modal" role="dialog" aria-modal="true"><h2>Delete game</h2><p></p><div class="modal-actions"></div></div>';
    overlay.querySelector('p').textContent = 'Delete the ' + QC.fmtDate(entry.date) + ' game (actual ' + entry.actual + ')? This cannot be undone.';
    const actions = overlay.querySelector('.modal-actions');
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => finish(false));
    const ok = document.createElement('button'); ok.type = 'button'; ok.className = 'btn-danger'; ok.textContent = 'Delete';
    ok.addEventListener('click', () => finish(true));
    actions.append(cancel, ok);
    overlay.hidden = false;
  });
}

// Deletes one history entry after confirmation
async function deleteEntry(entry) {
  if (!(await confirmDelete(entry))) return;
  try {
    await QC.del('history', entry.id);
    entries = entries.filter(e => e.id !== entry.id);
  } catch (e) {
    const f = document.getElementById('fatalMsg');
    f.textContent = 'Could not delete the game. (' + e.message + ')';
    f.hidden = false;
  }
  renderList();
}

// Builds one expandable history card from a HistoryEntry
function buildItem(entry) {
  const item = document.createElement('div');
  item.className = 'hist-item';

  const split = entry.winners.length > 1;
  const winNames = entry.winners.map(w => w.name).join(' & ');
  const pay = QC.money(entry.winners[0].payout) + (split ? ' each' : '');

  const summary = document.createElement('button');
  summary.type = 'button';
  summary.className = 'hist-summary';
  summary.setAttribute('aria-expanded', 'false');
  const main = document.createElement('span');
  main.className = 'h-main';
  const date = document.createElement('span'); date.className = 'h-date';
  date.textContent = QC.fmtDate(entry.date) + ' · Actual ' + entry.actual + ' · ' + entry.entryCount + ' entries';
  const win = document.createElement('span'); win.className = 'h-win'; win.textContent = winNames;
  main.append(date, win);
  const payEl = document.createElement('span'); payEl.className = 'h-pay'; payEl.textContent = pay;
  summary.append(main, payEl);

  // Detail list is built lazily on first expand
  const detail = document.createElement('div');
  detail.className = 'hist-detail';
  detail.hidden = true;
  let built = false;

  summary.addEventListener('click', () => {
    const open = detail.hidden;
    if (open && !built) {
      const ul = document.createElement('ul');
      ul.className = 'row-list';
      const rows = entry.guesses.map(g => ({ name: g.name, value: g.value, miss: g.miss }));
      QC.renderResultList(ul, rows, entry.winners, entry.actual);
      detail.appendChild(ul);
      built = true;
    }
    detail.hidden = !open;
    summary.setAttribute('aria-expanded', String(open));
  });

  if (editMode) {
    // Summary and delete button share one box
    const head = document.createElement('div');
    head.className = 'hist-head';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'hist-del';
    del.textContent = '×';
    del.setAttribute('aria-label', 'Delete game from ' + QC.fmtDate(entry.date));
    del.addEventListener('click', () => deleteEntry(entry));
    head.append(summary, del);
    item.append(head, detail);
  } else {
    item.append(summary, detail);
  }
  return item;
}

// Rebuilds the list for the current entries and edit mode
function renderList() {
  listEl.innerHTML = '';
  emptyEl.hidden = entries.length > 0;
  editBtn.hidden = entries.length === 0;
  editBtn.textContent = editMode ? 'Done' : 'Edit history';
  if (entries.length === 0) editMode = false;
  entries.forEach(e => listEl.appendChild(buildItem(e)));
}

editBtn.addEventListener('click', () => { editMode = !editMode; renderList(); });

async function init() {
  document.getElementById('appVersion').textContent = APP_VERSION;
  try {
    entries = await QC.getAll('history');
  } catch (e) {
    const f = document.getElementById('fatalMsg');
    f.textContent = 'Storage is unavailable in this browser. (' + e.message + ')';
    f.hidden = false;
    return;
  }
  entries.sort((a, b) => b.lockedAt.localeCompare(a.lockedAt));
  renderList();
}

init();
