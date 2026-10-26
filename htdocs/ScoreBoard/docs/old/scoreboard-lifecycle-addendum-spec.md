# ScoreBoard — Lifecycle Addendum: Review Fixes & History Log Standardization

**Target:** Antigravity (implementation agent)
**Builds on:** `scoreboard-game-lifecycle-spec.md` (already implemented)
**Scope:** `htdocs/ScoreBoard/index.html`, `htdocs/ScoreBoard/scoreboard-shared.js`, `htdocs/api/games.php`, `htdocs/api/setup.php`
**Status:** Approved design. Implement as specified.

---

## Part A — Review Fixes

### A1. Preserve `ended_by` once a game is final (`games.php`)

**Problem:** Finalizing sends two syncs: `publishActiveGameState('final', <reason>)` and then `saveState()`. The second derives `ended_by: 'user'` from `activeGameEnded` and carries a higher `rev`. The update path writes `ended_by` unconditionally, so the stale-modal `abandoned` reason (and `new_game`, if a later sync ever occurs) is overwritten with `user`.

**Requirement:** In the sync **update** path, if the existing row's `status` is already `final`, keep its existing `ended_by`. This mirrors how `ended_at` is already preserved. `ended_by` may only be set on the transition from `live` to `final`.

### A2. No duplicate "Start" entry when reloading a running game (`index.html`)

**Problem:** When the page restores a game whose clock was running (drift < 3 hours), it calls `startTimer(false)`, the new-period branch, which logs another `period_start` on every refresh.

**Requirement:** The restore path must resume the clock **silently**. It must not log any history event and must not modify `periodStartTimeUtc` if one is already set. Use the internal clock primitive from B1 (for example a `runClock()` counterpart to `stopClock()`) rather than `startTimer()`. Do **not** change the existing drift and accumulated-time math. Only the logging and start-branch side effects are removed.

### A3. Move tombstone table creation into setup (`games.php`, `setup.php`)

**Problem:** `games.php` runs `CREATE TABLE IF NOT EXISTS suite_game_tombstones` on every API request.

**Requirement:** Remove it from `games.php`. Add it to the idempotent migration block in `setup.php`, alongside the `ended_by` migration, reporting "created" or "verified" in the setup output. `games.php` must keep its existing try/catch around tombstone reads and writes so a missing table degrades gracefully instead of failing requests.

### A4. Redundant finalize sync (`index.html`, optional)

`endCurrentGame()` publishes `final` explicitly and then `saveState()` publishes again. With A1 in place this is harmless. Optionally, avoid the second network sync on the finalize path (local persistence via `saveState()` must still occur). Low priority.

### A5. Verify spec assumption A1 (score buttons disabled in `draft`)

Not visible in review. Confirm that scoring is blocked while `gameLifecycle === 'draft'`. If it isn't, implement it per the original spec §4.6.

---

## Part B — Clock Stop / Resume Semantics

### B1. Split "stop the clock" from "user pause"

**Problem:** `pauseTimer()` is both the Pause button's action and the generic clock-stop routine used by expiry, End Period, drift End on Time, and Finalize. Every stop therefore logs "Paused" and sets pause bookkeeping.

**Requirement:** Introduce an internal primitive and route all callers through it.

| Function | Responsibility | Logs? | Sets `isPaused` / `pauseStartUtc`? |
|---|---|---|---|
| `stopClock(reason)` *(new, internal)* | Clear the interval, fold running time into `accumulatedTime`, set `startTime = null` and `timerRunning = false`, set `lastStopReason = reason` | **Never** | Only when `reason ∈ {'pause', 'score'}` |
| `pauseTimer()` *(Pause button only)* | `stopClock('pause')`, log a `paused` event (if the setting is on), `matchState = 'paused'`, `saveState()` | ✅ | ✅ |

`reason` values: `'pause' | 'score' | 'expiry' | 'period_end' | 'final'`.

`lastStopReason` must be persisted in `saveState()` and restored on load (default `null`).

### B2. Caller mapping

| Caller | Current | New |
|---|---|---|
| Pause button | `pauseTimer()` | `pauseTimer()` (unchanged) |
| Pause on Score (auto-pause after a goal) | `pauseTimer()` (assumed) | `stopClock('score')`, then log `paused` with qualifier `score` (if the setting is on), `matchState = 'paused'` |
| Clock reaches 0:00 (`updateTimer`) | `pauseTimer()` | `stopClock('expiry')` |
| End Period button (`endCurrentPeriod`) | `pauseTimer()` | `stopClock('period_end')` |
| Drift modal → End Period on Time | `pauseTimer()` | `stopClock('period_end')` |
| Finalize (`endCurrentGame`) | `pauseTimer()` | `stopClock('final')` |

After a non-pause stop that leaves the period in progress (final-period expiry with the End/OT modal open), `matchState` should still become `'paused'` so the existing Resume and End/OT controls work. That state is a clock stop, not a logged pause.

### B3. Resume logging rule

`startTimer(true)` (Resume) logs a `resumed` event **only if** `lastStopReason ∈ {'pause', 'score'}` and the Log Pause/Resume setting is on. Otherwise it resumes silently.

Key case: the final period expires → End/OT modal → **Cancel** (continue in overage) → Resume. Nothing was logged at the stop, so nothing is logged at the resume.

### B4. Pause bookkeeping on non-pause stops

`totalPeriodPausedMs` / `pauseStartUtc` track real pauses only. On `'expiry'` and `'final'` stops, `pauseStartUtc` is not set. If the operator resumes into overage after a final-period expiry, the gap between stop and resume is **not** added to `totalPeriodPausedMs`. Existing period-reset logic for `'period_end'` is unchanged.

---

## Part C — History Log Standardization

### C1. Display format

Clock-event rows keep the existing three-column layout rendered by `renderHistory()`:

| Column | Content | Source |
|---|---|---|
| 1 | ⏱️ icon + **event label** | Icon from the renderer (unchanged). Label per C2 |
| 2 | Note, or `—` when empty | `entry.note` (unchanged) |
| 3 | Local time | `formatEventTime(entry.timestamp)` at render time (unchanged) |

Only the **event label** changes. Score and card rows are out of scope and unchanged.

### C2. Event label format

`<period> - <event>[ (<qualifier>)]`

| Trigger | `eventType` | `qualifier` | Label | Gated by setting |
|---|---|---|---|---|
| Period start (Start button) | `period_start` | — | `P1 - Start` | Log Period Start/Stop |
| Pause button | `paused` | — | `P1 - Paused` | Log Pause/Resume |
| Pause on Score | `paused` | `score` | `P1 - Paused (Score)` | Log Pause/Resume |
| Resume (per B3) | `resumed` | — | `P1 - Resumed` | Log Pause/Resume |
| Expiry / End Period / drift End on Time | `period_end` | — | `P1 - End` | Always logged (current behavior) |
| Finalize (per C4) | `period_end` | `final` | `P2 - End (Final)` | Always logged |

- `<period>` comes from `getPeriodLabel(entry.period)` **at render time** (`P1`, `P2`, …, `OT`, or `OT1`, `OT2`, …). Because it is derived rather than stored, adding a second overtime retroactively relabels the first OT's entries from `OT` to `OT1`. This is intended.
- The previous visible suffix `(Time)` on expiry is removed.

### C3. Event data model

Every clock event written from now on carries structured fields. The label is **derived** from them.

| Field | Type | Notes |
|---|---|---|
| `id` | UUID | Existing |
| `type` | `'event'` | Existing |
| `eventType` | `'period_start' \| 'paused' \| 'resumed' \| 'period_end'` | Required |
| `period` | number | Required. Period number, not label |
| `qualifier` | `'score' \| 'final' \| null` | New |
| `endReason` | `'time' \| 'manual' \| 'drift' \| 'final'` | New, `period_end` only. Data only, never displayed |
| `labelVersion` | `2` | New. Marks structured entries for the formatter |
| `timestamp` | ISO UTC | Existing |
| `text` | string | Still written: the generated label (e.g. `P1 - End`), without icon, note, or time. It is regenerated whenever the entry is amended. Kept for backward compatibility with any consumer that reads `text` |
| `note` | string | Existing, unchanged |
| `periodLabel`, `scoreSnapshot`, `periodElapsedMs`, `gameTime` | — | Existing `period_end` fields, retained. `periodLabel` is **not** used for display |

All clock events must be created through one helper (for example `logClockEvent(eventType, { qualifier, endReason })`) so the fields are always populated consistently. No call site should build label strings inline.

### C4. Finalize: append or amend the final period entry

On Finalize, after `stopClock('final')`:

| Condition | Action |
|---|---|
| Current period **has started** (`periodStartTimeUtc !== null`) **and** a `period_end` entry already exists for `currentPeriod` (drift End on Time in the final period) | **Amend** that entry |
| Current period has started and **no** `period_end` exists for it (final-period expiry → Finalize, or paused mid-period → Finalize) | **Append** a new `period_end` for `currentPeriod`, `qualifier: 'final'`, `endReason: 'final'`, `timestamp` = now |
| Current period has **not** started (between periods: the last period ended and the next was never started) | **Amend** the most recent `period_end` entry in the log |
| Fallback: no `period_end` exists anywhere (should not occur for a live game) | Append for `currentPeriod` |

**Amend** means setting `qualifier: 'final'`, regenerating `text`, and keeping **everything else**, including the original `timestamp`. The row keeps its original end time, not the time Finalize was pressed.

Use `periodStartTimeUtc`, not the presence of a `period_start` log entry, to decide "has started", because start entries are not written when Log Period Start/Stop is off.

Exactly one entry per game carries `qualifier: 'final'`.

### C5. Add Overtime: log the end of regulation

When the operator chooses **Add Overtime** from the End/OT modal, the period being closed must have a `period_end` entry (`P2 - End`, no qualifier) before the overtime period begins, unless one already exists for that period (the drift End on Time path). Verify the current Add OT handler and add this if it's missing.

### C6. Single formatter, shared by all views

`parseEventDetails()` exists in both `index.html` and `scoreboard-shared.js`, and is used by `renderHistory()`, `openHistoryOptions()`, and the share action.

| Requirement | Detail |
|---|---|
| One implementation | `index.html` uses the `scoreboard-shared.js` version. Remove the local copy. If that isn't feasible, both copies must be byte-for-byte equivalent in logic |
| Structured entries (`labelVersion === 2`) | Build the label per C2 from `eventType`, `period` (via `getPeriodLabel` with the view's `basePeriods`/`totalPeriods`), and `qualifier` |
| Legacy entries (no `labelVersion`) | Display the stored `text` exactly as today. No migration of old games |
| Consumers | History table, history options preview, share text, and the Viewer all show the same label |

---

## Part D — Version Bumps

Bump the version constant and footer in each file touched, from its **current** value:

| File | Bump |
|---|---|
| `ScoreBoard/index.html` | minor |
| `ScoreBoard/scoreboard-shared.js` | minor (if versioned) |
| `api/games.php` | 1.3 → 1.4 |
| `api/setup.php` | minor |

---

## Part E — Acceptance Criteria

| # | Scenario | Expected |
|---|---|---|
| 1 | Start P1 → Pause button → Resume | `P1 - Start`, `P1 - Paused`, `P1 - Resumed` (with pause/resume logging on) |
| 2 | Pause on Score on: goal scored → Resume | Score row, then `P1 - Paused (Score)`, then `P1 - Resumed` |
| 3 | P1 clock expires | Exactly one new row: `P1 - End`. No `Paused`, no `(Time)` |
| 4 | Press End Period mid-P1 | `P1 - End` only. No `Paused` |
| 5 | Drift modal → End Period on Time (non-final period) | `P1 - End` only |
| 6 | Final period expires → Finalize | `P2 - End (Final)` appended |
| 7 | Paused mid-P2 → End/OT → Finalize | `P2 - Paused`, then `P2 - End (Final)` |
| 8 | P1 ended, P2 never started → End/OT → Finalize | The existing `P1 - End` becomes `P1 - End (Final)` with its **original** time. No P2 row |
| 9 | Drift End on Time in the final period → Finalize | The existing `P2 - End` is amended to `(Final)`. No duplicate |
| 10 | Final period expires → Cancel → Resume (overage) → Finalize | No `Paused`/`Resumed` rows. Ends with `P2 - End (Final)` |
| 11 | Regulation expires → Add Overtime → OT played → Finalize | `P2 - End`, `OT - Start`, `OT - End (Final)` |
| 12 | Add a second OT after the first | The first OT's rows now display `OT1`; new rows display `OT2` |
| 13 | Log Period Start/Stop off | No Start rows. End rows and the Final marker still appear |
| 14 | Log Pause/Resume off | No Paused/Resumed rows of any kind |
| 15 | Add a note to any clock row | The note replaces `—` in column 2. The label is unchanged |
| 16 | Reload the page while the clock is running | No new history rows. The clock continues correctly |
| 17 | Stale modal → Finish | Server `ended_by = 'abandoned'` and it stays so after any later sync |
| 18 | Open a legacy game (pre-change history) | Old rows display their original text unchanged |
| 19 | Viewer page for a live game | Labels are identical to the scorer's |
| 20 | Run `setup.php` twice | Tombstone table created, then verified. No errors |
| 21 | Exactly one `(Final)` row per finished game | Holds across all scenarios 6–11 |

---

## Out of Scope

- Score and card row formats.
- Migration of existing history entries.
- Changes to how local time is formatted (render-time, device timezone, as today).
