# Dominoes - Sub-Application AI Agent Guidelines

This document defines the agent parameters, scoring rules and architecture specific to the **Dominoes** score keeper under `htdocs/Dominoes/`. Follow the root `AGENTS.md` as well.

---

## 1. Sub-App Overview

Dominoes keeps score for n players in games such as Mexican Train and Chickenfoot. Each round a player scores the pips left in their hand, and the **lowest total wins**. A camera scanner (planned, see section 5) counts the pips on the tiles left in a hand.

### Primary Files
- `index.html`: Main screen (round status strip, line chart, player cards, score sheet) plus the score-entry and settings dialogs.
- `core.js`: Pure scoring and game-state functions (`DominoCore`). No DOM access, so it runs in Node tests.
- `chart.js`: Dependency-free SVG line chart (`DominoChart`).
- `app.js`: Page controller: state, rendering, dialogs, persistence, cloud sync, wake lock.
- `styles.css`: Dark theme tokens and layout.
- `tests/core.test.js`: Node unit tests for `core.js` (`node htdocs/Dominoes/tests/core.test.js`).

---

## 2. Scoring Rules

| Rule | Value |
| :--- | :--- |
| Tile score | `a + b` (pips on both halves) |
| Double-blank `0\|0` | Configurable, default **30** (`settings.doubleBlankValue`). Only the 0\|0 tile uses it; `0\|5` is just 5. |
| Player who goes out | 0 for the round ("Out (0)" button) |
| Winner | Lowest total after the last round; ties share rank and all tie-holders win |
| Domino set | `settings.setMax` 6, 9, 12 (default) or 15 |
| Rounds | `settings.rounds`, default `setMax + 1` (13 for double-12); minimum is the last round that already has scores |
| Engine double | Counts down from `setMax` (or up from 0) and wraps; shown as `d\|d` per round |
| Starting player | `players[round % playerCount]`, in seat order |

A round entry is `{ points, source: 'type' | 'out' | 'scan', tiles? }`. Entries that keep `tiles` are re-scored whenever the 0|0 value changes; typed scores are never changed.

---

## 3. Storage & Sync

| Key | Contents |
| :--- | :--- |
| `dominoGame` | The current game (settings, players, rounds with per-player entries, `updatedAt`) |
| `dominoHistory` | Up to 30 finished or abandoned game summaries |
| `dominoPrefs` | Player sort, chart mode, last roster |

- Every change is written to `localStorage` first, then `SuiteProfile.saveAppData('dominoes', { game, history })` backs it up (logged-in users only; the library queues it while offline).
- On load and on sign-in, `SuiteProfile.loadAppData('dominoes')` is merged with `DominoCore.mergeRemote`: the game with the newer `updatedAt` wins and history is unioned by id. A default game that was never edited has `updatedAt` 0, so it never overwrites cloud data.
- The three keys are listed in `SUITE_APP_KEYS` in `media/suite-profile.js` so sign-out clears them.
- `profile.php` accepts any app id, so no server change is needed.

---

## 4. UI Notes

- Player order modes: **Seat** (turn order, changed in Settings with the arrow buttons), **Name**, **Score** (lowest first).
- Only the **selected** player shows the scoring buttons (Scan, Enter/Edit, Out); every other player is a compact line with score position, name and total. Tapping a line selects that player. Scoring from the list selects the next seat in seat order (wrapping, regardless of sort) that has no score in the round, because scores are often entered out of order (lowest hands first); changing rounds selects the first player without a score in that round. Sheet-cell edits do not change the selection.
- The status strip's round can be changed with the arrows, by tapping a chart column or by tapping a score-sheet row; entering the last missing score of the viewed round advances to the next open round.
- Undo restores the whole game snapshot (score edits and settings changes), up to 20 steps per session.
- The 44px touch-target rule applies to every button and cell.

---

## 5. Camera Scanner (planned)

`scan/` will hold the scanner page (tile detection, perspective straightening, per-half pip counting and an editable review grid). `SCAN_ENABLED` in `app.js` shows the per-player Scan button once the page ships. It reuses `Imaging` from `htdocs/media/scan/imaging.js` (moved out of `Bingo/scan/`). Test photos and labels live in `tools/domino-scan-testset/`, which is never deployed.

---

## 6. Coding & Maintenance Guidelines

- Every script defines its own 2-part version constant with a unique name (`APP_VERSION` in `app.js`, `DOMINO_CORE_VERSION`, `DOMINO_CHART_VERSION`); increment by `0.1` per change and show the page version in the footer. Never redeclare a name that another script on the same page already declares.
- Add every new file to `APP_SHELL` in `htdocs/sw.js` and bump `SW_VERSION`.
- Keep comments about current behavior only.
