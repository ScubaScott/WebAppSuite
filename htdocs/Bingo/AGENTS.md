# Bingo - Sub-Application AI Agent Guidelines

This document defines the agent parameters, visual rules, and architecture specific to the **Bingo** sub-application under `htdocs/Bingo/`.

---

## 1. Sub-App Overview

The Bingo suite consists of a Bingo Number Tracker, caller system, call log, game-mode manager, printable card generator, and camera card scanner.

### Primary Files & Directories
- `index.html`: Main number tracking board, caller view, last-six balls display, and game mode selector.
- `tracking.js`: Core tracking state, Web Speech API audio announcements, board persistence, and game mode logic.
- `game-creator.html`: Generator tool for customizable, printable Bingo cards.
- `style.css`: Visual styling for numbers, caller balls, cards, and modal sheets.
- `scan/`: camera card scanner (`scan.html`, `utils.js`, `ocr.js`) plus `bench.html` (benchmark page, not linked from the launcher). Image processing is plain JavaScript in `imaging.js` (no OpenCV). `geometry.js` finds the 5x5 number windows and fits the camera perspective using the card profiles in `profiles.js` (add a new card format as a new profile plus labeled test photos, never by special-casing the detector); `readers/tesseract-reader.js` reads the 24 cell crops on one sheet (the reader contract is in the spec, so a different reader can replace it); `decoder.js` turns the reader's guesses into the most likely valid card using the column ranges and no-repeats rule (also the home of `COLUMN_RANGES`); `ocr.js` ties detection, reader, decoder and the review grid together; `training-store.js` records each confirmed scan as a training sample and uploads it in the background to `api/training.php` (on by default, switchable on the Scan tab; the server side is described in section 9 of the spec and tested in `tools/bingo-scan-testset/server-test/`); `utils.js` straightens the photo. Its OCR files are not loaded from CDNs: `engine-loader.js` downloads the files listed in `scan/engine/manifest.json` once into a dedicated cache, and the service worker serves them cache-first. To change an engine file, add the new file under a new versioned name and update the manifest (sizes and SHA-256); never edit a published engine file in place. The redesign plan is in `bingo-scan-redesign-spec.md`; labeled test photos are in `tools/bingo-scan-testset/`.
- `php/`: Optional backend persistence/sync scripts.

---

## 2. Core Visual & UI Rules (Mandatory)

> [!IMPORTANT]
> **Square Centered Number Rule**:
> All bingo ball buttons and card squares must look consistent: they should all be square with the number centered. Maintain uniform aspect ratios, centered text alignment (`display: flex; align-items: center; justify-content: center;`), and distinct called/uncalled states.

### Column Mapping Conventions
- Standard B-I-N-G-O mapping:
  - **B**: 1 – 15
  - **I**: 16 – 30
  - **N**: 31 – 45 (Free Space traditionally centered on 3rd row)
  - **G**: 46 – 60
  - **O**: 61 – 75
- Custom session word bars (e.g. custom 5-letter words) must dynamically adapt column headers while maintaining standard number-to-column ranges.

---

## 3. Functional Parameters & Modes

- **Input Modes**: Support both "By Letter" (picking column first, then number) and "By Number" (direct 1–75 grid).
- **Recent Balls**: Maintain an active "Last 6" caller display strip and a timestamped Call Log modal.
- **Game Modes**:
  - Support game modes such as Standard Line/Corners, Double Mode, Coverall/Blackout, and Last Man Standing.
  - Provide clear status badges (e.g., individual card standing/sitting badges, `#doubleModeBadge`).
- **Audio Announcements**:
  - Use browser Web Speech API (`window.speechSynthesis`) for calling balls (e.g., "B-12", "I-24").
  - Ensure volume, rate, and pitch settings do not crash on mobile browsers or during rapid clicks.

---

## 4. Coding & Maintenance Guidelines

- Follow root `AGENTS.md` rules:
  - Inline comments must document current functionality with no historical commentary.
  - Increment the 2-part version constant (`APP_VERSION`) by `0.1` on changes and show in the page footer.
- Verify that card creator layouts remain printable (CSS `@media print`) with clean page breaks.
