// Bingo Offline-First SQL Persistence & Sync Client Library
// Implements the client sync state machine, outbox queue, local caching, and health reachability.

// Sync library version identifier
const BINGO_SYNC_VERSION = '1.0';

(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        define([], factory);
    } else if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.BingoSync = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {

    const STORAGE_KEYS = {
        SESSION: 'bingoSession',
        OUTBOX: 'bingoOutbox',
        CARDS_CACHE: 'bingoCardLibraryCache',
        GAMES_CACHE: 'bingoGamesCache',
        CACHE_META: 'bingoCacheMeta'
    };

    const STATES = {
        IDLE: 'IDLE',
        DIRTY: 'DIRTY',
        SYNCING: 'SYNCING',
        OFFLINE_DIRTY: 'OFFLINE_DIRTY',
        PARTIAL_FAILURE: 'PARTIAL_FAILURE'
    };

    let currentState = STATES.IDLE;
    const stateListeners = new Set();
    let isDraining = false;
    let backoffTimer = null;

    /**
     * Resolves API path relative to current document location.
     * Works seamlessly whether hosted at domain root, in subfolder, or in scan/ subfolder.
     */
    function resolveApiUrl(path) {
        const cleanPath = path.replace(/^\/+/, '');
        const pathname = window.location.pathname;
        if (pathname.includes('/scan/')) {
            return '../../' + cleanPath;
        } else if (pathname.includes('/Bingo/')) {
            return '../' + cleanPath;
        }
        return '/' + cleanPath;
    }

    /**
     * Retrieves authentication headers if SuiteProfile is available.
     */
    function getAuthHeaders() {
        const headers = { 'Content-Type': 'application/json' };
        try {
            if (window.SuiteProfile && !SuiteProfile.isGuest()) {
                const user = SuiteProfile.getUser();
                if (user && user.token) {
                    headers['Authorization'] = 'Bearer ' + user.token;
                }
            }
        } catch (e) {}
        return headers;
    }

    /**
     * Retrieves authenticated SuiteProfile user ID or username.
     */
    function getAuthUserId() {
        try {
            if (window.SuiteProfile && !SuiteProfile.isGuest()) {
                const user = SuiteProfile.getUser();
                return user ? (user.username || user.id) : null;
            }
        } catch (e) {}
        return null;
    }

    /**
     * Reads outbox array from localStorage.
     */
    function getOutbox() {
        try {
            const raw = localStorage.getItem(STORAGE_KEYS.OUTBOX);
            return raw ? JSON.parse(raw) : [];
        } catch (e) {
            return [];
        }
    }

    /**
     * Persists outbox array to localStorage and recalculates state.
     */
    function saveOutbox(entries) {
        try {
            localStorage.setItem(STORAGE_KEYS.OUTBOX, JSON.stringify(entries));
        } catch (e) {
            console.error('Failed to write outbox to localStorage:', e);
        }
        recalculateState();
    }

    /**
     * Transitions state and notifies listeners.
     */
    function setState(newState) {
        if (currentState !== newState) {
            currentState = newState;
            stateListeners.forEach(fn => {
                try { fn(currentState); } catch (e) { console.error(e); }
            });
            window.dispatchEvent(new CustomEvent('bingo-sync-state', { detail: { state: currentState } }));
        }
    }

    /**
     * Evaluates outbox status to determine current sync state.
     */
    function recalculateState() {
        if (isDraining) {
            setState(STATES.SYNCING);
            return;
        }

        const outbox = getOutbox();
        if (outbox.length === 0) {
            setState(STATES.IDLE);
            return;
        }

        const hasFailed = outbox.some(e => e.status === 'failed');
        if (hasFailed) {
            setState(STATES.PARTIAL_FAILURE);
            return;
        }

        if (!navigator.onLine) {
            setState(STATES.OFFLINE_DIRTY);
            return;
        }

        setState(STATES.DIRTY);
    }

    /**
     * Performs a fast HEAD ping to /api/health to confirm real server reachability.
     * Enforces a strict 3-second timeout.
     */
    async function pingHealth() {
        if (!navigator.onLine) return false;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);
        try {
            const res = await fetch(resolveApiUrl('api/health'), {
                method: 'HEAD',
                signal: controller.signal,
                cache: 'no-store'
            });
            clearTimeout(timeoutId);
            return res.ok;
        } catch (e) {
            clearTimeout(timeoutId);
            return false;
        }
    }

    /**
     * Collapses duplicate operations in outbox before draining.
     * Discards upsert + delete pairs for unsynced entities, or merges to single delete.
     */
    function collapseOutbox(entries) {
        const collapsed = [];
        const seen = new Map();

        // Process in chronological order
        for (const entry of entries) {
            const key = `${entry.entityType}:${entry.entityId}`;
            if (seen.has(key)) {
                const prev = seen.get(key);
                if (prev.operation === 'upsert' && entry.operation === 'delete') {
                    if (!prev.syncedAt) {
                        // Never synced to server; discard both
                        seen.delete(key);
                        continue;
                    } else {
                        // Existed on server; replace with delete
                        seen.set(key, entry);
                        continue;
                    }
                } else if (prev.operation === 'upsert' && entry.operation === 'upsert') {
                    // Overwrite with newer payload snapshot
                    seen.set(key, { ...entry, syncedAt: prev.syncedAt });
                    continue;
                }
            }
            seen.set(key, entry);
        }

        return Array.from(seen.values()).sort((a, b) => a.queuedAt - b.queuedAt);
    }

    /**
     * Queues an outbox entry.
     */
    function queueEntry(entityType, entityId, operation, payload = null) {
        const outbox = getOutbox();
        const entry = {
            id: (crypto.randomUUID ? crypto.randomUUID() : ('entry_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6))),
            entityType,
            entityId,
            operation,
            payload,
            queuedAt: Date.now(),
            status: 'pending',
            retryCount: 0,
            lastError: null,
            syncedAt: null
        };

        outbox.push(entry);
        saveOutbox(outbox);

        // Opportunistically drain if online
        if (navigator.onLine) {
            drainOutbox();
        }
        return entry;
    }

    /**
     * Processes and flushes pending outbox entries to server.
     */
    async function drainOutbox() {
        if (isDraining) return;

        let outbox = getOutbox();
        const pendingEntries = outbox.filter(e => e.status === 'pending');
        if (pendingEntries.length === 0) {
            recalculateState();
            return;
        }

        // Verify reachability first
        const reachable = await pingHealth();
        if (!reachable) {
            setState(STATES.OFFLINE_DIRTY);
            return;
        }

        isDraining = true;
        setState(STATES.SYNCING);

        // Collapse redundant operations
        outbox = collapseOutbox(outbox);
        saveOutbox(outbox);

        for (let i = 0; i < outbox.length; i++) {
            const entry = outbox[i];
            if (entry.status !== 'pending' && entry.status !== 'syncing') {
                continue;
            }

            entry.status = 'syncing';
            saveOutbox(outbox);

            try {
                let success = false;
                let status = 0;

                if (entry.entityType === 'card') {
                    if (entry.operation === 'upsert') {
                        const res = await fetch(resolveApiUrl(`api/cards/${encodeURIComponent(entry.entityId)}`), {
                            method: 'PUT',
                            headers: getAuthHeaders(),
                            body: JSON.stringify(entry.payload)
                        });
                        status = res.status;
                        success = res.ok;
                    } else if (entry.operation === 'delete') {
                        const res = await fetch(resolveApiUrl(`api/cards/${encodeURIComponent(entry.entityId)}`), {
                            method: 'DELETE',
                            headers: getAuthHeaders()
                        });
                        status = res.status;
                        // 404 is considered successful deletion idempotency
                        success = res.ok || res.status === 404;
                    }
                } else if (entry.entityType === 'game') {
                    if (entry.operation === 'upsert') {
                        const res = await fetch(resolveApiUrl(`api/games/${encodeURIComponent(entry.entityId)}`), {
                            method: 'PUT',
                            headers: getAuthHeaders(),
                            body: JSON.stringify(entry.payload)
                        });
                        status = res.status;
                        success = res.ok;
                    } else if (entry.operation === 'delete') {
                        const res = await fetch(resolveApiUrl(`api/games/${encodeURIComponent(entry.entityId)}`), {
                            method: 'DELETE',
                            headers: getAuthHeaders()
                        });
                        status = res.status;
                        success = res.ok || res.status === 404;
                    }
                }

                if (success) {
                    // Confirmed: remove entry from outbox
                    outbox.splice(i, 1);
                    i--;
                    saveOutbox(outbox);
                } else if (status >= 400 && status < 500) {
                    // Non-network client error: increment retry counter
                    entry.retryCount = (entry.retryCount || 0) + 1;
                    entry.lastError = `Server returned HTTP ${status}`;
                    if (entry.retryCount >= 3) {
                        entry.status = 'failed';
                    } else {
                        entry.status = 'pending';
                    }
                    saveOutbox(outbox);
                } else {
                    // 5xx server error or disconnect: roll back to pending
                    entry.status = 'pending';
                    entry.lastError = `Server error HTTP ${status}`;
                    saveOutbox(outbox);
                    setState(STATES.OFFLINE_DIRTY);
                    break;
                }

            } catch (networkErr) {
                // Network dropped mid-drain: roll back to pending without penalty
                entry.status = 'pending';
                entry.lastError = 'Network connection dropped';
                saveOutbox(outbox);
                setState(STATES.OFFLINE_DIRTY);
                break;
            }
        }

        isDraining = false;
        recalculateState();
    }

    /**
     * Scans outbox on SuiteProfile login to assign guest cards to authenticated user.
     */
    function claimGuestCardsOnLogin() {
        const userId = getAuthUserId();
        if (!userId) return;

        let outbox = getOutbox();
        let changed = false;
        outbox.forEach(entry => {
            if (entry.entityType === 'card' && entry.payload && !entry.payload.createdBy) {
                entry.payload.createdBy = userId;
                entry.status = 'pending';
                changed = true;
            }
        });

        if (changed) {
            saveOutbox(outbox);
            if (navigator.onLine) {
                drainOutbox();
            }
        }
    }

    /**
     * Fetches card library with transparent offline cache fallback.
     */
    async function loadCardLibrary() {
        const userId = getAuthUserId();
        const url = resolveApiUrl(`api/cards${userId ? `?userId=${encodeURIComponent(userId)}` : ''}`);

        if (navigator.onLine) {
            try {
                const res = await fetch(url, { headers: getAuthHeaders() });
                if (res.ok) {
                    const cards = await res.json();
                    if (Array.isArray(cards)) {
                        localStorage.setItem(STORAGE_KEYS.CARDS_CACHE, JSON.stringify(cards));
                        localStorage.setItem(STORAGE_KEYS.CACHE_META + '_cards', String(Date.now()));
                        return { cards, fromCache: false, lastUpdated: Date.now() };
                    }
                }
            } catch (e) {
                console.warn('Network error loading cards, falling back to cache:', e);
            }
        }

        // Offline or fetch failed: load from cache
        try {
            const cachedRaw = localStorage.getItem(STORAGE_KEYS.CARDS_CACHE);
            const cachedTime = parseInt(localStorage.getItem(STORAGE_KEYS.CACHE_META + '_cards') || '0', 10);
            const cards = cachedRaw ? JSON.parse(cachedRaw) : [];
            return { cards, fromCache: true, lastUpdated: cachedTime };
        } catch (e) {
            return { cards: [], fromCache: true, lastUpdated: 0 };
        }
    }

    /**
     * Toggles favorite status for a card on the server and in local cache.
     */
    async function toggleFavorite(cardId, shouldFavorite) {
        if (!navigator.onLine) {
            throw new Error('Favorites cannot be changed while offline.');
        }

        const reachable = await pingHealth();
        if (!reachable) {
            throw new Error('Server is unreachable. Please try again when connection is restored.');
        }

        const url = resolveApiUrl(`api/favorites/${encodeURIComponent(cardId)}`);
        const method = shouldFavorite ? 'PUT' : 'DELETE';
        const res = await fetch(url, {
            method,
            headers: getAuthHeaders()
        });

        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `Failed to update favorite (HTTP ${res.status})`);
        }

        // Update local card cache
        try {
            const cachedRaw = localStorage.getItem(STORAGE_KEYS.CARDS_CACHE);
            if (cachedRaw) {
                const cards = JSON.parse(cachedRaw);
                const target = cards.find(c => String(c.id) === String(cardId));
                if (target) {
                    target.isFavorite = !!shouldFavorite;
                    localStorage.setItem(STORAGE_KEYS.CARDS_CACHE, JSON.stringify(cards));
                }
            }
        } catch (e) {}

        return true;
    }

    /**
     * Fetches game definitions with offline cache fallback.
     */
    async function loadGamesList() {
        const url = resolveApiUrl('api/games');

        if (navigator.onLine) {
            try {
                const res = await fetch(url, { headers: getAuthHeaders() });
                if (res.ok) {
                    const games = await res.json();
                    if (Array.isArray(games) && games.length > 0) {
                        localStorage.setItem(STORAGE_KEYS.GAMES_CACHE, JSON.stringify(games));
                        localStorage.setItem(STORAGE_KEYS.CACHE_META + '_games', String(Date.now()));
                        return { games, fromCache: false, lastUpdated: Date.now() };
                    }
                }
            } catch (e) {
                console.warn('Network error loading games, using cache:', e);
            }
        }

        try {
            const cachedRaw = localStorage.getItem(STORAGE_KEYS.GAMES_CACHE);
            const cachedTime = parseInt(localStorage.getItem(STORAGE_KEYS.CACHE_META + '_games') || '0', 10);
            const games = cachedRaw ? JSON.parse(cachedRaw) : [];
            return { games, fromCache: true, lastUpdated: cachedTime };
        } catch (e) {
            return { games: [], fromCache: true, lastUpdated: 0 };
        }
    }

    /**
     * Renders or updates a compact sync status indicator dot/badge.
     */
    function renderSyncBadge(container) {
        if (!container) return;

        let badge = container.querySelector('.bingo-sync-badge');
        if (!badge) {
            badge = document.createElement('div');
            badge.className = 'bingo-sync-badge';
            badge.setAttribute('role', 'button');
            badge.setAttribute('tabindex', '0');
            badge.title = 'View sync status';
            badge.onclick = (e) => {
                e.stopPropagation();
                showOutboxModal();
            };
            container.appendChild(badge);
        }

        const outbox = getOutbox();
        const pendingCount = outbox.filter(e => e.status === 'pending' || e.status === 'syncing').length;
        const failedCount = outbox.filter(e => e.status === 'failed').length;

        badge.className = 'bingo-sync-badge ' + currentState.toLowerCase();

        let dotColor = '#10b981'; // Green
        let text = 'Synced';

        if (currentState === STATES.SYNCING) {
            dotColor = '#f59e0b';
            text = 'Syncing...';
        } else if (currentState === STATES.DIRTY || currentState === STATES.OFFLINE_DIRTY) {
            dotColor = '#f59e0b';
            text = pendingCount > 0 ? `${pendingCount} Pending` : 'Offline';
        } else if (currentState === STATES.PARTIAL_FAILURE) {
            dotColor = '#ef4444';
            text = `${failedCount} Failed`;
        }

        badge.innerHTML = `
            <span class="sync-dot" style="background:${dotColor};"></span>
            <span class="sync-label">${text}</span>
        `;
    }

    /**
     * Displays modal showing outbox items and retry options.
     */
    function showOutboxModal() {
        let existing = document.getElementById('bingoOutboxModal');
        if (existing) existing.remove();

        const outbox = getOutbox();
        const modal = document.createElement('div');
        modal.id = 'bingoOutboxModal';
        modal.className = 'bingo-sync-modal-overlay';

        let itemsHtml = '';
        if (outbox.length === 0) {
            itemsHtml = '<p style="text-align:center; color:var(--text-subtle); padding:20px 0;">All items are up to date and confirmed on the server.</p>';
        } else {
            itemsHtml = outbox.map(entry => {
                const name = entry.payload && (entry.payload.name || entry.payload.label) ? (entry.payload.name || entry.payload.label) : entry.entityId;
                const statusColor = entry.status === 'failed' ? '#ef4444' : (entry.status === 'syncing' ? '#3b82f6' : '#f59e0b');
                return `
                    <div class="outbox-modal-item">
                        <div style="flex:1;">
                            <div style="font-weight:600; font-size:13px; color:var(--text);">${entry.operation.toUpperCase()} ${entry.entityType.toUpperCase()}: ${escapeHtml(name)}</div>
                            <div style="font-size:11px; color:var(--text-subtle);">Queued: ${new Date(entry.queuedAt).toLocaleTimeString()} · Retries: ${entry.retryCount || 0}</div>
                            ${entry.lastError ? `<div style="font-size:11px; color:#ef4444; margin-top:2px;">${escapeHtml(entry.lastError)}</div>` : ''}
                        </div>
                        <span style="font-size:11px; font-weight:700; color:${statusColor}; text-transform:uppercase;">${entry.status}</span>
                    </div>
                `;
            }).join('');
        }

        modal.innerHTML = `
            <div class="bingo-sync-modal-card">
                <div class="outbox-modal-header">
                    <h3>Sync Status & Outbox</h3>
                    <button type="button" class="link-button" id="closeOutboxModalBtn" style="font-size:18px;">&times;</button>
                </div>
                <div class="outbox-modal-body">
                    <div style="margin-bottom:12px; font-size:13px; color:var(--text-subtle);">
                        State: <strong style="color:var(--text);">${currentState}</strong> · Network: <strong style="color:var(--text);">${navigator.onLine ? 'Online' : 'Offline'}</strong>
                    </div>
                    <div class="outbox-modal-list">
                        ${itemsHtml}
                    </div>
                </div>
                <div class="outbox-modal-actions">
                    <button type="button" class="btn secondary-btn" id="retrySyncBtn" style="font-size:13px; padding:6px 12px;">Sync Now</button>
                    <button type="button" class="btn primary-btn" id="doneOutboxModalBtn" style="font-size:13px; padding:6px 12px;">Done</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        document.getElementById('closeOutboxModalBtn').onclick = () => modal.remove();
        document.getElementById('doneOutboxModalBtn').onclick = () => modal.remove();
        document.getElementById('retrySyncBtn').onclick = async () => {
            const btn = document.getElementById('retrySyncBtn');
            btn.disabled = true;
            btn.textContent = 'Pinging...';
            // Reset any failed entries to pending for retry
            const cur = getOutbox();
            cur.forEach(e => { if (e.status === 'failed') e.status = 'pending'; });
            saveOutbox(cur);
            await drainOutbox();
            modal.remove();
            showOutboxModal();
        };
    }

    function escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // -------------------------------------------------------------------------
    // Event Listeners for Network & Profile
    // -------------------------------------------------------------------------
    window.addEventListener('online', () => {
        recalculateState();
        drainOutbox();
    });

    window.addEventListener('offline', () => {
        recalculateState();
    });

    // Hook SuiteProfile login event to re-attribute guest cards
    window.addEventListener('suite-profile-changed', (e) => {
        if (e.detail && e.detail.action === 'change' && e.detail.session) {
            claimGuestCardsOnLogin();
        }
    });

    // Initial state calculation
    recalculateState();

    // Auto-drain on page load if online
    if (navigator.onLine) {
        setTimeout(drainOutbox, 500);
    }

    return {
        VERSION: BINGO_SYNC_VERSION,
        STATES,
        getState: () => currentState,
        onStateChange: (listener) => stateListeners.add(listener),
        pingHealth,
        drainOutbox,
        queueCardUpsert: (card) => queueEntry('card', card.id, 'upsert', card),
        queueCardDelete: (cardId) => queueEntry('card', cardId, 'delete', null),
        queueGameUpsert: (game) => queueEntry('game', game.id, 'upsert', game),
        queueGameDelete: (gameId) => queueEntry('game', gameId, 'delete', null),
        loadCardLibrary,
        toggleFavorite,
        loadGamesList,
        renderSyncBadge,
        showOutboxModal,
        resolveApiUrl,
        claimGuestCardsOnLogin
    };
}));
