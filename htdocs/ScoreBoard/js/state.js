/**
 * ScoreBoard game state: the `game` object, the reducer that changes it, and selectors that read it.
 * Pure: no DOM, no storage, no network, and no reading of the current time or random ids.
 * Every action carries the time (`at`, epoch ms) and any new ids it needs.
 *
 * Design: AGENTS.md section 4, clock rules: docs/TIMING-SPEC.md.
 */

import * as clock from './clock.js';
import { getPeriodLabel, formatAdjustment } from './format.js';

/** Default values for a game that has not been set up yet. */
const DEFAULT_PERIOD_LENGTH_MS = 40 * 60000;
const MAX_PERIODS = 8;

/** Statuses a game moves through (AGENTS.md section 4). */
export const STATUS = Object.freeze({
    IDLE: 'idle',
    READY: 'ready',
    RUNNING: 'running',
    PAUSED: 'paused',
    BETWEEN_PERIODS: 'between_periods',
    FINAL: 'final'
});

/** A game with nothing set up. */
export function createGame() {
    return {
        id: null,
        writeToken: null,
        status: STATUS.IDLE,
        home: { name: 'Us', color: '#ef4444' },
        away: { name: 'Them', color: '#3b82f6' },
        periodCount: 2,
        regulationPeriods: 2,
        currentPeriod: 1,
        periodLengthMs: DEFAULT_PERIOD_LENGTH_MS,
        overageAcknowledged: false,
        events: [],
        visibility: 'public',
        startedAt: null,
        endedBy: null,
        sync: { lastSentRev: 0, lastAckRev: 0 }
    };
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/** Goals for each team, counted from the event log. */
export function getScores(game) {
    const scores = { home: 0, away: 0 };
    game.events.forEach((event) => {
        if (event.type === 'score' && (event.teamId === 'home' || event.teamId === 'away')) {
            scores[event.teamId] += 1;
        }
    });
    return scores;
}

/** True once the first Start created the game on the server. */
export function isCommitted(game) {
    return game.startedAt !== null;
}

/** Scoring and cards are only allowed while the clock runs. */
export function canScore(game) {
    return game.status === STATUS.RUNNING;
}

/** Status sent to the server. */
export function serverStatus(game) {
    return game.status === STATUS.FINAL ? 'final' : 'live';
}

/** Whether the current period has had its first Start. */
function periodHasStarted(game, period = game.currentPeriod) {
    return clock.getPeriodClock(game.events, period).recordedStart !== null;
}

/** Whether the given period has an end event. */
function periodHasEnded(game, period = game.currentPeriod) {
    return clock.getPeriodClock(game.events, period).end !== null;
}

/** Clock reading of the current period (counts up from 0:00), never negative. */
export function getElapsed(game, now) {
    return clock.getElapsed(game.events, game.currentPeriod, now);
}

/** Time left in the current period; negative in overage. */
export function getRemaining(game, now) {
    return game.periodLengthMs - getElapsed(game, now);
}

/** True when a running clock has reached the period length and overage was not acknowledged. */
export function needsExpiry(game, now) {
    return game.status === STATUS.RUNNING
        && !game.overageAcknowledged
        && getElapsed(game, now) >= game.periodLengthMs;
}

/** True when the period length can still be changed (the current period has not started). */
export function canChangePeriodLength(game) {
    return (game.status === STATUS.READY || game.status === STATUS.BETWEEN_PERIODS)
        && !periodHasStarted(game);
}

/** User-facing label for a period of this game. */
export function periodLabel(game, period = game.currentPeriod) {
    return getPeriodLabel(period, game.periodCount, game.regulationPeriods);
}

// ---------------------------------------------------------------------------
// Event builders
// ---------------------------------------------------------------------------

function toIso(at) {
    return new Date(at).toISOString();
}

/** Build a clock event (history entry of type 'event'). */
function clockEvent(game, eventType, action, details = {}) {
    const period = details.period !== undefined ? details.period : game.currentPeriod;
    const label = getPeriodLabel(period, game.periodCount, game.regulationPeriods);
    const qualifier = details.qualifier || null;
    const names = { period_start: 'Start', paused: 'Paused', resumed: 'Resumed', period_end: 'End' };
    let text;
    if (eventType === 'clock_adjust') {
        text = `${label} - Clock ${formatAdjustment(details.deltaMs)}`;
    } else {
        const suffix = qualifier === 'score' ? ' (Score)' : (qualifier === 'final' ? ' (Final)' : '');
        text = `${label} - ${names[eventType]}${suffix}`;
    }
    const event = {
        id: action.id,
        type: 'event',
        eventType,
        period,
        qualifier,
        endReason: details.endReason || null,
        labelVersion: 2,
        timestamp: toIso(details.at !== undefined ? details.at : action.at),
        text,
        note: ''
    };
    if (eventType === 'clock_adjust') event.deltaMs = details.deltaMs;
    return event;
}

/** Copy of a period_end event marked as the end of the game. */
function markFinalEnd(game, event) {
    const label = getPeriodLabel(event.period, game.periodCount, game.regulationPeriods);
    return { ...event, qualifier: 'final', labelVersion: 2, text: `${label} - End (Final)` };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

const reject = (error) => ({ error });
const accept = (game) => ({ game });

/** Options the clock checks need, taken from the game. */
function clockOptions(game, at) {
    return {
        now: at,
        periodLengthMs: game.periodLengthMs,
        overageAcknowledged: game.overageAcknowledged,
        status: game.status
    };
}

function sanitizeTeam(current, update) {
    if (!update) return current;
    const name = typeof update.name === 'string' ? update.name.trim() : '';
    return { name: name || current.name, color: update.color || current.color };
}

/**
 * Apply an action. Returns { game } on success or { error } with a message for the operator.
 * Statuses and rules follow the table in AGENTS.md section 4.
 */
function apply(game, action) {
    const status = game.status;

    switch (action.type) {
        case 'new_game': {
            if (!(action.periodLengthMs > 0)) return reject('Period length must be more than 0:00');
            const periodCount = Math.min(MAX_PERIODS, Math.max(1, Number(action.periodCount) || 2));
            return accept({
                ...createGame(),
                id: action.gameId,
                writeToken: action.writeToken,
                status: STATUS.READY,
                home: sanitizeTeam(game.home, action.home),
                away: sanitizeTeam(game.away, action.away),
                periodCount,
                regulationPeriods: periodCount,
                periodLengthMs: action.periodLengthMs,
                visibility: action.visibility || game.visibility
            });
        }

        case 'edit_match': {
            if (![STATUS.READY, STATUS.PAUSED, STATUS.BETWEEN_PERIODS].includes(status)) {
                return reject('The match cannot be edited right now');
            }
            const next = { ...game, home: sanitizeTeam(game.home, action.home), away: sanitizeTeam(game.away, action.away) };
            if (action.periodCount !== undefined) {
                const count = Math.min(MAX_PERIODS, Math.max(game.currentPeriod, Number(action.periodCount) || game.periodCount));
                next.periodCount = count;
                // Before the first Start the regulation count follows the chosen count
                if (!isCommitted(game)) next.regulationPeriods = count;
            }
            if (action.periodLengthMs !== undefined && action.periodLengthMs !== game.periodLengthMs) {
                if (!(action.periodLengthMs > 0)) return reject('Period length must be more than 0:00');
                if (!canChangePeriodLength(game)) return reject('The period length can only change before the period starts');
                next.periodLengthMs = action.periodLengthMs;
            }
            return accept(next);
        }

        case 'start': {
            if (status !== STATUS.READY && status !== STATUS.BETWEEN_PERIODS) return reject('The game cannot be started now');
            const next = {
                ...game,
                status: STATUS.RUNNING,
                startedAt: game.startedAt || toIso(action.at),
                events: [...game.events, clockEvent(game, 'period_start', action)]
            };
            return accept(next);
        }

        case 'pause': {
            if (status !== STATUS.RUNNING) return reject('The clock is not running');
            const event = clockEvent(game, 'paused', action, { qualifier: action.qualifier });
            return accept({ ...game, status: STATUS.PAUSED, events: [...game.events, event] });
        }

        case 'resume': {
            if (status !== STATUS.PAUSED) return reject('The clock is not paused');
            const current = clock.getPeriodClock(game.events, game.currentPeriod);
            if (current.end !== null) {
                // The period already ended on time: continue in overage. The end entry is replaced by a
                // pause at that moment followed by the resume, and overage is acknowledged.
                const endEvent = [...game.events].reverse()
                    .find((e) => e.type === 'event' && e.eventType === 'period_end' && Number(e.period) === game.currentPeriod);
                const pause = clockEvent(game, 'paused', { id: action.pauseId }, { at: current.end });
                const resume = clockEvent(game, 'resumed', action);
                return accept({
                    ...game,
                    status: STATUS.RUNNING,
                    overageAcknowledged: true,
                    events: [...game.events.filter((e) => e !== endEvent), pause, resume]
                });
            }
            return accept({ ...game, status: STATUS.RUNNING, events: [...game.events, clockEvent(game, 'resumed', action)] });
        }

        case 'score': {
            if (!canScore(game)) return reject('Clock is stopped');
            if (action.teamId !== 'home' && action.teamId !== 'away') return reject('Unknown team');
            const event = { id: action.id, type: 'score', period: game.currentPeriod, teamId: action.teamId, timestamp: toIso(action.at), note: '' };
            return accept({ ...game, events: [...game.events, event] });
        }

        case 'card': {
            if (!canScore(game)) return reject('Clock is stopped');
            if (action.teamId !== 'home' && action.teamId !== 'away') return reject('Unknown team');
            if (action.cardType !== 'yellow' && action.cardType !== 'red') return reject('Unknown card');
            const event = {
                id: action.id, type: 'card', period: game.currentPeriod, teamId: action.teamId,
                cardType: action.cardType, timestamp: toIso(action.at), note: ''
            };
            return accept({ ...game, events: [...game.events, event] });
        }

        case 'add_note': {
            const index = game.events.findIndex((e) => e.id === action.id);
            if (index < 0) return reject('Entry not found');
            const events = game.events.slice();
            events[index] = { ...events[index], note: String(action.note || '') };
            return accept({ ...game, events });
        }

        case 'adjust_clock': {
            const delta = Number(action.deltaMs);
            if (!delta || delta % 60000 !== 0) return reject('Corrections are whole minutes');
            const check = clock.validateAdjustment(game.events, game.currentPeriod, delta, clockOptions(game, action.at));
            if (!check.ok) return reject(check.message);
            const event = clockEvent(game, 'clock_adjust', action, { deltaMs: delta });
            return accept({ ...game, events: [...game.events, event] });
        }

        case 'acknowledge_overage': {
            if (status !== STATUS.RUNNING && status !== STATUS.PAUSED) return reject('No period is in progress');
            return accept({ ...game, overageAcknowledged: true });
        }

        case 'remove_event':
            return removeEvent(game, action);

        case 'end_period': {
            if (status !== STATUS.RUNNING && status !== STATUS.PAUSED) return reject('No period is in progress');
            if (periodHasEnded(game)) return reject('The period has already ended');
            const reason = action.reason || 'manual';
            // An ending caused by time is recorded at the moment the period reached its length
            let endAt = action.at;
            if (reason === 'time' || reason === 'drift') {
                const expiry = clock.getExpiryTime(game.events, game.currentPeriod, game.periodLengthMs);
                if (expiry !== null) endAt = Math.min(expiry, action.at);
            }
            const event = clockEvent(game, 'period_end', action, { at: endAt, endReason: reason });
            const events = [...game.events, event];
            if (game.currentPeriod < game.periodCount) {
                return accept({
                    ...game, events, currentPeriod: game.currentPeriod + 1,
                    status: STATUS.BETWEEN_PERIODS, overageAcknowledged: false
                });
            }
            // The last period ended: the operator chooses Finalize or Add Overtime
            return accept({ ...game, events, status: STATUS.PAUSED });
        }

        case 'add_overtime': {
            if (status !== STATUS.PAUSED && status !== STATUS.BETWEEN_PERIODS) return reject('Overtime cannot be added now');
            if (!(action.periodLengthMs > 0)) return reject('Period length must be more than 0:00');
            let events = game.events;
            if (periodHasStarted(game) && !periodHasEnded(game)) {
                events = [...events, clockEvent(game, 'period_end', { id: action.endId, at: action.at }, { endReason: 'manual' })];
            }
            const currentPeriod = game.currentPeriod + 1;
            return accept({
                ...game, events, currentPeriod,
                periodCount: Math.max(game.periodCount, currentPeriod),
                periodLengthMs: action.periodLengthMs,
                status: STATUS.BETWEEN_PERIODS,
                overageAcknowledged: false
            });
        }

        case 'finalize': {
            if (![STATUS.RUNNING, STATUS.PAUSED, STATUS.BETWEEN_PERIODS].includes(status)) return reject('The game cannot be finalized now');
            if (!isCommitted(game)) return reject('The game has not started');
            let events = game.events;
            const started = periodHasStarted(game);
            const ended = periodHasEnded(game);
            const lastEndIndex = lastIndexOf(events, (e) => e.type === 'event' && e.eventType === 'period_end');
            if (started && ended) {
                const index = lastIndexOf(events, (e) => e.type === 'event' && e.eventType === 'period_end' && Number(e.period) === game.currentPeriod);
                events = events.slice();
                events[index] = markFinalEnd(game, events[index]);
            } else if (started) {
                events = [...events, clockEvent(game, 'period_end', action, { qualifier: 'final', endReason: 'final' })];
            } else if (lastEndIndex >= 0) {
                events = events.slice();
                events[lastEndIndex] = markFinalEnd(game, events[lastEndIndex]);
            } else {
                events = [...events, clockEvent(game, 'period_end', action, { qualifier: 'final', endReason: 'final' })];
            }
            return accept({ ...game, events, status: STATUS.FINAL, endedBy: action.endedBy || 'user' });
        }

        case 'set_visibility': {
            if (action.visibility !== 'public' && action.visibility !== 'private') return reject('Unknown visibility');
            return accept({ ...game, visibility: action.visibility });
        }

        case 'sync_state':
            return accept({
                ...game,
                sync: {
                    lastSentRev: action.lastSentRev !== undefined ? action.lastSentRev : game.sync.lastSentRev,
                    lastAckRev: action.lastAckRev !== undefined ? action.lastAckRev : game.sync.lastAckRev
                }
            });

        case 'server_final': {
            // The server reports the game as ended (or deleted): follow it without adding history
            if (status === STATUS.FINAL) return accept(game);
            return accept({ ...game, status: STATUS.FINAL, endedBy: action.endedBy || game.endedBy || 'user' });
        }

        default:
            return reject(`Unknown action: ${action.type}`);
    }
}

function lastIndexOf(list, predicate) {
    for (let i = list.length - 1; i >= 0; i--) {
        if (predicate(list[i])) return i;
    }
    return -1;
}

/** Remove a history entry, following the removal rules in AGENTS.md section 4. */
function removeEvent(game, action) {
    const index = game.events.findIndex((e) => e.id === action.id);
    if (index < 0) return reject('Entry not found');
    const entry = game.events[index];
    const without = game.events.filter((_, i) => i !== index);

    if (entry.type === 'score' || entry.type === 'card') {
        return accept({ ...game, events: without });
    }

    if (entry.type === 'event' && entry.eventType === 'clock_adjust') {
        const check = clock.validateAdjustmentRemoval(game.events, entry.period, entry.id, clockOptions(game, action.at));
        if (!check.ok) return reject(check.message);
        return accept({ ...game, events: without });
    }

    if (entry.type === 'event' && entry.eventType === 'period_end') {
        if (game.status === STATUS.FINAL) return reject('The period end cannot be removed after the game is final');
        if (index !== game.events.length - 1) return reject('Only the latest period end can be removed');
        // Return to that period, paused at the moment it ended
        const period = Number(entry.period);
        const pause = clockEvent({ ...game, currentPeriod: period }, 'paused', { id: action.pauseId }, { at: Date.parse(entry.timestamp), period });
        const events = [...without, pause];
        const endedPosition = clock.getPosition(events, period, Date.parse(entry.timestamp));
        return accept({
            ...game,
            events,
            currentPeriod: period,
            status: STATUS.PAUSED,
            overageAcknowledged: endedPosition >= game.periodLengthMs
        });
    }

    return reject('This entry cannot be removed');
}

/**
 * Apply an action and return the new game. A rejected action returns the same game object.
 *
 * @param {Object} game
 * @param {{type: string}} action
 * @returns {Object}
 */
export function reduce(game, action) {
    const result = apply(game, action);
    return result.error ? game : result.game;
}

/**
 * The message explaining why an action is not allowed right now, or null when it is.
 * Use before dispatching to show the operator a reason.
 *
 * @param {Object} game
 * @param {{type: string}} action
 * @returns {string|null}
 */
export function explain(game, action) {
    const result = apply(game, action);
    return result.error || null;
}
