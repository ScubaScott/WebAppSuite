# Task: ScoreBoard Game Tracking Redesign Implementation Checklist

This checklist tracks the implementation of the database-backed game tracking system for ScoreBoard, as specified in `ScoreBoard-GameTracking-Spec.md`.

## Phase 1: Database Schema & Core Authentication
- [x] 1.1 Append `suite_sessions` and `suite_games` tables to `htdocs/api/schema.sql`
- [x] 1.2 Create `htdocs/api/auth.php` extracting `getAuthToken()` and `authenticateUser()` with `suite_sessions` token hashing (no legacy check required)
- [x] 1.3 Update `htdocs/api/profile.php` to use `auth.php`, issue per-device sessions on login, validate payload size and app ID length, bump version to 1.2
- [x] 1.4 Update `htdocs/api/setup.php` to prevent echoing DB credentials on connection failure, bump version to 1.1

## Phase 2: Game Tracking API (`api/games.php`)
- [x] 2.1 Create `htdocs/api/games.php` with same-origin policy and database connection
- [x] 2.2 Implement `POST ?action=sync` (create/update, auto-claim, revision check with 409, snapshot processing, guest 24h expiry)
- [x] 2.3 Implement `GET ?action=list_public` (effective status with 3h timeout, age_ms calculation, opportunistic expired purge)
- [x] 2.4 Implement `GET ?action=get&id=...` and `POST ?action=get` (public and owner-authenticated private game retrieval)
- [x] 2.5 Implement `POST ?action=list_mine` (paginated list of user-owned games)
- [x] 2.6 Implement `POST ?action=set_visibility` (toggle public/private for owned games)
- [x] 2.7 Implement `POST ?action=delete` (hard delete for owned games)

## Phase 3: Client Library Updates (`media/suite-profile.js`)
- [x] 3.1 Implement non-destructive 401 handling (clear session without wiping app keys, dispatch `action: 'expired'`)
- [x] 3.2 Update footer indicator for expired session state
- [x] 3.3 Fix `saveAppData` debounce collision with per-appId timeout tracking
- [x] 3.4 Implement `SuiteProfile.games` namespace (`sync`, `listMine`, `setVisibility`, `remove`, `get`, `listPublic`) with revision conflict handling (409)
- [x] 3.5 Bump `SUITE_PROFILE_VERSION` to 1.5

## Phase 4: ScoreBoard Operator Console (`ScoreBoard/index.html`)
- [x] 4.1 Update game initialization to generate UUIDv4 and 64-hex `writeToken`
- [x] 4.2 Replace `publishActiveGameStateServer` with `SuiteProfile.games.sync` while maintaining local storage fallback
- [x] 4.3 Configure sync triggers: debounced state change, heartbeat only while timer is running, and `pagehide`/`visibilitychange` beacon flush
- [x] 4.4 Add 3-hour stale resume prompt modal to prevent phantom elapsed time on clock
- [x] 4.5 Fix guest game loss on login (retain guest game on login without cloud data; claim & finalize if cloud data exists)
- [x] 4.6 Add "Share on Active Games list" visibility toggle and "My Games" link for signed-in users only
- [x] 4.7 Add optional "End Game" button and update "New Game" flow to finalize before generating new UUID
- [x] 4.8 Fix footer version script execution timing and bump version to 2.8

## Phase 5: Spectator & Active Games Pages
- [x] 5.1 Update `ScoreBoardViewer.html`: switch to `api/games.php`, clock extrapolation using `age_ms`, handle stalled/final states, fix penalty card history rendering, fix footer version, bump version to 1.2
- [x] 5.2 Update `ScoreBoardActiveGames.html`: switch to `api/games.php`, prevent XSS (textContent / data attributes), update status pills (Live, Paused, Stalled, Final), fix footer version, bump version to 1.3
- [x] 5.3 Create `ScoreBoard/ScoreBoardMyGames.html`: signed-in user game management dashboard (view, toggle visibility, delete, pagination), guest sign-in notice, version 1.0

## Phase 6: Cutover & Cleanup
- [x] 6.1 Retire and delete `ScoreBoard/active-games.php` and `ScoreBoard/active-games.json`
- [x] 6.2 Bump `SW_VERSION` in `htdocs/sw.js` to 3.3
- [x] 6.3 Update `htdocs/ScoreBoard/AGENTS.md` to reflect new DB-backed sync architecture
- [x] 6.4 Verification: syntax linting, functional review, and acceptance criteria verification
