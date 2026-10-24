# QueenCount - Sub-Application AI Agent Guidelines

This document defines the agent parameters specific to the **QueenCount** sub-application under `htdocs/QueenCount/`. Follow it together with the root `AGENTS.md`. The full requirements live in `Docs/headcount-build-spec.md` (the spec's working name was "HeadCount").

---

## 1. Sub-App Overview

A single-operator bar-game tracker: each player pays $1 to guess the crowd head count; the closest guess wins the pot (ties split it). Fully offline, data stored in IndexedDB only (no cookies, no server sync).

### Primary Files
- `index.html` / `app.js`: Main screen (No Game / Open / Locked states), pinned entry bar, name pool, Enter actual → Preview → Confirm & lock modals.
- `history.html` / `history.js`: Read-only list of locked games, expandable to the full result list.
- `qc-shared.js`: Global `QC` — IndexedDB access, result/payout calculation, shared result-list renderer.
- `style.css`: All styling via CSS custom properties.
- `Docs/headcount-build-spec.md`: Build specification.

---

## 2. Business Rules

- Plain closest wins (over allowed); max 2 winners (equidistant under/over); exact match wins alone.
- Pot = entries × $1, no house cut; a tie splits evenly to the cent.
- Lock is permanent and atomic: the HistoryEntry and the Locked game are written in one IndexedDB transaction.
- Preview is UI-only and never persisted; reload during Preview returns to Open.
- One Game record at a time (store `game`); history (`history`) is an immutable text snapshot (never edited; entries can only be deleted whole via Edit history); the name pool (`pool`) has no links to games or history.
- Names are case/space-insensitive unique within a game and within the pool; guess values are unique within a game.
- Soft typo guard (second tap) for guesses and the actual outside 50–300; Enter actual needs ≥ 2 guesses.
- An Open game from an earlier calendar day prompts Discard / Keep at app launch only.
