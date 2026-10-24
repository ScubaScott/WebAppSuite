# HeadCount — Build Specification

**App:** HeadCount (working name; rename freely)
**Suite:** Web App Suite — new app at `htdocs/HeadCount/`
**Spec version:** 1.0 · 2026-10-23
**Audience:** Antigravity build agent

---

## 1. Purpose

A single-operator phone app for a weekly bar game: players each guess how many people will show up (typically ~130). Each guess costs $1. When the actual count is announced, the closest guess wins the whole pot. Ties split the pot.

The app must make entering names and guesses **fast** during a busy night, keep a reusable list of names from week to week, and keep a simple history of past games.

---

## 2. Scope

### In scope
- One open game at a time; entering names and guesses; editing them until the result is entered.
- A reusable **Pool** of names for one-tap entry.
- Result entry with a preview, then a permanent lock.
- Results display with the winner(s), payouts, and each guess's miss.
- A history of locked games.

### Out of scope (v1)
- Sync to a server (data model is prepared for it; see §4.5).
- Export/import or backup.
- Multiple operators or devices, broadcast or display mode.
- Stats across games (win counts, leaderboards).
- Payment handling beyond the implied $1 per entry.

---

## 3. Platform & Constraints

| Constraint | Requirement |
|---|---|
| Technology | Plain HTML/CSS/JS web page, no framework requirement, phone-agnostic |
| Primary target | Android, Chrome |
| Must also work | Any modern mobile browser (incl. iPhone Safari), desktop browsers |
| Connectivity | Fully functional offline; no network calls required at runtime |
| Storage | Browser site storage only — **IndexedDB** preferred. **No cookies.** |
| Storage durability | Request persistent storage from the browser on first run. Installable to home screen (web app manifest) but not required. |
| Data-loss policy | **Accepted risk.** If site data is cleared, the pool and history are lost and the app starts empty. No backup feature. |
| Suite conventions | Standard suite **back link at top** and **version footer at bottom** on every page. Back returns only to the page that opened it (Main → suite app list; History → Main). |
| Touch targets | Minimum ~44px for all tappable elements |

---

## 4. Data Model

All records carry a unique ID and created/updated timestamps (sync readiness).

### 4.1 PoolName
A shortcut name for fast entry. Has **no link** to games or history.

| Field | Notes |
|---|---|
| id | unique |
| name | trimmed, 1–30 chars, unique across the pool (case-insensitive) |
| createdAt, updatedAt | timestamps |

Deleting a PoolName is a **hard delete**. It has no effect on any game or history.

### 4.2 Game
The current game. At most **one** Game record exists at any time.

| Field | Notes |
|---|---|
| id | unique |
| status | `Open` or `Locked` |
| startedAt | timestamp; defines the game's date |
| actual | integer, set only at lock |
| lockedAt | timestamp, set at lock |
| guesses | list of Guess |

### 4.3 Guess
Belongs to the current Game. Stores the name as **plain text**.

| Field | Notes |
|---|---|
| id | unique |
| name | text; unique within the game (case-insensitive) |
| value | non-negative whole number; unique within the game |
| createdAt, updatedAt | timestamps |

### 4.4 HistoryEntry
An immutable text snapshot written once, at lock. Never edited or deleted by the app.

| Field | Notes |
|---|---|
| id | unique |
| gameId | id of the source game (informational only) |
| date | date of the game's `startedAt` |
| actual | integer |
| entryCount | number of guesses |
| pot | entryCount × $1 |
| winners | list of { name, guess, miss, payout } — 1 or 2 items |
| guesses | full list of { name, value, miss }, sorted by value |
| lockedAt | timestamp |

### 4.5 Derived values (never stored on the Game)
- **Pool view** = all PoolNames whose name (case-insensitive) is not already a Guess name in the current Open game.
- **Pot** = number of guesses × $1.
- **Miss** = guess − actual (signed).
- **Winners and payouts** = calculated (§6), then frozen into the HistoryEntry at lock.

### 4.6 Sync readiness
No sync in v1. IDs and timestamps on every record allow a later sync design without migration. History entries are immutable, which makes later merging easy.

---

## 5. Game Lifecycle

```
 [No Game] --New game--> [Open] --Enter actual--> (Preview) --Confirm--> [Locked]
                           ^                          |
                           +--------Back/Cancel-------+
 [Locked] --New game--> [Open]
```

| State | Persisted? | Add/edit/remove guesses | Enter/change actual | Available actions |
|---|---|---|---|---|
| No Game | — | No | No | New game |
| Open | Yes | **Yes** | — | Enter actual (needs ≥ 2 guesses) |
| Preview | **No** (UI only) | No | Yes (via Back) | Confirm / Back |
| Locked | Yes | No | No | New game only |

### Rules
1. **Lock is permanent.** No undo, no reopen, no correction of the actual after confirm.
2. **Confirm is atomic:** write the HistoryEntry and set the Game to `Locked` together. If either fails, neither is applied, and the operator sees an error and stays in Preview.
3. **New game** (from Locked) discards the locked Game record (its HistoryEntry remains) and creates a new Open game with no guesses. Multiple games on the same night are allowed.
4. **Preview is not saved.** If the app is closed or reloaded during Preview, it reopens in Open with all guesses intact.
5. **Unfinished game:** when the app opens and finds an Open game whose `startedAt` is on an earlier calendar day, prompt: *"Unfinished game from [date] with N guesses. Discard or Keep?"* Discard deletes it with nothing written to history; Keep resumes it.
6. **Minimum entries:** Enter actual is disabled until the game has at least 2 guesses, with a visible reason ("Need at least 2 guesses").

---

## 6. Winner & Payout Rules

1. Calculate each guess's absolute distance from the actual.
2. The winner is the guess with the smallest distance. **Plain closest wins** (going over is allowed).
3. Because guesses are unique, at most **2** winners are possible (one under, one over by the same distance). An exact match always wins alone.
4. **Pot** = entries × $1. The full pot goes to the winner(s); no house cut.
5. **Tie:** the pot is split evenly. Display to the cent (e.g., a $25 pot split gives $12.50 each). An even split of whole dollars between 2 never needs rounding beyond $0.50.

---

## 7. Validation

| Check | Applies to | Behavior |
|---|---|---|
| Name required | Entry | Add disabled while empty |
| Name length | Entry, pool rename | 1–30 chars after trimming |
| Duplicate name in game | New guess | Blocked inline: "Already entered" |
| Duplicate name in pool | Pool add/rename | Blocked inline: "Already in pool" |
| Guess required | Entry | Whole number ≥ 0; numeric keypad |
| **Duplicate guess** | New and edited guesses | **Live** inline as soon as the value matches: "Taken by [name]". Submit disabled. |
| Typo guard (guess) | New and edited guesses | Value outside 50–300 shows a soft warning; submit requires a second tap ("Add anyway") |
| Typo guard (actual) | Enter actual | Same soft warning outside 50–300 |
| Name match ignores case and surrounding spaces | All name checks | "mike " = "Mike" |

---

## 8. Screens

### 8.1 Main Screen (by state)

**Layout, top to bottom:**
1. Suite back link (to suite app list)
2. Game header: game date, entries count, pot
3. Content by state (below)
4. Version footer

#### No Game
- A single prominent **New game** button.
- Link to History.

#### Open
1. **Entry bar — pinned at the top** so it stays visible above the on-screen keyboard.
   - Name field, guess field (numeric keypad), Add button.
   - Typing in the name field **filters the pool** live.
   - Pressing Enter in the guess field submits.
2. **Pool** — expanded, directly below the entry bar.
   - Names as compact tap targets in an alphabetical grid (2–3 across) so a pool of 30–40 fits on about one screen.
   - **Tap a name → it loads into the name field and the guess field takes focus** (numeric keypad opens).
   - Tapping a different name before submitting replaces it.
   - Header has an **Edit pool** toggle (§8.2).
   - Empty state: "Pool is empty — type a name above."
3. **Tonight's list** — sorted by guess, ascending.
   - Each row: name, guess.
   - Header: entry count and pot.
   - **Tap a row → edit mode** (§9.3).
4. **Enter actual** button (disabled if fewer than 2 guesses).
5. Link to History.

#### Preview (modal or full-screen panel over Open)
- Actual entered (large).
- Entries and pot.
- Winner name(s) — **large**, so a wrong result is obvious — with each winner's guess, miss, and payout.
- Buttons: **Confirm & lock** (primary), **Back** (returns to Open, keeps the actual pre-filled).
- Text: "This can't be undone."

#### Locked (results)
- Pool and entry bar are hidden.
- Header shows the actual and pot.
- **Results list** sorted by guess, ascending:
  - Every row shows name, guess, and signed miss (e.g., "−4", "+7", "0").
  - Winner row(s) **highlighted in place**, with a payout badge ("$12.50 each" on a tie).
  - A divider row **"▶ Actual: N"** inserted where the actual falls in the sorted order. If the actual equals a guess, the divider goes directly above that row.
- **New game** button.
- Link to History.

### 8.2 Edit Pool Mode
Toggled from the pool header; available whenever the pool is visible (any time no game is locked on screen, including No Game state — show the pool with an Edit toggle there too).

| Behavior | Rule |
|---|---|
| Tapping a name | Does **not** load it; opens rename instead |
| Remove | Each name shows a **×**; tapping it asks for confirmation, then hard-deletes |
| Add | An "Add name" field for adding names without a game |
| Entry bar | Disabled while in edit mode |
| Names in tonight's game | Not shown (they're not in the pool view), so they can't be edited or removed mid-game |
| Exit | Toggle again; also exits automatically when leaving the screen |

### 8.3 History Screen
- Suite back link (returns to Main) and version footer.
- Newest game first.
- Each game is one summary line: date, actual, winner name(s), payout.
- Tap a line to expand the full guess list (name, guess, miss), sorted by guess, with the winner(s) highlighted and the Actual divider, matching the results view.
- Read-only. No totals across games.
- Empty state: "No games yet."

---

## 9. Key Flows

### 9.1 Add a guess from the pool (primary, must be fastest)
1. Tap a name in the pool → name loads, guess field focused, numeric keypad up.
2. Type the guess → duplicate and typo checks run live.
3. Submit (Enter or Add).
4. The guess appears in tonight's list at its sorted position, **briefly highlighted and scrolled into view**.
5. The name disappears from the pool.
6. Fields clear and the **keyboard is dismissed** so the pool is fully visible for the next tap.

Target: one tap plus the digits plus Enter per player.

### 9.2 Add a guess for a new name
1. Type a name in the name field. The pool filters as you type; if a match exists, tapping it continues as §9.1.
2. With no match, move to the guess field and submit.
3. The guess is added **and the name is added to the pool** automatically.

### 9.3 Edit or remove a guess (Open only)
1. Tap a row in tonight's list → the entry bar switches to **edit mode**: name shown read-only, guess editable.
2. Actions: **Save** (same validation as a new guess; a guess equal to its own current value is not a duplicate), **Remove** (with confirmation; deletes the guess and the name returns to the pool), **Cancel**.
3. To change a name, remove the guess and re-add it.

### 9.4 Announce and lock
1. Tap Enter actual → enter the number (numeric keypad, typo guard applies).
2. Preview shows the calculated result.
3. Back to adjust, or Confirm & lock → HistoryEntry written, game Locked, results shown.

### 9.5 Start the next game
From Locked, tap New game → empty tonight's list, full pool visible.

---

## 10. Edge Cases

| Case | Expected behavior |
|---|---|
| App closed mid-entry | All saved guesses persist; any unsubmitted field contents may be lost |
| App closed during Preview | Reopens in Open, guesses intact, nothing locked |
| Open game from an earlier day | Discard/Keep prompt (§5 rule 5) |
| Fewer than 2 guesses | Enter actual disabled with reason |
| Exact match | Single winner, miss 0, divider directly above the row |
| Equidistant tie | Two winners, both highlighted, pot split |
| Guess edited to a taken value | Blocked inline, same as new entry |
| Name typed that exists in pool with different case | Treated as the pool name; no duplicate pool entry |
| Pool name renamed or deleted | No effect on history (history is plain text) |
| Lock write fails | Stays in Preview with an error; nothing partially saved |
| Persistent storage request denied | App works normally; no warning needed |
| Site data cleared | App starts empty (accepted risk) |
| Same night, second game | Allowed via New game after lock |
| Game spans midnight | Dated by `startedAt`; the unfinished-game prompt only triggers on the next app open on a later day, not mid-game. Implementation note: the prompt check runs at app launch only. |

---

## 11. Acceptance Criteria

1. With an empty store, the operator can create a game, add 3 new names with guesses, enter an actual, preview, and lock — and the result appears in History.
2. In the next game, those 3 names appear in the pool; tapping one loads it with the numeric keypad open in **one tap**.
3. After submitting a guess, the keyboard closes, the name leaves the pool, and the new row is highlighted in the sorted list.
4. Typing a guess value already in use shows "Taken by [name]" before submission and blocks it.
5. A guess outside 50–300 requires a second confirmation tap.
6. Enter actual stays disabled until there are 2 guesses.
7. Preview shows correct winner(s) and payout for: exact match, single closest, and an equidistant tie (pot split to the cent).
8. After lock, no guess can be added, edited, or removed, and the actual can't change; only New game is available.
9. Results are sorted by guess with signed misses, winner(s) highlighted in place, and an Actual divider in the correct position.
10. Deleting or renaming a pool name in Edit pool mode leaves every History entry unchanged.
11. Reloading the page at any point preserves the pool, the current game, and history. Reloading during Preview returns to Open.
12. Opening the app on a later day with an unfinished game shows the Discard/Keep prompt; Discard records nothing.
13. The app works with networking disabled and sets no cookies.
14. Main and History show the suite back link and version footer; back links follow the suite rule.

---

## 12. Assumptions

These were proposed during design and not explicitly confirmed; adjust if needed.
- Miss is measured relative to the actual number.
- "▶ Actual" divider row is shown in results and expanded history.
- Unfinished games from an earlier day prompt Discard/Keep and are never recorded.
- Minimum of 2 guesses to enter the actual.
- Game date is the start date.
- Typo guard range is 50–300 (soft warning only).
- Entry fee is a fixed $1 (not editable).
- History screen: newest first, expandable summary lines, no totals.
- Working app name "HeadCount" and folder `htdocs/HeadCount/`.
