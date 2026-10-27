/**
 * ScoreBoard server sync: decides when the game is sent, numbers the revisions, handles the server's
 * answers, and sends the unload beacon. This is the only code that talks to the games API.
 * Everything it needs from the page is passed in (`deps`), so it runs the same in tests.
 *
 * Rules: AGENTS.md section 7.
 */

import { isCommitted, STATUS } from './state.js';
import { buildSyncPayload, fingerprint, statusKey } from './snapshot.js';

/** Wait before sending an ordinary change, so several quick changes become one request. */
export const SYNC_DELAY_MS = 2000;

/**
 * @param {Object} deps
 * @param {function(): Object} deps.getGame Current game.
 * @param {function(): Object} deps.getPrefs Operator preferences (decide which history rows are sent).
 * @param {function(Object): void} deps.dispatch Applies a `sync_state`, `set_visibility` or `server_final` action.
 * @param {function(Object): Promise<Object>} deps.send Sends one payload (SuiteProfile.games.sync with no delay).
 * @param {function(Object): void} deps.sendBeacon Sends one payload with navigator.sendBeacon.
 * @param {function(): (string|null)} deps.getToken Session token of the signed-in user, or null.
 * @param {function(): number} deps.now Current time in epoch milliseconds.
 * @param {function(string): void} deps.notify Shows a message to the operator.
 * @param {function(function, number): *} [deps.setTimer] Defaults to setTimeout.
 * @param {function(*): void} [deps.clearTimer] Defaults to clearTimeout.
 */
export function createSyncer(deps) {
    const setTimer = deps.setTimer || ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = deps.clearTimer || ((handle) => clearTimeout(handle));

    let timer = null;
    let lastFingerprint = '';
    let lastStatusKey = '';
    let beaconSent = false;

    /** Reserve the next revision number: one above anything sent or acknowledged. */
    function nextRev() {
        const sync = deps.getGame().sync;
        const rev = Math.max(sync.lastSentRev, sync.lastAckRev) + 1;
        deps.dispatch({ type: 'sync_state', lastSentRev: rev });
        return rev;
    }

    /** Send the current game, handling the server's answer. A revision conflict is retried once. */
    async function transmit(isRetry) {
        const rev = nextRev();
        const payload = buildSyncPayload(deps.getGame(), { rev, now: deps.now(), prefs: deps.getPrefs() });
        let result;
        try {
            result = await deps.send(payload);
        } catch (error) {
            return; // Offline or failed: the suite keeps the payload queued and resends it later
        }
        if (!result) return;

        if (result.error_code === 'final_without_live') return; // The server never saw this game live; nothing to do
        if (result.error_code === 'game_deleted') {
            deps.dispatch({ type: 'server_final', endedBy: 'deleted' });
            deps.notify('This game was deleted');
            return;
        }
        if (result.conflict) {
            if (result.rev) {
                deps.dispatch({ type: 'sync_state', lastAckRev: result.rev });
            }
            if (result.stopped) {
                deps.dispatch({ type: 'server_final', endedBy: 'user' });
                deps.notify('Match was finalized on the server');
            } else if (!isRetry) {
                await transmit(true);
            }
            return;
        }
        if (result.success !== false) {
            deps.dispatch({ type: 'sync_state', lastAckRev: rev });
            // The server decides visibility for an existing game; follow it
            if (result.visibility && result.visibility !== deps.getGame().visibility) {
                deps.dispatch({ type: 'set_visibility', visibility: result.visibility, silent: true });
            }
        }
    }

    /** Send the current state now and cancel any scheduled send. */
    function publishNow() {
        const game = deps.getGame();
        if (!isCommitted(game) || !game.id) return Promise.resolve();
        if (timer !== null) {
            clearTimer(timer);
            timer = null;
        }
        lastFingerprint = fingerprint(game, deps.getPrefs());
        lastStatusKey = statusKey(game);
        return transmit(false);
    }

    /**
     * Ask for the current state to reach the server soon. A status change goes at once; any other change
     * goes once, SYNC_DELAY_MS after the first unsent change; an unchanged game sends nothing.
     */
    function request() {
        const game = deps.getGame();
        if (!isCommitted(game) || !game.id) return;
        if (fingerprint(game, deps.getPrefs()) === lastFingerprint) return;
        if (statusKey(game) !== lastStatusKey) {
            if (timer !== null) clearTimer(timer);
            timer = setTimer(publishNow, 0);
        } else if (timer === null) {
            timer = setTimer(publishNow, SYNC_DELAY_MS);
        }
    }

    /**
     * Send a finished game that is no longer the current game (New Game replaces it right after).
     * Uses its own revision handling and never touches the current game. A conflict is retried once.
     */
    async function sendDetached(game) {
        let rev = Math.max(game.sync.lastSentRev, game.sync.lastAckRev) + 1;
        for (let attempt = 0; attempt < 2; attempt++) {
            let result;
            try {
                result = await deps.send(buildSyncPayload(game, { rev, now: deps.now(), prefs: deps.getPrefs() }));
            } catch (error) {
                return; // Offline: the suite keeps the payload queued
            }
            if (result && result.conflict && !result.stopped && result.rev) {
                rev = result.rev + 1;
                continue;
            }
            return;
        }
    }

    /** While the clock runs, tell the server the game is still live. */
    function heartbeat() {
        if (deps.getGame().status === STATUS.RUNNING) publishNow();
    }

    /** Send the game with a beacon when the page is hidden or closing. At most once until `pageVisible()`. */
    function pageHidden() {
        if (beaconSent) return;
        const game = deps.getGame();
        if (!isCommitted(game) || !game.id) return;
        beaconSent = true;
        const rev = nextRev();
        deps.sendBeacon(buildSyncPayload(game, { rev, now: deps.now(), prefs: deps.getPrefs(), token: deps.getToken() }));
    }

    /** The page is visible again: the next hide may send a beacon. */
    function pageVisible() {
        beaconSent = false;
    }

    return { request, publishNow, sendDetached, heartbeat, pageHidden, pageVisible };
}
