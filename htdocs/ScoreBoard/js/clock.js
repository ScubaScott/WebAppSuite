/**
 * ScoreBoard clock: pure functions that turn a game's event log into period positions.
 * Implements docs/TIMING-SPEC.md. No DOM, no storage, no network, no reading of the current time:
 * every function takes the time it should use as an argument.
 *
 * Times are epoch milliseconds. An event's `timestamp` may be an ISO string or a number.
 */

// Event types that are not "play" events when checking an adjustment: the start row and the
// adjustment rows themselves.
const ADJUST_EXEMPT_TYPES = ['period_start', 'clock_adjust'];

/** Real time of an event in epoch milliseconds. */
function eventTime(event) {
    return typeof event.timestamp === 'number' ? event.timestamp : Date.parse(event.timestamp);
}

/** True for a clock event (history entry of type 'event') with the given eventType. */
function isClockEvent(event, eventType) {
    return event.type === 'event' && event.eventType === eventType;
}

/** All events recorded for a period, in log order. */
function eventsOfPeriod(events, period) {
    return events.filter((event) => Number(event.period) === Number(period));
}

/**
 * Summarize the clock of one period.
 *
 * @param {Array<Object>} events The whole event log.
 * @param {number} period 1-based period number.
 * @returns {{
 *   recordedStart: number|null,
 *   adjustMs: number,
 *   effectiveStart: number|null,
 *   pauses: Array<{from: number, to: number|null}>,
 *   end: number|null,
 *   endPositionMs: number|null
 * }}
 */
function getPeriodClock(events, period) {
    const list = eventsOfPeriod(events, period);
    const startEvent = list.find((event) => isClockEvent(event, 'period_start'));
    const recordedStart = startEvent ? eventTime(startEvent) : null;

    // Sum of corrections; positive means play began earlier than the recorded start
    const adjustMs = list
        .filter((event) => isClockEvent(event, 'clock_adjust'))
        .reduce((sum, event) => sum + (Number(event.deltaMs) || 0), 0);

    // Pair each pause with the next resume; the last pause may still be open
    const pauses = [];
    list.forEach((event) => {
        if (isClockEvent(event, 'paused')) {
            const open = pauses.length > 0 && pauses[pauses.length - 1].to === null;
            if (!open) pauses.push({ from: eventTime(event), to: null });
        } else if (isClockEvent(event, 'resumed')) {
            const last = pauses[pauses.length - 1];
            if (last && last.to === null) last.to = eventTime(event);
        }
    });

    const endEvents = list.filter((event) => isClockEvent(event, 'period_end'));
    const lastEnd = endEvents.length > 0 ? endEvents[endEvents.length - 1] : null;
    const end = lastEnd ? eventTime(lastEnd) : null;
    // A period end recorded by an earlier version carries its position; it is used as it is
    const storedEnd = lastEnd ? Number(lastEnd.periodElapsedMs) : NaN;
    const endPositionMs = Number.isFinite(storedEnd) ? storedEnd : null;

    return {
        recordedStart,
        adjustMs,
        effectiveStart: recordedStart === null ? null : recordedStart - adjustMs,
        pauses,
        end,
        endPositionMs
    };
}

/** Length of pause time that falls between `from` and `to` (an open pause counts up to `to`). */
function pausedBetween(pauses, from, to) {
    let total = 0;
    pauses.forEach((pause) => {
        const pauseEnd = pause.to === null ? to : pause.to;
        const overlap = Math.min(to, pauseEnd) - Math.max(from, pause.from);
        if (overlap > 0) total += overlap;
    });
    return total;
}

/** Position for an already-summarized clock; negative when `t` is before the effective start. */
function positionFromClock(clock, t) {
    if (clock.effectiveStart === null) return 0;
    return (t - clock.effectiveStart) - pausedBetween(clock.pauses, clock.effectiveStart, t);
}

/**
 * Game-clock time (milliseconds, paused time excluded) at real time `t`.
 * Returns 0 for a period that has not started. May be negative when `t` is before the effective start.
 */
function getPosition(events, period, t) {
    return positionFromClock(getPeriodClock(events, period), t);
}

/**
 * The clock reading to show right now: frozen at the period end, frozen at the start of an open pause,
 * otherwise running up to `now`. Never negative.
 */
function getElapsed(events, period, now) {
    const clock = getPeriodClock(events, period);
    if (clock.effectiveStart === null) return 0;
    let reference = now;
    if (clock.end !== null) {
        if (clock.endPositionMs !== null) return Math.max(0, clock.endPositionMs);
        reference = clock.end;
    } else {
        const open = clock.pauses.find((pause) => pause.to === null);
        if (open) reference = open.from;
    }
    return Math.max(0, positionFromClock(clock, reference));
}

/**
 * Real time at which the period's position reaches `periodLengthMs`, or null when the period has not
 * started or is paused (the answer would depend on when it resumes).
 */
function getExpiryTime(events, period, periodLengthMs) {
    const clock = getPeriodClock(events, period);
    if (clock.effectiveStart === null) return null;
    if (clock.pauses.some((pause) => pause.to === null)) return null;
    const completedPauses = clock.pauses.reduce((sum, pause) => sum + (pause.to - pause.from), 0);
    return clock.effectiveStart + periodLengthMs + completedPauses;
}

/** Format a position as +M:SS for messages. */
function formatPosition(ms) {
    const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = String(totalSeconds % 60).padStart(2, '0');
    return `+${minutes}:${seconds}`;
}

/** Short description of an event for blocking messages, for example "A goal". */
function describeEvent(event) {
    if (event.type === 'score') return 'A goal';
    if (event.type === 'card') return 'A card';
    if (isClockEvent(event, 'paused')) return 'A pause';
    if (isClockEvent(event, 'resumed')) return 'A resume';
    if (isClockEvent(event, 'period_end')) return 'The period end';
    return 'An event';
}

/**
 * Check whether the period's total adjustment may become `newAdjustMs`. Shared by adding an adjustment and
 * by removing one. Returns { ok: true } or { ok: false, rule, message }.
 *
 * Rules (TIMING-SPEC section 4):
 * 1. No play event of the period may be earlier than the new effective start.
 * 2. The clock may not become negative.
 * 3. Unless overage was acknowledged, no event may land beyond the period length.
 *
 * @param {Array<Object>} events
 * @param {number} period
 * @param {number} newAdjustMs Total adjustment of the period after the change.
 * @param {{now: number, periodLengthMs: number, overageAcknowledged?: boolean}} options
 */
function checkEffectiveStart(events, period, newAdjustMs, options) {
    const clock = getPeriodClock(events, period);
    if (clock.recordedStart === null) {
        return { ok: false, rule: 0, message: 'The period has not started' };
    }
    if (clock.end !== null) {
        return { ok: false, rule: 0, message: 'The period has ended' };
    }

    const newStart = clock.recordedStart - newAdjustMs;
    const playEvents = eventsOfPeriod(events, period)
        .filter((event) => !(event.type === 'event' && ADJUST_EXEMPT_TYPES.includes(event.eventType)));

    // Rule 1: nothing may sit before the new start
    const tooEarly = playEvents.find((event) => eventTime(event) < newStart);
    if (tooEarly) {
        const position = formatPosition(positionFromClock(clock, eventTime(tooEarly)));
        return { ok: false, rule: 1, message: `${describeEvent(tooEarly)} is logged at ${position}` };
    }

    // Rule 2: the clock reading must not be negative
    const open = clock.pauses.find((pause) => pause.to === null);
    const reference = open ? open.from : options.now;
    if (reference < newStart) {
        return { ok: false, rule: 2, message: 'The clock cannot go below 0:00' };
    }

    // Rule 3: nothing may land beyond the period length unless overage was acknowledged
    if (!options.overageAcknowledged) {
        const newClock = { ...clock, effectiveStart: newStart };
        const beyond = playEvents.find((event) => positionFromClock(newClock, eventTime(event)) > options.periodLengthMs);
        if (beyond) {
            return { ok: false, rule: 3, message: 'This would put an event after the end of the period' };
        }
    }

    return { ok: true };
}

/**
 * Check a new adjustment of `deltaMs` (positive = play began earlier than recorded).
 * `status` must be 'running' or 'paused'.
 */
function validateAdjustment(events, period, deltaMs, options) {
    if (options.status !== 'running' && options.status !== 'paused') {
        return { ok: false, rule: 0, message: 'The clock can only be corrected while running or paused' };
    }
    const clock = getPeriodClock(events, period);
    return checkEffectiveStart(events, period, clock.adjustMs + deltaMs, options);
}

/** Check deleting the adjustment event with id `eventId`. */
function validateAdjustmentRemoval(events, period, eventId, options) {
    const target = events.find((event) => event.id === eventId && isClockEvent(event, 'clock_adjust'));
    if (!target) return { ok: false, rule: 0, message: 'Adjustment not found' };
    const clock = getPeriodClock(events, period);
    return checkEffectiveStart(events, period, clock.adjustMs - (Number(target.deltaMs) || 0), options);
}

export {
    eventTime,
    getPeriodClock,
    getPosition,
    getElapsed,
    getExpiryTime,
    validateAdjustment,
    validateAdjustmentRemoval
};
