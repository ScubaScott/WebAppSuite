// Tests for js/clock.js, following docs/TIMING-SPEC.md.
// Run from htdocs/ScoreBoard: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getPeriodClock, getPosition, getElapsed, getExpiryTime,
    validateAdjustment, validateAdjustmentRemoval
} from '../js/clock.js';

const MIN = 60000;
const LENGTH = 40 * MIN;

// Real time helper: minutes after 5:00pm on a fixed day
const BASE = Date.parse('2026-10-26T17:00:00');
const at = (minutes) => new Date(BASE + minutes * MIN).toISOString();

let nextId = 1;
const clockEvent = (eventType, minutes, extra = {}) => ({
    id: `e${nextId++}`, type: 'event', eventType, period: 1, labelVersion: 2, timestamp: at(minutes), ...extra
});
const goal = (minutes, period = 1) => ({ id: `e${nextId++}`, type: 'score', period, teamId: 'home', timestamp: at(minutes) });
const card = (minutes) => ({ id: `e${nextId++}`, type: 'card', period: 1, teamId: 'home', timestamp: at(minutes) });

// The worked example from TIMING-SPEC section 6, before any adjustment
function workedExample() {
    return [
        clockEvent('period_start', 1),
        goal(5),
        clockEvent('paused', 8),
        clockEvent('resumed', 10),
        goal(12)
    ];
}

test('positions before the adjustment (spec section 6)', () => {
    const events = workedExample();
    assert.equal(getPosition(events, 1, BASE + 5 * MIN), 4 * MIN);
    assert.equal(getPosition(events, 1, BASE + 8 * MIN), 7 * MIN);
    assert.equal(getPosition(events, 1, BASE + 10 * MIN), 7 * MIN);
    assert.equal(getPosition(events, 1, BASE + 12 * MIN), 9 * MIN);
});

test('+1:00 moves every position by one minute and keeps pauses', () => {
    const events = [...workedExample(), clockEvent('clock_adjust', 13, { deltaMs: MIN })];
    assert.equal(getPeriodClock(events, 1).effectiveStart, BASE);
    assert.equal(getPosition(events, 1, BASE + 5 * MIN), 5 * MIN);
    assert.equal(getPosition(events, 1, BASE + 8 * MIN), 8 * MIN);
    assert.equal(getPosition(events, 1, BASE + 12 * MIN), 10 * MIN);
    // 5:15pm: 15 minutes since 5:00 minus 2 minutes paused
    assert.equal(getElapsed(events, 1, BASE + 15 * MIN), 13 * MIN);
});

test('removing the adjustment restores the earlier positions', () => {
    const base = workedExample();
    const withAdjust = [...base, clockEvent('clock_adjust', 13, { deltaMs: MIN })];
    const without = withAdjust.filter((event) => event.eventType !== 'clock_adjust');
    assert.equal(getPosition(without, 1, BASE + 12 * MIN), 9 * MIN);
});

test('adjustments add up in any order', () => {
    const events = [
        clockEvent('period_start', 1),
        clockEvent('clock_adjust', 3, { deltaMs: 5 * MIN }),
        clockEvent('clock_adjust', 4, { deltaMs: -4 * MIN })
    ];
    assert.equal(getPeriodClock(events, 1).adjustMs, MIN);
});

test('elapsed is frozen while paused and after the period ends', () => {
    const paused = [clockEvent('period_start', 0), clockEvent('paused', 10)];
    assert.equal(getElapsed(paused, 1, BASE + 30 * MIN), 10 * MIN);
    const ended = [clockEvent('period_start', 0), clockEvent('period_end', 40, { endReason: 'time' })];
    assert.equal(getElapsed(ended, 1, BASE + 90 * MIN), 40 * MIN);
});

test('a period that has not started reads 0', () => {
    assert.equal(getElapsed([], 1, BASE), 0);
    assert.equal(getPosition([], 1, BASE), 0);
});

test('periods are independent', () => {
    const events = [
        clockEvent('period_start', 0),
        clockEvent('period_end', 40),
        { ...clockEvent('period_start', 50), period: 2 },
        goal(55, 2)
    ];
    assert.equal(getPosition(events, 2, BASE + 55 * MIN), 5 * MIN);
    assert.equal(getElapsed(events, 1, BASE + 100 * MIN), 40 * MIN);
});

test('expiry time is start + length + completed pauses', () => {
    const events = [clockEvent('period_start', 0), clockEvent('paused', 5), clockEvent('resumed', 8)];
    assert.equal(getExpiryTime(events, 1, LENGTH), BASE + 43 * MIN);
    const adjusted = [...events, clockEvent('clock_adjust', 9, { deltaMs: MIN })];
    assert.equal(getExpiryTime(adjusted, 1, LENGTH), BASE + 42 * MIN);
    const open = [clockEvent('period_start', 0), clockEvent('paused', 5)];
    assert.equal(getExpiryTime(open, 1, LENGTH), null);
});

const options = (now, extra = {}) => ({ now: BASE + now * MIN, periodLengthMs: LENGTH, status: 'running', ...extra });

test('rule 1: blocks an adjustment that puts a goal before the start', () => {
    const events = [clockEvent('period_start', 0), goal(0.5)];
    const result = validateAdjustment(events, 1, -MIN, options(2));
    assert.equal(result.ok, false);
    assert.equal(result.rule, 1);
    assert.match(result.message, /A goal is logged at \+0:30/);
});

test('rule 1 does not count the start row itself', () => {
    // Start pressed at 5:00, play really began at 5:01: start is later than the recorded start
    const events = [clockEvent('period_start', 0)];
    assert.equal(validateAdjustment(events, 1, -MIN, options(3)).ok, true);
});

test('rule 2: the clock cannot go negative', () => {
    const events = [clockEvent('period_start', 0)];
    const result = validateAdjustment(events, 1, -5 * MIN, options(2));
    assert.equal(result.ok, false);
    assert.equal(result.rule, 2);
});

test('rule 3: blocks an event landing after the period length', () => {
    const events = [clockEvent('period_start', 0), goal(39.5)];
    const blocked = validateAdjustment(events, 1, 2 * MIN, options(40));
    assert.equal(blocked.ok, false);
    assert.equal(blocked.rule, 3);
    const allowed = validateAdjustment(events, 1, 2 * MIN, options(40, { overageAcknowledged: true }));
    assert.equal(allowed.ok, true);
});

test('adjusting is only allowed while running or paused', () => {
    const events = [clockEvent('period_start', 0)];
    assert.equal(validateAdjustment(events, 1, MIN, options(2, { status: 'between_periods' })).ok, false);
    assert.equal(validateAdjustment(events, 1, MIN, options(2, { status: 'paused' })).ok, true);
    assert.equal(validateAdjustment([], 1, MIN, options(2)).ok, false);
});

test('adjusting after the period ended is blocked', () => {
    const events = [clockEvent('period_start', 0), clockEvent('period_end', 40)];
    assert.equal(validateAdjustment(events, 1, MIN, options(41)).ok, false);
});

test('removing an adjustment follows the same rules', () => {
    // A -1:00 adjustment (start later) was made, then a goal was logged 30 seconds after the new start.
    // Removing the adjustment would move the effective start back and is fine; removing a +1:00 would
    // move the goal to a position before 0:00 only if the goal predates the start, so test that.
    const events = [
        clockEvent('period_start', 0),
        clockEvent('clock_adjust', 1, { id: 'adj', deltaMs: -MIN }),
        goal(1.5)
    ];
    // Removing -1:00 moves the start from 5:01 to 5:00: allowed
    assert.equal(validateAdjustmentRemoval(events, 1, 'adj', options(3)).ok, true);

    const events2 = [
        clockEvent('period_start', 2),
        goal(2.5),
        clockEvent('clock_adjust', 3, { id: 'adj2', deltaMs: 2 * MIN })
    ];
    // Effective start is 5:00. Removing +2:00 moves it to 5:02; the goal at 5:02:30 is still after it: allowed
    assert.equal(validateAdjustmentRemoval(events2, 1, 'adj2', options(4)).ok, true);

    const events3 = [
        clockEvent('period_start', 2),
        clockEvent('clock_adjust', 2.1, { id: 'adj3', deltaMs: 2 * MIN }),
        goal(0.5)
    ];
    // The goal at 5:00:30 sits before the recorded start of 5:02: removing +2:00 would leave it before the start
    const blocked = validateAdjustmentRemoval(events3, 1, 'adj3', options(4));
    assert.equal(blocked.ok, false);
    assert.equal(blocked.rule, 1);
    assert.equal(validateAdjustmentRemoval(events3, 1, 'missing', options(4)).ok, false);
});

test('an open pause is measured up to now when computing positions in the past', () => {
    const events = [clockEvent('period_start', 0), clockEvent('paused', 10)];
    // Position at real time 20 is still 10 minutes: the pause covers the gap
    assert.equal(getPosition(events, 1, BASE + 20 * MIN), 10 * MIN);
});
