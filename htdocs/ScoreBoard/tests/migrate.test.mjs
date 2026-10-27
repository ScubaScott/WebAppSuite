// Tests for js/migrate.js using saved games from docs/ and constructed records.
// Run from htdocs/ScoreBoard: node --test tests/migrate.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migrateGame, isGameObject } from '../js/migrate.js';
import { STATUS, getScores, isCommitted, periodLabel, reduce, explain, getElapsed } from '../js/state.js';

const load = (name) => JSON.parse(readFileSync(new URL(`../docs/${name}`, import.meta.url), 'utf8'));
let counter = 0;
const newId = () => `m${++counter}`;
const migrate = (record, now) => migrateGame(record, { newId, now });

test('a running game keeps its scores, identity, period and clock', () => {
    const saved = load('timerStateV7_Running.json');
    const { game, converted } = migrate(saved);
    assert.equal(converted, true);
    assert.equal(game.status, STATUS.RUNNING);
    assert.equal(game.id, saved.activeGameId);
    assert.equal(game.writeToken, saved.activeGameWriteToken);
    assert.equal(game.currentPeriod, 1);
    assert.equal(game.periodCount, 2);
    assert.equal(game.periodLengthMs, 2400000);
    assert.deepEqual(getScores(game), { home: 1, away: 0 });
    assert.equal(game.home.name, 'pre-test');
    assert.equal(game.away.color, '#10b981');
    assert.equal(isCommitted(game), true);
    assert.equal(game.sync.lastAckRev, 7);
    // The clock reads what the old clock read: accumulated + (now - startTime)
    const now = saved.startTime + 123456;
    assert.equal(getElapsed(game, now), saved.accumulatedTime + (now - saved.startTime));
});

test('the running game keeps its history entries and their stored positions', () => {
    const saved = load('timerStateV7_Running.json');
    const { game } = migrate(saved);
    // The old start entry is replaced by a rebuilt one, so the count is unchanged
    assert.equal(game.events.length, saved.scoreHistory.length);
    const goal = game.events.find((e) => e.type === 'score');
    assert.equal(goal.periodElapsedMs, 21427);
    assert.equal(goal.teamName, undefined);
    assert.equal(goal.teamId, 'home');
    assert.equal(game.events[0].eventType, 'period_start');
});

test('a finished game stays final and shows its stored end position', () => {
    const saved = load('timerStateV7_Finalized.json');
    const { game } = migrate(saved);
    assert.equal(game.status, STATUS.FINAL);
    assert.equal(game.endedBy, 'user');
    assert.equal(game.currentPeriod, 2);
    assert.deepEqual(getScores(game), { home: 1, away: 2 });
    assert.equal(game.events.length, saved.scoreHistory.length);
    // The old end entry stored 5999 ms even though 8.8 s passed in real time (a pause was not logged)
    assert.equal(getElapsed(game, Date.now()), 5999);
    assert.equal(game.startedAt, saved.activeGameStartedAt);
});

test('a finished game still accepts the edits a final game allows', () => {
    const { game } = migrate(load('timerStateV7_Finalized.json'));
    const goal = game.events.find((e) => e.type === 'score');
    assert.equal(explain(game, { type: 'add_note', id: goal.id, note: 'x' }), null);
    assert.deepEqual(getScores(reduce(game, { type: 'remove_event', id: goal.id, at: Date.now() })), { home: 0, away: 2 });
});

test('a paused game gets a start and a pause that freeze the clock at the saved value', () => {
    const saved = { ...load('timerStateV7_Running.json'), running: false, startTime: null, accumulatedTime: 600000,
        matchState: 'paused', isPaused: true, lastStopReason: 'pause', lastSavedAt: 1793048500000 };
    const { game } = migrate(saved);
    assert.equal(game.status, STATUS.PAUSED);
    assert.equal(getElapsed(game, saved.lastSavedAt + 5 * 60000), 600000);
    assert.equal(game.events.at(-1).eventType, 'paused');
    const resumed = reduce(game, { type: 'resume', at: saved.lastSavedAt + 60000, id: 'r1', pauseId: 'p1' });
    assert.equal(getElapsed(resumed, saved.lastSavedAt + 120000), 660000);
});

test('a score pause is migrated as a score pause', () => {
    const saved = { ...load('timerStateV7_Running.json'), running: false, startTime: null, accumulatedTime: 1000,
        matchState: 'paused', lastStopReason: 'score', lastSavedAt: 1793048000000 };
    assert.equal(migrate(saved).game.events.at(-1).qualifier, 'score');
});

test('a final period that expired waits for Finalize or Add Overtime', () => {
    const saved = { ...load('timerStateV7_Running.json'), currentPeriod: 2, running: false, startTime: null,
        accumulatedTime: 2400000, matchState: 'paused', lastStopReason: 'expiry', lastSavedAt: 1793050000000 };
    const { game } = migrate(saved);
    assert.equal(game.status, STATUS.PAUSED);
    assert.equal(game.events.at(-1).eventType, 'period_end');
    assert.equal(getElapsed(game, Date.now()), 2400000);
    const ot = reduce(game, { type: 'add_overtime', at: 1793050100000, id: 'a', endId: 'b', periodLengthMs: 600000 });
    assert.equal(periodLabel(ot), 'OT');
});

test('between periods and draft games have no clock to rebuild', () => {
    const between = { ...load('timerStateV7_Running.json'), currentPeriod: 2, running: false, startTime: null,
        accumulatedTime: 0, matchState: 'ready', periodStartTimeUtc: null };
    assert.equal(migrate(between).game.status, STATUS.BETWEEN_PERIODS);
    const draft = { ...load('timerStateV7_Running.json'), gameLifecycle: 'draft', gameCommitted: false, matchState: 'ready',
        scoreHistory: [], running: false, startTime: null, accumulatedTime: 0 };
    const converted = migrate(draft).game;
    assert.equal(converted.status, STATUS.READY);
    assert.equal(isCommitted(converted), false);
});

test('an empty saved record becomes an idle game with the saved defaults', () => {
    const { game } = migrate({ gameLifecycle: 'idle', homeTeamName: 'Eagles', timeLimit: 1200000 });
    assert.equal(game.status, STATUS.IDLE);
    assert.equal(game.home.name, 'Eagles');
    assert.equal(game.periodLengthMs, 1200000);
    assert.equal(game.id, null);
});

test('old red/blue field names and card degrees are understood', () => {
    const saved = { gameLifecycle: 'final', redTeamName: 'R', blueTeamName: 'B', redTeamColor: '#111111', blueTeamColor: '#222222',
        totalPeriods: 2, basePeriods: 2, currentPeriod: 1, activeGameId: 'g', activeGameWriteToken: 't',
        scoreHistory: [{ id: 'c', teamId: 'home', degree: 'Yellow Card', teamName: 'R', timestamp: '2026-10-26T20:00:00.000Z', type: 'card' }] };
    const { game } = migrate(saved);
    assert.equal(game.home.name, 'R');
    assert.equal(game.away.color, '#222222');
    assert.equal(game.events[0].cardType, 'yellow');
});

test('a current-format game passes through unchanged', () => {
    const { game } = migrate(load('timerStateV7_Running.json'));
    assert.equal(isGameObject(game), true);
    const again = migrateGame(game, { newId });
    assert.equal(again.converted, false);
    assert.equal(again.game, game);
});
