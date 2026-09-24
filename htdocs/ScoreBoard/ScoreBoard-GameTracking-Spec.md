# ScoreBoard Game Tracking Redesign: Implementation Spec

**Project:** WebAppSuite (Scuba's App Suite), vanilla JS front end + PHP/PDO + MySQL/MariaDB
**Status:** Planning complete. No code has been written.
**Audience:** A coding agent implementing the change. This document is self-contained.

## 0. How to read this spec

Every requirement carries one of three tags:

- **[CONFIRMED]** The owner explicitly decided this. Do not deviate.
- **[PROPOSED]** Recommended during planning and not objected to. Implement it unless the owner says otherwise.
- **[OPEN]** Undecided. Implement the stated default and flag it in your summary.

Ground rules:

- Keep the existing stack: vanilla JS, PHP with PDO, MySQL/MariaDB. No frameworks, no build step.
- **[CONFIRMED]** All login and profile UI stays at the suite level (the launcher `index.html` and `SuiteProfile`). Sub-app pages (ScoreBoard, Viewer, Active Games, My Games) must not contain login forms or login clutter. They may only read session state (guest vs signed in) and show the existing footer badge.
- **[CONFIRMED]** ScoreBoard must keep working offline-first. localStorage stays the source of truth during a live game, and a failed network call must never throw an unhandled error or block scoring.

## 1. Repository map (relevant files, under `htdocs/`)

| Path | Role | Current version |
|---|---|---|
| `index.html` | Suite launcher, mounts the profile button | 2.0 |
| `sw.js` | Service worker, network-first for html/js/css/php/json | `SW_VERSION` 3.2 |
| `api/config.php` | PDO connection (`getDbConnection()`), credentials are placeholders | 1.0 |
| `api/profile.php` | Auth, password, per-app JSON blob load/save | `$API_VERSION` 1.1 |
| `api/setup.php` | Runs `schema.sql` (idempotent `CREATE TABLE IF NOT EXISTS`) | 1.0 |
| `api/schema.sql` | Tables `suite_users`, `suite_user_data` | n/a |
| `media/suite-profile.js` | Client session and cloud-sync library (`window.SuiteProfile`) | 1.4 |
| `ScoreBoard/index.html` | Operator console (timer, scores, history, settings) | `VERSION` 2.7 |
| `ScoreBoard/ScoreBoardViewer.html` | Read-only spectator page | 1.1 |
| `ScoreBoard/ScoreBoardActiveGames.html` | List of active games | 1.2 |
| `ScoreBoard/active-games.php` | File-based (`active-games.json`) game store, to be replaced | 1.1 |
| `ScoreBoard/AGENTS.md` | Sub-app notes (partly stale, see section 8) | n/a |

Not reviewed: the root `AGENTS.md`, other sub-apps (FarkleScore, BagScore, Bingo, DriverScore, HarleyVinDecoder; out of scope), any `.htaccess`, real DB credentials.

Hosting assumption (unverified): `config.php` comments reference InfinityFree free hosting. Assume no cron jobs and possible stripping of the `Authorization` header under Apache FastCGI (the existing `getAuthToken()` already works around this).

## 2. Current behavior and known problems

**How it works today**

- A game ID (`scoreboard-<timestamp>-<random>`) is created in `startTimer()` on the first Start of period 1 and kept in localStorage (`scoreBoardCurrentGameIdV1`). State lives under `timerStateV7`.
- `saveState()` calls `publishActiveGameState()`, which mirrors the game to a local `scoreBoardActiveGamesV1` entry and POSTs the full snapshot, including `scoreHistory`, to `ScoreBoard/active-games.php`. A 20-second heartbeat repeats the POST. Every POST sets `expiresAt` to now + 24 h.
- "New Game" (`endCurrentGameAndStartNew`) posts a final snapshot with `status: 'game_over'` and mints a new ID. It is the only thing that closes a game.
- Signed-in users also get `SuiteProfile.saveAppData('scoreboard', state)`, which stores one overwritten blob: the current state, not an archive.

**Problems this spec fixes**

1. **Orphaned games.** If the app is closed without pressing New Game, the server record stays "in progress" until its 24 h expiry, then disappears. There is no permanent record of any game.
2. **Runaway viewer clock.** The server keeps `timerRunning: true`. The viewer computes `elapsedMs + (Date.now() - lastUpdate)`, so a dead game's clock counts up until expiry. It also mixes the viewer's clock with the server's timestamp (clock skew).
3. **Phantom time on resume.** `onload` adds `Date.now() - lastSavedAt` to `accumulatedTime` when the saved state was running. Reopening the app hours later adds hours to the clock.
4. **Heartbeat never stops.** A tab left open republishes forever, extending expiry.
5. **No permissions.** `active-games.php` accepts unauthenticated POST and DELETE for any ID. IDs are exposed by the public list, so anyone can overwrite or delete anyone's game.
6. **Race condition.** `active-games.php` does read-modify-write on one JSON file with no `flock`.
7. **Stored XSS.** `ScoreBoardActiveGames.html` interpolates `homeTeamName`, `awayTeamName`, `gameTitle` and `id` into `innerHTML` and an inline `onclick` without escaping. Since anyone can POST arbitrary names, this is exploitable.
8. **Guest game discarded on login.** In `ScoreBoard/index.html` `onload`, when logged in and no cloud state exists, local `timerStateV7` is deleted ("cloud state strictly overwrites local"). A guest's in-progress game is lost when they sign in at the launcher.
9. **Single token per user.** `profile.php` stores one `auth_token` per user, so logging in on a second device silently invalidates the first. `token_expires` is never set, so tokens never expire. In `suite-profile.js`, a 401 is treated as an ordinary failure: the stale session is never cleared, the UI still shows the signed-in cloud icon, and saves silently stop.
10. **Debounce collision.** `saveAppData` uses one module-level `saveTimeout` shared across apps, so saves for different `appId`s cancel each other.
11. **Viewer renders cards wrongly.** History entries with `type: 'card'` fall through to the "scored" branch in `ScoreBoardViewer.html`.

## 3. Goals and confirmed decisions

- **[CONFIRMED]** Capture each game whole, start to finish, as one unit.
- **[CONFIRMED]** Handle the common case where users just close the app at the end and never press a game-over control.
- **[CONFIRMED]** Keep game history for longer than today.
- **[CONFIRMED]** Move server-side game storage into the database.
- **[CONFIRMED]** A game can be public (appears on the Active Games list) or not. Non-public games are stored per user in the DB, where the user can view or delete them later.
- **[CONFIRMED]** Guests keep today's behavior: they can run a game and it appears on the active games list, but they get no delete or save controls and no "My Games".
- **[CONFIRMED]** For signed-in users, new games default to **public** unless the user specifically changes it to private.

## 4. Target design

### 4.1 Game model

A game is a database row with a lifecycle, not a JSON blob overwritten in place.

| Concept | Guest game | Signed-in (owned) game |
|---|---|---|
| Owner | none | the user |
| Visibility | always `public` (no control shown) | `public` by default, user may set `private` |
| Delete / My Games | none | yes |
| Lifetime | expires 24 h after last activity | kept until the user deletes it **[PROPOSED]** |
| Ends via | New Game, or auto-finalize timeout | New Game, End Game, or auto-finalize timeout |
| Writes require | per-game write token | session token or per-game write token |

Status is `live` or `final`. `ended_by` records `user`, `new_game`, or `timeout`. **[PROPOSED]** Only two visibility values exist (`public`, `private`). A link-only "unlisted" state was considered and dropped.

### 4.2 Orphan handling **[PROPOSED]** (layered; no single button is relied on)

1. **Server auto-finalize.** A `live` game whose `last_activity_at` is older than `GAME_TIMEOUT_HOURS` (constant, default **3**) is treated as `final` with `ended_by = 'timeout'`, `ended_at = last_activity_at`, `timer_running = 0`, keeping the last known score. Compute it at read time, and also persist it lazily when the row is touched. There is no cron.
2. **Client stale-resume prompt.** On load, if the saved state was running and `now - lastSavedAt` exceeds the same threshold, do not resume the clock. Ask "Finish last game?" with two options: finish it (send a final sync with `ended_by: 'timeout'`, then reset to a fresh game) or resume without adding elapsed time. Gaps under the threshold keep today's drift behavior.
3. **Better flush on close.** Send a last sync from `pagehide` and `visibilitychange: hidden` using `navigator.sendBeacon` (JSON body, token in body). Do not rely on `beforeunload`.
4. **Heartbeat only while the timer is running.** Heartbeat and every-change syncs update `last_activity_at`. A stopped or paused game with no changes therefore times out naturally.
5. **Optional "End Game" button (low priority).** Finalizes the game without resetting, so the final score stays on screen. "New Game" behaves as today (finalizes with `ended_by = 'new_game'`, then resets).

### 4.3 Data model (append to `api/schema.sql`; keep `CREATE TABLE IF NOT EXISTS`)

Use UTC consistently for all DB timestamps (`UTC_TIMESTAMP()`, or set the connection time zone), to avoid PHP vs MySQL mismatch on shared hosting.

```sql
-- Per-device sessions (replaces the single suite_users.auth_token) [PROPOSED]
CREATE TABLE IF NOT EXISTS `suite_sessions` (
    `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    `user_id` INT UNSIGNED NOT NULL,
    `token_hash` CHAR(64) NOT NULL UNIQUE,      -- sha256 of the token; raw token only lives on the client
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    `last_used_at` DATETIME DEFAULT NULL,
    `expires_at` DATETIME NOT NULL,             -- default 90 days, sliding
    INDEX `idx_sessions_user` (`user_id`),
    CONSTRAINT `fk_sessions_user` FOREIGN KEY (`user_id`)
        REFERENCES `suite_users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `suite_games` (
    `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    `game_id` CHAR(36) NOT NULL UNIQUE,         -- client-generated UUIDv4
    `app_id` VARCHAR(32) NOT NULL DEFAULT 'scoreboard',
    `owner_id` INT UNSIGNED NULL,               -- NULL = guest game
    `write_token_hash` CHAR(64) NOT NULL,       -- sha256 of client-generated per-game secret
    `visibility` ENUM('public','private') NOT NULL DEFAULT 'public',
    `status` ENUM('live','final') NOT NULL DEFAULT 'live',
    `ended_by` ENUM('user','new_game','timeout') NULL,
    `rev` INT UNSIGNED NOT NULL DEFAULT 0,
    -- denormalized columns for list views
    `home_name` VARCHAR(60) NOT NULL DEFAULT 'Home',
    `away_name` VARCHAR(60) NOT NULL DEFAULT 'Away',
    `home_score` INT NOT NULL DEFAULT 0,
    `away_score` INT NOT NULL DEFAULT 0,
    `current_period` TINYINT UNSIGNED NOT NULL DEFAULT 1,
    `timer_running` TINYINT(1) NOT NULL DEFAULT 0,
    `is_paused` TINYINT(1) NOT NULL DEFAULT 0,
    `elapsed_ms` BIGINT UNSIGNED NOT NULL DEFAULT 0,
    -- full snapshot: config, colors, time limit, scoreHistory, etc.
    `state_json` LONGTEXT NOT NULL,
    `started_at` DATETIME NOT NULL,
    `ended_at` DATETIME NULL,
    `last_activity_at` DATETIME NOT NULL,
    `expires_at` DATETIME NULL,                 -- set for guest games only; NULL = keep until deleted
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX `idx_games_owner` (`owner_id`, `started_at`),
    INDEX `idx_games_public` (`visibility`, `status`, `last_activity_at`),
    INDEX `idx_games_expires` (`expires_at`),
    CONSTRAINT `fk_games_owner` FOREIGN KEY (`owner_id`)
        REFERENCES `suite_users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

History stays a JSON snapshot column (not an events table), because the app lets users edit notes and delete entries and derives the score from them.

Queries and rules:

- **Public list:** `visibility = 'public' AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP()) AND (effective status is live OR ended_at > UTC_TIMESTAMP() - INTERVAL 24 HOUR)`. Owned public games drop off the list 24 h after ending but stay in the owner's history.
- **Guest rows:** `expires_at = last_activity_at + 24 h`, refreshed on every write.
- **Purge:** opportunistically run `DELETE FROM suite_games WHERE expires_at IS NOT NULL AND expires_at < UTC_TIMESTAMP() LIMIT 100` on list requests. No cron.

### 4.4 API: new `api/games.php`

Move the auth helpers (`getAuthToken()`, `authenticateUser()`) out of `profile.php` into a shared `api/auth.php` that both files `require_once`. Update `authenticateUser()` to look up `suite_sessions` by `sha256(token)`, checking `expires_at` and updating `last_used_at`. **[PROPOSED]** For a transition period, also accept the legacy `suite_users.auth_token` so existing signed-in clients are not logged out at cutover, then remove that fallback later. `profile.php` `auth` should issue a new session row per login instead of overwriting one token.

Transport rules:

- Do **not** put session tokens in URLs. Public reads use `GET` with no auth. Any read that needs the session (My Games, a private game the owner is viewing) uses `POST` with the token in the JSON body. Also accept `Authorization: Bearer`, but the body is the reliable path on this host.
- Same-origin use only, so do not send `Access-Control-Allow-Origin: *` from `games.php`.
- Reject request bodies over ~256 KB (HTTP 413) and cap `scoreHistory` at about 2000 entries.
- Sanitize on write: team names limited to 60 chars, control characters stripped. Never trust stored strings; clients still escape on render.
- Never return `write_token_hash` or any token from any endpoint.

Actions (query param `?action=`, like `profile.php`):

**`POST ?action=sync`**: create or update a game.
```json
{
  "game_id": "uuid-v4",
  "write_token": "64-hex-chars",
  "rev": 12,
  "token": "<session token, optional>",
  "visibility": "public",
  "status": "live",
  "ended_by": null,
  "snapshot": {
    "homeTeamName": "", "awayTeamName": "", "homeScore": 0, "awayScore": 0,
    "currentPeriod": 1, "timerRunning": false, "isPaused": false,
    "isCountingUp": false, "timeLimit": 2400000, "elapsedMs": 0,
    "homeTeamColor": "#ef4444", "awayTeamColor": "#3b82f6",
    "scoreHistory": [], "startedAt": 1700000000000
  }
}
```
Server rules:
- If the game does not exist, create it. Owner = session user if a valid session was sent, else NULL. Store `sha256(write_token)`. For guest games force `visibility = 'public'`, set `expires_at`.
- If it exists, authorize by either (a) a valid session whose user is `owner_id`, or (b) a `write_token` whose hash matches. Otherwise return 403.
- **Auto-claim:** if the game is ownerless, the token matches, and a valid session is present, set `owner_id` to that user and clear `expires_at`. This is how a guest game becomes an account game on login. It keeps its current visibility (public).
- Ignore `visibility` from guests. For owners, accept it.
- Reject a stale `rev` (`rev <= stored rev`) with HTTP 409 and `{ "success": false, "rev": <stored rev> }`. This protects against out-of-order requests (debounce, beacon, queued flush). On 409 the client sets its local rev to the server rev and lets the next change or heartbeat resend its (authoritative) state. If the stored game is already `final`, the client treats the game as ended elsewhere and stops syncing it.
- Update `last_activity_at` to server time. Recompute the denormalized columns from the snapshot.
- Return `{ "success": true, "rev": n, "status": "...", "visibility": "..." }`.

**`GET ?action=list_public`**: summaries only (no history, no tokens): `game_id, home_name, away_name, home_score, away_score, current_period, status (effective), timer_running, is_paused, elapsed_ms, age_ms, started_at, ended_at`. Include `server_now`. Sort by `last_activity_at` descending.

**`GET ?action=get&id=<game_id>`**: full game including history for `public` games. For `private` games return 404 (do not reveal existence).

**`POST ?action=get`** with `token`: as above, but also returns private games to their owner.

**`POST ?action=list_mine`** (auth): paginated summaries (`limit`, `offset`) of the user's games, all visibilities.

**`POST ?action=set_visibility`** (auth, owner) `{ game_id, visibility }`.

**`POST ?action=delete`** (auth, owner) `{ game_id }`: hard delete. This also removes it from the public list.

Every read response includes `age_ms = server_now - last_activity_at` so viewers extrapolate the clock without comparing their own clock to the server's (fixes the skew issue).

### 4.5 Client: `media/suite-profile.js`

- **Session expiry must not wipe game data.** On any 401, clear the session token but keep local app data (unlike an explicit logout, which wipes `SUITE_APP_KEYS`). Dispatch `suite-profile-changed` with `action: 'expired'`. The existing footer badge should show "Session expired, sign in on the main page" (text only, no login UI). ScoreBoard's existing reload handler only fires on `login` and `logout`, so `expired` must update the badge without reloading.
- Add a `SuiteProfile.games` namespace: `sync`, `listMine`, `setVisibility`, `remove`, `get`, `listPublic`. It has its own per-game debounce (not the shared `saveTimeout`), its own offline queue (separate from `webappsuite_pending_sync`), and `rev` tracking including the 409 handling above.
- Game sync must work for **guests** (unlike `saveAppData`, which returns early for guests). Attach the session token only when one exists.
- Fix the shared-`saveTimeout` collision (per-appId timers) while in the file.
- Keep `saveAppData('scoreboard', state)` for resume state, and keep the legacy `scorekeeper` app-id fallback on load.
- Bump `SUITE_PROFILE_VERSION`.

### 4.6 Client: `ScoreBoard/index.html`

- Replace game-ID generation with `crypto.randomUUID()` (with a fallback) plus a 32-byte random hex `writeToken`. Store `activeGameId`, `writeToken`, `rev`, and `visibility` in the persisted state.
- Replace `publishActiveGameStateServer()` and its direct `fetch('./active-games.php')` calls with `SuiteProfile.games.sync`. Keep the local `scoreBoardActiveGamesV1` mirror so the Active Games page still has a localStorage fallback.
- Sync triggers: debounced on state change (about 2 s), every 20-30 s only while the timer runs, and a final beacon flush on `pagehide` and `visibilitychange`.
- Implement the stale-resume prompt (4.2 item 2) in `onload`.
- **Fix guest-game loss on login** (problem 8): when logged in and no cloud state exists, do not delete an unfinished local game. Keep it and let the next sync auto-claim it. When cloud state exists and an unfinished local guest game also exists, claim the local game and mark it `final` (`ended_by: 'new_game'`), then load the cloud state.
- Signed-in users only: add a "Share on Active Games list" toggle in the settings modal (default on) and a "My Games" link next to "View Active Games". For guests, render neither. No login UI anywhere.
- `endCurrentGameAndStartNew` sends the final snapshot via `SuiteProfile.games.sync` with `status: 'final', ended_by: 'new_game'`, then generates a new UUID and token.
- Optional End Game button per 4.2 item 5.
- Bump `VERSION` and update the footer version.

### 4.7 Viewer, Active Games, My Games

**`ScoreBoardViewer.html`**
- Fetch via `games.php` (`get`). If a session exists, use the authenticated POST variant so owners can view their private games.
- 404 shows "Game not found or no longer shared."
- Extrapolate the clock only when `status = live` AND `timer_running` AND `age_ms` is under about 60 s, computed as `elapsed_ms + age_ms + time since fetch`. Otherwise freeze the clock and show "Stalled, last update X ago" or "FINAL". Stop polling once final.
- Render `card` history entries correctly (team plus card degree, not "scored").

**`ScoreBoardActiveGames.html`**
- Use `list_public`. Escape every interpolated field (or build DOM nodes with `textContent`). Replace the inline `onclick` with a data attribute and a listener, and pass the ID through `encodeURIComponent`.
- Status pills: Live, Paused, Stalled (live but `age_ms` over about 60 s), Final. Keep the localStorage fallback.

**New `ScoreBoardMyGames.html`** (signed-in only)
- List the user's games (teams, score, date, status, visibility) with pagination.
- Actions per game: open in the Viewer, toggle public/private, delete (with confirm).
- If opened without a session, show a plain message telling the user to sign in from the main page. No login form.
- Match ScoreBoard's existing dark styling.

**Retire `ScoreBoard/active-games.php`** once all three pages use `games.php`. Old data expires within 24 h, so no migration is needed. Leave the old endpoint in place until the switch is complete, then delete it along with `active-games.json`.

## 5. Suggested build order

Each step should leave the app working.

1. **Server:** add the two tables to `schema.sql`, extract `auth.php`, update `profile.php` for per-device sessions (with legacy-token fallback), write `games.php`.
2. **`suite-profile.js`:** 401 handling that preserves local data, the `games` namespace, the debounce fix.
3. **ScoreBoard:** new sync, stale-resume prompt, claim-on-login fix, visibility toggle and My Games link (signed-in only).
4. **Viewer and Active Games:** switch endpoints, escaping, stalled and final handling, card rendering.
5. **My Games page.**
6. **Cutover:** remove the old endpoint and JSON file, bump `SW_VERSION` in `sw.js`, bump all touched file versions, update `ScoreBoard/AGENTS.md`.

## 6. Incidental issues worth fixing while in these files

- `api/setup.php` echoes `DB_HOST`, `DB_NAME`, and `DB_USER` into a publicly reachable page on connection failure. Remove that output, and consider protecting or removing the page after setup.
- `profile.php` `save` has no payload size cap and does not validate the `app` identifier length (column is `VARCHAR(32)`).
- `profile.php` `auth` logs in anyone who submits an existing passwordless username. This is worth surfacing in the UI as "open profile" (it already says so), but be aware that "private" games on a passwordless profile are only as private as the username is secret.
- In `ScoreBoard/index.html`, the Viewer, and Active Games, the script that writes the footer version runs before the footer element exists, so `getElementById` returns null. The footer shows the hard-coded default (ScoreBoard shows 2.6 while `VERSION` is 2.7). Move the lookup into a `DOMContentLoaded` handler or after the footer.

## 7. Conventions (from `ScoreBoard/AGENTS.md`, root `AGENTS.md` not reviewed)

- Add clear inline comments for timer intervals, sync behavior, and any audio or heartbeat logic.
- Bump the two-part version constant by 0.1 on every functional edit and update the footer version element. Bump `SW_VERSION` in `sw.js` with every deployment (its comment requires this).
- Never throw an unhandled error if PHP or the network fails. Continue in local mode.
- `ScoreBoard/AGENTS.md` sections 2 and 3 describe features that do not exist in the current code (+2/+3 buttons, shot clock) and the old sync model. Update the sync section to describe the DB-backed model. Do not treat the stale sections as requirements.

## 8. Acceptance criteria

1. A guest starts a game and it appears on Active Games within about 5 s. The guest sees no visibility toggle and no My Games link. If the tab is closed mid-game, the game stays live, is auto-finalized after 3 h with its last score, and leaves the list 24 h after last activity.
2. A signed-in user's new game is public by default. Setting it private removes it from the list by the next poll, and a Viewer link then shows "no longer shared." The owner sees it in My Games and can delete it, which removes it everywhere.
3. Reopening the app after more than 3 h shows the "Finish last game?" prompt and never adds phantom hours to the clock.
4. The same user signed in on two devices keeps both working (per-device sessions). A 401 on either device clears only the session, never the local game state, and the footer badge reflects "Session expired."
5. Signing in at the launcher mid-game does not lose the guest game. It is claimed by the account, keeps syncing, and appears in My Games.
6. A stale `rev` is ignored with a 409 and the client recovers. A wrong `write_token` returns 403. No response ever contains a token or token hash.
7. A team name of `<img src=x onerror=alert(1)>` renders as inert text on every page.
8. The Viewer never ticks the clock for a stalled or final game, and card events render correctly.
9. With the API unreachable, scoring continues, queued syncs flush on reconnect, and no unhandled errors appear in the console.
10. All touched files have bumped version constants and footers, and `SW_VERSION` is bumped.

## 9. Open items and assumptions to verify

- **[OPEN]** Should a user's choice of "private" be remembered so later games also start private, or apply only to that one game? **Default: per game only** (each new game starts public).
- **[PROPOSED, adjustable]** `GAME_TIMEOUT_HOURS = 3` and the 24 h public-list window for finished games.
- **[PROPOSED]** Owned games are kept until the user deletes them, with no automatic cap.
- **[PROPOSED, optional]** Throttle guest game creation per IP to limit abuse of the public unauthenticated write path.
- **Verify on the host:** whether the `Authorization` header reaches PHP (the body-token path avoids depending on it), that cron is unavailable (the design does not need it), and the real MySQL/MariaDB version for the schema.
- Root `AGENTS.md` was not reviewed. If it conflicts with anything above, the root file wins on conventions and this spec wins on behavior.
