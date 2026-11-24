/**
 * Cycle sync: optional per-user server backup of the tracker's records (api/period.php).
 *
 * Records sync one by one: the version with the later updated_at wins, soft deletes travel as
 * ordinary records. The local IndexedDB stays the source the UI reads, so the app works offline;
 * changes made while offline stay in a "dirty" list and are pushed when a sync next succeeds.
 *
 * create(deps) builds a sync controller from injected parts so the same file runs in the browser
 * (global `CycleSync`) and in Node tests (tools/period-sync-test.js):
 *   store          { getAll(name), putMany(name, records, opts), onChange(fn) }
 *   fetch          fetch-compatible function
 *   apiUrl         URL of period.php
 *   getSession()   { username, token } or null
 *   storage        { getItem, setItem, removeItem } (device-local sync settings)
 *   onRemoteApplied()  called after records from the server changed local data
 *   onStatus(state)    called whenever the visible state changes
 */
(function (root) {
  'use strict';

  const STATE_KEY = 'period_sync_state';
  const PUSH_DELAY_MS = 2000;           // wait after a change before pushing
  const POLL_MS = 60000;                // pick up other devices' changes while the page is visible
  const BATCH_RECORDS = 200;            // matches the server limit
  const BATCH_BYTES = 180000;           // stay under the server's 256 KB body limit
  // Record types that sync (the reserved empty stores stay on the device)
  const SYNC_STORES = ['period_entries', 'cycle_flags', 'settings', 'health_note_dismissals', 'daily_logs'];
  const FIXED_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

  function create(deps) {
    const store = deps.store;
    const now = deps.now || (() => Date.now());

    // Persisted, device-local sync settings
    let saved = { enabled: false, username: null, cursor: 0, dirty: {}, lastSyncedAt: null };
    // Transient status shown in Settings: off | idle | syncing | error | signed-out | no-access
    let status = 'off';
    let errorMessage = null;
    let running = null;
    let again = false;
    let pushTimer = null;
    let started = false;

    /* ------------------------------------------------------------ state */

    function load() {
      try {
        const raw = deps.storage.getItem(STATE_KEY);
        if (raw) saved = Object.assign(saved, JSON.parse(raw));
      } catch (e) { /* unreadable state: start with sync off */ }
      if (!saved.dirty || typeof saved.dirty !== 'object') saved.dirty = {};
    }

    function persist() {
      try { deps.storage.setItem(STATE_KEY, JSON.stringify(saved)); } catch (e) { /* storage blocked: state lives for this session */ }
    }

    function pendingCount() {
      return Object.keys(saved.dirty).reduce((n, k) => n + saved.dirty[k].length, 0);
    }

    function getState() {
      return {
        enabled: saved.enabled,
        username: saved.username,
        status: status,
        error: errorMessage,
        lastSyncedAt: saved.lastSyncedAt,
        pending: pendingCount()
      };
    }

    function emit() {
      if (deps.onStatus) deps.onStatus(getState());
    }

    function setStatus(s, message) {
      status = s;
      errorMessage = message || null;
      emit();
    }

    function resetLocal() {
      saved = { enabled: false, username: null, cursor: 0, dirty: {}, lastSyncedAt: null };
      persist();
      if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
      setStatus('off');
    }

    function markDirty(name, ids) {
      if (!saved.enabled || SYNC_STORES.indexOf(name) < 0) return;
      const list = saved.dirty[name] || (saved.dirty[name] = []);
      ids.forEach(id => { if (list.indexOf(id) < 0) list.push(id); });
      persist();
      emit();
    }

    // Queues every local record (used when backup is first switched on)
    async function markAllDirty() {
      for (const name of SYNC_STORES) {
        const recs = await store.getAll(name);
        saved.dirty[name] = recs.map(r => r.id);
      }
      persist();
    }

    /* ---------------------------------------------------------- network */

    // Calls period.php; throws an Error carrying status and the parsed body on failure
    async function request(action, opts) {
      const session = deps.getSession();
      if (!session || !session.token) {
        const err = new Error('Sign in to use server backup.');
        err.status = 401;
        throw err;
      }
      opts = opts || {};
      const post = !!opts.body;
      let url = deps.apiUrl + '?action=' + action + (opts.query ? '&' + opts.query : '');
      const init = { headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.token } };
      if (post) {
        init.method = 'POST';
        init.body = JSON.stringify(Object.assign({ token: session.token }, opts.body));
      } else {
        url += '&token=' + encodeURIComponent(session.token);
      }
      let res;
      try {
        res = await deps.fetch(url, init);
      } catch (e) {
        const err = new Error('You appear to be offline.');
        err.offline = true;
        throw err;
      }
      let data = null;
      try { data = await res.json(); } catch (e) { /* non-JSON error page */ }
      if (!res.ok || !data || !data.success) {
        const err = new Error((data && data.error) || 'Server error (' + res.status + ').');
        err.status = res.status;
        err.data = data;
        throw err;
      }
      return data;
    }

    // Maps a failed request to a visible status; returns true when sync should simply retry later
    function handleFailure(err) {
      if (err.status === 401) { setStatus('signed-out', 'Sign in again to keep syncing.'); return false; }
      if (err.status === 403) { setStatus('no-access', 'Your profile does not have access to server backup.'); return false; }
      if (err.status === 409 && err.data && err.data.notEnabled) {
        resetLocal();
        setStatus('off', 'Server backup was turned off or deleted from another device.');
        return false;
      }
      setStatus('error', err.message);
      return true;
    }

    /* ------------------------------------------------------- pull / push */

    const ts = v => { const t = Date.parse(v); return isNaN(t) ? 0 : t; };

    // Fetches changed records from the server and merges them by updated_at; returns how many local records changed
    async function pull() {
      let changed = 0;
      for (;;) {
        const page = await request('pull', { query: 'since=' + saved.cursor });
        const byStore = {};
        page.records.forEach(item => {
          (byStore[item.store] || (byStore[item.store] = [])).push(item.record);
        });
        for (const name of Object.keys(byStore)) {
          if (SYNC_STORES.indexOf(name) < 0) continue;
          const local = {};
          (await store.getAll(name)).forEach(r => { local[r.id] = r; });
          const apply = [];
          byStore[name].forEach(rec => {
            const mine = local[rec.id];
            if (!mine || ts(rec.updated_at) > ts(mine.updated_at)) {
              apply.push(rec);
              // The server version replaces any unsent local edit of the same record
              const list = saved.dirty[name];
              if (list && list.indexOf(rec.id) >= 0) list.splice(list.indexOf(rec.id), 1);
            } else if (ts(mine.updated_at) > ts(rec.updated_at)) {
              // The local copy is newer than the server's, so it still needs to be sent
              const list = saved.dirty[name] || (saved.dirty[name] = []);
              if (list.indexOf(rec.id) < 0) list.push(rec.id);
            }
          });
          if (apply.length) {
            await store.putMany(name, apply, { remote: true });
            changed += apply.length;
          }
        }
        saved.cursor = page.cursor;
        persist();
        if (!page.hasMore) break;
      }
      return changed;
    }

    // Sends every dirty record to the server in size-limited batches; returns the records it rejected as stale
    async function push() {
      const snapshot = saved.dirty;
      saved.dirty = {};
      persist();
      const stale = [];
      try {
        const items = [];
        for (const name of Object.keys(snapshot)) {
          if (!snapshot[name].length) continue;
          const wanted = {};
          snapshot[name].forEach(id => { wanted[id] = true; });
          const toFix = [];
          (await store.getAll(name)).forEach(rec => {
            if (!wanted[rec.id]) return;
            if (!FIXED_ISO.test(rec.updated_at)) {
              // The server compares timestamps as text, so they must share one format
              rec.updated_at = new Date(ts(rec.updated_at) || now()).toISOString();
              toFix.push(rec);
            }
            items.push({ store: name, record: rec });
          });
          if (toFix.length) await store.putMany(name, toFix, { remote: true });
        }

        let batch = [];
        let bytes = 0;
        const flush = async () => {
          if (!batch.length) return;
          const result = await request('push', { body: { records: batch } });
          result.stale.forEach(s => stale.push(s));
          batch = [];
          bytes = 0;
        };
        for (const item of items) {
          const size = JSON.stringify(item).length;
          if (batch.length >= BATCH_RECORDS || (batch.length && bytes + size > BATCH_BYTES)) await flush();
          batch.push(item);
          bytes += size;
        }
        await flush();
      } catch (err) {
        // Put everything back so the next sync retries it
        Object.keys(snapshot).forEach(name => {
          const list = saved.dirty[name] || (saved.dirty[name] = []);
          snapshot[name].forEach(id => { if (list.indexOf(id) < 0) list.push(id); });
        });
        persist();
        throw err;
      }
      return stale;
    }

    /* ------------------------------------------------------------- sync */

    // True when backup is on and the signed-in profile is the one that turned it on
    function sessionOk() {
      const session = deps.getSession();
      if (!session || !session.token) { setStatus('signed-out', 'Sign in again to keep syncing.'); return false; }
      if (saved.username && session.username !== saved.username) {
        // A different profile signed in on this device: its data must not mix with the other profile's backup
        resetLocal();
        setStatus('off', 'Server backup was turned off because a different profile signed in.');
        return false;
      }
      return true;
    }

    // One full sync: pull (merge server changes), push (send local changes), pull again if the server held newer copies
    async function runSync() {
      if (!saved.enabled || !sessionOk()) return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) { setStatus('error', 'You appear to be offline.'); return; }
      setStatus('syncing');
      try {
        let changed = await pull();
        // Records the server rejected as stale come back with its newer copy, which replaces ours
        const stale = await push();
        for (const name of SYNC_STORES) {
          const newer = stale.filter(s => s.store === name && s.record).map(s => s.record);
          if (newer.length) {
            await store.putMany(name, newer, { remote: true });
            changed += newer.length;
          }
        }
        saved.lastSyncedAt = new Date(now()).toISOString();
        persist();
        setStatus('idle');
        if (changed && deps.onRemoteApplied) await deps.onRemoteApplied();
      } catch (err) {
        handleFailure(err);
      }
    }

    // Runs one sync at a time; a request made while one is running triggers another afterwards
    function syncNow() {
      if (running) { again = true; return running; }
      running = (async () => {
        try {
          do {
            again = false;
            await runSync();
          } while (again);
        } finally {
          running = null;
        }
      })();
      return running;
    }

    function schedulePush() {
      if (!saved.enabled) return;
      if (pushTimer) clearTimeout(pushTimer);
      pushTimer = setTimeout(() => { pushTimer = null; syncNow(); }, PUSH_DELAY_MS);
    }

    /* -------------------------------------------------- public actions */

    // Turns backup on for the signed-in profile, merging with any copy already on the server
    async function enable() {
      const session = deps.getSession();
      if (!session || !session.token) return { ok: false, error: 'Sign in to use server backup.' };
      try {
        await request('enable');
      } catch (err) {
        return { ok: false, error: err.message, status: err.status };
      }
      saved = { enabled: true, username: session.username, cursor: 0, dirty: {}, lastSyncedAt: null };
      persist();
      await markAllDirty();
      await syncNow();
      return status === 'idle' ? { ok: true } : { ok: false, error: errorMessage || 'Could not finish the first sync.' };
    }

    // Turns backup off on this device, optionally deleting the server copy first
    async function disable(opts) {
      if (opts && opts.deleteServerCopy) {
        try {
          await request('delete_data', { body: {} });
        } catch (err) {
          if (!(err.status === 409 && err.data && err.data.notEnabled)) return { ok: false, error: err.message };
        }
      }
      resetLocal();
      return { ok: true };
    }

    // Replaces the server copy with this device's records ("Replace all" import)
    async function replaceServerWithLocal() {
      if (!saved.enabled) return { ok: true };
      try {
        const reset = await request('reset', { body: {} });
        // Newer than the server's deletion markers, whatever the device clock says
        const stamp = new Date(Math.max(now(), ts(reset.serverTime) + 1)).toISOString();
        for (const name of SYNC_STORES) {
          const recs = await store.getAll(name);
          recs.forEach(r => { r.updated_at = stamp; });
          await store.putMany(name, recs);
        }
        await markAllDirty();
        await syncNow();
        return status === 'idle' ? { ok: true } : { ok: false, error: errorMessage };
      } catch (err) {
        handleFailure(err);
        return { ok: false, error: err.message };
      }
    }

    // Starts listening for local changes and page events; call once after the stores are open
    function start() {
      if (started) return;
      started = true;
      load();
      store.onChange((name, ids) => { markDirty(name, ids); schedulePush(); });
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => { if (!document.hidden) syncNow(); });
        setInterval(() => { if (!document.hidden) syncNow(); }, POLL_MS);
      }
      if (typeof window !== 'undefined') window.addEventListener('online', () => syncNow());
      if (saved.enabled) { setStatus('idle'); syncNow(); } else emit();
    }

    // Re-checks the signed-in profile after a sign-in, sign-out or session expiry
    function sessionChanged() {
      if (!saved.enabled) return;
      if (sessionOk()) syncNow();
    }

    return {
      start: start, getState: getState, enable: enable, disable: disable, syncNow: syncNow,
      replaceServerWithLocal: replaceServerWithLocal, sessionChanged: sessionChanged,
      // exposed for tests
      _flushPush: () => { if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; } return syncNow(); }
    };
  }

  const api = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CycleSync = api;
})(typeof self !== 'undefined' ? self : this);
