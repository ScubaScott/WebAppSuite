// Tests for js/snapshot.js: the snapshot of a converted saved game must match what the old console sent.
// Run from htdocs/ScoreBoard: node --test tests/snapshot.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migrateGame } from '../js/migrate.js';
import { reduce, createGame } from '../js/state.js';
import { toSnapshot, buildSyncPayload, fingerprint, statusKey, buildHistory } from '../js/snapshot.js';

const load = (name) => JSON.parse(readFileSync(new URL(`../docs/${name}`, import.meta.url), 'utf8'));
let counter = 0;
const newId = () => `s${++counter}`;
const convert = (record) => migrateGame(record, { newId }).game;
const prefs = (saved) => ({ logPauseResume: saved.logPauseResume, logPeriodStartStop: saved.logPeriodStartStop });

// The fields the old console put in the snapshot that the server and viewer read
function oldSnapshot(saved, now) {
    return {
        homeTeamName: saved.homeTeamName,
        awayTeamName: saved.awayTeamName,
        homeScore: saved.homeScore,
        awayScore: saved.awayScore,
        currentPeriod: saved.currentPeriod,
        totalPeriods: saved.totalPeriods,
        basePeriods: saved.basePeriods,
        timerRunning: saved.running,
        timeLimit: saved.timeLimit,
        elapsedMs: saved.accumulatedTime + (saved.startTime ? now - saved.startTime : 0),
        startedAt: saved.activeGameStartedAt,
        homeTeamColor: saved.homeTeamColor,
        awayTeamColor: saved.awayTeamColor
    };
}

test('a running game produces the same snapshot fields as the old console', () => {
    const saved = load('timerStateV7_Running.json');
    const now = saved.startTime + 90000;
    const snapshot = toSnapshot(convert(saved), now, prefs(saved));
    const expected = oldSnapshot(saved, now);
    Object.keys(expected).forEach((key) => assert.deepEqual(snapshot[key], expected[key], key));
    assert.equal(snapshot.isPaused, false);
});

test('a finished game produces the same snapshot fields as the old console', () => {
    const saved = load('timerStateV7_Finalized.json');
    const snapshot = toSnapshot(convert(saved), Date.now(), prefs(saved));
    const expected = oldSnapshot(saved, Date.now());
    Object.keys(expected).forEach((key) => assert.deepEqual(snapshot[key], expected[key], key));
    // A final game is not "paused" any more; viewers check the final status first
    assert.equal(snapshot.isPaused, false);
    assert.equal(snapshot.timerRunning, false);
});

test('history rows keep every field the old console stored', () => {
    ['timerStateV7_Finalized.json', 'timerStateV7_Running.json'].forEach((name) => {
        const saved = load(name);
        const rows = toSnapshot(convert(saved), Date.now(), prefs(saved)).scoreHistory;
        assert.equal(rows.length, saved.scoreHistory.length, name);
        saved.scoreHistory.forEach((original, index) => {
            Object.keys(original).forEach((key) => {
                // The rebuilt start entry of a game in progress has a new id and time
                if (name.includes('Running') && original.eventType === 'period_start' && ['id', 'timestamp'].includes(key)) return;
                assert.deepEqual(rows[index][key], original[key], `${name} row ${index} ${key}`);
            });
        });
    });
});

test('running tallies and team names follow the current game', () => {
    const saved = load('timerStateV7_Running.json');
    let game = convert(saved);
    const at = saved.lastSavedAt + 1000;
    game = reduce(game, { type: 'score', at, id: 'g2', teamId: 'away' });
    game = reduce(game, { type: 'score', at: at + 1000, id: 'g3', teamId: 'away' });
    // Remove the first goal: the later rows are re-tallied, and rows follow a renamed team
    const firstGoal = game.events.find((e) => e.type === 'score');
    game = reduce(game, { type: 'remove_event', id: firstGoal.id, at: at + 2000 });
    game = reduce(game, { type: 'pause', at: at + 3000, id: 'p1' });
    game = reduce(game, { type: 'edit_match', away: { name: 'Hawks' } });
    const rows = buildHistory(game, prefs(saved)).filter((r) => r.type === 'score');
    assert.deepEqual(rows.map((r) => r.currentScore), ['0-1', '0-2']);
    assert.equal(rows[0].teamName, 'Hawks');
});

test('new entries get their position from the event times', () => {
    let game = createGame();
    const at = Date.parse('2026-10-26T17:00:00');
    game = reduce(game, { type: 'new_game', gameId: 'g', writeToken: 't', at, periodCount: 2, periodLengthMs: 2400000 });
    game = reduce(game, { type: 'start', at, id: 'a' });
    game = reduce(game, { type: 'score', at: at + 4 * 60000, id: 'b', teamId: 'home' });
    game = reduce(game, { type: 'adjust_clock', at: at + 5 * 60000, id: 'c', deltaMs: 60000 });
    const goal = toSnapshot(game, at + 6 * 60000, { logPeriodStartStop: true }).scoreHistory.find((r) => r.type === 'score');
    assert.equal(goal.periodElapsedMs, 5 * 60000);
    assert.equal(goal.gameTime, 'P1: 05:00.0');
    assert.equal(goal.currentScore, '1-0');
});

test('pause and start rows are left out when the operator turned them off', () => {
    let game = createGame();
    const at = Date.parse('2026-10-26T17:00:00');
    game = reduce(game, { type: 'new_game', gameId: 'g', writeToken: 't', at, periodCount: 2, periodLengthMs: 2400000 });
    game = reduce(game, { type: 'start', at, id: 'a' });
    game = reduce(game, { type: 'pause', at: at + 60000, id: 'b' });
    const hidden = buildHistory(game, { logPauseResume: false, logPeriodStartStop: false });
    assert.equal(hidden.length, 0);
    const shown = buildHistory(game, { logPauseResume: true, logPeriodStartStop: true });
    assert.equal(shown.length, 2);
});

test('the payload carries the revision, status and (for a beacon) the token', () => {
    const game = convert(load('timerStateV7_Running.json'));
    const payload = buildSyncPayload(game, { rev: 8, now: Date.now(), prefs: {} });
    assert.equal(payload.rev, 8);
    assert.equal(payload.status, 'live');
    assert.equal(payload.ended_by, null);
    assert.equal(payload.token, undefined);
    assert.equal(buildSyncPayload(game, { rev: 9, now: 0, prefs: {}, token: 'abc' }).token, 'abc');
    const final = convert(load('timerStateV7_Finalized.json'));
    const finalPayload = buildSyncPayload(final, { rev: 21, now: 0, prefs: {} });
    assert.equal(finalPayload.status, 'final');
    assert.equal(finalPayload.ended_by, 'user');
});

test('the fingerprint ignores the clock but sees real changes', () => {
    const game = convert(load('timerStateV7_Running.json'));
    assert.equal(fingerprint(game), fingerprint(game));
    const scored = reduce(game, { type: 'score', at: Date.now(), id: 'x', teamId: 'away' });
    assert.notEqual(fingerprint(scored), fingerprint(game));
    const paused = reduce(game, { type: 'pause', at: Date.now(), id: 'y' });
    assert.notEqual(statusKey(paused), statusKey(game));
    assert.equal(statusKey(scored), statusKey(game));
});

test('the start row shows the corrected start time', () => {
    let game = createGame();
    const at = Date.parse('2026-10-26T17:01:00');
    game = reduce(game, { type: 'new_game', gameId: 'g', writeToken: 't', at, periodCount: 2, periodLengthMs: 2400000 });
    game = reduce(game, { type: 'start', at, id: 'a' });
    game = reduce(game, { type: 'adjust_clock', at: at + 60000, id: 'b', deltaMs: 60000 });
    const rows = buildHistory(game, { logPeriodStartStop: true });
    const start = rows.find((r) => r.eventType === 'period_start');
    assert.equal(start.timestamp, new Date(Date.parse('2026-10-26T17:00:00')).toISOString());
    assert.equal(start.adjustedMs, 60000);
});

test('pause, resume and end rows of new entries carry their position; old entries do not', () => {
    let game = createGame();
    const at = Date.parse('2026-10-26T17:00:00');
    game = reduce(game, { type: 'new_game', gameId: 'g', writeToken: 't', at, periodCount: 2, periodLengthMs: 2400000 });
    game = reduce(game, { type: 'start', at, id: 'a' });
    game = reduce(game, { type: 'pause', at: at + 13 * 60000, id: 'b' });
    game = reduce(game, { type: 'resume', at: at + 15 * 60000, id: 'c', pauseId: 'x' });
    game = reduce(game, { type: 'end_period', at: at + 30 * 60000, id: 'd', reason: 'manual' });
    const rows = buildHistory(game, { logPauseResume: true, logPeriodStartStop: true });
    const byType = (type) => rows.find((r) => r.eventType === type);
    assert.equal(byType('paused').positionMs, 13 * 60000);
    assert.equal(byType('resumed').positionMs, 13 * 60000);
    assert.equal(byType('period_end').positionMs, 28 * 60000);
    assert.equal(byType('period_start').positionMs, undefined);

    // An entry recorded by an earlier version keeps its stored position and shows its clock time
    const old = convert(load('timerStateV7_Finalized.json'));
    const oldEnd = buildHistory(old, {}).filter((r) => r.eventType === 'period_end').pop();
    assert.equal(oldEnd.positionMs, undefined);
    assert.equal(oldEnd.periodElapsedMs, 5999);
});

test('a corrected start row keeps the time that was pressed', () => {
    let game = createGame();
    const at = Date.parse('2026-10-26T17:01:00');
    game = reduce(game, { type: 'new_game', gameId: 'g', writeToken: 't', at, periodCount: 2, periodLengthMs: 2400000 });
    game = reduce(game, { type: 'start', at, id: 'a' });
    game = reduce(game, { type: 'adjust_clock', at: at + 60000, id: 'b', deltaMs: 60000 });
    const start = buildHistory(game, { logPeriodStartStop: true }).find((r) => r.eventType === 'period_start');
    assert.equal(start.recordedTimestamp, new Date(at).toISOString());
});
