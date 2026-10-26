/**
 * ScoreBoard migration: converts a game saved by earlier versions (the flat record with `scoreHistory`,
 * `accumulatedTime`, `gameLifecycle`, ...) into the current `game` object (js/state.js).
 * Pure: takes the saved object, returns a new object. The only names from the old format live here.
 *
 * Positions recorded by the old format stay on their entries (`periodElapsedMs`, `gameTime`) and are shown
 * as they were; see docs/TIMING-SPEC.md section 8.
 */

import { STATUS, createGame } from './state.js';
import { getPeriodLabel } from './format.js';

/** True when the object is already a current-format game. */
export function isGameObject(record) {
    return !!record && typeof record === 'object' && Array.isArray(record.events) && typeof record.status === 'string';
}

const DEFAULT_PERIOD_LENGTH_MS = 40 * 60000;

/** Pick the first value that is defined. */
function firstDefined(...values) {
    return values.find((value) => value !== undefined && value !== null);
}

/** Derive the lifecycle of a record that predates `gameLifecycle` (see the old load code). */
function legacyLifecycle(record) {
    if (record.gameLifecycle !== undefined) return record.gameLifecycle;
    if (record.activeGameEnded) return 'final';
    if (record.activeGameStarted) {
        const history = Array.isArray(record.scoreHistory) ? record.scoreHistory : [];
        const clockHasRun = !!record.periodStartTimeUtc
            || (record.accumulatedTime && record.accumulatedTime > 0)
            || history.some((entry) => entry.eventType === 'period_start');
        return clockHasRun ? 'live' : 'draft';
    }
    return 'idle';
}

/** Convert one old history entry. Score and card entries drop the copied team data (looked up at render time). */
function convertEntry(entry) {
    const type = entry.type || (entry.teamId ? 'score' : 'event');
    const copy = { ...entry, type };
    if (type === 'score' || type === 'card') {
        delete copy.teamName;
        delete copy.teamColor;
        delete copy.currentScore;
        if (type === 'card' && !copy.cardType) {
            copy.cardType = String(copy.degree || '').toLowerCase().includes('yellow') ? 'yellow' : 'red';
        }
        delete copy.degree;
        copy.note = copy.note || '';
    }
    return copy;
}

/** A clock event in the current shape, for the entries the migration synthesizes. */
function syntheticEvent(game, eventType, id, at, details = {}) {
    const period = game.currentPeriod;
    const label = getPeriodLabel(period, game.periodCount, game.regulationPeriods);
    const names = { period_start: 'Start', paused: 'Paused', period_end: 'End' };
    const suffix = details.qualifier === 'score' ? ' (Score)' : '';
    return {
        id,
        type: 'event',
        eventType,
        period,
        qualifier: details.qualifier || null,
        endReason: details.endReason || null,
        labelVersion: 2,
        timestamp: new Date(at).toISOString(),
        text: `${label} - ${names[eventType]}${suffix}`,
        note: ''
    };
}

/**
 * Convert a saved record to a game.
 *
 * @param {Object} record The saved object (old flat record, or a current game).
 * @param {{newId: function(): string, now?: number}} options `newId` supplies ids for synthesized entries.
 * @returns {{game: Object, converted: boolean}} `converted` is false when the record was already current.
 */
export function migrateGame(record, options) {
    if (isGameObject(record)) return { game: record, converted: false };
    const newId = options.newId;
    const now = options.now !== undefined ? options.now : Date.now();
    const saved = record || {};

    const lifecycle = legacyLifecycle(saved);
    const game = createGame();

    game.home = {
        name: firstDefined(saved.homeTeamName, saved.redTeamName, game.home.name),
        color: firstDefined(saved.homeTeamColor, saved.redTeamColor, game.home.color)
    };
    game.away = {
        name: firstDefined(saved.awayTeamName, saved.blueTeamName, game.away.name),
        color: firstDefined(saved.awayTeamColor, saved.blueTeamColor, game.away.color)
    };
    game.periodCount = saved.totalPeriods || 2;
    game.regulationPeriods = saved.basePeriods || saved.totalPeriods || 2;
    game.currentPeriod = saved.currentPeriod || 1;
    game.periodLengthMs = saved.timeLimit !== undefined && saved.timeLimit > 0 ? saved.timeLimit : DEFAULT_PERIOD_LENGTH_MS;
    game.overageAcknowledged = !!saved.overageResolvedForCurrentPeriod;
    game.visibility = saved.activeGameVisibility === 'private' ? 'private' : 'public';

    if (lifecycle === 'idle') {
        return { game, converted: true };
    }

    game.id = saved.activeGameId || null;
    game.writeToken = saved.activeGameWriteToken || null;
    const rev = saved.activeGameRev || 0;
    game.sync = { lastSentRev: rev, lastAckRev: rev };
    game.events = (Array.isArray(saved.scoreHistory) ? saved.scoreHistory : []).map(convertEntry);

    if (lifecycle === 'draft') {
        // Set up but never started: local only
        game.status = STATUS.READY;
        return { game, converted: true };
    }

    // From here the game has been started
    const firstEvent = game.events[0];
    game.startedAt = saved.activeGameStartedAt
        || (firstEvent && firstEvent.timestamp)
        || new Date(saved.lastSavedAt || now).toISOString();

    if (lifecycle === 'final') {
        game.status = STATUS.FINAL;
        game.endedBy = 'user';
        return { game, converted: true };
    }

    // A game in progress. Between periods (the current period has not started) there is no clock to rebuild.
    const matchState = saved.matchState || (saved.running ? 'running' : 'paused');
    if (matchState === 'ready') {
        game.status = STATUS.BETWEEN_PERIODS;
        return { game, converted: true };
    }

    // The current period is under way: rebuild its start (and pause) from the saved clock so the
    // clock reads the same as before. Earlier entries of this period keep their stored positions.
    const acc = Number(saved.accumulatedTime) || 0;
    const running = !!saved.running && matchState === 'running';
    const lastSaved = saved.lastSavedAt || now;
    const runStart = saved.startTime || saved.periodStartTimeUtc || lastSaved;
    const startAt = running ? runStart - acc : lastSaved - acc;

    // Drop this period's old start, pause and resume entries: the rebuilt start already accounts for them,
    // and keeping them would count the paused time twice
    const rebuiltTypes = ['period_start', 'paused', 'resumed'];
    game.events = game.events.filter((event) => !(event.type === 'event' && rebuiltTypes.includes(event.eventType)
        && Number(event.period) === game.currentPeriod));
    const startEvent = syntheticEvent(game, 'period_start', newId(), startAt);
    // Keep chronological order: the rebuilt start goes before this period's other entries
    const firstInPeriod = game.events.findIndex((event) => Number(event.period) === game.currentPeriod);
    if (firstInPeriod >= 0) {
        game.events.splice(firstInPeriod, 0, startEvent);
    } else {
        game.events.push(startEvent);
    }

    if (running) {
        game.status = STATUS.RUNNING;
        return { game, converted: true };
    }

    // Stopped mid-period
    const lastPeriod = game.currentPeriod >= game.periodCount;
    if (saved.lastStopReason === 'expiry' && lastPeriod && acc >= game.periodLengthMs) {
        // The final period reached its length and is waiting for Finalize or Add Overtime
        game.events.push(syntheticEvent(game, 'period_end', newId(), startAt + game.periodLengthMs, { endReason: 'time' }));
    } else {
        game.events.push(syntheticEvent(game, 'paused', newId(), lastSaved, {
            qualifier: saved.lastStopReason === 'score' ? 'score' : null
        }));
    }
    game.status = STATUS.PAUSED;
    return { game, converted: true };
}
