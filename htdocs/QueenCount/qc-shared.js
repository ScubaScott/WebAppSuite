// QueenCount shared module: IndexedDB storage, result calculation and result-list rendering.
// Loaded by index.html (game) and history.html (history); exposes a single global `QC`.
(function () {
  const DB_NAME = 'queencount';
  const DB_VERSION = 1;
  const ENTRY_FEE = 1; // fixed $1 per guess

  let dbPromise = null;

  // Unique id for every record (sync readiness)
  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  // Opens (and on first run creates) the database: pool, game (single record) and history stores
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('IndexedDB is not available')); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        ['pool', 'game', 'history'].forEach(s => {
          if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
        });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Could not open storage'));
    });
    return dbPromise;
  }

  // Runs fn(stores...) inside one transaction; resolves when the transaction commits, rejects if it aborts
  async function withTx(storeNames, mode, fn) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeNames, mode);
      const stores = storeNames.map(n => tx.objectStore(n));
      let result;
      try { result = fn(...stores); } catch (e) { tx.abort(); reject(e); return; }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    });
  }

  // Reads every record of a store
  async function getAll(store) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction(store, 'readonly').objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  const put = (store, rec) => withTx([store], 'readwrite', s => { s.put(rec); });
  const del = (store, id) => withTx([store], 'readwrite', s => { s.delete(id); });

  // Asks the browser to keep site storage from being evicted; failures are ignored
  function requestPersistence() {
    try {
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
    } catch (e) { /* app works without persistence */ }
  }

  // Name comparison key: ignores case and surrounding spaces
  const nameKey = n => String(n).trim().toLowerCase();

  // Formats whole dollars without cents and split payouts to the cent: $25 / $12.50
  function money(n) {
    return Number.isInteger(n) ? '$' + n : '$' + n.toFixed(2);
  }

  // Signed miss using a true minus sign: -4 -> "−4", 7 -> "+7", 0 -> "0"
  function fmtMiss(m) {
    if (m === 0) return '0';
    return (m > 0 ? '+' : '−') + Math.abs(m);
  }

  const fmtDate = iso => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

  // Calculates sorted rows (with signed miss), pot and winners with payouts for a set of guesses
  function computeResult(guesses, actual) {
    const rows = guesses
      .map(g => ({ name: g.name, value: g.value, miss: g.value - actual }))
      .sort((a, b) => a.value - b.value);
    const pot = rows.length * ENTRY_FEE;
    let best = Infinity;
    rows.forEach(r => { best = Math.min(best, Math.abs(r.miss)); });
    const closest = rows.filter(r => Math.abs(r.miss) === best);
    // Full pot goes to the winner(s); a tie splits evenly to the cent
    const payout = Math.round((pot / closest.length) * 100) / 100;
    const winners = closest.map(r => ({ name: r.name, guess: r.value, miss: r.miss, payout }));
    return { rows, pot, winners };
  }

  // Renders the sorted results list into a <ul>: signed misses, highlighted winners, and the Actual divider
  function renderResultList(ul, rows, winners, actual) {
    ul.innerHTML = '';
    const winKeys = new Set(winners.map(w => nameKey(w.name)));
    const split = winners.length > 1;
    let dividerDone = false;
    const addDivider = () => {
      const d = document.createElement('li');
      d.className = 'divider';
      d.textContent = '▶ Actual: ' + actual;
      ul.appendChild(d);
      dividerDone = true;
    };
    rows.forEach(r => {
      // Divider sits above the first guess at or beyond the actual (directly above an exact match)
      if (!dividerDone && r.value >= actual) addDivider();
      const li = document.createElement('li');
      const isWin = winKeys.has(nameKey(r.name));
      li.className = 'row' + (isWin ? ' winner' : '');
      const name = document.createElement('span'); name.className = 'name'; name.textContent = r.name;
      const val = document.createElement('span'); val.className = 'val'; val.textContent = r.value;
      const miss = document.createElement('span'); miss.className = 'miss'; miss.textContent = fmtMiss(r.miss);
      li.append(name, val, miss);
      if (isWin) {
        const w = winners.find(x => nameKey(x.name) === nameKey(r.name));
        const b = document.createElement('span');
        b.className = 'badge';
        b.textContent = money(w.payout) + (split ? ' each' : '');
        li.appendChild(b);
      }
      ul.appendChild(li);
    });
    if (!dividerDone) addDivider();
  }

  window.QC = {
    ENTRY_FEE, uid, getAll, put, del, withTx, openDB, requestPersistence,
    nameKey, money, fmtMiss, fmtDate, computeResult, renderResultList
  };
})();
