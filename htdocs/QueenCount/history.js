// QueenCount history screen: read-only list of locked games, newest first.
// Each entry is an immutable text snapshot written at lock time; tapping a summary expands the full result list.
const APP_VERSION = "1.1";

const listEl = document.getElementById('historyList');
const emptyEl = document.getElementById('historyEmpty');

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

  item.append(summary, detail);
  return item;
}

async function init() {
  document.getElementById('appVersion').textContent = APP_VERSION;
  let entries;
  try {
    entries = await QC.getAll('history');
  } catch (e) {
    const f = document.getElementById('fatalMsg');
    f.textContent = 'Storage is unavailable in this browser. (' + e.message + ')';
    f.hidden = false;
    return;
  }
  entries.sort((a, b) => b.lockedAt.localeCompare(a.lockedAt));
  emptyEl.hidden = entries.length > 0;
  entries.forEach(e => listEl.appendChild(buildItem(e)));
}

init();
