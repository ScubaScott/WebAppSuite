/**
 * Cycle store: IndexedDB persistence with one object store per record type, keyed by `id`.
 * Falls back to an in-memory store (data lasts only for the session) when IndexedDB is
 * unavailable, and reports that through isPersistent() so the UI can warn the user.
 */
const CycleStore = (function () {
  'use strict';

  const DB_NAME = 'period-tracker';
  const DB_VERSION = 1;

  // Object stores and their secondary index. daily_logs, sharing_grants and calendar_sync are
  // created empty so later features need no schema migration.
  const STORES = {
    period_entries: 'start_date',
    cycle_flags: 'period_entry_id',
    settings: null,
    health_note_dismissals: 'note_type',
    daily_logs: 'date',
    sharing_grants: null,
    calendar_sync: null
  };

  let db = null;
  let persistent = false;
  const memory = {};
  Object.keys(STORES).forEach(name => { memory[name] = {}; });

  // Opens the database; resolves with true when IndexedDB is in use, false for the memory fallback
  function open() {
    return new Promise(resolve => {
      if (!window.indexedDB) { resolve(false); return; }
      let req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        resolve(false);
        return;
      }
      req.onupgradeneeded = () => {
        const d = req.result;
        Object.keys(STORES).forEach(name => {
          if (d.objectStoreNames.contains(name)) return;
          const os = d.createObjectStore(name, { keyPath: 'id' });
          if (STORES[name]) os.createIndex(STORES[name], STORES[name], { unique: false });
        });
      };
      req.onsuccess = () => { db = req.result; persistent = true; resolve(true); };
      req.onerror = () => resolve(false);
      req.onblocked = () => resolve(false);
    });
  }

  // Wraps an IndexedDB request in a promise
  function wrap(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // All records in a store
  function getAll(name) {
    if (!persistent) return Promise.resolve(Object.keys(memory[name]).map(k => memory[name][k]));
    return wrap(db.transaction(name, 'readonly').objectStore(name).getAll());
  }

  // Listeners told about every local write (store name, record ids) so server sync can queue them.
  // Writes made with { remote: true } (records that just came from the server) are not announced.
  const changeListeners = [];

  function onChange(fn) {
    changeListeners.push(fn);
  }

  function announce(name, recs, opts) {
    if (opts && opts.remote) return;
    changeListeners.forEach(fn => fn(name, recs.map(r => r.id)));
  }

  // Inserts or replaces one record
  function put(name, rec, opts) {
    if (!persistent) {
      memory[name][rec.id] = rec;
      announce(name, [rec], opts);
      return Promise.resolve(rec);
    }
    return wrap(db.transaction(name, 'readwrite').objectStore(name).put(rec)).then(() => {
      announce(name, [rec], opts);
      return rec;
    });
  }

  // Inserts or replaces several records in one transaction
  function putMany(name, recs, opts) {
    if (!recs.length) return Promise.resolve();
    if (!persistent) {
      recs.forEach(r => { memory[name][r.id] = r; });
      announce(name, recs, opts);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(name, 'readwrite');
      const os = tx.objectStore(name);
      recs.forEach(r => os.put(r));
      tx.oncomplete = () => { announce(name, recs, opts); resolve(); };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  // Hard-deletes every record in one store
  function clear(name) {
    if (!persistent) { memory[name] = {}; return Promise.resolve(); }
    return wrap(db.transaction(name, 'readwrite').objectStore(name).clear());
  }

  // Hard-deletes every record in every store
  function clearAll() {
    return Promise.all(Object.keys(STORES).map(clear));
  }

  // RFC 4122 version 4 id
  function uuid() {
    if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  // Current time as an ISO-8601 UTC string
  function nowIso() {
    return new Date().toISOString();
  }

  return {
    open: open, getAll: getAll, put: put, putMany: putMany, clear: clear, clearAll: clearAll, onChange: onChange,
    uuid: uuid, nowIso: nowIso, isPersistent: () => persistent, storeNames: Object.keys(STORES)
  };
})();
