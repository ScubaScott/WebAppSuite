/**
 * ScoreBoard snapshot: builds the object sent to the server and read by spectators.
 * Pure functions. The field names are the contract in AGENTS.md section 6; the history entries keep the
 * shape older viewers expect (team name, running score, game time on every row).
 */

import { getPeriodClock, getPosition } from './clock.js';
import { formatClock, getPeriodLabel } from './format.js';
import { getElapsed, getScores, serverStatus, STATUS } from './state.js';

/** True for a stored finite number. */
function isNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Position of an event in its period: the stored value when an earlier version recorded one,
 * otherwise calculated from the event times.
 */
function positionOf(game, event) {
    if (isNumber(event.periodElapsedMs)) return event.periodElapsedMs;
    return Math.max(0, getPosition(game.events, event.period, Date.parse(event.timestamp)));
}

/**
 * History entries in the shape viewers read. Every row gets the text and tallies older viewers show.
 *
 * @param {Object} game
 * @param {{logPauseResume?: boolean, logPeriodStartStop?: boolean}} prefs Rows the operator chose to hide.
 */
export function buildHistory(game, prefs = {}) {
    const showPause = !!prefs.logPauseResume;
    const showStart = prefs.logPeriodStartStop === undefined ? true : !!prefs.logPeriodStartStop;
    const tally = { home: 0, away: 0 };
    const rows = [];

    game.events.forEach((event) => {
        const label = getPeriodLabel(event.period, game.periodCount, game.regulationPeriods);
        const gameTime = (ms) => `${label}: ${formatClock(ms)}`;

        if (event.type === 'score') {
            tally[event.teamId] += 1;
            const team = event.teamId === 'home' ? game.home : game.away;
            const position = positionOf(game, event);
            rows.push({
                ...event,
                periodElapsedMs: position,
                teamName: team.name,
                teamColor: team.color,
                currentScore: `${tally.home}-${tally.away}`,
                gameTime: event.gameTime || gameTime(position)
            });
        } else if (event.type === 'card') {
            const team = event.teamId === 'home' ? game.home : game.away;
            const position = positionOf(game, event);
            rows.push({
                ...event,
                periodElapsedMs: position,
                teamName: team.name,
                teamColor: team.color,
                degree: event.cardType === 'yellow' ? 'Yellow Card' : 'Red Card',
                gameTime: event.gameTime || gameTime(position)
            });
        } else if (event.eventType === 'period_end') {
            const position = isNumber(event.periodElapsedMs)
                ? event.periodElapsedMs
                : Math.max(0, getPosition(game.events, event.period, Date.parse(event.timestamp)));
            rows.push({
                ...event,
                periodLabel: event.periodLabel || label,
                scoreSnapshot: event.scoreSnapshot || `${tally.home}-${tally.away}`,
                periodElapsedMs: position,
                gameTime: event.gameTime || gameTime(position)
            });
        } else if (event.eventType === 'paused' || event.eventType === 'resumed') {
            if (showPause) rows.push({ ...event });
        } else if (event.eventType === 'period_start') {
            // After a clock correction the start row shows when play really began
            const periodClock = getPeriodClock(game.events, event.period);
            const row = { ...event };
            if (periodClock.adjustMs !== 0 && periodClock.effectiveStart !== null) {
                row.timestamp = new Date(periodClock.effectiveStart).toISOString();
                row.adjustedMs = periodClock.adjustMs;
            }
            if (showStart) rows.push(row);
        } else {
            rows.push({ ...event });
        }
    });
    return rows;
}

/**
 * The snapshot sent to the server.
 *
 * @param {Object} game
 * @param {number} now Epoch milliseconds, used for the elapsed time and a missing start time.
 * @param {{logPauseResume?: boolean, logPeriodStartStop?: boolean}} [prefs]
 */
export function toSnapshot(game, now, prefs = {}) {
    const scores = getScores(game);
    return {
        homeTeamName: game.home.name,
        awayTeamName: game.away.name,
        homeTeamColor: game.home.color,
        awayTeamColor: game.away.color,
        homeScore: scores.home,
        awayScore: scores.away,
        currentPeriod: game.currentPeriod,
        totalPeriods: game.periodCount,
        basePeriods: game.regulationPeriods,
        timerRunning: game.status === STATUS.RUNNING,
        isPaused: game.status === STATUS.PAUSED,
        // The viewer still reads this flag; the console no longer has a count-up mode
        isCountingUp: false,
        timeLimit: game.periodLengthMs,
        elapsedMs: getElapsed(game, now),
        startedAt: game.startedAt || now,
        scoreHistory: buildHistory(game, prefs)
    };
}

/** The complete sync request for one revision. */
export function buildSyncPayload(game, { rev, now, prefs, token }) {
    const payload = {
        game_id: game.id,
        write_token: game.writeToken,
        rev,
        visibility: game.visibility,
        status: serverStatus(game),
        ended_by: game.status === STATUS.FINAL ? (game.endedBy || 'user') : null,
        snapshot: toSnapshot(game, now, prefs)
    };
    // The unload beacon cannot send headers, so it carries the session token in the body
    if (token !== undefined) payload.token = token;
    return payload;
}

/** Snapshot content without the values that change every tick; equal fingerprints mean nothing new to send. */
export function fingerprint(game, prefs = {}) {
    const snapshot = toSnapshot(game, 0, prefs);
    delete snapshot.elapsedMs;
    delete snapshot.startedAt;
    return `${JSON.stringify(snapshot)}|${game.visibility}|${game.status}`;
}

/** Changes of this key must reach spectators immediately instead of waiting for the debounce. */
export function statusKey(game) {
    return `${game.status}|${game.currentPeriod}`;
}
