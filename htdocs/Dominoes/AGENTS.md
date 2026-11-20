# Dominoes - Sub-Application AI Agent Guidelines

This document defines the agent parameters, scoring rules and architecture specific to the **Dominoes** score keeper under `htdocs/Dominoes/`. Follow the root `AGENTS.md` as well.

---

## 1. Sub-App Overview

Dominoes keeps score for n players in games such as Mexican Train and Chickenfoot. Each round a player scores the pips left in their hand, and the **lowest total wins**. A photo scanner (section 5) counts the pips on the tiles left in a hand.

### Primary Files
- `index.html`: Main screen (round status strip, line chart, player cards, score sheet) plus the score-entry and settings dialogs.
- `core.js`: Pure scoring and game-state functions (`DominoCore`). No DOM access, so it runs in Node tests.
- `chart.js`: Dependency-free SVG line chart (`DominoChart`).
- `app.js`: Page controller: state, rendering, dialogs, persistence, cloud sync, wake lock.
- `styles.css`: Dark theme tokens and layout.
- `tests/core.test.js`: Node unit tests for `core.js` (`node htdocs/Dominoes/tests/core.test.js`).
- `scan/`: the scanner (section 5): `scan.html`, `scan.css`, `scan.js`, `tiles.js`, `pips.js`, `review.js`, `live.js`.

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
- No browser dialogs: confirmations and messages use the shared `SuiteDialog` (`../media/suite-dialog.*`; see the root `AGENTS.md`): New game, removing a scored player, the scanner's "Use the score as scanned?" warning and "Score not saved".
- The 44px touch-target rule applies to every button and cell.

---

## 5. Photo Scanner

The selected player's **Scan** button opens `scan/scan.html?player=<id>&round=<index>`. Everything runs on the device in plain JavaScript on top of the shared `Imaging` module (`htdocs/media/scan/imaging.js`, also used by Bingo; keep its API stable).

Flow: the Scan button opens the **live camera** directly (Retake returns to it too). **Cancel** there leads to the **photo** step ("Scan with camera", "Choose a photo", "Enter tiles by hand"), and a camera that cannot start lands on that step with the reason. Then **outlines** (detected tiles drawn on the photo; tap one to leave it out; Auto/Light/Dark tile color) -> **review** (grid of straightened tiles with a bright disc over every counted pip, sized to cover the pip itself, so a pip still showing its own color is one that was missed; tap a tile to open the editor) -> **Use score**.

| File | Role |
| :--- | :--- |
| `tiles.js` (`DominoTiles`) | Detects tiles on an 800px copy of the photo. **Shadows:** when the lighting is uneven (90th / 10th percentile of the local brightness at least 1.5) and the picture has bar-like marks, every pixel is first multiplied by (typical brightness / brightness of its wide surroundings), gain limited to 0.8-2, so a tile in shadow looks like a lit one and the edge of a shadow across the table flattens; the original picture is still used to reject objects that are nearly black. Four ways of splitting tiles from the surface are tried and the one with the most bar-backed tiles wins (bar-less shapes count for little once bars are seen): **warm tint** (ivory is yellowish, a neutral gray table is not; divided by brightness so shadow does not hide it), **weakest channel** (a warm table such as wood has almost no blue, ivory is bright in every channel; needed because the camera's white balance turns ivory cool white on wood), plain light, plain dark. Holes are filled so pips do not break a tile. **Divider bars** (long thin very dark marks with tile surface on both sides, found once per notion of surface: 'warm' for neutral tables, 'neutral' = bright and weakly saturated for wood) anchor tiles in shadow, tiles that touch, and tiles that merge with bright stray patches (a blob with bars is judged tile by tile, not rejected for touching the picture edge): each bar is one tile, centered on its bar, perpendicular to it, sized from the bar length as fitted over the picture (a plane fit, so tiles nearer the camera come out larger). A blob with one bar and a clean rectangular outline uses its own outline instead. A bar that falls outside every segmented blob still makes a tile (modeled from the bar, checked for covering the surface found beside it). Bars the fixed surface tests reject (mostly in shadow or under a different light) are rescued when judged against their own surface, and every bar must have the same material on both sides (brightness within 25%), come from the one family of bars the trusted set establishes, be about as long as the others (0.4-2x the median), and stand on a surface at least 80 bright in the original picture; this removes shadow edges, cracks, cables and dark objects. Tiles lying end to end with no bars are cut apart by length; tiles side by side with no bars are reported as `uncertain`. Overlapping false tiles are dropped. Crops are cut from the full photo into 240x120 horizontal tiles. |
| `pips.js` (`DominoPips`) | Counts pips per half on a crop. A pip is a pixel whose color differs from the tile body: each half's body color is its dominant color (smoothed histogram, so a tight pip color cannot outvote shaded ivory), compared by the part of the color that is not along the body color's own RGB direction (shading only scales the body color, so shading does not count) plus rules for black pips and for pale pips that are only darker than their surroundings. Highlights next to a pip are joined to it. Finds the divider bar as a run of unbroken full-height columns, ignores the center rivet, estimates typical pip size **per half** (an oblique photo makes one half's pips much larger) and splits touching pips by size. Flags `over-max`, `duplicate`, `merged` and `uneven` per tile. Pip layouts are not used (they differ by manufacturer above 9). |
| `review.js` (`DominoReview`) | Review grid and tile editor: plus/minus/Blank per half, tap a disc to remove a pip, tap the tile to add one, delete a tile (correcting a tile, by adding, removing or blanking pips, clears the scanner's own doubts about it: "Check count" from touching pips or uneven pip sizes; "Duplicate" and "Too many pips" follow from the counts and clear on their own once they are right; **Use score** warns only while tiles are still flagged), add a tile by hand, previous/next. |
| `live.js` (`DominoLive`) | Live camera: `getUserMedia` (rear camera, up to 4K), an 800px copy of the video is analysed with `DominoTiles.detect` about five times a second and the outlines are drawn over the preview. The video element letterboxes the picture (a phone held upright gives black bars at the sides), so outlines are drawn through a transform that matches where the video actually draws the picture. **Auto** takes the picture once the camera has held still (mean brightness change between detections under a limit) and the tile centers have not moved for about a second (5 detections); a moving or shaky camera never fires. The shutter button always works. The picture is a full-size video frame (at most 3000px) that goes through the same outline check and review as a chosen photo. A missing, blocked or insecure (non-https) camera is explained on the photo step, where choosing a photo still works. The camera is switched off whenever the live step is left or the page is hidden. The Auto choice is kept in `localStorage` (`dominoScanPrefs`). |
| `scan.js` | Page flow. Writes `dominoPendingScan` (`gameId`, `playerId`, `round`, `points`, `tiles`, `at`) and returns to the game. |

**Hand-off:** only `app.js` writes game state. On load it runs `consumePendingScan()`, which records a `source: 'scan'` entry that keeps its tiles (so a changed 0|0 value re-scores it) and selects the next open seat. A hand-off for a different game, an unknown player or older than an hour is discarded.

The scanner page reads the saved game from `localStorage`, so `app.js` saves the default game on first load.

**Tuning:** thresholds live in `LIMITS` in `tiles.js` and `pips.js`. After any change run both:
- `node tools/domino-scan-testset/scan-test.js` (synthetic scenes; guards against regressions, says little about real accuracy).
- `node tools/domino-scan-testset/live-test.js` (browser test of the live camera with a fake camera; see its README section).
- `node tools/domino-scan-testset/real-test.js` (real photos in `photos/`, true tiles in `labels.json`; needs `puppeteer-core` on `NODE_PATH`). Saved results are in `baselines/`.

**Tuning with new photos:** on the outline step **Save photo** downloads the picture (a live capture or a chosen file) as `dominoes-<date>-<time>.jpg`; drop it into `tools/domino-scan-testset/photos/`, label it in `labels.json`, and run `real-test.js`. There is no server upload.

`detect(img, { debug: [] })` and `analyze(crop, { debug: [] })` fill the list with every candidate divider mark / pip blob and why it was kept or dropped. Read the true counts off the large straightened crops, not the photo: that is how `labels.json` was made.

**Current accuracy (7 images: 5 phone photos of a double-12 colored-pip ivory set on gray metal and on wood, plus the camera pictures cut from 2 live-view screenshots with tiles partly in shadow; hand-labeled in `labels.json`):** 48 of 49 labeled tiles found, 33 of 36 pip-labeled tiles read exactly (92%), 69 of 72 halves right (96%), 0 false tiles on the fully labeled photos. For comparison, the detector before shadow handling scored 43 / 28 of 35 / 61 of 70 on the same set (it found only 2 of the 4 tiles in the shadow screenshot). The live-view shadow test (`live-test.js`) expects all 4 tiles. Known weak spots: a blank 0|0 tile is sometimes missed (its only mark is the bar, and a glossy reflection can split the bar into two short pieces; a blank tile is worth 30 points, so check the count against the tiles in hand), crops that cut off part of a tile when the camera is low and oblique, very pale gray pips in a bright corner, and tiles piled on each other. The tuning images are no longer unseen: a fresh photo is the next real test.

---

## 6. Coding & Maintenance Guidelines

- Every script defines its own 2-part version constant with a unique name (`APP_VERSION` in `app.js`, `DOMINO_CORE_VERSION`, `DOMINO_CHART_VERSION`); increment by `0.1` per change and show the page version in the footer. Never redeclare a name that another script on the same page already declares.
- Add every new file to `APP_SHELL` in `htdocs/sw.js` and bump `SW_VERSION`.
- Keep comments about current behavior only.
