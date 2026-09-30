# ScoreBoard - Sub-Application AI Agent Guidelines

This document defines the agent parameters, sync protocols, and architecture specific to the **ScoreBoard** sub-application under `htdocs/ScoreBoard/`.

---

## 1. Sub-App Overview

ScoreBoard is a versatile multi-sport digital scoreboard and match management utility. It includes home and away team scoring, period tracking, countdown and countup game timers, audio buzzer alerts, real-time spectator viewing, and authenticated cloud match management.

### Primary Files
- `index.html`: Main operator console and scoreboard controller.
- `ScoreBoardGames.html`: Unified two-tab matches screen (Active Games public broadcast directory and authenticated My Games archive).
- `ScoreBoardViewer.html`: Read-only spectator display mirroring scoring console layout with server-anchored clock extrapolation.
- `scoreboard-shared.js`: Shared timing helpers, status pill derivation, history table formatting, and read-only theme application.
- `ScoreBoardActiveGames.html`: Legacy redirect stub forwarding to `ScoreBoardGames.html?tab=active`.
- `ScoreBoardMyGames.html`: Legacy redirect stub forwarding to `ScoreBoardGames.html?tab=mine`.
- `ScoreBoardHelp.html`: Operating guide and keyboard shortcut instructions.
- `scoreboard.css`: High-contrast dark scoreboard styling, large LED-style score boxes, and responsive control panels.
- `../api/games.php`: Database-backed game tracking API interfacing with `scoreboard_games`, `scoreboard_game_tombstones`, and `suite_sessions`.

---

## 2. Core Scoreboard & Timing Parameters

### Score & Period Operations
- **Teams**: Dual-team tracking (`Home` / `#score-home` vs. `Away` / `#score-away`) with custom team names and theme colors.
- **Score Increments**: Fast-action buttons for `+1`, `+2`, `+3`, and `-1` (correction), as well as direct tap-to-edit capabilities.
- **Period Management**: Cycle through standard periods (`P1`, `P2`, `P3`, `P4`) and Overtime (`OT`).
- **Penalty Foul Cards**: Optional yellow and red card tracking with card-raising animations and activity logging.
- **Game Clock**:
  - Millisecond-accurate countdown or countup timer with drum roller adjustment.
  - Controls for Start, Stop, Pause, Reset (New Game), and End Game.
  - 3-hour stale resume protection modal prevents phantom drift accumulation on abandoned games.
  - Audio whistle alert upon timer expiration.

---

## 3. Database Sync & Remote Spectator Architecture

- **Backend Integration (`../api/games.php`)**:
  - Games are persisted in the `scoreboard_games` table in MySQL/MariaDB with JSON snapshots, monotonic revision counters (`rev`), 64-hex write tokens, and guest 24-hour expiration.
  - Authenticated sessions are tracked via `suite_sessions` storing SHA-256 token hashes per device.
  - Guest games are automatically claimed by signed-in users on login or next sync.
- **Operator Sync Lifecycle (`index.html`)**:
  - Local state in `localStorage` remains the immediate source of truth during matches for complete offline resilience.
  - State changes trigger debounced cloud synchronization (`SuiteProfile.games.sync`) with an offline queue.
  - 20-second heartbeat pings fire **only while the timer is actively running**.
  - Immediate beacon flushes (`navigator.sendBeacon`) dispatch on `pagehide` and `visibilitychange: hidden`.
- **Spectator Clock Extrapolation (`ScoreBoardViewer.html`)**:
  - Uses server-anchored clock model with `server_now` time offset calculation.
  - Extrapolates clock display only when `status !== 'final'`, timer is running, and `isPaused === false`.
  - Clamps at period limit unless reported in overage, and caps extrapolation at `STALL_THRESHOLD_MS` (30 minutes).
  - When `age_ms >= 30 * 60 * 1000`, the clock freezes and the match is marked as `Stalled`.
  - When `status === 'final'`, polling ceases immediately and clock displays final frozen time.
- **XSS Prevention**:
  - Dynamic content in `ScoreBoardGames.html`, `ScoreBoardViewer.html`, and `index.html` uses safe DOM assignment (`textContent`) and `encodeURIComponent` for all identifiers.

---

## 4. Coding & Maintenance Guidelines

- Follow root `AGENTS.md` rules:
  - Document timer intervals, audio synthesis, and sync methods with clear inline comments.
  - Increment the 2-part version constant (`APP_VERSION`) by `0.1` upon every functional edit and update the footer version element.
  - Sub-app pages must never embed login forms (authentication is managed by the root launcher).
- Ensure scoreboard numbers maintain high legibility from a distance and avoid text-wrapping issues during rapid score updates.
