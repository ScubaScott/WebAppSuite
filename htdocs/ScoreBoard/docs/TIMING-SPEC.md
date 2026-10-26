# ScoreBoard Timing Spec

Status: agreed design, not yet built. Implement in Phase 3 of the refactor (see `../AGENTS.md` section 2). Do not apply it to the current `main` code.

Replaces the current clock, which keeps `accumulatedTime` and `startTime` (the start of the latest run segment) and has no way to correct a period's start time.

---

## 1. Principles

1. **Real time is the only thing stored.** Every clock event, goal and card is saved with its real time (`timestamp`, ISO UTC).
2. **Position is calculated, never stored.** A position is how far into the period's game clock an event happened. It is derived from the timestamps, so correcting the period start corrects every position at once.
3. **The period start is written once and never modified.** A correction is a separate `clock_adjust` entry in the history. Deleting that entry undoes the correction.
4. **Pauses are stored as lengths of real time.** A correction does not move them.
5. **The clock has no saved state.** Elapsed time is a function of the events and the current time. Reloading, a sleeping phone or a background tab cannot lose time.

## 2. Terms

| Term | Meaning |
| --- | --- |
| Recorded start | `timestamp` of the period's `period_start` event: the real time Start was pressed. Never changes. |
| Adjustment | A `clock_adjust` event with `deltaMs` (positive = play began earlier than recorded, negative = later). |
| Effective start `S` | Recorded start minus the sum of `deltaMs` of every adjustment in the period. |
| Pause interval | A `paused` event and the next `resumed` event of the same period. The last interval may be open (still paused). |
| Position `P(t)` | Game-clock time at real time `t`: `(t - S)` minus the length of every pause interval (or part of one) between `S` and `t`. Paused time never counts. |
| Elapsed (now) | Running: `P(now)`. Paused: `P(pausedAt)` of the open pause. Between periods or after `period_end`: `P(period end timestamp)`. |

Every period has its own recorded start, adjustments and pauses. Positions restart at 0:00 each period.

## 3. Events

All events are history entries (`type: 'event'`, `labelVersion: 2`) with `id`, `period`, `timestamp`, `text`, optional `note`.

| `eventType` | Added when | Extra fields |
| --- | --- | --- |
| `period_start` | First Start of a period | none |
| `paused` / `resumed` | Pause or Resume. A goal with Pause on Score on logs `paused` with `qualifier: 'score'` | `qualifier` |
| `clock_adjust` | The elapsed time panel (plus or minus minutes) | `deltaMs` (a whole number of minutes in milliseconds) |
| `period_end` | End Period, expiry, End Period on Time, Finalize | `endReason`: `'time'`, `'manual'`, `'drift'`, `'final'`; `qualifier: 'final'` for the last |

- Goals (`type: 'score'`) and cards (`type: 'card'`) also carry a `timestamp`, the real time they were recorded.
- New events never store `periodElapsedMs` or `gameTime`. These are derived (section 7).
- Start, pause, resume and adjust events are **always recorded**, because the clock is calculated from them. The preferences "Log pause/resume" and "Log period start/stop" only decide whether the rows are **shown** and whether they are included in the snapshot history sent to viewers (as today).
- `text` is always filled in, in the existing style (`P1 - Clock +1:00`, `P2 - Start`), so older viewers that read `text` show a readable row.

## 4. Operations

### Start (first start of a period)
Add `period_start` at `now`. The period is running.

### Pause and Resume
`paused` at `now`, then later `resumed` at `now`. Resume is only allowed while an open pause exists.

### Clock adjustment

Opened from the elapsed time display, as now. Choices are +1, −1, +5 and −5 minutes. Positive means "play started earlier than I pressed Start".

Allowed only when the current period has a `period_start`, has no `period_end`, and the status is `running` or `paused`.

The new effective start `S'` = `S − delta`. The adjustment is **blocked, with a message and no change**, when any of these would be true afterwards:

1. **An event would sit before the start.** Any goal, card, pause, resume or end of this period (not the period start entry itself) has a timestamp earlier than `S'`. Message names the event, for example "A goal is logged at +0:30".
2. **The clock would be negative.** The reference time (now when running, the open pause's time when paused) is earlier than `S'`.
3. **An event would land beyond the period length** when overage has not been acknowledged: `P(latest event of the period) > periodLengthMs`. Message: "This would put an event after the end of the period".

Otherwise add the `clock_adjust` event at `now`. If the adjustment makes `P(now)` reach the period length while running, normal expiry follows on the next tick (section 4, Expiry).

The panel hides itself after one adjustment or when the user dismisses it.

### Deleting an adjustment
It is a normal history removal with a confirmation. The same three rules are checked against the recomputed start, and the removal is blocked with the same messages if one fails. Pause, resume and period start entries are not deletable on their own (unchanged).

### Expiry
Runs when `P(now) >= periodLengthMs` while running and overage is not acknowledged.
- Whistle plays unless muted.
- `period_end` is added with `endReason: 'time'`. Its `timestamp` is the **calculated** real time the period reached its length: `S + periodLengthMs + total pause length`, not `now`. A phone that slept past the end therefore records the true end.
- Non-final period: status becomes `between_periods` and the next period is ready. Final period: status `paused` and the End / Overtime dialog opens.

### Coming back to the page (load, tab visible, wake from sleep)
Nothing needs restoring: recompute `P(now)` from the events.
- `P(now)` of 3 hours or more: stale prompt (Finish Game / Resume Clock). Finish Game finalizes through the normal path, with the end timestamp at the last saved time.
- Past the period length and not acknowledged: "Period Limit Exceeded" prompt (End Period on Time / Continue in Overage). End Period on Time records the end at the calculated expiry time, as in Expiry. Continue in Overage sets the acknowledgement flag for the period.

### Manual End Period / Finalize
`period_end` at `now` (position = `P(now)`, which may exceed the length in overage).

### New period
A new period begins with no events; the next Start adds its `period_start`.

## 5. Safety checks

- **Device clock changed.** If a new event's `now` is earlier than the latest timestamp already in the game, or the clock jumped by more than a few minutes between ticks, do not record it silently: show a message ("The device clock changed") and use the latest known timestamp so the game stays consistent.
- **Open pause at final.** Finalizing while paused ends the open interval at the end timestamp.
- **Time zone and daylight saving** do not matter: timestamps are UTC and only differences are used.

## 6. Worked example

P1 length 40:00. Start pressed at 5:01pm. Goal at 5:05pm. Pause at 5:08pm, resume at 5:10pm. Goal at 5:12pm. At 5:13pm the operator taps +1:00 (play had really started at 5:00pm).

| Row | Real time | Position before the adjustment | Position after |
| --- | --- | --- | --- |
| P1 start | 5:01pm recorded | 5:01pm | shown as 5:00pm |
| Goal | 5:05pm | +4:00 | +5:00 |
| Paused | 5:08pm | +7:00 | +8:00 |
| Resumed | 5:10pm | +7:00 | +8:00 |
| Goal | 5:12pm | +9:00 | +10:00 |
| Clock +1:00 | 5:13pm | (not present) | row added, shows "Clock +1:00" |

At 5:15pm the clock reads 15:00 (5:00 to 5:15) minus 2:00 paused = 13:00. Deleting the adjustment row returns every row to its "before" position.

## 7. Display and snapshot

- **History rows:** time-based rows show the position, for example `+4:00`, with the period (`P1 +4:00`). The period start row shows the effective start time (`5:00pm`) with a small "adjusted +1:00" note when there are adjustments. Pause and resume rows show their position. The recorded real time is shown only in an entry's detail dialog.
- **Snapshot** (`toSnapshot`, contract in AGENTS.md section 6) stays as is. For each history entry it adds the derived `periodElapsedMs` and `gameTime`, recalculated at every sync, so existing viewers and games lists keep working. `elapsedMs` is `P` at the snapshot time. The server needs no change.
- **Viewers** extrapolate the clock from `elapsedMs`, `timerRunning` and the server time as today. After an adjustment they jump to the new value at the next poll.
- **Old viewers** (the code currently on the live site) do not know `clock_adjust`. They show its `text` as a generic event row. Because the live site and `/dev/` share the games list until the merge, this is acceptable but must be checked in the live viewer before the branch is used for real games.

## 8. Old games

Games recorded before this spec have history entries with a stored `periodElapsedMs` or `gameTime` and no clock events that carry enough information to recompute. They are **not converted**. A game recorded under this spec carries `timingVersion: 2` (set when it is created, copied into the snapshot). For a game without it, the renderer uses each entry's stored `periodElapsedMs` or `gameTime` as today; for a game with it, positions are always derived. Archived games therefore look exactly as they do today.

The cutover has no live games (AGENTS.md section 13), so no in-progress clock needs converting.

## 9. Consequences for the rest of the design

- The `clock` object (`elapsedBeforeRun`, `runStartedAt`) in AGENTS.md section 4 is replaced by the events. The console no longer saves `accumulatedTime`, `startTime`, `periodStartTimeUtc`, `totalPeriodPausedMs` or `pauseStartUtc`.
- The reducer and the display loop use one pure function, `getPosition(events, period, t)`, for the clock display, history rows, expiry and snapshots. It is covered by unit-style checks in the test checklist.
- Bug 1 (clock loses time on reload) and the `Period Limit Exceeded` race on load are removed by design: there is nothing to restore, and the drift check runs once on load before the tick starts.

## 10. Tests (add to `TEST-CHECKLIST.md` when the refactor branch can run them)

- [ ] Worked example in section 6 produces exactly those positions, before and after the adjustment.
- [ ] Reload while running, while paused and between periods: the clock reads the same as before the reload.
- [ ] +1:00 at the start of a period: the clock jumps by one minute and the start row shows one minute earlier.
- [ ] −1:00 after a goal logged less than a minute after the start is blocked with the goal named.
- [ ] Delete an adjustment: all positions return to their earlier values. Delete is blocked when it would break rule 1, 2 or 3.
- [ ] +N that reaches the period length ends the period; the end row's position is the full length.
- [ ] Put the phone to sleep past the period length: on return, the prompt appears and "End Period on Time" records the end at the true expiry.
- [ ] Pause for several minutes, then adjust: pause lengths are unchanged.
- [ ] A game with an old-format history still displays all its rows with their original times.
- [ ] Device clock set backwards mid-game: warning shown, no negative position.

## 11. Open items

- Deleting an individual pause or resume is not supported. A later feature could delete the whole pair at once.
- Editing a goal's time (a change to that entry's `timestamp`) would work with this model but is not part of this spec.
- Adjusting a finished period is not supported.
