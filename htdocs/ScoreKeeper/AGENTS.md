# ScoreKeeper - Sub-Application AI Agent Guidelines

This document defines the agent parameters, sync protocols, and architecture specific to the **ScoreKeeper** sub-application under `htdocs/ScoreKeeper/`.

---

## 1. Sub-App Overview

ScoreKeeper is a versatile multi-sport digital scoreboard and match management utility. It includes home and away team scoring, period tracking, countdown game timers, shot/possession clocks, audio buzzer alerts, and spectator remote viewing.

### Primary Files
- `index.html`: Main operator console and scoreboard controller.
- `ScoreKeeperViewer.html`: Clean spectator display optimized for external monitors, projectors, or remote viewers.
- `ScoreKeeperActiveGames.html`: Dashboard showing currently active/open games.
- `ScoreKeeperHelp.html`: Operating guide and keyboard shortcut instructions.
- `active-games.php`: Optional lightweight PHP backend for publishing and reading active game states across multiple devices.
- `scorekeeper.css`: High-contrast dark scoreboard styling, large LED-style score boxes, and responsive control panels.

---

## 2. Core Scoreboard & Timing Parameters

### Score & Period Operations
- **Teams**: Dual-team tracking (`Home` / `#score-home` vs. `Away` / `#score-away`).
- **Score Increments**: Fast-action buttons for `+1`, `+2`, `+3`, and `-1` (correction), as well as direct tap-to-edit capabilities.
- **Period Management**: Cycle through standard periods (`P1`, `P2`, `P3`, `P4`) and Overtime (`OT`) with automatic reset options.
- **Game Clock**:
  - Millisecond-accurate countdown timer.
  - Controls for Start, Pause, Reset, and quick minute adjustments (+1 min, -1 min, +10 sec, -10 sec).
  - Audio buzzer signal upon expiration (utilizing Web Audio API synthesis or embedded audio clips).
- **Secondary / Shot Clock**: Independent reset (e.g., 24-sec / 30-sec / 14-sec shot clocks) with dedicated horn alert.

---

## 3. Remote Sync & Viewer Protocol

- **Hybrid Synchronization**:
  - Local state: Persisted in `localStorage` for zero-latency local operations and full offline capability.
  - Network sync (`active-games.php`): When a backend server is available, periodically sync active game payloads (JSON containing `gameId`, `homeTeam`, `awayTeam`, `homeScore`, `awayScore`, `period`, `timeRemaining`, `status`).
  - Spectator mode (`ScoreKeeperViewer.html`): Polls or listens for game state updates to mirror the operator's scoreboard without exposing controls.
- **Resilience**: Never throw unhandled errors if PHP/network sync fails; gracefully continue local operation.

---

## 4. Coding & Maintenance Guidelines

- Follow root `AGENTS.md` rules:
  - Document timer intervals, audio synthesis, and sync methods with clear inline comments.
  - Increment the 2-part version constant (`APP_VERSION`) by `0.1` upon every functional edit and update the footer version element.
- Ensure scoreboard numbers maintain high legibility from a distance and avoid text-wrapping issues during rapid score updates.
