# FarkleScore - Sub-Application AI Agent Guidelines

This document defines the agent parameters, scoring tables, and architecture specific to the **FarkleScore** (Farkle 10,000) sub-application under `htdocs/FarkleScore/`.

---

## 1. Sub-App Overview

FarkleScore is an interactive score sheet and turn manager for the push-your-luck dice game Farkle. It supports multi-player games, running turn totals, bank/risk decisions, standings, and customizable game settings.

### Primary Files
- `index.html`: Main game scorekeeper view, active player indicator, and turn scoring pad.
- `app.js`: Core game state machine, score calculators, turn logic, and persistence.
- `players.html`: Player roster management (add, edit, remove, reorder players).
- `standings.html`: Live leaderboard showing current rankings, total points, and historical rounds.
- `settings.html`: Configurable options (opening threshold, winning target score, farkle penalties).
- `styles.css`: Visual styling, dice score buttons, and responsive tables.
- `rules.md` & `directions.md`: Game documentation and player instructions.

---

## 2. Official Farkle Scoring Parameters

Combinations must come from a single roll; combinations cannot be built across multiple rolls.

| Dice Combination | Points Awarded |
| :--- | :--- |
| Single 1 | 100 points |
| Single 5 | 50 points |
| Three 1s | 1,000 points |
| Three of a Kind (2s through 6s) | Face Value $\times 100$ (e.g., three 4s = 400) |
| Four of a Kind | 1,000 points |
| Five of a Kind | 2,000 points |
| Six of a Kind | 3,000 points |
| Straight (1-2-3-4-5-6) | 1,500 points |
| Three Pairs | 1,500 points |

### Turn Flow & Mechanics
- **Turn Start**: Player rolls six dice and must select at least one scoring die/combination.
- **Bank**: Player banks turn points to their permanent game score. Turn passes to next player.
- **Risk / Roll Again**: Player rolls unbanked dice.
- **Hot Dice**: Scoring all 6 dice unlocks "Hot Dice" — the player rolls all 6 dice again, continuing their turn accumulation.
- **Farkle (Bust)**: A roll with zero scoring dice is a Farkle; turn ends immediately and unbanked turn points are lost (0 points for the turn).
- **Opening Board Threshold**: Players must achieve a set threshold (typically 500 or 1,000 points in a single turn) before their first score is recorded on the board.
- **End Game**: Reaching or exceeding 10,000 points triggers the final round; remaining players each receive one final turn to top the leader.

---

## 3. Storage & State Management

- Maintain game state, players, and turn history in `localStorage`.
- Preserve player turn index and ensure seamless navigation between `index.html`, `players.html`, and `standings.html`.

---

## 4. Coding & Maintenance Guidelines

- Follow root `AGENTS.md` rules:
  - Keep inline comments focused on current functionality and calculation logic.
  - Increment the 2-part version constant (`APP_VERSION`) by `0.1` upon every functional edit and update the footer version element.
- Ensure buttons and score inputs provide instant feedback and prevent accidental double-tap Farkles or early banking.
