# ScoreBoard — Match Lifecycle, Flow & Timeline Engine (Implementation Spec v2)

Target app: `htdocs/ScoreBoard/` (vanilla JS, no build step). This spec supersedes `gameflow improvement.md`. Read the **Decision Log (§2)** first: it lists where v1 contradicted itself or the existing code and what was chosen.

---

## 0. Files, Versions & Conventions

| File | Change | Version bump (per AGENTS.md, +0.1) |
| :--- | :--- | :--- |
| `ScoreBoard/index.html` | Main work: state machine, setup modal, clock engine, ledger | `2.7 → 2.8` (also update footer default text) |
| `ScoreBoard/scoreboard.css` | New classes (§12) | `2.3 → 2.4` |
| `ScoreBoard/active-games.php` | Write-token check, status, locking (§11) | `1.1 → 1.2` |
| `ScoreBoard/ScoreBoardActiveGames.html` | Map new `status` values | `1.2 → 1.3` |
| `ScoreBoard/ScoreBoardViewer.html` | Final badge, card entries, `status` | `1.1 → 1.2` |
| `ScoreBoard/ScoreBoardHelp.html` | Rewrite Timer / Start-Stop / Period / Reset / Settings sections to match the new flow | `1.6 → 1.7` |
| `ScoreBoard/AGENTS.md` | Replace timing/period section with the state machine below | n/a |
| `sw.js` | Bump `SW_VERSION` | `3.2 → 3.3` |
| `media/suite-profile.js` | **No change** (storage key is kept, see §3.3) | n/a |

Conventions (root AGENTS.md): comment every timer interval, sync call and state transition; keep the version constant and footer element in sync. Return **full files**, not diffs.

---

## 1. Scope & Objectives

1. **Streamlined control bar:** show only the actions valid for the current match state.
2. **Dedicated Match Setup:** team names/colors move out of Settings into a Match Setup modal opened by **New Game**, the top-right ellipsis (⋮), or **Add Overtime**.
3. **Fail-safe operation:** the period cannot advance and the match cannot end while the clock is ticking. **Single exception:** the "Period Limit Exceeded" dialog (§8), which is an explicit operator choice.
4. **Dual clocks with overage:** primary countdown, secondary period-elapsed. Passing zero rolls into overage; the app never auto-halts the clock.
5. **Immediate drift dialog:** if the app wakes or reloads with the clock running and the limit already passed, show the dialog immediately while the clock keeps ticking.
6. **Event ledger & rollback:** structural events (end of period / match) store their own elapsed time so deleting the latest one safely rolls the board back.

---

## 2. Decision Log (resolved from v1)

| # | v1 problem | Resolution in this spec |
| :--- | :--- | :--- |
| D1 | v1 §4 said "at zero: whistle, halt, auto-advance period" but §1/§4 clock rules and §5 say overage keeps ticking. Direct contradiction (and auto-advance breaks the fail-safe rule). | **Overage model wins.** At zero: whistle once, keep ticking, show OVERAGE. Operator taps Pause, then End Period / End-OT. The old `stopTimer(true)` auto-reset at zero is removed. |
| D2 | "End Period on Time" timestamp = `periodStartTimeUtc + timeLimit` is wrong when the period had pauses. | Timestamp = `now − (elapsed − limit)`, i.e. the wall-clock moment elapsed reached the limit. `periodElapsedMs` = `limit`. |
| D3 | v1 introduced `periodStartTimeUtc` + `totalPeriodPausedMs`. Redundant with the existing model. | Keep `accumulatedTime` + `startTime` (epoch ms). Elapsed = `accumulatedTime + (startTime ? now − startTime : 0)`. Persist `startTime`. This also fixes an existing reload bug (see §7.5). |
| D4 | Drift dialog would re-fire after an operator legitimately watched the clock cross zero, then locked/unlocked the phone. | New `overageAcknowledged` flag (§7.3). Dialog only fires when the crossing was **not** observed live. |
| D5 | Rollback keyed on history text `"End of P{n}"`, but that entry only exists if the "Log Period Start/Stop" toggle is on, and "reconstruct from UTC" is impossible (pause events are optional, entries are deletable). | Structural events (`period_end`, `match_end`) are **always** logged, carry `subtype` + `periodElapsedMs`, and rollback restores that stored value. Only the latest boundary is deletable (§10). The toggle now governs "Start of P{n}" only. |
| D6 | "Public Sharing toggle" listed as a retained global setting; it doesn't exist and is per-match by nature. | Per-match `isPublic`, set in Match Setup, **hidden for guests** (guest games are always public), default `true` for signed-in users. Private = never published to the server list (§11). |
| D7 | "Add Pause" toggle, tap-to-cycle period, count-up mode, and tap-timer-to-set-limit all conflict with the new flow. | Pause is always shown while Running (toggle removed). Period changes only via End Period / auto flows / rollback (tap-to-cycle removed). Count-up (`timeLimit ≤ 0`) removed; minimum period is 1:00. Limit selection lives only in the setup modal. |
| D8 | v1 status `final` vs. code's existing `status: 'game_over'`. | Emit `final`; ActiveGames/Viewer accept both `final` and legacy `game_over`. |
| D9 | "Add Time / Overtime" conflated *extra stoppage minutes* with *an extra period*. | Stoppage = overage (no action needed). **Add Overtime** = append one period, with its own duration (§9.4). |
| D10 | No way to abandon a mistaken match except publishing it as a finished game. | In Ready state with an empty ledger, **End / OT** offers **Discard Match** (removes from server, returns to Idle). |
| D11 | Bumping `timerStateV7` would orphan the key list in `suite-profile.js` used for logout wipes. | Keep `timerStateV7`; add `schemaVersion: 2` inside the state object and migrate (§3.3). |

---

## 3. State Model

### 3.1 State fields

Persisted (in the existing `saveState()` object; also flows to `SuiteProfile.saveAppData('scoreboard', state)`):

```javascript
schemaVersion: 2,
matchState: 'idle' | 'ready' | 'running' | 'paused' | 'final',
currentPeriod: 1,
totalPeriods: 2,                 // 1..8 (may grow via Add Overtime)
timeLimit: 2400000,              // ms, default period length, min 60000, max 5999000
periodLimitOverrides: {},        // { "3": 300000 } per-period override (overtime)
accumulatedTime: 0,              // ms elapsed in CURRENT period, excluding the running segment
startTime: null,                 // epoch ms when the running segment began; null unless running
overageAcknowledged: false,      // see §7.3
homeTeamName, awayTeamName, homeTeamColor, awayTeamColor,
homeScore, awayScore, scoreHistory,
activeGameId, activeGameWriteToken, activeGameStarted, activeGameEnded,
activeGameStartedAt, activeGameEndedAt,   // ISO strings or null
isPublic: true,
// unchanged global prefs: muted, pauseOnScore, logPauseResume, logPeriodStartTimes,
// splashOnHome, splashOnAway, showPenaltyCards, selectedTheme
lastSavedAt
```

Removed: `isCountingUp`, `addPauseButton`, `isPaused` (replaced by `matchState`), the rename `logPeriodStartStop → logPeriodStartTimes` (accept the old key on load).

Helpers:

```javascript
getPeriodLimit(n) => periodLimitOverrides[n] ?? timeLimit
getElapsed()      => accumulatedTime + (startTime ? Date.now() - startTime : 0)
getRemaining()    => getPeriodLimit(currentPeriod) - getElapsed()   // may be negative (overage)
```

### 3.2 IDs & tokens

* `activeGameId`: `crypto.randomUUID()` (fallback: build a v4 UUID from `crypto.getRandomValues`).
* `activeGameWriteToken`: 32 random bytes → 64-char lowercase hex via `crypto.getRandomValues`.
* The token is **never** rendered, logged, or included in any share text. It is synced to the user's cloud state as part of the normal state object (acceptable; it is per-user).

### 3.3 Migration (run in `onload` before rendering, for local and cloud state)

If `saved.schemaVersion !== 2`:

1. `totalPeriods = max(2, saved.currentPeriod || 1)`; `periodLimitOverrides = {}`.
2. `timeLimit`: if missing or `<= 0` (legacy count-up) → `2400000`.
3. `matchState`:
   * saved.running → `'running'`; else `accumulatedTime > 0` → `'paused'`; else if history non-empty or `activeGameStarted` → `'ready'`; else `'idle'`.
   * Legacy `game_over` is not stored in state, so nothing to map.
4. If migrated state is not `idle`: keep the legacy `activeGameId` as-is (server treats it as claimable, §11), generate `activeGameWriteToken`, set `activeGameStarted = true`, `activeGameEnded = false`, `isPublic = true`.
5. History entries: assign `id` if missing; set `period` from `/^P(\d+)/` on `gameTime` else `currentPeriod`; set `subtype` on legacy events by matching `/^End of P(\d+)/` → `period_end`, `/^Start of P/` → `period_start`.
6. **Running-clock restore fix:** if the saved state was running, elapsed on load = `saved.accumulatedTime + (Date.now() − saved.startTime)`. Do **not** use `lastSavedAt` (see §7.5).
7. `overageAcknowledged = false`.

Fresh install / no saved state (also logged-in user with no cloud state) → `matchState = 'idle'`, default names `Us` / `Them`, `totalPeriods = 2`, `timeLimit = 2400000`.

---

## 4. Match State Machine & Button Rules

Buttons are one row inside the existing card. Only render the buttons listed; do not hide with CSS-only tricks that leave them focusable.

| State | Board controls (score tiles, period, cards, clocks) | Ellipsis (⋮) | Buttons | Notes |
| :--- | :--- | :--- | :--- | :--- |
| **idle** | Locked & dimmed | Hidden | **[New Game]** (full width) | Fresh load or after Discard. |
| **ready** (configured, clock not running, elapsed = 0; used at P1 and between periods) | Unlocked | Visible | **[Start]** \| **[End / OT]** | Start logs `Start of P{n}` only if `logPeriodStartTimes`. |
| **running** | Unlocked | Hidden | **[Pause]** (full width) | No period advance / match end. |
| **paused**, `currentPeriod < totalPeriods` | Unlocked | Visible | **[Resume]** \| **[End Period]** \| **[End / OT]** | |
| **paused**, `currentPeriod >= totalPeriods` | Unlocked | Visible | **[Resume]** \| **[End / OT]** | No End Period: no next period. |
| **final** | Locked & dimmed; **history stays interactive** | Hidden | **[New Game]** (full width) | Add note / share / delete (with rollback rules §10) still work. |

Global UI (settings gear, mute FAB, links) stays available in every state.

### 4.1 Transitions

* `idle → ready`: Match Setup create → **[Start Match]** (§5).
* `ready → running`: **[Start]** (`startTime = now`, `overageAcknowledged = false`).
* `running → paused`: **[Pause]**, or Pause-on-Score. (`accumulatedTime += now − startTime; startTime = null`). Logs pause event only if `logPauseResume`.
* `paused → running`: **[Resume]**. If `getElapsed() > getPeriodLimit()` at resume, set `overageAcknowledged = true` (operator knowingly resumes into overage). Logs resume event only if `logPauseResume`.
* `paused → ready` (next period): **[End Period]** (§9.1).
* `paused/ready → final`: **[End / OT] → Match Complete** (§9.2).
* `paused → ready` (added period): **[End / OT] → Add Overtime** (§9.4).
* `running → ready` (next period) or `running → paused`: only via the drift dialog (§8).
* `final → idle`: no direct transition; **[New Game]** opens the setup modal and on **[Start Match]** creates a new match (`ready`).

### 4.2 Period display

`#period-display` shows `P{n}` and is **not tappable** (D7). Title attribute: `Period n of total`.

---

## 5. Match Setup Modal

Single modal element `#match-setup-modal`, three modes: **create**, **edit**, **overtime**. Stacked single-column layout, z-index above Settings (use 60; history options modal is 60 too, so close it first; drift dialog is 70). Backdrop click closes in create/edit modes only.

### 5.1 Fields

* Header: `New Game Setup` | `Edit Match Details` | `Add Overtime` + ✕.
* **Home** and **Away** sections: team name input (trimmed, 1–20 chars; blank falls back to `Us` / `Them`), color select (reuse the existing 8 options; show live swatch). Non-blocking hint if both colors are equal.
* **Match Rules** (hidden in overtime mode except duration):
  * **Total Periods** stepper, 1–8, default 2. In edit mode `min = currentPeriod`.
  * **Period Duration:** presets `12m / 20m / 35m / 40m` + a "Custom (MM:SS)" button that reveals the **existing roller picker** (move it from the main card into the modal). Minimum 1:00. Roller scroll positions must be synced **after** the modal is visible (`requestAnimationFrame`), because `scrollTo` is a no-op on `display:none`.
* **Sharing** (signed-in only, i.e. `!SuiteProfile.isGuest()`): "Share to Active Games list" toggle, default ON. Guests: control not rendered; `isPublic` forced `true`.
* Defaults for create mode = previous match's names, colors, total periods, duration (falling back to `Us` / `Them` / 2 / 40:00).

### 5.2 Actions

**Create → [Start Match]**
1. Reset scores, history, period = 1, `accumulatedTime = 0`, `startTime = null`, `periodLimitOverrides = {}`, `overageAcknowledged = false`.
2. New `activeGameId`, `activeGameWriteToken`, `activeGameStarted = true`, `activeGameEnded = false`, `activeGameStartedAt = new Date().toISOString()`, `activeGameEndedAt = null`.
3. `matchState = 'ready'`; unlock board; render **[Start]** | **[End / OT]**.
4. `saveState()` (localStorage + cloud sync + publish if `isPublic`). No confirm dialog: a previous match is already `final` or `idle`.

**Edit → [Save Changes]**
* Update names, colors, `totalPeriods`, `timeLimit`, `isPublic`; **do not** regenerate IDs/token.
* Update existing `scoreHistory` entries' `teamName` / `teamColor` for the edited team.
* If `isPublic` flipped to `false`: send DELETE to server (§11) and stop publishing. If flipped to `true`: publish immediately.
* If the new limit makes `elapsed > limit` while paused: just render overage; no dialog (dialog is only for `running`).

**Overtime → [Add Overtime]** (§9.4).

### 5.3 Validation

Names sanitized on render via existing `escapeHtml`; duration ≥ 1:00; `totalPeriods ≥ currentPeriod`; reject save with an inline message otherwise.

---

## 6. Settings Panel Cleanup

Remove from Settings and from JS: `.team-setup-grid` and its two cards, `#home-name-input`, `#away-name-input`, `#home-color-select`, `#away-color-select`, both swatches, their change listeners, the population code in `openSettings()`, and `applyTeamSettings()` (and its call in `closeSettings()`).

Also remove the **Add Pause Button** toggle, `addPauseButton`, `updatePauseButtonVisibility()`, and `pauseBtn.disabled` logic (D7).

Retain: Theme grid, Pause on Score, Log Pause/Resume Times, **Log Period Start Times** (renamed; End events are always logged, D5), Score Splash Home/Away, Show Penalty Cards. Mute stays as the existing FAB. **Public sharing is not a global setting** (D6).

---

## 7. Dual Clock & Overage Engine

### 7.1 Displays

1. **Primary (large, `#timer-display`):** `getRemaining()` formatted with **no clamping** (delete `Math.max(0, …)`). Negative values render with a leading `-` (e.g. `-02:15.0`), bold, `#ef4444`. Existing "under 2 minutes → red" rule stays.
2. **Secondary (`#elapsed-time-display`):** `getElapsed()` counting up from `00:00.0`, **uncapped** (delete `Math.min(timeLimit, elapsed)`).
3. **Overage badge:** `.overage-badge` "OVERAGE", shown next to/below the primary clock whenever `getRemaining() < 0`.

`formatTime` must zero-pad minutes to 2 digits (`04:15.2`, `-02:15.0`). Existing history strings are not rewritten. Also fix the static placeholder `00:40:00.0` in the HTML to `40:00.0`.

### 7.2 Tick

`setInterval(updateTimer, 100)` only while `matchState === 'running'`. Each tick recomputes both clocks from `Date.now()` (never increments counters), so throttling in background tabs cannot cause drift.

### 7.3 Live crossing vs. drift (`overageAcknowledged`)

Track runtime-only `lastTickAt` and `prevRemaining`. On each tick:

```javascript
const remaining = getRemaining();
const liveCross = prevRemaining > 0 && remaining <= 0
               && !overageAcknowledged
               && document.visibilityState === 'visible'
               && (now - lastTickAt) < 1500;   // gap this small means we watched it happen
if (liveCross) { playWhistle(); overageAcknowledged = true; }   // whistle once, keep ticking
```

`overageAcknowledged` resets to `false` on: Start of a period, period change, limit change in edit mode (only if the new limit > elapsed), elapsed adjustment that brings elapsed back under the limit. It is set to `true` on: live crossing, **[Continue in Overage]**, Resume into overage.

### 7.4 Drift check

`checkOverageDrift()` runs on `window.onload` (after state restore) and on `visibilitychange → visible`:

```javascript
if (matchState === 'running' && getElapsed() >= getPeriodLimit(currentPeriod) && !overageAcknowledged) {
  showOverageDialog();   // §8. Clock keeps ticking underneath.
}
```

If elapsed is still under the limit, just refresh displays.

### 7.5 Existing bug this replaces

Current `onload` restores a running clock with `accumulatedTime += Date.now() − saved.lastSavedAt`. `lastSavedAt` moves on every score/event save, but `accumulatedTime` does not include the running segment, so any reload after a mid-period score under-reports elapsed time (e.g. start at 0:00, score at 10:00, reload at 12:00 → shows 2:00). Use `saved.accumulatedTime + (now − saved.startTime)` and persist `startTime` (it is already saved; just use it).

### 7.6 Elapsed adjustment panel

Keep the existing ±1 / ±5 min panel (needed for early/late starts), now available while **running or paused**. Clamp elapsed ≥ 0; re-evaluate `overageAcknowledged` per §7.3. It does not log an event.

---

## 8. "Period Limit Exceeded" Dialog

Blocking modal (`#overage-dialog`, z-index 70): no backdrop dismiss, no ESC, nothing focusable behind it. Close any other open modal first. Only shown in `running`.

> **Period Limit Exceeded**
> Current elapsed time has passed the configured period duration. Did Period {n} end on schedule, or is the match in stoppage/overage?
> **[End Period on Time]**  **[Continue in Overage]**

**[Continue in Overage]:** `overageAcknowledged = true`, close, no history entry. Clock keeps running until the operator taps Pause.

**[End Period on Time]:**
1. `overage = getElapsed() − limit`; `endTs = new Date(Date.now() − overage).toISOString()`.
2. Halt: `accumulatedTime = 0`, `startTime = null`, clear interval.
3. If `currentPeriod < totalPeriods`: log `period_end` (`periodElapsedMs = limit`, `timestamp = endTs`, `gameTime = P{n}: {formatTime(limit)}`), `currentPeriod++`, `matchState = 'ready'`, `overageAcknowledged = false`, buttons **[Start]** | **[End / OT]**.
4. If final period: do **not** log yet. Set `accumulatedTime = limit`, `matchState = 'paused'`, then open the Final/OT prompt (§9.2) carrying `{ endTs, elapsedMs: limit }` as an override so **Match Complete** / **Add Overtime** log with those values. Cancel leaves the match paused at the limit.

---

## 9. End Period, End / OT, Overtime

### 9.1 [End Period] (paused, intermediate period)
Log `period_end` with actual `periodElapsedMs = getElapsed()` and `timestamp = now`; `currentPeriod++`; `accumulatedTime = 0`; `matchState = 'ready'`; `overageAcknowledged = false`. No confirm dialog (rollback in §10 is the undo).

### 9.2 [End / OT] prompt

| Situation | Prompt | Buttons |
| :--- | :--- | :--- |
| `ready`, P1, empty ledger | Discard this match? | **Cancel**, **Discard Match** |
| `currentPeriod < totalPeriods` | End the match early? | **Cancel**, **End Match** (= Match Complete) |
| `currentPeriod >= totalPeriods` | Match over? | **Match Complete**, **Add Overtime**, **Cancel** |

**Match Complete / End Match:** log a single `match_end` event (`period = n`, `periodElapsedMs`, text `Match Complete — End of P{n}`), stop the timer, `matchState = 'final'`, `activeGameEnded = true`, `activeGameEndedAt = now`, lock board (history stays interactive), buttons **[New Game]**, publish `status: 'final'`, stop the heartbeat.

**Discard Match:** DELETE from server (if published), clear state to `idle`.

### 9.3 Auto-behavior removed
Reaching zero never halts or advances (D1).

### 9.4 Add Overtime
Opens Match Setup in **overtime mode**: only the duration control (default = `timeLimit`, editable) plus **[Add Overtime]** / Cancel. On confirm:
1. Log `period_end` for period `n` (`periodElapsedMs` = override value if coming from §8, else `getElapsed()`), flagged `overtimeAdded: true`.
2. `totalPeriods = n + 1`; `periodLimitOverrides[n+1] = chosenMs`; `currentPeriod = n + 1`; `accumulatedTime = 0`; `matchState = 'ready'`; `overageAcknowledged = false`.

---

## 10. Event Ledger, History & Rollback

### 10.1 Entry schema

Insertion order in `scoreHistory` is the display order. **Never sort by timestamp** (an "End on Time" timestamp can precede earlier entries by design).

```javascript
{
  id: crypto.randomUUID(),
  type: 'score' | 'card' | 'event',
  subtype: 'period_start' | 'period_end' | 'match_end' | 'pause' | 'resume',  // events only
  period: currentPeriod,
  periodElapsedMs: elapsedInPeriod,
  gameTime: `P${period}:${formatTime(periodElapsedMs)}`,   // e.g. "P1:04:15.2"
  timestamp: new Date().toISOString(),                     // UTC anchor
  // score/card only:
  teamId, teamName, teamColor, currentScore, cardType, degree,
  // events only:
  text,                                                    // e.g. "End of P1 3:05 pm"
  overtimeAdded: true,                                     // period_end created by Add Overtime
  note: ''
}
```

Keep the existing `gameTime` format (`P1:` with no space) so existing render code and viewers keep working.

### 10.2 Deleting entries

* `score` delete: decrement the team score (existing) **and recompute** the `currentScore` snapshot on all later score entries (existing entries go stale otherwise).
* `card` and other events: delete only that entry.
* **Boundary events (`period_end`, `match_end`):** deletable **only if** it is the latest boundary in the ledger **and** no `score`/`card` entries follow it. Otherwise show toast "Remove later events first" and do nothing. Trailing system events (`period_start`, `pause`, `resume`) that follow it are removed automatically.

### 10.3 Rollback execution

When a permitted boundary event for period `n` is deleted:
1. Halt the clock if running (rollback always ends in `paused`).
2. `currentPeriod = n`; `periodDisplay.textContent = 'P' + n`.
3. `accumulatedTime = event.periodElapsedMs`; `startTime = null` (**restore the stored value, do not reconstruct from timestamps**).
4. If `subtype === 'match_end'`: `activeGameEnded = false`, `activeGameEndedAt = null`, unlock board, `matchState = 'paused'`.
5. If `overtimeAdded`: `totalPeriods--`, delete `periodLimitOverrides[n+1]`.
6. `overageAcknowledged = true`; if `elapsed > limit` render overage (no dialog, since paused).
7. `saveState()` and publish (including `status`).

Legacy entries without `subtype` are matched with `/^End of P(\d+)/` on `text` and have no stored `periodElapsedMs`; for those, block rollback with the same toast.

---

## 11. Publishing & Server Contract

Publish through the existing `publishActiveGameState*` path, **only** when `isPublic` is true and `matchState !== 'idle'`. Payload adds: `status` (`ready|running|paused|final`; also send `isPaused` and `timerRunning` for older readers), `totalPeriods`, `timeLimit` (current period's effective limit), `elapsedMs` (period elapsed), `isPublic`, `startedAt`, `endedAt`, `writeToken`. Heartbeat (20 s) runs only while `ready/running/paused`; on `final` publish once and stop (otherwise `expiresAt` is refreshed forever). Final games keep the existing 24 h expiry.

### `active-games.php` changes
* On POST: if the stored game has a `writeTokenHash`, require `hash('sha256', $payload['writeToken'])` to match (`hash_equals`), else `403`. If the game has no hash (new or legacy), store the hash (**claim on first write**). Never store or echo the raw token.
* On DELETE: same token check (legacy games without a hash may be deleted/claimed).
* On GET (list and by id): strip `writeToken` and `writeTokenHash` from every response.
* Wrap read-modify-write in `flock(LOCK_EX)` (currently unguarded; concurrent posts can drop games).
* Add `htdocs/ScoreBoard/.htaccess` denying direct access to `active-games.json` (it currently contains full payloads and would contain hashes).
* Private games are never POSTed. This is Phase 1; DB-backed storage / "My Games" / long-term history is a separate spec.

### Reader updates
* `ScoreBoardActiveGames.html`: treat `status` of `final` or `game_over` as "game over"; `ready` → "ready"; show `P{n}/{totalPeriods}`.
* `ScoreBoardViewer.html`: render `card` entries (currently mislabeled "X scored"), show a Final badge, keep period-elapsed display (append `+` overage styling optional).

---

## 12. CSS Additions (`scoreboard.css`)

```css
/* Dimmed/locked state. Apply to the score row, penalty-cards row and clock block
   individually. Do NOT wrap the history table inside a locked parent: a child's
   opacity:1 cannot undo a parent's opacity:0.45. Also set the `inert` attribute so
   keyboard focus is blocked, not only pointer events. */
.board-locked {
  opacity: 0.45;
  pointer-events: none;
  transition: opacity 0.2s ease-in-out;
}

/* Kept for clarity; history sits outside locked wrappers so this is a safeguard only. */
.history-interactive {
  pointer-events: auto !important;
}

/* Ellipsis button; the card wrapper must get position: relative */
.card-menu-btn {
  position: absolute;
  top: 16px;
  right: 16px;
  background: transparent;
  border: none;
  color: #9ca3af;
  font-size: 1.5rem;
  line-height: 1;
  padding: 4px 8px;
  cursor: pointer;
  border-radius: 8px;
  transition: color 0.15s, background 0.15s;
}
.card-menu-btn:hover {
  color: #ffffff;
  background: rgba(255, 255, 255, 0.1);
}

/* Overage indicator badge */
.overage-badge {
  font-size: 0.65rem;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #ef4444;
  background: rgba(239, 68, 68, 0.15);
  border: 1px solid rgba(239, 68, 68, 0.4);
  padding: 2px 8px;
  border-radius: 999px;
  margin-top: 4px;
}

/* Primary clock in overage */
.timer-overage {
  color: #ef4444 !important;
  font-weight: 900;
}

/* Blocking dialog above every other modal */
#overage-dialog { z-index: 70; }
```

DOM notes: give the main card `position: relative` and extra top padding so ⋮ doesn't overlap the away team label; wrap score row + cards row + clocks in locked-able containers, leaving the history block outside them.

---

## 13. Acceptance Tests

1. Fresh load (no state): board dimmed, only **New Game**, no ⋮. History empty.
2. New Game → setup modal → Start Match: board unlocks, **Start** | **End / OT**; UUID + 64-hex token exist; state persisted.
3. Start: only **Pause** visible, ⋮ hidden. Score/cards work. Period display does not respond to taps.
4. Pause in P1 of 2: **Resume** | **End Period** | **End / OT**. End Period → P2 ready, clocks reset, End of P1 logged with the true elapsed.
5. Pause in P2 of 2: no **End Period**.
6. Let the clock cross zero while watching: whistle once, no halt, `-mm:ss` in red, OVERAGE badge, secondary clock keeps counting past the limit. Lock/unlock phone: **no** dialog.
7. Start, background the app past the limit, return: dialog appears immediately, clock already shows overage and keeps ticking behind it.
8. Dialog → **Continue in Overage**: no history entry; no re-prompt until next period.
9. Dialog → **End Period on Time** with a mid-period pause earlier: End event's `gameTime` = exactly the limit; its timestamp = crossing moment (not `start + limit`); next period ready at full limit.
10. Same on the final period: Final/OT prompt appears; Cancel keeps match paused at the limit.
11. End / OT in final period → **Match Complete**: board dimmed, **New Game**, history still tappable (note, share, delete).
12. Delete the latest `End of P1` (no scores after it): back in P1 paused with the stored elapsed; overage shown if it exceeded the limit. Deleting an older boundary, or one followed by scores, is refused with a toast.
13. Delete `Match Complete` in `final`: match reopens paused in the last period.
14. **Add Overtime** from the final period: `totalPeriods + 1`, OT period uses its own duration; deleting the resulting boundary reverts `totalPeriods`.
15. Reload while running after a mid-period score: elapsed is correct (regression test for §7.5).
16. Load a pre-v2 saved state (running and paused variants): migrates without errors, board state is sensible.
17. Ready state with empty ledger → End / OT offers **Discard Match**; game disappears from Active Games.
18. Guest: no sharing toggle, game is public. Signed-in: toggle defaults ON; setting private removes it from Active Games and stops publishing.
19. POST to `active-games.php` for an existing id with a wrong/missing token → 403; GET responses contain no token/hash; `active-games.json` is not directly downloadable.
20. Settings panel has no team fields and no Add Pause toggle; theme, mute and remaining toggles still work.

---

## 14. Out of Scope (separate specs)

DB-backed game storage, "My Games" history, longer retention, delete-from-history controls for signed-in users, per-team sport presets, and any change to `suite-profile.js` or the launcher.
