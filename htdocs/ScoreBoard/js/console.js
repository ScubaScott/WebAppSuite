/**
 * ScoreBoard console: the operator's page. Loads the saved game and preferences, turns taps into actions,
 * redraws after every change, and runs the clock display.
 *
 * Structure (AGENTS.md section 3): state.js holds the rules, clock.js the timing, snapshot.js/sync.js the
 * server traffic, storage.js the saved data, render.js/setup.js/history.js/theme.js/effects.js the screen.
 */

import { STATUS, createGame, reduce, explain, needsExpiry, getElapsed, canChangePeriodLength, isCommitted, periodLabel } from './state.js';
import { getExpiryTime, eventTime } from './clock.js';
import { createStore } from './store.js';
import { createStorage, defaultPrefs } from './storage.js';
import { createSyncer } from './sync.js';
import { createRenderer } from './render.js';
import { createSetup } from './setup.js';
import { createHistoryDialog } from './history.js';
import { applyThemeToBody } from './shared.js';
import { showToast, playWhistle, playScoreSplash, playCardRaise, shareText } from './effects.js';

// Page version, shown in the footer
const APP_VERSION = '7.1';

const TICK_MS = 100;
const HEARTBEAT_MS = 20 * 1000;
const STALE_MS = 3 * 3600 * 1000;
// An expiry noticed this long after it happened (page asleep or in the background) asks the operator first
const LATE_EXPIRY_MS = 5000;

const byId = (id) => document.getElementById(id);
const profile = () => window.SuiteProfile;
const isSignedIn = () => !!(profile() && !profile().isGuest());

function newId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

/** A 64-character hex secret that authorizes writes to a game. */
function newWriteToken() {
    const bytes = new Uint8Array(32);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        crypto.getRandomValues(bytes);
    } else {
        for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** An action stamped with the current time and fresh ids (the reducer itself never reads the clock). */
const act = (type, extra = {}) => ({ type, at: Date.now(), id: newId(), pauseId: newId(), endId: newId(), ...extra });

// Actions that change bookkeeping only; they are saved but never trigger a server send
const QUIET_ACTIONS = new Set(['sync_state', 'server_final']);

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------

const storage = createStorage(window.localStorage, newId);
let prefs = storage.loadPrefs() || defaultPrefs();

const loaded = storage.loadGame(Date.now(), prefs.theme);
const store = createStore(loaded ? loaded.game : createGame());
// When the page last saved the game; used to judge a game left running for hours
let lastSavedAt = loaded && loaded.game.savedAt ? loaded.game.savedAt : Date.now();

const renderer = createRenderer();
let currentRows = [];
let staleAcknowledged = false;
let driftPromptOpen = false;

const syncer = createSyncer({
    getGame: store.getGame,
    getPrefs: () => prefs,
    dispatch: (action) => store.dispatch(action),
    send: (payload) => (profile() && profile().games ? profile().games.sync(payload, 0) : Promise.resolve({ success: false })),
    sendBeacon: (payload) => {
        try {
            navigator.sendBeacon('../api/games.php?action=sync', new Blob([JSON.stringify(payload)], { type: 'application/json' }));
        } catch (error) {
            // Beacons are best effort
        }
    },
    getToken: () => {
        const user = isSignedIn() ? profile().getUser() : null;
        return user ? user.token : null;
    },
    now: () => Date.now(),
    notify: showToast
});

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

const openModal = (id) => byId(id).classList.remove('hidden');
const closeModal = (id) => byId(id).classList.add('hidden');

function openEndOtModal() { openModal('end-ot-modal'); }

function closePromptModals() {
    closeModal('end-ot-modal');
    closeModal('overage-drift-modal');
    closeModal('stale-resume-modal');
    driftPromptOpen = false;
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

/** Change one or more preferences, save them, and apply them to the page. */
function changePrefs(patch) {
    prefs = { ...prefs, ...patch, savedAt: Date.now() };
    storage.savePrefs(prefs);
    if (profile()) profile().saveAppData('scoreboard', prefs);
    applyPrefs();
    // Which history rows are sent depends on the preferences
    syncer.request();
}

/** Show the current preferences on the page. */
function applyPrefs() {
    renderer.renderMute(prefs.muted);
    renderAll();
}

// The theme in force is the game's own; before a game exists (or for a game from an earlier version
// without one) the operator's last choice is used.
let appliedTheme = null;
function applyGameTheme(force = false) {
    const theme = store.getGame().theme || prefs.theme;
    if (force || theme !== appliedTheme) {
        applyThemeToBody(theme);
        appliedTheme = theme;
    }
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/** Redraw everything that depends on the game. */
function renderAll() {
    const game = store.getGame();
    applyGameTheme();
    renderer.renderBoard(game, prefs);
    currentRows = renderer.renderHistory(game, prefs, (id) => historyDialog.open(id));
    renderer.renderClock(game, Date.now());
    // The correction panel only makes sense while a period is in progress
    if (game.status !== STATUS.RUNNING && game.status !== STATUS.PAUSED) hideAdjustPanel();
}

const adjustPanel = byId('elapsed-adjust-panel');
const showAdjustPanel = () => adjustPanel.classList.remove('hidden');
function hideAdjustPanel() { adjustPanel.classList.add('hidden'); }

// ---------------------------------------------------------------------------
// Actions from the screen
// ---------------------------------------------------------------------------

/** Dispatch an action from the operator and show the reason when it is refused. */
function perform(action) {
    const result = store.dispatch(action);
    if (!result.ok) showToast(result.error);
    return result.ok;
}

function addScore(teamId) {
    if (!perform(act('score', { teamId }))) return;
    const game = store.getGame();
    const team = teamId === 'home' ? game.home : game.away;
    const splash = teamId === 'home' ? prefs.splashHome : prefs.splashAway;
    if (splash) playScoreSplash(renderer.elements[teamId === 'home' ? 'scoreHome' : 'scoreAway'], team.color);
    if (prefs.pauseOnScore) store.dispatch(act('pause', { qualifier: 'score' }));
}

function addCard(teamId, cardType) {
    if (perform(act('card', { teamId, cardType }))) {
        playCardRaise(renderer.elements[teamId === 'home' ? 'scoreHome' : 'scoreAway'], cardType);
    }
}

function endPeriod() {
    const game = store.getGame();
    const label = periodLabel(game);
    if (perform(act('end_period', { reason: 'manual' }))) showToast(`${label} ended`);
}

function finalizeGame(endedBy, at) {
    closePromptModals();
    if (perform(act('finalize', { endedBy, ...(at ? { at } : {}) }))) showToast('Match Finalized');
}

/** The newest time the game is known to have been active, used to end a game left running. */
function lastActivityAt() {
    const events = store.getGame().events;
    const newest = events.reduce((max, event) => Math.max(max, eventTime(event)), 0);
    return Math.min(Date.now(), Math.max(newest, lastSavedAt));
}

/** Apply the setup dialog. Returns an error message to keep the dialog open, or null. */
function handleSetupSubmit(values) {
    const game = store.getGame();
    const teams = { home: values.home, away: values.away };

    if (values.mode === 'create') {
        if (!(values.periodLengthMs > 0)) return 'Period length must be more than 0:00';
        // The game being replaced is closed on the server first, with its own names, scores and periods
        if (isCommitted(game) && game.status !== STATUS.FINAL) {
            const closing = act('finalize', { endedBy: 'new_game' });
            if (explain(game, closing) === null) syncer.sendDetached(reduce(game, closing));
        }
        const result = store.dispatch(act('new_game', {
            gameId: newId(),
            writeToken: newWriteToken(),
            ...teams,
            periodCount: values.periodCount,
            periodLengthMs: values.periodLengthMs,
            visibility: game.visibility,
            theme: values.theme
        }));
        if (!result.ok) return result.error;
        // The chosen theme is also the one offered for the next game
        if (values.theme !== prefs.theme) changePrefs({ theme: values.theme });
        showToast('Game ready — press Start at the whistle');
        loadTeamSuggestions();
        return null;
    }

    if (values.mode === 'overtime') {
        store.dispatch({ type: 'edit_match', ...teams });
        const result = store.dispatch(act('add_overtime', { periodLengthMs: values.periodLengthMs }));
        if (!result.ok) return result.error;
        showToast(`Overtime (${periodLabel(store.getGame())}) added`);
        return null;
    }

    const edit = { type: 'edit_match', ...teams, periodCount: values.periodCount };
    if (values.periodLengthMs !== undefined && values.periodLengthMs !== game.periodLengthMs) {
        edit.periodLengthMs = values.periodLengthMs;
    }
    // The theme can only change before the first Start
    if (!isCommitted(game) && values.theme !== game.theme) edit.theme = values.theme;
    const result = store.dispatch(edit);
    if (!result.ok) return result.error;
    showToast('Match details updated');
    return null;
}

const setup = createSetup({
    onSubmit: handleSetupSubmit,
    canChangePeriodLength: () => canChangePeriodLength(store.getGame()),
    // Picking a theme in the dialog shows it behind the dialog; closing restores the game's own theme
    onThemePreview: (theme) => applyThemeToBody(theme),
    onClose: () => applyGameTheme(true)
});

/** Offer the names of the user's earlier teams while typing our team's name (signed-in users only). */
async function loadTeamSuggestions() {
    if (!isSignedIn() || !profile().games || !profile().games.listMyTeams) return;
    try {
        const result = await profile().games.listMyTeams();
        if (result && result.success && Array.isArray(result.teams)) {
            setup.setTeamSuggestions(result.teams.map((team) => team.name));
        }
    } catch (error) {
        // Suggestions are optional
    }
}

function openEditMatch() {
    const status = store.getGame().status;
    if (status === STATUS.READY || status === STATUS.PAUSED || status === STATUS.BETWEEN_PERIODS) {
        setup.open('edit', store.getGame(), prefs.theme);
    }
}

const historyDialog = createHistoryDialog({
    getGame: store.getGame,
    getRows: () => currentRows,
    saveNote: (id, note) => {
        if (perform({ type: 'add_note', id, note })) showToast('Note saved');
    },
    removeEntry: (id) => {
        if (perform({ type: 'remove_event', id, at: Date.now(), pauseId: newId() })) showToast('Entry removed');
    },
    share: shareText
});

// ---------------------------------------------------------------------------
// Clock loop and prompts
// ---------------------------------------------------------------------------

/** Handle a running clock that has reached the period length. */
function handleExpiry(now) {
    const game = store.getGame();
    const expiry = getExpiryTime(game.events, game.currentPeriod, game.periodLengthMs);
    if (expiry !== null && now - expiry > LATE_EXPIRY_MS) {
        // The page was away when the period ended: ask whether it ended on time
        driftPromptOpen = true;
        byId('drift-period-name').textContent = periodLabel(game);
        openModal('overage-drift-modal');
        return;
    }
    playWhistle(prefs.muted);
    store.dispatch(act('end_period', { reason: 'time' }));
    // After the last period the operator chooses between Finalize and Overtime
    if (store.getGame().status === STATUS.PAUSED) openEndOtModal();
}

/** Once a tick: redraw the clocks and watch for an expired or abandoned period. */
function tick() {
    const game = store.getGame();
    const now = Date.now();
    renderer.renderClock(game, now);
    if (game.status !== STATUS.RUNNING || driftPromptOpen) return;

    if (!staleAcknowledged && getElapsed(game, now) >= STALE_MS) {
        openModal('stale-resume-modal');
        return;
    }
    if (needsExpiry(game, now)) handleExpiry(now);
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

function wireControls() {
    const el = renderer.elements;
    el.btnNewGame.addEventListener('click', () => setup.open('create', store.getGame(), prefs.theme));
    el.btnStart.addEventListener('click', () => perform(act('start')));
    el.btnPause.addEventListener('click', () => perform(act('pause')));
    el.btnResume.addEventListener('click', () => perform(act('resume')));
    el.btnEndPeriod.addEventListener('click', endPeriod);
    el.btnEndOt.addEventListener('click', openEndOtModal);
    el.cardMenu.addEventListener('click', openEditMatch);
    el.period.addEventListener('click', () => {
        if (store.getGame().status !== STATUS.RUNNING) openEditMatch();
    });

    el.scoreHome.addEventListener('click', () => addScore('home'));
    el.scoreAway.addEventListener('click', () => addScore('away'));
    document.querySelectorAll('[data-card-team]').forEach((button) => {
        button.addEventListener('click', () => addCard(button.dataset.cardTeam, button.dataset.cardType));
    });

    el.muteButton.addEventListener('click', () => changePrefs({ muted: !prefs.muted }));

    // Clock correction panel
    el.elapsedDisplay.addEventListener('click', () => {
        const status = store.getGame().status;
        if (status === STATUS.RUNNING || status === STATUS.PAUSED) showAdjustPanel();
    });
    document.querySelectorAll('[data-adjust-minutes]').forEach((button) => {
        button.addEventListener('click', () => {
            if (perform(act('adjust_clock', { deltaMs: Number(button.dataset.adjustMinutes) * 60000 }))) hideAdjustPanel();
        });
    });
    byId('btn-adjust-close').addEventListener('click', hideAdjustPanel);

    // End / Overtime dialog
    byId('close-end-ot-x').addEventListener('click', () => closeModal('end-ot-modal'));
    byId('btn-modal-cancel-end').addEventListener('click', () => closeModal('end-ot-modal'));
    byId('btn-modal-finalize').addEventListener('click', () => finalizeGame('user'));
    byId('btn-modal-add-ot').addEventListener('click', () => {
        closeModal('end-ot-modal');
        setup.open('overtime', store.getGame(), prefs.theme);
    });

    // "Period Limit Exceeded" prompt
    byId('btn-drift-end-on-time').addEventListener('click', () => {
        closeModal('overage-drift-modal');
        driftPromptOpen = false;
        if (perform(act('end_period', { reason: 'drift' })) && store.getGame().status === STATUS.PAUSED) openEndOtModal();
    });
    byId('btn-drift-continue-overage').addEventListener('click', () => {
        closeModal('overage-drift-modal');
        driftPromptOpen = false;
        perform(act('acknowledge_overage'));
    });

    // "Finish Last Game?" prompt
    byId('btn-stale-finish').addEventListener('click', () => finalizeGame('abandoned', lastActivityAt()));
    byId('btn-stale-resume').addEventListener('click', () => {
        staleAcknowledged = true;
        closeModal('stale-resume-modal');
    });
}

function wireSettings() {
    const checkbox = (id, key) => {
        const input = byId(id);
        input.addEventListener('change', () => changePrefs({ [key]: input.checked }));
        return input;
    };
    const inputs = {
        pauseOnScore: checkbox('setting-pause-on-score', 'pauseOnScore'),
        logPauseResume: checkbox('setting-log-pause-resume', 'logPauseResume'),
        logPeriodStartStop: checkbox('setting-log-period-start-stop', 'logPeriodStartStop'),
        splashHome: checkbox('setting-splash-home', 'splashHome'),
        splashAway: checkbox('setting-splash-away', 'splashAway'),
        showCards: checkbox('setting-show-cards', 'showCards')
    };
    const sharePublic = byId('setting-share-public');

    function openSettings() {
        Object.keys(inputs).forEach((key) => { inputs[key].checked = !!prefs[key]; });
        sharePublic.checked = store.getGame().visibility !== 'private';
        openModal('settings-modal');
    }
    function closeSettings() {
        closeModal('settings-modal');
    }
    byId('settings-btn').addEventListener('click', openSettings);
    byId('close-settings-btn').addEventListener('click', closeSettings);
    byId('close-settings-x').addEventListener('click', closeSettings);

    // The gear on the other ScoreBoard pages links here with ?settings=1
    const params = new URLSearchParams(window.location.search);
    if (params.get('settings') === '1') {
        params.delete('settings');
        const query = params.toString();
        history.replaceState(null, '', window.location.pathname + (query ? '?' + query : ''));
        openSettings();
    }

    sharePublic.addEventListener('change', async () => {
        const game = store.getGame();
        const next = sharePublic.checked ? 'public' : 'private';
        if (!isCommitted(game)) {
            // Not on the server yet: the choice is sent when the first Start creates the game
            store.dispatch({ type: 'set_visibility', visibility: next });
            return;
        }
        // The server ignores visibility on ordinary syncs, so use the dedicated call
        sharePublic.disabled = true;
        try {
            const result = await profile().games.setVisibility(game.id, next);
            if (!result || !result.success) throw new Error('rejected');
            store.dispatch({ type: 'set_visibility', visibility: next });
        } catch (error) {
            sharePublic.checked = store.getGame().visibility !== 'private';
            showToast('Could not change sharing. Try again.');
        } finally {
            sharePublic.disabled = false;
        }
    });
}

/** Save the game, draw it, and schedule a server send after every change. */
function wireStore() {
    store.subscribe((game, action) => {
        lastSavedAt = Date.now();
        if (!storage.saveGame({ ...game, savedAt: lastSavedAt }) && !wireStore.warned) {
            wireStore.warned = true;
            showToast('Could not save on this device');
        }
        renderAll();
        if (game.status === STATUS.FINAL) closePromptModals();
        if (!QUIET_ACTIONS.has(action.type) && !action.silent) syncer.request();
    });
}

function wireLifecycle() {
    // Page hidden or closing: save locally, then send one beacon
    const onHidden = () => {
        lastSavedAt = Date.now();
        storage.saveGame({ ...store.getGame(), savedAt: lastSavedAt });
        syncer.pageHidden();
    };
    window.addEventListener('pagehide', onHidden);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            onHidden();
        } else {
            syncer.pageVisible();
            tick();
        }
    });
    // Signing in or out reloads the page so the right data is shown
    window.addEventListener('suite-profile-changed', (event) => {
        const detail = event.detail || {};
        if (detail.action === 'logout' || detail.action === 'login') window.location.reload();
    });
    setInterval(tick, TICK_MS);
    setInterval(() => syncer.heartbeat(), HEARTBEAT_MS);
}

// ---------------------------------------------------------------------------
// Preferences from the profile
// ---------------------------------------------------------------------------

/**
 * Compare the profile's copy of the preferences with this device's. The newer one wins; the profile is
 * updated when this device is newer or when it still holds a whole game saved by an earlier version.
 * A profile that does not answer within 3 seconds is skipped.
 */
async function reconcileProfilePrefs() {
    if (!isSignedIn()) return;
    let record;
    try {
        record = await Promise.race([
            profile().loadAppData('scoreboard'),
            new Promise((resolve) => setTimeout(() => resolve('timeout'), 3000))
        ]);
    } catch (error) {
        return;
    }
    if (record === 'timeout') return;

    const remote = record ? normalizeRemote(record) : null;
    if (remote && remote.savedAt > prefs.savedAt) {
        prefs = remote;
        storage.savePrefs(prefs);
        applyPrefs();
    }
    const holdsOldGame = !!(record && (record.activeGameId !== undefined || record.scoreHistory !== undefined));
    if (!remote || remote.savedAt < prefs.savedAt || holdsOldGame) {
        profile().saveAppData('scoreboard', { ...prefs, savedAt: prefs.savedAt || Date.now() });
    }
}

function normalizeRemote(record) {
    // storage.js understands both the current and the earlier field names
    return storage.normalize(record);
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

function start() {
    if (profile()) profile().renderFooterIndicator(document.querySelector('footer p'));
    byId('appVersion').textContent = APP_VERSION;

    // Links and settings that only exist for signed-in users
    byId('settings-sharing-section').classList.toggle('hidden', !isSignedIn());

    wireControls();
    wireSettings();
    wireStore();
    wireLifecycle();

    renderer.renderMute(prefs.muted);
    renderAll();
    loadTeamSuggestions();

    // The current-format records are written now; earlier ones go once the new game record reads back
    if (loaded) {
        storage.saveGame({ ...store.getGame(), savedAt: lastSavedAt });
        storage.removeLegacy();
    }
    if (!storage.hasPrefs()) storage.savePrefs(prefs);

    // A game left running while the page was closed
    const game = store.getGame();
    if (game.status === STATUS.RUNNING && Date.now() - lastSavedAt >= STALE_MS) {
        openModal('stale-resume-modal');
    } else {
        tick();
    }

    reconcileProfilePrefs();
}

start();
