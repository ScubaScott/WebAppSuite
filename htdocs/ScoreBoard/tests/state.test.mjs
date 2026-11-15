// Tests for js/state.js: the status table and event rules in AGENTS.md section 4.
// Run from htdocs/ScoreBoard: node --test tests/state.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    STATUS, createGame, reduce, explain, getScores, isCommitted, canScore, serverStatus,
    getElapsed, getRemaining, needsExpiry, canChangePeriodLength, periodLabel
} from '../js/state.js';

const MIN = 60000;
const BASE = Date.parse('2026-10-26T17:00:00');
const t = (minutes) => BASE + minutes * MIN;

let counter = 0;
const id = () => `id${++counter}`;

// Apply a list of actions, requiring each to be accepted
function run(game, ...actions) {
    return actions.reduce((current, action) => {
        const reason = explain(current, action);
        assert.equal(reason, null, `${action.type} was rejected: ${reason}`);
        return reduce(current, action);
    }, game);
}

const newGame = (overrides = {}) => ({
    type: 'new_game', gameId: 'g1', writeToken: 'tok', at: t(0),
    home: { name: 'Eagles', color: '#111111' }, away: { name: 'Hawks', color: '#222222' },
    periodCount: 2, periodLengthMs: 40 * MIN, ...overrides
});
const start = (m) => ({ type: 'start', at: t(m), id: id() });
const pause = (m, qualifier) => ({ type: 'pause', at: t(m), id: id(), qualifier });
const resume = (m) => ({ type: 'resume', at: t(m), id: id(), pauseId: id() });
const score = (m, teamId = 'home') => ({ type: 'score', at: t(m), id: id(), teamId });

const ready = () => run(createGame(), newGame());

test('a new game is ready, local only, and uses the setup values', () => {
    const game = ready();
    assert.equal(game.status, STATUS.READY);
    assert.equal(game.home.name, 'Eagles');
    assert.equal(game.periodCount, 2);
    assert.equal(game.regulationPeriods, 2);
    assert.equal(isCommitted(game), false);
    assert.equal(serverStatus(game), 'live');
});

test('a new game rejects a zero-length period', () => {
    assert.equal(explain(createGame(), newGame({ periodLengthMs: 0 })), 'Period length must be more than 0:00');
});

test('Start commits the game and records the period start', () => {
    const game = run(ready(), start(1));
    assert.equal(game.status, STATUS.RUNNING);
    assert.equal(isCommitted(game), true);
    assert.equal(game.startedAt, new Date(t(1)).toISOString());
    assert.equal(game.events[0].eventType, 'period_start');
    assert.equal(game.events[0].text, 'P1 - Start');
});

test('scoring and cards work only while running', () => {
    assert.equal(explain(ready(), score(1)), 'Clock is stopped');
    const running = run(ready(), start(0));
    const scored = run(running, score(3), score(5, 'away'), score(6));
    assert.deepEqual(getScores(scored), { home: 2, away: 1 });
    const carded = run(running, { type: 'card', at: t(2), id: id(), teamId: 'away', cardType: 'yellow' });
    assert.equal(carded.events[1].cardType, 'yellow');
    const paused = run(running, pause(4));
    assert.equal(explain(paused, score(5)), 'Clock is stopped');
});

test('pause and resume move between running and paused and keep the clock right', () => {
    let game = run(ready(), start(0), pause(10));
    assert.equal(game.status, STATUS.PAUSED);
    assert.equal(getElapsed(game, t(30)), 10 * MIN);
    game = run(game, resume(15));
    assert.equal(game.status, STATUS.RUNNING);
    assert.equal(getElapsed(game, t(20)), 15 * MIN);
    assert.equal(getRemaining(game, t(20)), 25 * MIN);
});

test('a goal with pause on score records a score pause', () => {
    const game = run(ready(), start(0), score(5), pause(5, 'score'));
    assert.equal(game.events[2].qualifier, 'score');
    assert.equal(game.events[2].text, 'P1 - Paused (Score)');
});

test('pause and resume are rejected in the wrong status', () => {
    assert.equal(explain(ready(), pause(1)), 'The clock is not running');
    const running = run(ready(), start(0));
    assert.equal(explain(running, resume(1)), 'The clock is not paused');
});

test('expiry in a non-final period ends it on time and waits for the next Start', () => {
    let game = run(ready(), start(0));
    assert.equal(needsExpiry(game, t(39)), false);
    assert.equal(needsExpiry(game, t(41)), true);
    // The page noticed the expiry 2 minutes late; the end is recorded at 40:00
    game = run(game, { type: 'end_period', at: t(42), id: id(), reason: 'time' });
    assert.equal(game.status, STATUS.BETWEEN_PERIODS);
    assert.equal(game.currentPeriod, 2);
    const end = game.events.find((e) => e.eventType === 'period_end');
    assert.equal(end.timestamp, new Date(t(40)).toISOString());
    assert.equal(end.endReason, 'time');
    assert.equal(getElapsed(game, t(50)), 0);
    game = run(game, start(50));
    assert.equal(game.status, STATUS.RUNNING);
    assert.equal(getElapsed(game, t(55)), 5 * MIN);
});

test('expiry accounts for pauses', () => {
    let game = run(ready(), start(0), pause(10), resume(15));
    // Position 40:00 is reached at real time 45
    assert.equal(needsExpiry(game, t(44)), false);
    assert.equal(needsExpiry(game, t(46)), true);
    game = run(game, { type: 'end_period', at: t(46), id: id(), reason: 'time' });
    assert.equal(game.events.at(-1).timestamp, new Date(t(45)).toISOString());
});

test('manual End Period from paused moves to the next period', () => {
    const game = run(ready(), start(0), pause(10), { type: 'end_period', at: t(12), id: id(), reason: 'manual' });
    assert.equal(game.status, STATUS.BETWEEN_PERIODS);
    assert.equal(game.currentPeriod, 2);
    assert.equal(periodLabel(game), 'P2');
});

test('expiry in the final period waits for Finalize or Add Overtime', () => {
    let game = run(ready(), start(0), { type: 'end_period', at: t(10), id: id(), reason: 'manual' }, start(20));
    game = run(game, { type: 'end_period', at: t(60), id: id(), reason: 'time' });
    assert.equal(game.status, STATUS.PAUSED);
    assert.equal(game.currentPeriod, 2);
    const finalized = run(game, { type: 'finalize', at: t(61), id: id(), endedBy: 'user' });
    assert.equal(finalized.status, STATUS.FINAL);
    // The existing end entry becomes the final end; no second end is added
    const ends = finalized.events.filter((e) => e.eventType === 'period_end' && e.period === 2);
    assert.equal(ends.length, 1);
    assert.equal(ends[0].qualifier, 'final');
    assert.equal(ends[0].text, 'P2 - End (Final)');
    assert.equal(serverStatus(finalized), 'final');
});

test('Resume after final-period expiry continues in overage', () => {
    let game = run(ready(), start(0), { type: 'end_period', at: t(10), id: id(), reason: 'manual' }, start(20));
    game = run(game, { type: 'end_period', at: t(61), id: id(), reason: 'time' });
    game = run(game, resume(65));
    assert.equal(game.status, STATUS.RUNNING);
    assert.equal(game.overageAcknowledged, true);
    assert.equal(game.events.some((e) => e.eventType === 'period_end' && e.period === 2), false);
    // The clock stopped at 40:00 at real time 60 and continues from there at real time 65
    assert.equal(getElapsed(game, t(66)), 41 * MIN);
    assert.equal(needsExpiry(game, t(80)), false);
});

test('Add Overtime closes an open period, adds an OT period and sets its length', () => {
    let game = run(ready(), start(0), { type: 'end_period', at: t(10), id: id(), reason: 'manual' }, start(20), pause(30));
    game = run(game, { type: 'add_overtime', at: t(31), id: id(), endId: id(), periodLengthMs: 10 * MIN });
    assert.equal(game.status, STATUS.BETWEEN_PERIODS);
    assert.equal(game.currentPeriod, 3);
    assert.equal(game.periodCount, 3);
    assert.equal(game.periodLengthMs, 10 * MIN);
    assert.equal(periodLabel(game), 'OT');
    assert.equal(game.events.filter((e) => e.eventType === 'period_end' && e.period === 2).length, 1);
    game = run(game, start(35));
    assert.equal(getRemaining(game, t(40)), 5 * MIN);
});

test('Add Overtime after an on-time final end adds no second end', () => {
    let game = run(ready(), start(0), { type: 'end_period', at: t(10), id: id(), reason: 'manual' }, start(20));
    game = run(game, { type: 'end_period', at: t(60), id: id(), reason: 'time' });
    game = run(game, { type: 'add_overtime', at: t(61), id: id(), endId: id(), periodLengthMs: 5 * MIN });
    assert.equal(game.events.filter((e) => e.eventType === 'period_end' && e.period === 2).length, 1);
    assert.equal(game.currentPeriod, 3);
});

test('Finalize in the middle of a period adds a final end', () => {
    const game = run(ready(), start(0), pause(10), { type: 'finalize', at: t(12), id: id(), endedBy: 'abandoned' });
    assert.equal(game.status, STATUS.FINAL);
    assert.equal(game.endedBy, 'abandoned');
    const end = game.events.at(-1);
    assert.equal(end.qualifier, 'final');
    assert.equal(end.endReason, 'final');
    assert.equal(getElapsed(game, t(90)), 10 * MIN);
});

test('Finalize between periods marks the last end as final', () => {
    let game = run(ready(), start(0), { type: 'end_period', at: t(10), id: id(), reason: 'manual' });
    game = run(game, { type: 'finalize', at: t(11), id: id() });
    const ends = game.events.filter((e) => e.eventType === 'period_end');
    assert.equal(ends.length, 1);
    assert.equal(ends[0].qualifier, 'final');
});

test('a game that never started cannot be finalized', () => {
    assert.equal(explain(ready(), { type: 'finalize', at: t(1), id: id() }), 'The game cannot be finalized now');
});

test('nothing changes a final game except notes, goal removal and visibility', () => {
    let game = run(ready(), start(0), score(3), pause(5), { type: 'finalize', at: t(6), id: id() });
    assert.notEqual(explain(game, start(7)), null);
    assert.notEqual(explain(game, resume(7)), null);
    const goal = game.events.find((e) => e.type === 'score');
    game = run(game, { type: 'add_note', id: goal.id, note: 'nice' }, { type: 'remove_event', id: goal.id, at: t(8) });
    assert.deepEqual(getScores(game), { home: 0, away: 0 });
    game = run(game, { type: 'set_visibility', visibility: 'private' });
    assert.equal(game.visibility, 'private');
});

test('removing a goal lowers the score and later goals follow', () => {
    let game = run(ready(), start(0), score(1), score(2), score(3, 'away'));
    const firstGoal = game.events.find((e) => e.type === 'score');
    game = run(game, { type: 'remove_event', id: firstGoal.id, at: t(4) });
    assert.deepEqual(getScores(game), { home: 1, away: 1 });
});

test('removing the latest period end returns to that period, paused at its end time', () => {
    let game = run(ready(), start(0), score(5), { type: 'end_period', at: t(20), id: id(), reason: 'manual' });
    const end = game.events.find((e) => e.eventType === 'period_end');
    game = run(game, { type: 'remove_event', id: end.id, at: t(25), pauseId: id() });
    assert.equal(game.status, STATUS.PAUSED);
    assert.equal(game.currentPeriod, 1);
    assert.equal(getElapsed(game, t(90)), 20 * MIN);
    game = run(game, resume(30));
    assert.equal(getElapsed(game, t(35)), 25 * MIN);
});

test('only the latest period end can be removed, and not once final', () => {
    let game = run(ready(), start(0), { type: 'end_period', at: t(10), id: id(), reason: 'manual' }, start(15), score(16));
    const firstEnd = game.events.find((e) => e.eventType === 'period_end');
    assert.equal(explain(game, { type: 'remove_event', id: firstEnd.id, at: t(17), pauseId: id() }), 'Only the latest period end can be removed');
    game = run(game, { type: 'finalize', at: t(20), id: id() });
    const finalEnd = game.events.at(-1);
    assert.equal(explain(game, { type: 'remove_event', id: finalEnd.id, at: t(21), pauseId: id() }), 'The period end cannot be removed after the game is final');
});

test('start, pause and resume entries cannot be removed on their own', () => {
    const game = run(ready(), start(0), pause(5));
    assert.equal(explain(game, { type: 'remove_event', id: game.events[0].id, at: t(6) }), 'This entry cannot be removed');
    assert.equal(explain(game, { type: 'remove_event', id: game.events[1].id, at: t(6) }), 'This entry cannot be removed');
});

test('clock corrections add a history entry and shift the clock', () => {
    let game = run(ready(), start(1), score(5));
    game = run(game, { type: 'adjust_clock', at: t(6), id: id(), deltaMs: MIN });
    const adjust = game.events.at(-1);
    assert.equal(adjust.eventType, 'clock_adjust');
    assert.equal(adjust.text, 'P1 - Clock +1:00');
    assert.equal(getElapsed(game, t(10)), 10 * MIN);
    // Removing the entry restores the clock
    game = run(game, { type: 'remove_event', id: adjust.id, at: t(11) });
    assert.equal(getElapsed(game, t(10)), 9 * MIN);
});

test('clock corrections are blocked with a reason when a rule fails', () => {
    const game = run(ready(), start(0), score(0.5));
    assert.equal(explain(game, { type: 'adjust_clock', at: t(2), id: id(), deltaMs: -MIN }), 'A goal is logged at +0:30');
    assert.equal(explain(game, { type: 'adjust_clock', at: t(2), id: id(), deltaMs: 30000 }), 'Corrections are whole minutes');
    assert.equal(explain(ready(), { type: 'adjust_clock', at: t(2), id: id(), deltaMs: MIN }),
        'The clock can only be corrected while running or paused');
});

test('editing the match changes names and colors and keeps history readable', () => {
    let game = run(ready(), edit({ home: { name: 'Falcons', color: '#abcdef' } }));
    assert.equal(game.home.name, 'Falcons');
    assert.equal(game.home.color, '#abcdef');
    game = run(game, edit({ away: { name: '   ' } }));
    assert.equal(game.away.name, 'Hawks');
});

function edit(fields) {
    return { type: 'edit_match', ...fields };
}

test('the period length changes only before the period starts', () => {
    let game = ready();
    assert.equal(canChangePeriodLength(game), true);
    game = run(game, edit({ periodLengthMs: 20 * MIN }));
    assert.equal(game.periodLengthMs, 20 * MIN);
    game = run(game, start(0), pause(5));
    assert.equal(canChangePeriodLength(game), false);
    assert.equal(explain(game, edit({ periodLengthMs: 30 * MIN })), 'The period length can only change before the period starts');
    // Unchanged length is not an error
    assert.equal(explain(game, edit({ periodLengthMs: 20 * MIN })), null);
});

test('the period count cannot drop below the current period', () => {
    let game = run(ready(), start(0), { type: 'end_period', at: t(10), id: id(), reason: 'manual' });
    game = run(game, edit({ periodCount: 1 }));
    assert.equal(game.periodCount, 2);
});

test('a new game after a finished one starts clean', () => {
    let game = run(ready(), start(0), score(2), pause(3), { type: 'finalize', at: t(4), id: id() });
    game = run(game, newGame({ gameId: 'g2', home: { name: 'Eagles' } }));
    assert.equal(game.id, 'g2');
    assert.equal(game.status, STATUS.READY);
    assert.equal(game.events.length, 0);
    assert.equal(game.startedAt, null);
    assert.equal(game.away.name, 'Hawks');
});

test('server_final moves the game to final without adding history', () => {
    const game = run(ready(), start(0), { type: 'server_final', endedBy: 'timeout' });
    assert.equal(game.status, STATUS.FINAL);
    assert.equal(game.events.length, 1);
    assert.equal(canScore(game), false);
});

test('a rejected action returns the same game object', () => {
    const game = ready();
    assert.equal(reduce(game, pause(1)), game);
    assert.equal(reduce(game, { type: 'no_such_action' }), game);
});

test('the theme is chosen at New Game and can change until the first Start', () => {
    let game = run(createGame(), newGame({ theme: 'chill-ice' }));
    assert.equal(game.theme, 'chill-ice');
    game = run(game, edit({ theme: 'EdenPrarie.png' }));
    assert.equal(game.theme, 'EdenPrarie.png');
    game = run(game, start(1), pause(2));
    assert.equal(explain(game, edit({ theme: 'chill-ice' })), 'The theme is fixed once the game has started');
    // Naming the same theme again is not an error
    assert.equal(explain(game, edit({ theme: 'EdenPrarie.png' })), null);
});

test('a theme that is not a safe name is dropped', () => {
    assert.equal(run(createGame(), newGame({ theme: '../etc/passwd' })).theme, null);
    assert.equal(run(createGame(), newGame({ theme: 'x'.repeat(65) })).theme, null);
    assert.equal(run(createGame(), newGame({})).theme, null);
});
