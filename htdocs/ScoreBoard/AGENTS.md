# ScoreBoard - Sub-Application AI Agent Guidelines

Rules and architecture for `htdocs/ScoreBoard/`. Follow the root `AGENTS.md` as well; this file only adds what is specific to ScoreBoard.

This file describes the **target design** agreed in the ScoreBoard Design Review (2026-10-26). The code is being moved to it in phases (see section 2). When you change code, move it toward this design, never away from it. If the code and this file disagree, this file states the intended behavior.

---

## 1. What the App Does

A two-team scoreboard for any timed sport, run by one operator on a phone or tablet, with live spectator viewing.

**Intent: it is always "us vs them", not a neutral home vs away.** The operator is scoring their own team (or their kid's team) against an opponent. The "home" side in the code is always **us**; "away" is **them**. Data and API field names keep `home`/`away`, but wording in the UI should say "us"/"them" (see section 12).

- **Console** (`index.html`): set up a game (team names, colors, number of periods, period length), run the clock, tap a team's score box to add a goal, record yellow/red cards, end periods, add overtime, and finalize. Every action is logged in a history list where entries can get a note, be shared (native share sheet + clipboard), or be removed.
- **Spectator viewer** (`ScoreBoardViewer.html`): read-only live view of one game, with the clock extrapolated between server updates.
- **Games list** (`ScoreBoardGames.html`): "Active Games" tab (public games, anyone) and "My Games" tab (signed-in users: view, make private/public, delete finished games).
- **Help** (`ScoreBoardHelp.html`): operating guide. Update it whenever a user-facing behavior changes.

Works offline. Guests can play and share games publicly; signed-in users also get a private archive.

---

## 2. Refactor Status

Update this table when a phase is finished. Bug and suggestion numbers refer to the design review.

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Manual test checklist (`docs/TEST-CHECKLIST.md`) and saved-state fixtures | Done (fixtures in `docs/`) |
| 1 | Fix high-impact bugs in place (clock reload, hidden My Games link, share toggle, rev off-by-one, viewer polling, legacy fallback, old game archived with new names, tab sync loop, stale finish, zero-length period, remove confirm) | Done on `main` and tested. `isCountingUp` removed from the snapshot in Phase 3 (the viewer still reads it for archived games) |
| 2 | One `toSnapshot()`, one send scheduler, game and preferences stored separately, shared helpers and one theme catalog, single beacon | Done and tested on `full_refactor` (console 5.3, shared 1.6) |
| 3 | Single `game` object + reducer, one `status` field, event log as source of truth, event-based clock (`docs/TIMING-SPEC.md`), one-time migration of old saved data | In progress; steps in `docs/PHASE3-PLAN.md`. 3.1 to 3.4 done with tests; 3.5 (console rewrite, console 6.0) and 3.6 (history display, shared 1.6, help 2.1) done; 3.8 dead-code removal done; 3.7 server migration script remains |
| 4 | Split console into ES modules, move inline styles and `onclick` into CSS/JS, score boxes become buttons, viewer and games list become modules | Done on `full_refactor` (console 6.1, viewer 1.6, games list 1.1, shared 2.0). Every page is free of inline `style` attributes and inline handlers; `scoreboard-shared.js` is now `js/shared.js` and no longer exposes a global. Needs the browser checklist |
| 5 | Features (section 12): "us vs them" wording, My Games grouped by our team, theme saved with each game | Done on `full_refactor` (console 7.0, games list 1.2, viewer 1.7, help 2.2, suite-profile 2.2); needs the browser checklist, and `setup.php` run once on the server for the new index | Not started. Starts after Phase 4 |
| Later | Viewer sends its last `rev` and gets 304 when unchanged | Optional |

---

## 3. Files

Target layout. Files marked *(planned)* do not exist yet.

| File | Role |
| --- | --- |
| `index.html` | Console markup only. No inline styles, no inline handlers, no logic. The score boxes, period box and elapsed-time readout are buttons. |
| `ScoreBoardViewer.html` | Viewer markup. Sub-page: "← Back" to the games list, no "Back to Apps". |
| `ScoreBoardGames.html` | Games list markup. Sub-page: "← Back" style navigation, no "Back to Apps". |
| `ScoreBoardHelp.html` | Help page. |
| `ScoreBoardActiveGames.html`, `ScoreBoardMyGames.html` | Redirect stubs for old bookmarks. Never add logic to them. |
| `scoreboard.css` | Every style for every ScoreBoard page, themed through custom properties on `:root`. |
| `js/console.js` | Console entry point: loads the saved game and preferences, turns taps into actions, runs the clock loop and the stale / overrun prompts. |
| `js/state.js`, `js/format.js`, `js/migrate.js`, `tests/state.test.mjs`, `tests/migrate.test.mjs` | `game` object, reducer, status machine, derived selectors. Pure: no DOM, no storage, no network. |
| `js/clock.js`, `tests/clock.test.mjs` | `getPosition(events, period, t)`, effective start, adjustment validation and expiry detection, per `docs/TIMING-SPEC.md`. Pure. |
| `js/snapshot.js`, `js/sync.js`, `js/storage.js`, with `tests/snapshot.test.mjs`, `tests/sync.test.mjs`, `tests/storage.test.mjs` | `snapshot.js`: `toSnapshot(game, now, prefs)` and the sync payload (pure). `sync.js`: when to send, revision numbers, conflict handling, beacon; the only code that talks to the games API (through `SuiteProfile.games`). `storage.js`: the saved game and preferences in localStorage, conversion of earlier records. |
| `js/setup.js` | New Game / Edit Match / Add Overtime dialog and the minutes:seconds roller. |
| `js/render.js`, `js/store.js`, `js/history.js`, `js/theme.js`, `js/effects.js` | `render.js`: console DOM updates from the game. `store.js`: holds the game and applies actions. `history.js`: the history entry dialog (note, share, remove). `theme.js`: the theme dropdown in Settings. `effects.js`: toast, whistle, goal and card animations, share. |
| *(preferences)* | Loaded, saved and normalized in `storage.js`; changed through `changePrefs` in `console.js`. |
| `js/shared.js` | Used by every page: status pill, history renderer, theme catalog and application, date formatting. Imports the clock and period-label formatters from `format.js`. |
| `js/viewer.js`, `js/games.js` | Page scripts for the viewer and games list. |
| `media/whistle.mp3` | Period-end whistle. |
| `media/bgimages/` + `list.php` | Theme background images; `list.php` returns the file list as JSON. |
| `../api/games.php` | Game API (section 8). Shared database with the rest of the suite. |
| `../media/suite-profile.js` | Suite-wide login, app data and game sync helpers. **Used by other apps**: changes here must not break them. |
| `../sw.js` | Service worker. Its precache list names ScoreBoard files: update it when files are added, renamed or removed. |
| `docs/` | Design and test documents (everything except this file). Active documents live here: `TEST-CHECKLIST.md` (manual test checklist; section 11 says when to run it), `TIMING-SPEC.md` (clock, period start, pauses and corrections; section 5) and `PHASE3-PLAN.md` (the step list for the single game object). |
| `docs/old/` | Archive of completed tasks and historical specs (the three lifecycle and viewer specs), already implemented and superseded by this file. Do not implement from them. When a task's document is finished, move it here. |

All scripts are native ES modules (`<script type="module">`). No build step, no frameworks.

---

## 4. Game State Model

### One object, one writer

All game data lives in a single `game` object. Only the reducer in `state.js` creates new versions of it:

```js
game = reduce(game, { type: 'score', team: 'home', at: Date.now() });
```

UI code calls `dispatch(action)`; `dispatch` runs the reducer, then render, then persist. Nothing else assigns to game fields. Do not add new top-level `let` variables for game data.

Stored fields (names are the target; map from the old names during migration):

| Field | Meaning |
| --- | --- |
| `id`, `writeToken` | UUID v4 and 64-hex secret, minted at New Game. |
| `status` | See below. The only status field. |
| `home`, `away` | `{ name, color }` |
| `periodCount`, `regulationPeriods` | Total periods now / periods set at setup. Periods above `regulationPeriods` are overtime. |
| `currentPeriod` | 1-based. |
| `periodLengthMs` | Length of the current period. Must be > 0. |
| `overageAcknowledged` | Per-period flag: the operator chose "Continue in Overage" (section 5). |
| `events` | The event log (below). |
| `visibility` | `'public'` or `'private'`. |
| `theme` | Theme key chosen in the New Game dialog; changeable until the first Start, then fixed. `null` for a game from an earlier version that never had one (it adopts the operator's current theme when first loaded). |
| `startedAt` | ISO time of the first Start. |
| `sync` | `{ lastAckRev, lastSentRev }` (section 7). |

Never store a value that can be derived. In particular these are **derived, not stored**: the clock and every event's position in the period (calculated from event timestamps; section 5), scores, `timerRunning`, `isPaused`, "committed", "ended", period labels, display text.

### Status machine

`status` is one of `idle`, `ready`, `running`, `paused`, `between_periods`, `final`.

| From | Action | To |
| --- | --- | --- |
| `idle` / any | New Game saved | `ready` (finalizes the previous game first if it was committed) |
| `ready` | Start | `running` (first Start creates the server row) |
| `running` | Pause, or goal with Pause on Score on | `paused` |
| `paused` | Resume | `running` |
| `running` / `paused` | End Period, or the clock expires in a non-final period, or "End Period on Time" | `between_periods` |
| `between_periods` | Start | `running` |
| `running` | Clock expires in the final period | `paused`, then the End / OT dialog opens |
| `paused` / `between_periods` | Add Overtime | `between_periods` with one more period and the OT length |
| `paused` / `between_periods` / stale prompt | Finalize | `final` |

Derived rules used across the UI:
- **Committed** (exists on the server) = status is not `idle` or `ready`.
- **Scoring and cards allowed** only while `running`.
- **Edit Match** allowed in `ready`, `paused`, `between_periods`. A period-length change applies to the current period only if it has not started; otherwise say so in the dialog, never ignore it silently.
- **Server status** is `'final'` when `final`, otherwise `'live'`.

### Event log

The event log is the record of truth. Each event:

```js
{ id, type, period, periodElapsedMs, timestamp, teamId?, cardType?, eventType?, qualifier?, endReason?, note? }
```

- `type`: `'score'` (a goal), `'card'`, or `'event'` (clock event). Keep these names: archived games in the database use them.
- `eventType` for clock events: `'period_start'`, `'paused'`, `'resumed'`, `'clock_adjust'` (carries `deltaMs`), `'period_end'`. `qualifier`: `'score'` or `'final'`. `endReason`: `'time'`, `'manual'`, `'drift'`, `'final'`.
- Scores are counted from `'score'` events. Removing an event and recomputing is the only undo.
- Team names, colors and labels are looked up at render time. Do not copy them into new events.
- Removing a `period_end` is allowed only for the most recent period end, and only when no later events exist. Removal always asks for confirmation.
- Start, pause, resume and adjust events are always recorded, because the clock is calculated from them. The preferences only decide whether those rows are shown and sent in the snapshot history.
- New events do not store `periodElapsedMs` or `gameTime`; positions are derived (section 5). Old entries keep their stored values (an entry that has one shows it; an entry without one is derived).

### Preferences (separate from the game)

`theme`, `muted`, `pauseOnScore`, `logPauseResume`, `logPeriodStartStop`, `splashHome`, `splashAway`, `showCards`. Stored and synced separately from the game (section 7). They never travel in the game snapshot. `theme` is only the default offered by the New Game dialog; the theme in force is the game's own (section 12.3).

### Storage keys

| Key | Holds |
| --- | --- |
| `scoreboardGameV8` | The current `game` object. |
| `scoreboardPrefsV1` | Preferences. The viewer and games list read the theme from here (read-only). |
| `scoreboard_discovered_bgimages` | Cached image list from `list.php`. |

Legacy keys read by the migration (delete them only after a successful conversion): `timerStateV7`, `scoreBoardActiveGamesV1`, `scoreBoardCurrentGameIdV1`, `scoreBoardCurrentGameWriteTokenV1`, `scoreKeeperCurrentGameIdV1`. Old saved data used `redScore`/`blueScore`/`redTeamName` etc.; only the migration may know those names. Once every user has had time to load the new code (section 13), delete every legacy reader.

---

## 5. Clock

The full design is in `docs/TIMING-SPEC.md`. Read it before touching any timing code. Summary:

- Only real time is stored: every event has a `timestamp`. A period's **position** (game-clock time, excluding paused time) is calculated by one pure function, `getPosition(events, period, t)`, used by the display, history rows, expiry and snapshots. Nothing else computes elapsed time.
- The period start event is written once and never edited. A correction is a `clock_adjust` event; the **effective start** is the recorded start minus the period's adjustments. Deleting the adjustment row undoes it.
- Adjustments apply to the current period only, while `running` or `paused`. They are blocked, with a message and no change, if an event would fall before the start, the clock would go negative, or an event would land after the period length (unless overage was acknowledged). Deleting an adjustment follows the same rules.
- Reload, sleep and background tabs need no restoring: recompute from events. On load while running: 3 hours or more shows the stale prompt; past the period length shows the "Period Limit Exceeded" prompt.
- Expiry records `period_end` at the calculated real time the period reached its length, not at `now`.
- The main display counts **down** from `periodLengthMs` and goes negative in overage (red, with an "Overage" badge). The secondary display counts up from 0. Format `MM:SS.d`. There is no count-up mode.
- The display loop only redraws; it dispatches `expire` when remaining time reaches 0 while running and overage is not acknowledged. Expiry plays the whistle (unless muted) and follows the status table.
- Audio and other device APIs fail quietly with a fallback (no sound, no crash).

---

## 6. Snapshot Contract

`toSnapshot(game, now, prefs)` in `snapshot.js` is the **only** builder of the object sent to the server, the beacon, and anything else outside the console. The server and viewer read these field names, so they must stay as they are unless `games.php`, `shared.js` and the viewer change in the same commit:

| Snapshot field | Read by | Source |
| --- | --- | --- |
| `homeTeamName`, `awayTeamName` | server, viewer, lists | `home.name`, `away.name` |
| `homeTeamColor`, `awayTeamColor` | viewer | `home.color`, `away.color` |
| `homeScore`, `awayScore` | server, viewer, lists | counted from events |
| `currentPeriod`, `totalPeriods`, `basePeriods` | server, viewer | `currentPeriod`, `periodCount`, `regulationPeriods` |
| `timerRunning`, `isPaused` | server, viewer, status pill | derived from `status` |
| `elapsedMs`, `timeLimit` | server, viewer clock | clock formula, `periodLengthMs` |
| `startedAt` | server | `startedAt` |
| `theme` | viewer | `theme` (omitted when the game has none). `games.php` drops a value that is not `^[A-Za-z0-9._-]+$` or is longer than 64 characters |
| `scoreHistory` | viewer | `events` |

The shared history renderer must also display **old-format** history (entries with `teamName`, `teamColor`, `currentScore`, `gameTime`, `text`, or no `labelVersion`), because archived games in the database keep that format.

---

## 7. Persistence and Sync

### Flow

`dispatch` → new state → render → `persist(game)`:

1. Write `scoreboardGameV8` to localStorage immediately. Local state is the source of truth during a game, online or offline.
2. If committed, schedule one server sync through `SuiteProfile.games.sync`: debounced 2 s for ordinary changes, sent immediately for status changes (start, pause, resume, period end, final).
3. While `running`, a heartbeat syncs every 20 s. No heartbeat in any other status.
4. On `pagehide` only, send one `navigator.sendBeacon` to `../api/games.php?action=sync` with the same snapshot. The beacon cannot send headers, so the session token goes in the body as `token`.

Each action causes exactly one local write and at most one scheduled server sync. Never call save twice for one action.

### Revision numbers

- The server rejects any `rev` that is not strictly greater than its stored `rev` (HTTP 409, body includes the server `rev` and `status`).
- `sync.js` assigns `rev` when the request is actually sent: `max(lastSentRev, lastAckRev) + 1`. Store `lastSentRev` before sending and `lastAckRev` from each success. Both are persisted with the game.
- On 409: set `lastAckRev` to the server `rev` and resend the current snapshot once. If the server says `status: 'final'`, move the console to `final`.
- Payloads waiting in the suite offline queue carry the `rev` from when they were queued; a 409 on flush is handled the same way.
- Other responses: 410 `game_deleted` → stop syncing, show a message, move to `final`. 409 `final_without_live` → drop silently. 403 → stop syncing and tell the operator.
- Never send a sync with a `rev` taken from an older saved copy without this rebasing.

### Starting a game and New Game

- The server row is created on the first Start, never before. A game in `ready` is local only.
- New Game while a committed game is not final: build the final snapshot of the **old** game first (with `ended_by: 'new_game'`), queue it, and only then apply the setup dialog's values.

### Load rule

- On page load, read `scoreboardGameV8` (or run the migration). Do not replace it with any cloud copy unless that copy is the same game with a higher `rev`.
- Never fall back to the legacy `scorekeeper` profile record.

### Profile app data

- Preferences are stored with `SuiteProfile.saveAppData` under the app id `scoreboard`, never the game. Existing `scoreboard` records hold a whole old-format game plus settings; on load, split them into the new game and preferences (the migration).
- **Decided: one user, one device per game.** A game cannot be picked up from another device, so the profile record never holds a game id or write token. The device's local copy exists so scoring keeps working without a network; resuming the same game elsewhere would break that and is not supported.

### Visibility

- Signed-in users can switch a game between public and private. Guests' games are always public (the server forces it).
- Before the first Start, the choice is stored on the game and sent when the row is created.
- After that, change it only with `SuiteProfile.games.setVisibility`. The sync call's `visibility` field is ignored by the server for existing games.

---

## 8. Server Facts (`../api/games.php`)

Do not change these without updating this section, the console and the viewer together.

- Actions: `sync` (POST), `list_public`, `get`, `list_mine`, `list_my_teams`, `list_all` (admin), `set_visibility`, `delete`.
- Admins (Admin group, profile with a password: the same gate as `api/admin.php`) also: `list_all` returns every game, paginated; `list_public` and `list_all` add `ownerName` (`guest` for unowned games) for them only; `get` returns private games to them; `delete` removes any final game. `set_visibility` stays owner-only.
- Table `scoreboard_games` stores the snapshot as JSON plus summary columns pulled from it (names, scores, period, `timer_running`, `is_paused`, `elapsed_ms`).
- Writes are authorized by the write token (stored as a SHA-256 hash) or by owning the row. Sessions are checked against `suite_sessions` (SHA-256 token hashes).
- Guest games expire 24 hours after their last update. A signed-in user who syncs a guest game with its write token claims it; owned games never expire.
- `final` is permanent: later syncs may update the snapshot (for example a note added after the game) but never return the game to `live`.
- A game cannot be created directly as `final`.
- Live games with no activity for 3 hours (`GAME_TIMEOUT_HOURS`) are marked final with `ended_by: 'timeout'`.
- Deleted games are recorded in `scoreboard_game_tombstones` for 7 days so open consoles cannot recreate them.
- Only final games can be deleted.
- Limits: request body 256 KB; history capped at the latest 2,000 entries; team names 60 characters.
- `list_public` returns up to 100 public games that are live or finished in the last 24 hours. `get` returns `server_now` and `age_ms` for the viewer's clock.

---

## 9. Viewer and Games List

### Viewer
- Polls `get` every 4 s; pauses polling and the display loop while the tab is hidden; fetches immediately when visible again.
- On `final`: stop polling for good and show the final frozen clock. The poll loop must not re-arm itself after a final response.
- Network errors and 5xx: keep the last state, show the "Connecting" banner, back off up to 10 s. Show "Game Unavailable" **only** for 404/410 (missing, deleted, or private).
- Clock: estimate server time from `server_now`; extrapolate only when not final, running, and not paused; stop at the period length unless the game was already in overage; never extrapolate more than 30 minutes (`STALL_THRESHOLD_MS`). With `age_ms` ≥ 30 minutes the pill shows "Stalled" and the clock freezes.
- Theme comes from the viewer's own `scoreboardPrefsV1`, read-only.

### Games list
- Active tab polls `list_public` every 4 s while visible. Tapping a row opens the viewer.
- All Games is a third tab for admins only (`?tab=all`; others are redirected to Active). It lists every game, 20 per page, newest activity first, with View and Delete (final games only) in the row sheet. Rows on Active and All Games show a small `owner:<username>` tag for admins; My Games never shows it.
- My Games is for signed-in users only; guests opening `?tab=mine` go to the launcher. Pages of 20. Row actions: View, Make Private/Public, Delete (final games only, with confirmation).

---

## 10. UI and Code Rules

- No inline `style` attributes and no inline event handlers in any ScoreBoard page. Styles go in `scoreboard.css` using custom properties; listeners are attached in JS. Values that come from data (team colors, theme images, animation positions) may be set from JS as properties, never written into markup.
- Show and hide elements by toggling the `hidden` class. Never set `style.display` on an element that may carry `hidden` (it is `display: none !important`).
- Every ScoreBoard page opens with the standard suite header (`suite-header.css`): back on the left, a one-word title, and on the right a settings gear on every page except the viewer. The console's back goes to the Apps launcher, the other pages go back one level (Games and Help to the console, the viewer to the games list). The gear on Games and Help opens the console with `?settings=1`, which opens its Settings dialog.
- Every tappable control is a `<button>` (or link) with at least a 44×44 px target; score boxes are buttons.
- One theme catalog, in `shared.js`, used by every page.
- One copy of each helper (formatters, `getPeriodLabel`, `escapeHtml`, history renderer), in `shared.js`. Never redefine them in a page script.
- Insert user or server text with `textContent`. If HTML must be built, escape every value with `escapeHtml`, including file names from `list.php`. Use `encodeURIComponent` for ids in URLs.
- Pages never contain login forms; sign-in happens in the root launcher. On login or logout (`suite-profile-changed`), the console reloads.
- Scores and clock must stay readable from across a field and must not wrap or shift when digits change.
- Each page has one `APP_VERSION` constant and its footer reads it from there; do not also hard-code the number in the HTML. Bump it by 0.1 for every change to that page (current: console 7.1, viewer 1.9, games list 1.4, help 2.3, shared 2.0).

---

## 11. Before You Finish a Change

1. Bump `APP_VERSION` on every page you changed.
2. Update `../sw.js` if you added, renamed or removed a file.
3. Update this file if you changed the state model, statuses, snapshot fields, sync rules or API behavior. Update the Help page if users will notice the change. Update section 2 when a phase is finished.
4. Run `node --test tests/*.mjs` from this folder (once the shell expands the pattern; otherwise name each file), then the parts of `docs/TEST-CHECKLIST.md` that your change touches. At minimum:
   - New Game → Start → goals for both teams → Pause/Resume → End Period → next period → final-period expiry → Add Overtime → Finalize
   - Reload the page while the clock is running: elapsed time continues correctly
   - Go offline mid-game, score, come back online: the server catches up with no lost update
   - Open the viewer during a game: clock tracks the console within about a second; after Finalize, polling stops
   - Remove a goal and a period end from history; add a note; share an entry
   - Sign in with a guest game in progress: the game is claimed, not lost
   - Signed in: switch a game to private and back; delete a finished game from My Games
   - Two console tabs open: no repeated syncing

---

## 12. Features Added in Phase 5

These are built. This section records the rules they follow.

### 12.1 "Us vs Them" wording
- Home is always the operator's team. Setup labels become "Our team" and "Opponent"; defaults stay "Us" / "Them".
- Spectator pages and the games list put our team first and label it as such where space allows.
- Field names (`homeTeamName`, `home_name`, ...) do **not** change; archived games and the API depend on them.

### 12.2 My Games grouped by our team
Use case: a player is on several teams, for example 2 games as "Shakopee" and 2 as "Eden Prairie". My Games shows them grouped by team.
- Group on the existing `home_name` column (our team). Matching ignores case and surrounding spaces ("Shakopee " = "shakopee").
- Groups must work across pages: the list is paginated (20), so grouping and filtering happen on the **server**, not by sorting the loaded page. Planned API: a `list_my_teams` action (distinct team names with game counts) and a `team` filter on `list_mine`. Add an index on `(owner_id, home_name)`.
- UI: team chips (or collapsible team headings) above the list, each with a count; "All" shows everything newest first. Remember the last choice on the device.
- Setup dialog: suggest our-team names from the user's past games so the spelling stays identical.
- Guests have no My Games, so nothing changes for them.
- Decided and built: one team at a time with chips above the list ("All" plus one chip per team with its game count); the chips are hidden when there are fewer than two teams. The server side is `list_mine` with `team` and `list_my_teams`; `setup.php` adds the index `idx_scoreboard_games_owner_team` (run it once; it is safe to repeat). Matching uses the column collation, which ignores case and trailing spaces but not leading spaces or accents-versus-plain differences.

### 12.3 Theme saved with each game
Every game remembers the theme in place when it started, and every screen showing that game uses it: the recorder, live viewers, and viewers of finished games.
- Add `theme` to the game and the snapshot contract. The theme is chosen in the **New Game dialog** (the theme selector moves there and is removed from Settings, so it is clear the theme belongs to the game). It is saved when the clock first starts, and is fixed from then on; until the first Start it can still be changed in the dialog. The value is the theme key from the single shared catalog.
- Viewer: apply the game's `theme`; fall back to the viewer's own saved theme only for older games that have none. The viewer stops using the viewer's own preference whenever the game carries a theme.
- Console: when it loads a game it applies that game's theme. The New Game dialog preselects the theme used by the operator's previous game (kept in preferences as `theme`, only as the default for the next game).
- `games.php` stores the value inside the snapshot JSON and caps it at 64 characters. Pages must accept only values matching `^[A-Za-z0-9._-]+$` and found in the catalog, because the value ends up in an image URL.
- Theme keys and image file names become permanent: archived games refer to them. Never rename or delete a catalog entry; if an image is missing, fall back to the default theme.
- Decided: the theme cannot change during a game, because Settings no longer has a theme selector. Spectators therefore see the same theme from start to finish.
- The theme selector is the dropdown in the setup dialog (`js/setup.js` with `js/theme.js`). Picking a theme previews it behind the dialog; cancelling restores the game's own theme. After the first Start the selector is shown dimmed with a note, and `edit_match` rejects a different theme.

---

## 13. Running Beside Production

Deployment: `main` is uploaded to the site root; other listed branches are uploaded to `/dev/`. `/dev/` has one user (the owner), and nobody uses both versions: production users stay on the production code until the refactor branch is merged to `main`. Browser storage, saved settings and caches are per person's browser, so `/dev/` testing cannot affect production users' devices.

What is still shared: **the database, the API data and the public game lists.** Until the merge:

1. **Database: additive changes only.** New nullable columns, indexes, tables and API actions are fine. Never rename, drop or change the meaning of an existing column, status value or `ended_by` value; production code reads them. `setup.php` migrations must be safe to run while production is live.
2. **Games recorded on `/dev/` are visible to production users** (public Active Games list, viewer). Keep the snapshot contract (section 6) and history entry shapes readable by the current production viewer, and add fields only as optional extras. Set test games to private or delete them.
3. **Deployment workflow:** `.github/workflows/deploy.yaml` deploys every branch: `main` to the site root, all others to `/dev/`. A push to any other branch replaces what is in `/dev/`.
4. **Cutover (merge to `main`):** every production user's existing data is in the old format, in localStorage (`timerStateV7` and related keys) and in their `scoreboard` profile record, so the migration must convert both on first load.
   - Merge only when no games are live (the owner will ensure this).
   - **One-time server migration script** (written in Phase 2/3 once the new format is final) converts every row in `scoreboard_games` (snapshot and history) and every `scoreboard` record in `suite_user_data` to the new format, and backfills new fields (team-grouping column; `theme` for old games = default theme). It must: be idempotent (skip rows already converted), have a dry-run mode, require a secret token or be deleted right after use, and be tested against a copy of real data after a database backup. Run it right after the merge deploys.
   - The script cannot reach browsers, so the app still converts the local saved game (`timerStateV7` and related keys) on first launch. Keep that local converter for a release or two, and re-run the script once afterward to catch games synced late by stale pages. After the script has run, the old-format history renderer and the server-side legacy readers can be removed.
   - A rollback after the cutover would meet new-format data the old code cannot read, so test the migration with real saved states (Phase 0 fixtures) before merging.
