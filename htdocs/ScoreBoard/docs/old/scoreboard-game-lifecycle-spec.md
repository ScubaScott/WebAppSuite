# ScoreBoard — Game Lifecycle Redesign Spec

**Target:** Antigravity (implementation agent)
**Scope:** `htdocs/ScoreBoard/index.html`, `htdocs/ScoreBoard/ScoreBoardMyGames.html`, `htdocs/api/games.php`, `htdocs/api/schema.sql`, `htdocs/api/setup.php`
**Status:** Approved design. Implement as specified. Items under §11 "Assumptions" should be implemented as written unless the owner says otherwise.

---

## 1. Problem

Games are written to the server (`suite_games`) before they are actually played. They then show up in **Active Games** and **My Games** as empty 0–0 entries.

**Root cause:** the single boolean `activeGameStarted` in `index.html` means three different things: "a game is configured," "the clock has started," and "the server may know about this game." Every sync path is gated only on that flag.

Where it becomes `true` too early:

| Path | Current behavior | Effect |
|---|---|---|
| `saveMatchSetup()` in `create` mode (setup button labeled "Start Match") | Mints the ID, sets `activeGameStarted = true` and `activeGameStartedAt = now`. The clock is **not** running (`matchState = 'ready'`) | The next `saveState()` → `publishActiveGameState()` → server INSERTs a `live` 0–0 row |
| Any later `saveState()` (mute, theme, visibility, etc.) | Publishes again | Bumps `last_activity_at` and keeps the phantom game "fresh" |
| `beforeunload` / `pagehide` / `visibilitychange` | `flushBeaconSync()` | Can create the row even if the user did nothing else |
| Login cloud reconciliation (`window.onload`) | Pushes the local game as `status: final, ended_by: new_game` | If that game was never synced, the upsert **creates** a brand-new `final` row in My Games |
| `startTimer()` when `activeGameStarted` is false | `loadOrCreateActiveGameId()` reuses the ID still in `localStorage` | May reuse a previous game's ID and collide with or revive an old row |

Related bugs:

- The stale-game "Finish" button sends `ended_by: 'abandoned'`, but `games.php` whitelists only `user`, `new_game`, and `timeout`, so the value is silently stored as `NULL`.
- `games.php?action=delete` deletes games in any status. Deleting a `live` game is undone by the next sync upsert, which re-inserts the row.

---

## 2. Core Rule

> **A game exists on the server if and only if its clock has been started at least once.**
> It does not matter how long it lasts or what the score is. A 10-second 0–0 game is a valid recorded game.
> Cleanup is after the fact: users delete their own `final` games in My Games, guest games expire after 24 hours (existing behavior), and admins clean up manually.

---

## 3. Lifecycle Model

Replace the boolean with **two** client fields. Game lifecycle and clock state are separate concerns. The existing `matchState` (`idle | ready | running | paused | final`) stays as the **clock/board** state and is not replaced.

| New field | Type | Meaning |
|---|---|---|
| `gameLifecycle` | `'idle' \| 'draft' \| 'live' \| 'final'` | Where the *game* is in its life |
| `gameCommitted` | boolean | The server has (or should have) a row for this `game_id`. It becomes `true` exactly once, at the first clock start, and never reverts for that game |

### 3.1 State diagram

```
                 Setup "Ready"                 First Start (whistle)
   ┌──────┐   ───────────────▶   ┌───────┐   ─────────────────────────▶   ┌──────┐
   │ idle │                      │ draft │                                │ live │
   └──────┘   ◀───────────────   └───────┘                                └──┬───┘
       ▲        (discard draft:      │  ▲                                     │
       │        New Game → new       │  │ Edit setup (stays draft)           │ End Game / stale Finish /
       │        draft replaces it)   └──┘                                     │ server timeout / New Game
       │                                                                      ▼
       │                                                                  ┌───────┐
       └────────────── New Game (opens setup; old game stays final) ──────│ final │
                                                                          └───────┘
```

### 3.2 Transition table

| From | Trigger | To | `gameCommitted` | Server effect |
|---|---|---|---|---|
| `idle` | Setup modal → **Ready** | `draft` | `false` | None |
| `draft` | Setup modal edit → Ready | `draft` | `false` | None |
| `draft` | New Game → Ready | `draft` (new ID) | `false` | None. The old draft is discarded locally |
| `draft` | Page reload | `draft` | `false` | None. The draft is restored from `localStorage` |
| `draft` | Tab close / `pagehide` | — | `false` | None. No beacon is sent |
| `draft` | **First `startTimer(false)`** | `live` | **`true`** | First sync INSERTs the row (`status: live`) |
| `live` | Pause / Resume / End Period / scoring / edit | `live` | `true` | Normal sync (unchanged) |
| `live` | End Game (`endCurrentGame`) | `final` | `true` | Sync `status: final, ended_by: user` |
| `live` | Stale modal → Finish | `final` | `true` | Sync `status: final, ended_by: abandoned` |
| `live` | New Game → Ready | `final` (old) → `draft` (new) | old `true`, new `false` | Old game synced `final / new_game`. Nothing sent for the new draft |
| `live` | Server 3-hour inactivity timeout | `final` (server side) | — | Existing lazy finalizer (`ended_by: timeout`) |
| `final` | New Game → Ready | `draft` (new ID) | `false` | None |

**Invariants**

- `gameCommitted === true` ⇒ `gameLifecycle ∈ {live, final}`.
- `gameLifecycle === 'draft'` ⇒ `gameCommitted === false` and `game_id` is non-null.
- `gameLifecycle === 'idle'` ⇒ `game_id` is null.
- A `game_id` is used for exactly one game. It is minted fresh every time a draft is created and **never** read back from the legacy `ACTIVE_GAME_ID_KEY` to start a new game.

---

## 4. Client Changes — `ScoreBoard/index.html`

Behavioral requirements per function. Keep existing names where possible.

### 4.1 State & persistence

| Item | Requirement |
|---|---|
| New state | Add `gameLifecycle` and `gameCommitted` as module-level variables alongside the existing `activeGame*` variables |
| `activeGameStarted` | Retire it. All reads are replaced by `gameCommitted` (for sync gating) or `gameLifecycle` (for UI) |
| `saveState()` | Persist both new fields in the `timerStateV7` object. `saveState()` must continue writing to `localStorage` and `SuiteProfile.saveAppData` in all states, but must only call `publishActiveGameState()` when `gameCommitted` is true |
| `loadOrCreateActiveGameId()` | Stop using it to start games. ID minting happens only in the draft-creation path (§4.2) via `generateUuidV4()` + `generateWriteToken()` |
| `activeGameStartedAt` | Set **only** at the draft → live transition, to the whistle time. Not at setup |

### 4.2 Setup modal

| Item | Requirement |
|---|---|
| Button label | In `create` mode, rename "Start Match" → **"Ready"**. Edit and overtime modes are unchanged |
| `saveMatchSetup()` (`create`) | (1) If the current game is `live`, finalize it (`publishActiveGameState('final', 'new_game')`) as today. If it is a `draft`, discard it and send nothing. (2) Mint a new `activeGameId` and `activeGameWriteToken`. (3) Set `gameLifecycle = 'draft'`, `gameCommitted = false`, `activeGameEnded = false`, `activeGameStartedAt = null`, `activeGameRev = 0`. (4) Reset scores, period, history, and timers as today. (5) `matchState = 'ready'`. Toast: "Game ready — press Start at the whistle" (wording flexible) |
| `saveMatchSetup()` (`edit`) during `draft` | Update the draft locally only. No sync |

### 4.3 Clock controls

| Function | Requirement |
|---|---|
| `startTimer(isResuming)` | If `gameLifecycle === 'draft'` (first start): set `gameLifecycle = 'live'`, `gameCommitted = true`, `activeGameStartedAt = now` (ISO), `activeGameRev = 1`, then proceed with the existing start logic. The existing `saveState()` at the end performs the first sync (INSERT). If `gameLifecycle === 'idle'` (no setup done): open the setup modal in `create` mode instead of starting. Resume behavior is unchanged |
| `pauseTimer()` | Unchanged. Pausing is always allowed while `live`, including immediately after start |
| `endCurrentPeriod()` | Only available while `live` |
| `endCurrentGame()` | Only available while `live`. Sets `gameLifecycle = 'final'` and keeps the existing behavior. **No** minimum duration or score check |
| Stale modal "Finish" | Sets `gameLifecycle = 'final'` and sends `ended_by: 'abandoned'` (now accepted by the server, §6) |

### 4.4 Sync gating

Every path that talks to the server or to the local active-games directory must require `gameCommitted === true`:

| Path | Gate |
|---|---|
| `publishActiveGameState()` | Return early if `!gameCommitted` |
| `syncActiveGameWithServer()` | Replace the `!activeGameStarted` check with `!gameCommitted` |
| `flushBeaconSync()` | Replace the `!activeGameStarted` check with `!gameCommitted` |
| `updateActiveGameEntry()` (local `scoreBoardActiveGamesV1`) | Replace the `!activeGameStarted` check with `!gameCommitted` |
| 20-second heartbeat | Condition becomes `timerRunning && gameCommitted && gameLifecycle === 'live'` |
| `storage` event listener | Calls `publishActiveGameState()`, which is already gated |

### 4.5 Page load / restore (`window.onload`)

| Case | Requirement |
|---|---|
| No saved state | `gameLifecycle = 'idle'`, `gameCommitted = false`, `activeGameId = null` |
| Saved state with new fields | Restore both fields as-is |
| **Legacy saved state** (no `gameLifecycle` field) | Map as follows. `activeGameEnded` true → `final`, committed `true`. `activeGameStarted` true and the clock has run (`periodStartTimeUtc` set, or `accumulatedTime > 0`, or any `period_start` event in `scoreHistory`) → `live`, committed `true`. `activeGameStarted` true and the clock never ran → `draft`, committed `false`, **with a freshly minted ID and write token** (the orphan server row is left for manual cleanup). Otherwise → `idle` |
| Login cloud reconciliation | When pushing the local game as `final / new_game`, do so **only** if the local game is committed and not already final. A local draft is discarded silently |
| Guest state preserved on login | A draft stays a draft. No sync |

### 4.6 UI affordances by lifecycle

| Control | `idle` | `draft` | `live` | `final` |
|---|---|---|---|---|
| New Game | ✅ | ✅ (replaces draft) | ✅ (finalizes current) | ✅ |
| Start | ✅ → opens setup | ✅ **commits game** | ✅ (next period / resume per `matchState`) | ❌ |
| Pause / Resume | ❌ | ❌ | ✅ | ❌ |
| End Period | ❌ | ❌ | ✅ | ❌ |
| End / OT | ❌ | ❌ | ✅ | ❌ |
| Edit setup (card menu) | ❌ | ✅ (local only) | ✅ (existing) | existing behavior |
| Score buttons | ❌ | ❌ (see §11) | ✅ | existing behavior |
| Visibility toggle | ✅ | ✅ (stored locally, sent on commit) | ✅ | existing behavior |

Draft state should be visually distinct (for example a "READY — awaiting start" label near the clock) so the user knows nothing is being broadcast yet.

---

## 5. Client Changes — `ScoreBoard/ScoreBoardMyGames.html`

| Item | Requirement |
|---|---|
| Delete button | Show it only for rows whose effective status is `final`. For `live` rows, show it disabled with the hint "End the game before deleting" (or hide it; either is acceptable) |
| Delete error handling | If the server responds with error code `game_live` (§6.3), show "This game is still live. End it before deleting." and refresh the list |

---

## 6. Server Changes — `api/games.php`

### 6.1 `action=sync`

| Rule | Requirement |
|---|---|
| Reject final-on-create | If no row exists for `game_id` **and** the incoming `status` is `final`, do not insert. Respond `409` with `{ success: false, error_code: 'final_without_live', error: '…' }` |
| Client handling | `syncActiveGameWithServer` treats `final_without_live` as terminal: stop retrying and do not surface an error to the user |
| `ended_by` whitelist | Add `'abandoned'`: `['user', 'new_game', 'timeout', 'abandoned']` |
| Everything else | Unchanged (upsert, write-token auth, `rev` conflict handling, guest 24-hour `expires_at`) |

### 6.2 `action=list_mine` / `action=list_public`

No query changes. Once drafts stop reaching the server, the lists are correct as they are.

### 6.3 `action=delete`

| Rule | Requirement |
|---|---|
| Final only | Delete only when the row's **effective** status is `final`. A `live` row whose `last_activity_at` is older than `GAME_TIMEOUT_HOURS` counts as final: lazily finalize it (same UPDATE as the existing timeout finalizer), then delete it |
| Live rejection | Otherwise respond `409` with `{ success: false, error_code: 'game_live', error: 'Game is still live. End it before deleting.' }` |
| Ownership | Unchanged (owner-only, `401`/`404` as today) |

### 6.4 Version

Bump `$GAMES_API_VERSION` `1.1` → `1.2`.

---

## 7. Schema Changes — `api/schema.sql` / `api/setup.php`

| Item | Requirement |
|---|---|
| `suite_games.ended_by` | ENUM becomes `('user','new_game','timeout','abandoned')` |
| Existing databases | `schema.sql` uses `CREATE TABLE IF NOT EXISTS`, so editing it will **not** alter existing tables. Add an idempotent migration step to `setup.php` that runs after `schema.sql`: if `suite_games.ended_by` does not include `abandoned`, alter the column to the new ENUM. Report the result in the setup page output |
| Version | Bump `$SETUP_VERSION` `1.2` → `1.3` |
| No other columns | No new status values or columns. The `draft` state is client-only by design |

---

## 8. Version Bumps

| File | From | To |
|---|---|---|
| `ScoreBoard/index.html` (`VERSION` + footer) | 4.1 | 4.2 |
| `ScoreBoard/ScoreBoardMyGames.html` (`VERSION` + footer) | 1.4 | 1.5 |
| `api/games.php` | 1.1 | 1.2 |
| `api/setup.php` | 1.2 | 1.3 |

---

## 9. Acceptance Criteria

| # | Scenario | Expected |
|---|---|---|
| 1 | Open ScoreBoard fresh, do nothing, close the tab | No `suite_games` row created. Nothing in Active Games |
| 2 | New Game → Ready, wait, change mute/theme, reload page | Draft restored with the same teams and settings. No server row. Nothing in Active Games or My Games |
| 3 | Draft → close the tab | No beacon sent. No server row |
| 4 | Draft → press Start | Row created with `status: live`; `started_at` ≈ the Start press time (not the setup time). Appears in Active Games (if public) and My Games (if signed in) |
| 5 | Start → Pause within 2 seconds | Allowed. Game remains `live` |
| 6 | Start → End Game after 10 seconds at 0–0 | Game saved as `final / user`. No warning shown |
| 7 | Draft → New Game → Ready | Old draft discarded, new ID minted. Still no server rows |
| 8 | Live game → New Game → Ready | Old game `final / new_game` on server. New draft has a new ID and no row |
| 9 | Stale modal → Finish | Server row has `ended_by = 'abandoned'` (not NULL) |
| 10 | Sign in with a local draft present while cloud state wins | Draft discarded. **No** `final` row created |
| 11 | Sign in with a local live game while cloud state wins | Local game pushed as `final / new_game` (existing behavior) |
| 12 | Legacy saved state: configured but never started | Loads as `draft` with a new ID. Nothing new written to the server |
| 13 | Direct API call: sync with a new `game_id` and `status: final` | `409 final_without_live`. No row inserted |
| 14 | My Games: live game | Delete disabled/hidden. Direct API delete → `409 game_live` and the row remains |
| 15 | My Games: final game → Delete | Row removed. It does **not** reappear afterward |
| 16 | My Games: live row inactive > 3 hours → Delete | Lazily finalized, then deleted successfully |
| 17 | Guest game | Same lifecycle rules. Row still gets the 24-hour `expires_at` |
| 18 | Two tabs, one in draft | The `storage` event in the other tab causes no sync for the draft |
| 19 | Re-run `setup.php` on an existing DB | `ended_by` ENUM includes `abandoned`. Running it again is a no-op |

---

## 10. Out of Scope

- Cleanup of existing empty/junk rows (the owner will do this manually).
- Admin tooling.
- Minimum game duration or score thresholds (explicitly rejected: any started game is valid).
- Changes to Viewer (`ScoreBoardViewer.html`) and Active Games (`ScoreBoardActiveGames.html`) pages beyond what the server behavior already implies.
- Multi-device control of a single game.

---

## 11. Assumptions (implement as written unless the owner overrides)

| # | Assumption | Rationale |
|---|---|---|
| A1 | Score buttons are **disabled in `draft`**. Scoring requires the clock to have started | Keeps "clock start = commit" as the only commit trigger. Otherwise a pre-whistle score would need its own commit path |
| A2 | Pressing Start in `idle` opens the setup modal instead of starting an unconfigured game | Every game passes through `draft`, so there is one path for minting IDs |
| A3 | The draft-state indicator wording and styling are left to the implementer, within the existing theme system | UX detail, not architecture |
