# Antigravity Technical Specification: ScoreBoard Lifecycle, Flow & Timeline Engine

## 1. Scope & Core Objectives
Refactor the match lifecycle, control flow, setup modals, and period timing architecture in `index.html`:
* **Streamlined Control Bar:** Display only the actions relevant to the current match state.
* **Dedicated Match Setup:** Remove team configurations from the global Settings panel and route them exclusively through a stacked modal triggered by **New Game**, the top-right ellipsis menu (⋮), or overtime extensions.
* **Fail-Safe Operation:** Prohibit period advancement and match termination while the clock is ticking; all state changes require an explicit pause.
* **UTC Master Timeline & Dual Clocks:** Primary countdown and secondary period-elapsed clocks anchored to UTC[cite: 1]. Overrun past the period duration seamlessly transitions into overage/stoppage.
* **Immediate Drift Dialog with Active Background Ticking:** If the app wakes up or reloads after the period duration has passed, pop the intervention dialog immediately while letting the clock tick in the background.
* **Event Ledger & Rollback:** Anchor matches to an immutable UTC timeline where deleting an `"End of Period"` history entry rolls the board back to the prior period without state corruption[cite: 1].

---

## 2. Match State Machine & Button Rules
### State-by-State Button Matrix
| State | Board Controls (Score, Period, Cards) | Top-Right Ellipsis (⋮) | Visible Buttons | Description |
| :--- | :--- | :--- | :--- | :--- |
| **Idle / Pre-Game** | **Locked & Dimmed** (`opacity: 0.45; pointer-events: none;`) | Hidden | **`[New Game]`** (Full width) | Initial state on fresh load or after match finalization. |
| **Game Ready** (Configured, clock not yet started) | **Unlocked** | Visible | **`[Start]`** \| **`[End / OT]`** | Game is configured; waiting for the opening whistle. |
| **Running** | **Unlocked** | Hidden (or disabled) | **`[Pause]`** (Full width) | Clock is actively ticking. No period advance or game termination allowed. |
| **Paused (Intermediate Period, e.g. P1 of 3)** | **Unlocked** | Visible | **`[Resume]`** \| **`[End Period]`** \| **`[End / OT]`** | Handles timeouts, injuries, ref adjustments, or early whistle period advances. |
| **Paused (Final Period, e.g. P3 of 3)** | **Unlocked** | Visible | **`[Resume]`** \| **`[End / OT]`** | `[End Period]` is omitted because there is no subsequent scheduled period. |
| **Game Over (Final)** | **Locked & Dimmed** (Score History remains **interactive**) | Hidden | **`[New Game]`** (Full width) | Scoreboard is frozen. Operators can view, add notes, delete entries, and share/SMS history. |

---

## 3. Match Setup Modal ("New Game" & "Edit Match")

### Modal Triggers
1. **`[New Game]` Button:** Opens modal in creation mode.
2. **Top-Right Ellipsis (⋮):** Visible during active games; opens modal in edit mode.
3. **"Add Time / Overtime" Option:** Triggered via the `[End / OT]` prompt or automatic period expiration.

### Stacked Layout Elements
* **Header:** "New Game Setup" or "Edit Match Details" + Close (✕) button.
* **Home Team Section:**
  * Team Name text input (defaults to "Us" or previous team).
  * Color Picker dropdown or circular swatches.
* **Away Team Section:**
  * Team Name text input (defaults to "Them" or previous team).
  * Color Picker dropdown or circular swatches.
* **Match Rules:**
  * **Total Periods:** Number selector / stepper (default: `2`, options `1` to `8`).
  * **Period Duration:** Preset buttons (`12m`, `20m`, `35m`, `40m`) + Roller picker button (Minutes : Seconds).
* **Actions:**
  * **Create Mode (`[Start Match]`):**
    * Generates new RFC4122 v4 UUID `activeGameId`.
    * Generates 64-char hex `activeGameWriteToken`.
    * Sets `activeGameStarted = true`, `activeGameEnded = false`.
    * Records `activeGameStartedAt = new Date().toISOString()`.
    * Unlocks the scoreboard and displays **`[Start]`** and **`[End / OT]`**.
    * Persists snapshot locally and syncs to DB.
  * **Edit Mode (`[Save Changes]`):**
    * Updates names, colors, total periods, and time limits without regenerating UUIDs.
    * Updates existing references in `scoreHistory`.

### Global Settings Panel Cleanup
* Remove team name inputs (`#home-name-input`, `#away-name-input`).
* Remove team color selectors (`#home-color-select`, `#away-color-select`).
* Retain strictly global preferences: Themes, Sound/Mute, Add Pause toggle, Pause on Score toggle, Log Start/Stop/Pause toggles, Score Splash toggles, Show Cards toggle, and Public Sharing toggle.

---

## 4. Dual Clock & Overage / Stoppage Engine

### Clock Definitions
1. **Primary Clock (Top / Large Display):** Count-down from the configured `timeLimit`.
   * If elapsed time in the period exceeds `timeLimit`, the clock continues ticking into negative/overage (e.g., `-02:15.0`) in bold red (`#ef4444`).
   * An auxiliary badge labeled **"OVERAGE"** or **"EXTRA TIME"** appears adjacent to the clock.
2. **Secondary Clock (Bottom Display):** Period Elapsed Time.
   * Counts strictly up from `00:00.0`.
   * Represents the in-period event time for logging and ref alignment.

### Period Expiration Logic
* When `remaining <= 0` while the clock is running live on the field:
  * Play whistle sound.
  * Halt timer (`pauseTimer()`).
  * **If `currentPeriod < totalPeriods`:**
    * Automatically advance to `currentPeriod + 1`.
    * Log `"End of P{n} (Time)"`.
    * Reset period elapsed clock to `00:00.0` and remaining clock to `timeLimit`.
    * Update button bar to **`[Start]`** and **`[End / OT]`**.
  * **If `currentPeriod >= totalPeriods`:**
    * Do not auto-advance.
    * Present modal prompt:
      * **Button 1: "Match Complete"** -> Transitions game to `final`, saves state, locks board, displays `[New Game]`.
      * **Button 2: "Add Time / Overtime"** -> Reopens Match Setup modal with total periods incremented or duration unlocked for extra stoppage minutes.

---

## 5. Mobile Background Drift & Immediate Overage Prompt

### Trigger Conditions
On `visibilitychange` (state becomes `visible`) and `window.onload`:
1. Calculate `currentPeriodElapsed = (now - periodStartTimeUtc) - totalPeriodPausedMs`.
2. If `timerRunning === true`:
   * **Active Live Ticking:** The `setInterval` loop continues ticking without interruption. Both clocks update immediately (primary displays live negative overage in red; secondary displays total period elapsed).
   * **Under Period Duration:** If `currentPeriodElapsed < timeLimit`, update the displays and do nothing else.
   * **Exceeded Period Duration:** If `currentPeriodElapsed >= timeLimit` and the overage state has not yet been resolved:
     * **Immediately display the modal dialog** over the running board:
       > **Period Limit Exceeded**  
       > *Current elapsed time has passed the configured period duration. Did Period {n} end on schedule, or is the match in stoppage/overage?*
       > 
       > **`[End Period on Time]`** &nbsp;&nbsp;&nbsp;&nbsp; **`[Continue in Overage]`**
     * **If `[End Period on Time]` is tapped:**
       * Halts timer (`timerRunning = false`).
       * Logs history event `"End of P{n}"` with timestamp strictly anchored to `(periodStartTimeUtc + timeLimit)` (e.g., exactly at 30:00.0).
       * Advances to `Period {n+1}` (or triggers Final/OT prompt if final period).
       * Resets clock to fresh `timeLimit` in stopped/ready state.
       * Updates buttons to **`[Start]`** and **`[End / OT]`**.
     * **If `[Continue in Overage]` is tapped:**
       * Dismisses modal immediately.
       * Adds no history entry.
       * Clock keeps ticking live in overage until the operator manually taps **`[Pause]`**.

---

## 6. Event Ledger, History & Rollback System

### History Event Schema
Every recorded event captures:
```javascript
{
  id: "evt-uuid",
  type: "score" | "card" | "event",
  period: currentPeriod,
  periodElapsedMs: elapsedInPeriod,
  gameTime: `P${currentPeriod}: ${formatTime(elapsedInPeriod)}`, // e.g. "P1: 04:15.2"
  timestamp: new Date().toISOString(), // UTC Anchor
  teamId: "home" | "away",
  teamName: "...",
  teamColor: "...",
  currentScore: "1-0",
  note: ""
}
Period Deletion & Rollback Execution
When an entry of type "event" matching text "End of P{n}" is deleted via removeSelectedHistoryEntry():

Decrement currentPeriod back to the deleted period's index (n).

Update periodDisplay.textContent = 'P' + currentPeriod.

Reconstruct period elapsed time based on the active UTC timeline.

Transition state machine to Paused in that restored period.

If the elapsed time already exceeds the period duration, display the clock in overage mode without stopping.

Trigger saveState() and publish sync update.

7. CSS Additions & UI Selectors
/* Dimmed/locked container state for pre-game and game-over */
.board-locked {
  opacity: 0.45;
  pointer-events: none;
  transition: opacity 0.2s ease-in-out;
}

/* History table remains explicitly interactive during game over */
.history-interactive {
  pointer-events: auto !important;
  opacity: 1 !important;
}

/* Top-right card menu ellipsis button */
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