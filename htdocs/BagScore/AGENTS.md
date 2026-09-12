# BagScore - Sub-Application AI Agent Guidelines

This document defines the agent parameters, domain rules, and architecture specific to the **BagScore** (Cornhole Scorekeeper) sub-application under `htdocs/BagScore/`.

---

## 1. Sub-App Overview

BagScore is a digital scoring utility for Cornhole / Bag Toss games. It features an interactive visual board target, team score tracking, and subtractive (cancellation) round scoring.

### Primary Files
- `index.html`: Main scoreboard view, interactive board canvas/SVG, action buttons, and scoring logic.
- `style.css`: Scoreboard layouts, team color themes (Red vs. Blue), board target styling, and responsive media queries.

---

## 2. Domain & Scoring Rules

### Game Format & Rules
- **Teams**: Two competing sides (Red Team and Blue Team).
- **Bags per Inning/Round**: Each team throws exactly 4 bags per round (total 8 bags per inning).
- **Target Points**:
  - **Hole Target**: `+3` points (bag inside the hole).
  - **Board Target**: `+1` point (bag resting on the board surface).
  - **Off-Board / Foul**: `0` points (missed or bounced off ground).
- **Subtractive / Cancellation Scoring**:
  - At the end of each 8-bag frame, calculate:
    $$\Delta = |\text{Red Round Points} - \text{Blue Round Points}|$$
  - Only the team with the higher round total is awarded the net difference ($\Delta$) added to their total game score. The other team scores 0 for that round.
- **Winning Condition**: Standard cornhole target is 21 points. Preserve options for exact-21 (bust penalty back to 11 or 15) vs. play-to-or-exceed 21 if configured.

---

## 3. UI & Interaction Parameters

- **Turn Progression**: Clearly indicate active throwing team via turn indicator banners and visual highlights on the active team box.
- **Interactive Board Element**: Clicking/tapping `#hole-element` registers a 3-point bag; clicking `#board-element` registers a 1-point bag.
- **Bag Limit Safeguard**: Prevent scoring more than 4 bags per team per round; show a notification toast (`#limitToast`) if a team attempts to exceed 4 bags.
- **Undo & Reset Actions**:
  - Undo must accurately revert the last thrown bag and restore previous round sub-totals.
  - Reset Round clears pending round points and bag tallies without altering cumulative game scores.
  - Reset Game resets all cumulative scores and starts a fresh match.

---

## 4. Coding & Maintenance Guidelines

- Adhere to the root `AGENTS.md` versioning and commenting rules:
  - Document all current functions and event handlers with clear inline comments.
  - Increment the 2-part version constant (`APP_VERSION`) by `0.1` upon every functional edit and update the footer version element.
- Keep layout responsive for handheld mobile use outdoors on cornhole courts.
