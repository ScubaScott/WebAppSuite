# ScoreBoard — Unified Games Screen & Read-Only Viewer

**Build Specification for Antigravity**
**App:** WebAppSuite / `htdocs/ScoreBoard`
**Status:** Approved design, ready to build
**Scope:** Navigation standardization, merged Active/My Games screen, Viewer parity rebuild

---

## 1. Summary

The current screens have inconsistent navigation and duplicated list pages:

- **Active Games:** back link to ScoreBoard, plus a sideways link to My Games.
- **My Games:** back link to ScoreBoard, plus a sideways link to Active Games.
- **Viewer:** two back links.
- **Active Games and My Games:** different row layouts for the same data.

This change delivers four things:

1. A **standard page shell** on every page: a back link at the top and the version footer at the bottom.
2. A **fixed navigation hierarchy**, in which back always goes to the logical parent and never to the suite app list.
3. **One Games screen** with two tabs (Active Games, My Games) that share an identical row design.
4. A **read-only Viewer** that mirrors the main scoring screen, using the viewer's own theme, the full history log with notes, and a server-anchored clock model.

### 1.1 Files affected

| File | Change |
|---|---|
| `ScoreBoardGames.html` | **New.** The unified two-tab Games screen. |
| `ScoreBoardActiveGames.html` | Becomes a redirect stub to `ScoreBoardGames.html?tab=active`, preserving query parameters. |
| `ScoreBoardMyGames.html` | Becomes a redirect stub to `ScoreBoardGames.html?tab=mine`. |
| `ScoreBoardViewer.html` | Rebuilt to match the main scoring screen's layout, theme, and history rendering. |
| `index.html` | "View Active Games" links to `ScoreBoardGames.html?tab=active`. The "My Games" sublink goes to `?tab=mine` and stays hidden for guests. |
| `scoreboard.css` | Loaded by the Viewer and the Games screen so theme tokens and history styles are shared. |
| `api/games.php` | Changes to the public-list filter and visibility authority (§8). |
| *(recommended)* `scoreboard-shared.js` | Extracted shared helpers (§9.1). |

---

## 2. Standard Page Shell

Every ScoreBoard sub-page uses the same frame:

```
┌─────────────────────────────────────┐
│ ← Back                              │  standard .back-link, top-left
│ Page Title                          │
├─────────────────────────────────────┤
│                                     │
│            page content             │
│                                     │
├─────────────────────────────────────┤
│           Version X.Y               │  standard .app-footer
└─────────────────────────────────────┘
```

**Rules**

- There is exactly **one** back link per page. No secondary navigation links sit in the header.
- The back link is a **fixed href** computed from the navigation hierarchy (§3). It never uses `history.back()`.
- The footer shows the page's own version constant, following the suite convention. It also renders `SuiteProfile.renderFooterIndicator` where the main page already does.
- The following links are removed: "← Back to ScoreBoard" in the header navigation, "Active Games Feed", "My Saved Games", and the Viewer's dual "← Active Games" / "← ScoreBoard" links.

---

## 3. Navigation Hierarchy

```
ScoreBoard (index.html)
   └── Games (ScoreBoardGames.html?tab=active|mine)
          └── Viewer (ScoreBoardViewer.html?id=<gameId>&from=active|mine)
```

### 3.1 URL contract

| Page | Parameters | Back target |
|---|---|---|
| Games | `tab` = `active` \| `mine` (default `active`) | `index.html` |
| Viewer | `id` (required), `from` = `active` \| `mine` (default `active`) | `ScoreBoardGames.html?tab=<from>` |

### 3.2 Rules

| Rule | Detail |
|---|---|
| **Tab state lives in the URL** | Switching tabs updates `?tab=` with `history.replaceState`, so no history entries are added and a refresh keeps the tab. |
| **The Viewer carries its origin** | Rows on the Active tab link with `from=active`. The "View" action on My Games links with `from=mine`. |
| **Cold deep link** | If `from` is missing or invalid, back goes to `?tab=active`. |
| **Guest and `from=mine`** | If a guest opens a Viewer with `from=mine`, back resolves to `?tab=active`, because the My Games tab is not available to guests. |
| **Never reach the app list via back** | No back link on any ScoreBoard sub-page targets `../index.html`. The only exception is the guest redirect (§6), which is a redirect, not a back action. |

---

## 4. Games Screen

### 4.1 Layout

```
← Back                                  (→ index.html)
Games
┌──────────────┬──────────────┐
│ Active Games │   My Games   │         My Games tab hidden for guests
└──────────────┴──────────────┘
┌─────────────────────────────────────┐
│ Home vs Away            [● Live]    │
│ 7:42 PM                 [Public]    │
│                  3 – 1              │
├─────────────────────────────────────┤
│ …                                   │
└─────────────────────────────────────┘
Version X.Y
```

### 4.2 Row anatomy

The row is identical on both tabs.

| Element | Content |
|---|---|
| Title | `{homeTeamName} vs {awayTeamName}`, truncated with an ellipsis |
| Date | The start time. Show the local time (for example `7:42 PM`) when the game started today, and the local date (for example `Sep 28`) otherwise. |
| Score | `{homeScore} – {awayScore}` |
| Status pill | Live / Paused / Stalled / Final (§4.3) |
| Visibility flag | Public / Private |

All data must be rendered through DOM text nodes, never `innerHTML` with game data. This preserves the existing XSS-safe pattern.

### 4.3 Status pill derivation

This is a single shared function used by both tabs **and** the Viewer. It is evaluated in order, and the first match wins:

| # | Condition | Pill |
|---|---|---|
| 1 | `status === 'final'` (manual, timeout, or abandoned) | **Final** |
| 2 | `isPaused === true` | **Paused** |
| 3 | `age_ms ≥ STALL_THRESHOLD_MS` | **Stalled** |
| 4 | `timerRunning === false` | **Paused** |
| 5 | otherwise | **Live** |

- `STALL_THRESHOLD_MS = 30 * 60 * 1000` (30 minutes). This must be defined **once** in shared code, because the Active page currently hardcodes 60 s.
- `age_ms` is **server-computed** from `last_activity_at`. It must never be derived from the client clock.
- The server auto-finalizes live games after `GAME_TIMEOUT_HOURS` (3 h), which is unchanged. The resulting lifecycle is Live → Stalled (30 min) → Final (3 h).

### 4.4 Active Games tab

| Aspect | Rule |
|---|---|
| **Contents** | All `visibility = public` games, **including the viewer's own**, that are either not final, or final with `ended_at` within the last 24 h. |
| **Sort** | Non-final games first, ordered by `last_activity_at` descending. Then finals, ordered by `ended_at` descending. |
| **Tap** | Navigates directly to `ScoreBoardViewer.html?id=<id>&from=active`. There is no menu. |
| **Owner actions** | None. No delete or visibility control appears here, even on the viewer's own games. |
| **Refresh** | Poll at the existing Active-page interval while the tab is visible and selected. |
| **Empty state** | "No public games right now. Start a game on ScoreBoard to broadcast here." |

### 4.5 My Games tab

| Aspect | Rule |
|---|---|
| **Visibility** | The tab control is rendered only when `!SuiteProfile.isGuest()`. |
| **Contents** | All games owned by the user (`list_mine`), paginated as today. |
| **Sort** | `started_at` descending, as today. |
| **Refresh** | Load when the tab is opened and when the page is resumed. No interval polling. |
| **Tap** | Opens the row action menu (§4.6). |
| **Empty state** | "You haven't recorded any games yet." |

### 4.6 My Games row action menu

The menu is an anchored popover or bottom sheet, with a header showing the game title, score, and date.

| Item | Availability | Behavior |
|---|---|---|
| **View** | Always | Navigate to `ScoreBoardViewer.html?id=<id>&from=mine`. |
| **Make Private / Make Public** | Always, including on live games | Calls the visibility endpoint. The item is disabled with a spinner while the request is pending. On success, update the row flag. On failure, show a toast and keep the prior state. |
| **Delete** | Enabled only when status is **Final** | Opens a confirmation dialog showing the title, score, and date. It removes the row only after the server confirms. On failure, show a toast. |
| **Delete (non-final)** | Shown **disabled** | Label: "End game to delete". |

The delete eligibility rule (Final only, whether manual or timed out) is carried over unchanged from the previous revision.

### 4.7 Mobile lifecycle

- On `visibilitychange → hidden`, stop all polling timers.
- On `visibilitychange → visible`, fetch immediately, then resume the interval if the Active tab is selected.
- Switching away from the Active tab stops its poller.

---

## 5. Viewer

### 5.1 Principle

The Viewer is the **main scoring screen, read-only**. It must look nearly identical: the same card, court, team colors, score typography, period label, clock, and history table. It must not be able to change anything, and it must never write to scoreboard storage.

### 5.2 Element parity

| Main-screen element | Viewer |
|---|---|
| Team names and scores | Displayed. There are no click handlers and no pointer cursor, and the `.interactive-box` affordance is removed. |
| Clock and period label | Displayed using the same `formatTime` and `getPeriodLabel` output (including OT labels). |
| Team colors | Taken from the snapshot fields `homeTeamColor` and `awayTeamColor`. |
| Score History table | Same columns (Team (Score) / Note / Time), same icons (goal, yellow card, red card, stopwatch), newest first. |
| History row tap, note editor, delete, share | **Removed.** Rows have no click handler and no hover pointer. |
| Settings button | **Removed** |
| Mute button and all sound | **Removed.** The Viewer plays no audio. |
| In-card help button | **Removed** |
| Active Games / My Games action bar | **Removed.** The standard back link replaces it. |
| Score celebration animation | Omit. It is optional polish and not required for parity. |
| **Added:** Status pill | Uses the shared derivation (§4.3). |
| **Added:** Age indicator | Shown **only when Stalled**, as "Last update {n}m ago". |

### 5.3 Theme

- The Viewer applies **the viewing user's** selected theme, read from the same source the scoring screen uses (the `selectedTheme` in scoreboard state, via `SuiteProfile` app data or `localStorage`).
- If no theme is found (for example, a guest who has never used ScoreBoard), use the `:root` defaults in `scoreboard.css`.
- The game creator's theme is **not** recorded or applied.
- **Read-only storage:** the Viewer may read theme state but must never call `saveState`, write `STORAGE_KEY`, or call `SuiteProfile.saveAppData('scoreboard', …)`. The same device may be scoring a game in another tab, and any write would corrupt that state.

### 5.4 Clock model

All fields below already exist in the `get` response: `elapsedMs` (per-period), `timeLimit`, `isCountingUp`, `timerRunning`, `isPaused`, `status`, `lastUpdate`, `server_now`, and `age_ms`.

**Server-anchored time.** On each fetch, compute `offset = server_now − Date.now()`. The effective server time is then `serverNowEst = Date.now() + offset`.

**Extrapolation.** Extrapolation applies only when `status ≠ final`, `timerRunning` is true, and `isPaused` is false. It is conceptual, not an implementation:

```
sinceUpdate   = min(serverNowEst − lastUpdate, STALL_THRESHOLD_MS)
extrapolated  = elapsedMs + sinceUpdate

if timeLimit > 0 AND elapsedMs < timeLimit:
    displayed = min(extrapolated, timeLimit)     // clamp: never invent overage
else:
    displayed = extrapolated                     // reported overage, or no limit
```

**Stop conditions.** Extrapolation stops at whichever comes first:

| Condition | Result |
|---|---|
| The period time limit is reached | Count-down holds at 0:00, and count-up holds at `timeLimit`. The pill stays **Live**. |
| 30 minutes since `lastUpdate` | The clock freezes and the pill shows **Stalled**. |
| A new snapshot arrives | The clock snaps to the reported state (new period, pause, overage, or Final). |

**Overage.** The scorer may legitimately run past the limit, since `formatTime` renders negative values and `overageResolvedForCurrentPeriod` exists. The Viewer shows overage **only when a snapshot reports it**, meaning `elapsedMs ≥ timeLimit`. From that point it mirrors the scorer's display, including negative count-down values, and continues extrapolating subject to the stall cap.

**No time limit.** If `timeLimit` is 0 or absent (an open-ended count-up game), only the stall cap applies.

**Rendering.** A 100 ms tick updates the display from the model. The tick only renders; it never mutates the model.

### 5.5 Viewer states

```
            fetch OK                       fetch 404
Loading ─────────────→ Showing ──────────────────────→ Unavailable (terminal)
   │                     │  ▲
   │ fetch 404           │  │ fetch OK
   ▼                     ▼  │
Unavailable         Reconnecting  (network or 5xx error: keep last state)
                         │
Showing ── status=final ─┴──→ Final (poll stops)
```

| State | UI | Polling |
|---|---|---|
| **Loading** | Skeleton, with "Connecting…" | Initial fetch |
| **Showing** | Full board plus status pill | Existing interval |
| **Reconnecting** | Last known board with a subtle "Reconnecting…" line. The clock follows the rules in §5.4 without resetting. | Retry with backoff |
| **Final** | The board frozen at the final snapshot, with the Final pill | **Stopped** |
| **Unavailable** | "Game not available" message plus the standard back link | **Stopped** |

- **Any 404** (game made private, deleted, or never existed) → Unavailable. The server already returns the same 404 for "private, not owner" and "not found", which covers both cases.
- A network error or 5xx must **never** transition to Unavailable.
- An owner viewing their own private game works as today, because the auth token is sent with `get`.
- Mobile lifecycle: pause polling and the tick on `hidden`, then fetch immediately on `visible`.

---

## 6. Guest Handling

| Situation | Behavior |
|---|---|
| Guest on the Games screen | The My Games tab control is not rendered. |
| Guest opens `?tab=mine` directly (bookmark or link) | **Redirect** (`location.replace`) to the suite apps page `../index.html`, which contains sign-in. No return URL is used. |
| Guest opens legacy `ScoreBoardMyGames.html` | The stub forwards to `?tab=mine`, which then redirects as above. |
| Session expires while on My Games (a `list_mine` 401) | Same redirect as a guest. |
| Guest on the Viewer with `from=mine` | Back resolves to `?tab=active` (§3.2). |

---

## 7. Data Contracts

### 7.1 Row view model

Both list endpoints are normalized into a single shape before rendering:

| Field | Source: public list | Source: `list_mine` |
|---|---|---|
| `id` | `game_id` | `game_id` |
| `homeName` / `awayName` | `snapshot.homeTeamName` / `awayTeamName` | `home_name` / `away_name` |
| `homeScore` / `awayScore` | `snapshot.*Score` | `home_score` / `away_score` |
| `status` | `status` | `status` |
| `isPaused`, `timerRunning` | `snapshot.*` | *(add to response; see §8.3)* |
| `ageMs` | `age_ms` | `age_seconds × 1000` |
| `visibility` | `visibility` *(must be present)* | `visibility` |
| `startedAt`, `endedAt` | `started_at`, `ended_at` | `started_at`, `ended_at` |
| `isOwner` | not used on this tab | always true |

### 7.2 Viewer (`games.php?action=get`), unchanged

The response already contains everything the Viewer needs: the merged snapshot including `scoreHistory` (each entry with `type`, `teamId`, `teamName`, `teamColor`, `currentScore`, `cardType`, `note`, timing fields), plus `timeLimit`, `isCountingUp`, `elapsedMs`, `lastUpdate`, `server_now`, `age_ms`, and `visibility`.

---

## 8. Server Changes (`api/games.php`)

### 8.1 Public list filter

```
visibility = 'public'
AND ( status = 'live'
      OR (status = 'final' AND ended_at >= UTC_TIMESTAMP() - INTERVAL 24 HOUR) )
```

The query must include the requester's own public games. It must apply the same lazy auto-finalize used by `get` so that timed-out games report `final`. It must return `visibility`, `started_at`, and `ended_at` for each row.

### 8.2 Visibility authority ⚠️ Race condition

The scorer sends `visibility: activeGameVisibility` on **every** sync. If the owner makes a live game private from My Games on another device, the scorer's next sync (on any score, note, or even a mute toggle) would silently revert it to public.

**Required behavior:**

| Rule | Detail |
|---|---|
| Visibility is taken from `sync` **only when the row is created** | For an existing row, the update path ignores the payload's `visibility`. |
| Visibility changes go through the dedicated visibility endpoint only | This applies to both My Games and the scorer's own in-app share setting. |
| The `sync` response returns the authoritative `visibility` | The scorer adopts it into `activeGameVisibility`, so its settings UI stays truthful. |

**Verify** whether the current update path writes `visibility` from the payload. If it does, this change is mandatory.

### 8.3 `list_mine` additions

Return `is_paused` and `timer_running`, so the status pill can be derived identically on both tabs.

### 8.4 Delete resurrection ⚠️ Verify against previous revision

After a Final game is deleted, a scorer page still open on that game can call `saveState()` (for example by editing a note or toggling mute), which triggers a sync. Because the row no longer exists, the create path would **recreate the game**.

This requires either a tombstone of deleted `game_id`s, so that `sync` for a deleted ID is rejected with a `deleted` or `stopped` result and the scorer clears its active game, or confirmation that the previous revision's delete logic already covers this.

---

## 9. Implementation Guidance

### 9.1 Shared module (recommended)

Parity will drift if the Viewer re-implements the scoring screen's rendering. The recommended approach is to extract the following into `scoreboard-shared.js`, used by `index.html`, the Games screen, and the Viewer:

- `formatTime`, `getPeriodLabel`, `formatGameTimeMmSs`, `formatEventTime`, `parseEventDetails`
- The history-row renderer, parameterized with `interactive: boolean`
- Theme resolution and application (read-only)
- `deriveStatusPill(row)` and `STALL_THRESHOLD_MS`
- The start-date formatter (§4.2)

### 9.2 Legacy stubs

`ScoreBoardActiveGames.html` and `ScoreBoardMyGames.html` each become a minimal page that calls `location.replace('ScoreBoardGames.html?tab=…')`. Existing bookmarks and the scoring screen's old links keep working.

---

## 10. Edge Cases

| # | Scenario | Expected behavior |
|---|---|---|
| E1 | The scorer's phone is locked for 20 min mid-period | The Viewer extrapolates, clamps at the period limit, and shows Live. Before 30 min, no Stalled pill appears. |
| E2 | The scorer's phone is locked for more than 30 min | The Viewer's clock freezes and the pill shows Stalled. At 3 h, the server finalizes the game and the Viewer shows Final. |
| E3 | A count-down period expires while the scorer's phone is locked | The Viewer holds at 0:00. It shows overage only after the scorer syncs it. |
| E4 | The viewer's device clock is wrong by several minutes | There is no effect, because the clock is anchored to `server_now` and the pill uses server `age_ms`. |
| E5 | The owner makes a live game private mid-game | Spectators get a 404 on their next poll and see Unavailable. The scorer is not reverted (§8.2). |
| E6 | The owner deletes a Final game while a spectator is watching | The spectator gets a 404 and sees Unavailable. |
| E7 | The owner deletes a Final game while the scorer page is still open | No resurrection occurs (§8.4). |
| E8 | The same device is scoring in one tab and viewing in another | The Viewer writes nothing to scoreboard storage, so the scorer's state is intact. |
| E9 | The network drops while viewing | The Viewer enters Reconnecting and keeps the last board. It never shows Unavailable. |
| E10 | A viewer opens a shared Viewer link cold | Back goes to Games with `?tab=active`. |
| E11 | A guest follows a My Games link | Redirected to the suite apps page. |
| E12 | A user refreshes on the My Games tab | Stays on My Games, because `?tab=mine` is in the URL. |
| E13 | The user's own public live game appears on Active | Tapping it opens the Viewer. No owner actions appear on the Active tab. |
| E14 | The user tries to delete a live game | The Delete item is disabled with "End game to delete". |
| E15 | An open-ended count-up game has no limit | Only the 30-min stall cap limits extrapolation. |
| E16 | A game is paused at halftime for more than 30 min | The pill stays **Paused**, because precedence rule 2 applies before Stalled. |

---

## 11. Acceptance Criteria

**Navigation**

- [ ] Every ScoreBoard sub-page has exactly one top back link and the version footer.
- [ ] No back link on any sub-page targets the suite app list.
- [ ] Viewer back returns to the originating tab. A cold link returns to Active.
- [ ] Tab switches update `?tab=` without adding history entries.
- [ ] The legacy Active and My Games URLs redirect to the correct tab.

**Games screen**

- [ ] Both tabs render identical rows: title, date, score, status pill, visibility flag.
- [ ] Active shows all public games (including the user's own) that are non-final or finished within 24 h, sorted per §4.4.
- [ ] Tapping an Active row opens the Viewer directly.
- [ ] Tapping a My Games row opens the menu with View, Public/Private, and Delete.
- [ ] Delete is enabled only for Final games and requires confirmation.
- [ ] The visibility toggle works on live games and is not reverted by the scorer's next sync.
- [ ] Guests never see the My Games tab, and a direct link redirects them to the apps page.
- [ ] Polling pauses when the page is backgrounded and refreshes on return.

**Viewer**

- [ ] Visually matches the scoring screen, using the viewer's theme or the CSS default.
- [ ] No element is interactive, and there is no audio, settings, mute, or help button.
- [ ] The history table shows every entry with notes, icons, and team colors, newest first.
- [ ] The clock clamps at the period limit, freezes at the 30-min stall, and mirrors reported overage.
- [ ] The clock is correct on a device whose clock is skewed.
- [ ] A 404 shows "Game not available". A network error shows Reconnecting.
- [ ] Polling stops at Final and at Unavailable.
- [ ] Zero writes to scoreboard `localStorage` or `SuiteProfile` app data.

---

## 12. Open Verification Items (non-blocking)

| # | Item | Action |
|---|---|---|
| V1 | Does `sync` accept writes to a game that is already Final? If not, notes added after the game ends never reach viewers. | Verify during the build. If writes are rejected, allow history and note-only updates on Final games from the owning write token. |
| V2 | Does the sync update path overwrite `visibility`? | Verify. If it does, implement §8.2. |
| V3 | Is delete resurrection already prevented? | Verify against the previous revision. If not, implement the §8.4 tombstone. |
| V4 | Can `timeLimit` be 0 or empty in the settings? | Confirm §5.4 handles it either way. |

---

## 13. Out of Scope

- Recording or applying the game creator's theme in the Viewer
- Viewer audio
- Return-URL handling after sign-in
- Changes to the scoring screen's own UI, other than updated links and adopting the authoritative `visibility` from `sync`
- Changes to the auto-finalize timeout (stays at 3 h)
