# Bingo Card Scanner — Redesign & On-Device AI Migration Specification
**Version:** 1.2
**Status:** All decisions confirmed; ready for Phase 0
**Scope:** `htdocs/Bingo/scan/` capture → detection → recognition → review pipeline, engine asset caching, training-data collection and upload, migration from Tesseract to a custom-trained digit model (DigitNet) that runs in plain JavaScript.

---

## 1. Context & Goals

The card scanner (`scan/scan.html`, `scan/utils.js`, `scan/ocr.js`) photographs a physical bingo card and fills the 5×5 card editor. On slider/shutter cards it currently takes **1–3 minutes** and returns **1–2 correct cells** out of 24.

This spec does three things:
1. **Phase 1:** rebuild geometry, decoding and review so the existing Tesseract engine gets correctly framed input, support any card format through card profiles, and **upload labeled training data from every scan by default**.
2. **Phase 2:** train a small custom digit model (DigitNet) on that data and run it in **plain JavaScript** — no ML runtime, a few hundred KB of weights — replacing Tesseract.
3. **Phase 3 (deferred):** a hosting move and PaddleOCR, only if Phases 1–2 hit a limit they can't work around.

Phases 1 and 2 fit within the current InfinityFree hosting limits (§3).

### Targets

| Metric (on the fixed test set, §10) | Today | Phase 1 (Tesseract) | Phase 2 (DigitNet) |
|---|---|---|---|
| Cells correct (of 24), primary slider format | ~5% | ≥ 80% | ≥ 98% |
| Cards fully correct, primary slider format | 0% | ≥ 25% | ≥ 80% |
| Cells correct, other formats | unknown | set when test cards exist | ≥ 95% once trained on that format |
| Scan time, mid-range phone (capture → review screen) | 60–180 s | ≤ 5 s | ≤ 1 s |
| Works offline after first use | No (CDN scripts) | Yes | Yes |

### Non-Goals
- Cloud/LLM vision APIs. All recognition runs on the device.
- Training on phones. Training runs on the developer PC (§13).
- Cards without a FREE center. The card editor assumes index 12 is FREE.
- Multi-card or video scanning.
- Generating or printing cards. The app only scans existing physical cards to track them against a live caller.

---

## 2. Diagnosis of the Current Pipeline

| # | Problem | Location | Effect |
|---|---|---|---|
| D1 | Slider detector frames the **red tabs**, which sit *below* each window, then pads 6% | `utils.js` `detectSliderTabGrid` | Top window row is clipped; bottom slice contains slider bars; every row is shifted |
| D2 | Detected region is an **axis-aligned bounding box**, not a perspective quad | `utils.js` `detectSliderTabGrid`, `detectCellGrid` | Angled photos (bottom wider than top) are not rectified; outer columns drift off their windows |
| D3 | Rectified image is cut into **25 equal tiles** | `ocr.js` `evaluateCanvasGrid` | Assumes windows evenly fill the area; slider cards have bars between rows and wide gutters |
| D4 | Up to **5 Tesseract passes per cell × 4 rotations** | `ocr.js` `RETRY_ATTEMPTS`, `runOCR` | ~480 `recognize()` calls → minutes |
| D5 | Tesseract is a page-OCR engine reading isolated gray digits behind glossy plastic | `ocr.js` | Low base accuracy, especially with glare |
| D6 | OpenCV loaded unversioned from `docs.opencv.org/4.x`; Tesseract + language data from CDN | `scan.html` script tags | Not cached by the service worker (cross-origin) → no offline scanning; behavior can change without a deploy |
| D7 | Only one answer per cell, no confidence; de-dup clears later duplicates | `ocr.js` `deduplicateGrid` | User cannot tell which cells to check; correct values can be discarded |
| D8 | Closed shutters (tinted window) not detected | — | Covered numbers read as garbage |
| D9 | Tuning panel exposes Tesseract internals (PSM, OEM, thresholds, offsets) | `scan.html` | Settings users cannot reason about; masks geometry bugs |

**Conclusion:** the dominant failure is geometry (D1–D3), not the recognition engine. Fixing geometry first benefits every later engine, and the same rectified cell crops become the training data.

---

## 3. Constraints

### Hosting (InfinityFree, current)
Verify each limit against the current account:
- **Per-file upload cap ≈ 10 MB.** Rules out ONNX Runtime's WASM binary (~10–12 MB) and `opencv.js` (~8–10 MB). Tesseract (~6–8 MB total, largest file < 5 MB) and DigitNet weights (< 1 MB) fit.
- **File-count (inode) cap.** Training samples are stored as **MySQL rows**, never as files.
- **MySQL database size quota.** At ~60 KB per sample, 1,000 scans ≈ 60 MB. The server enforces a configurable cap (§9.5).
- **Bot-protection JavaScript challenge** on some free hosts can interfere with `fetch()`. The training upload uses the same `/api/` path and request style as the existing card sync, so it works wherever card sync works.

### Repository Rules (root and Bingo `AGENTS.md`)
- Vanilla HTML/CSS/JS, no frameworks or build chain in shipped code.
- Separate CSS file; CSS custom properties; no inline styles.
- 2-part version constant per script/page, +0.1 per change, shown in the footer.
- Comments describe current behavior only.
- Network-first caching for app code (an exception for engine assets is defined in §8).
- Square, centered number cells; B 1–15, I 16–30, N 31–45, G 46–60, O 61–75.

---

## 4. Locked Design Decisions

| Concern | Decision | Rationale |
|---|---|---|
| Where recognition runs | On-device only | Offline use in bars; no per-scan cost; privacy |
| Card formats | **Any format** via card profiles, auto-selected. Slider (the `example/` photos) is built first; other profiles are added when physical cards are available to photograph | One pipeline, format-specific detection only; no profile is built without test photos |
| Geometry anchor | Card **windows/cells**, not card outline or slider tabs | Windows are where the digits are; tabs move when shutters close |
| Rectification | Full perspective homography fit from all detected windows | Corrects angled photos; tolerates a few missed windows |
| Cell sampling | Sample each window crop **directly from the original photo** through the homography | Avoids warping the whole image; full resolution per cell |
| OpenCV | **Removed.** Replaced by a small plain-JS imaging module | Near the file cap; only ~5 operations are used |
| Engine interface | One `CellReader` contract (§7.5); engines are swappable adapters | Tesseract → DigitNet without touching UI/geometry |
| Output of a reader | Ranked candidates with scores per cell, not a single answer | Enables constraint decoding and confidence highlighting |
| Final answer | Column-constraint decoder (§7.6) picks the best valid combination | Uses card rules (range + uniqueness) to correct misreads |
| Orientation | Phase 1: portrait enforced by the overlay. Phase 2: cheap 4-way check through the decoder | Tesseract is too slow to try orientations; DigitNet is not |
| Engine asset caching | Dedicated, versioned, cache-first engine cache, untouched by SW version bumps (§8) | Download once; update only when a file name changes |
| Training labels | Captured when the user taps **Apply to Card Editor** | The only moment labels are user-confirmed |
| Training contribution | **On by default for everyone**; can be turned off in settings; one-time notice | Collect data without manual effort |
| Training storage | Upload to `/api/training` (MySQL rows, sheet image as BLOB) through an IndexedDB outbox; JSON export as backup | Works within InfinityFree limits; survives offline use |
| Training data retention | Server is a **staging area**: samples are deleted from the server once a training run has used them. The master dataset lives on the dev PC (`tools/bingo-model/data/`, git-ignored, backed up by OneDrive) | Keeps the MySQL quota small; full history kept for retraining |
| Custom model runtime | **Plain-JS inference** (`nn.js`) with a weights file; no ONNX Runtime | Fits the 10 MB cap; zero dependencies; fast for a tiny CNN |
| PaddleOCR | **On hold** (§12) | Requires ~20 MB runtime + model; revisit only if DigitNet can't generalize |
| Training tooling | Python/PyTorch under `tools/bingo-model/`, outside `htdocs/` | Never deployed; documented exception to the no-build-chain rule |

---

## 5. Target Architecture

```
 ┌───────────── scan.html (UI thread) ─────────────┐
 │ 1 Capture      camera + profile overlay,        │
 │                steadiness auto-shutter          │
 │ 2 Detect       profiles tried, best fit chosen  │──► debug overlay
 │ 3 Rectify      homography (grid ↔ photo)        │
 │ 4 Extract      25 canonical cell crops          │
 └───────────────────────┬─────────────────────────┘
                         │ ImageData[24]
 ┌───────────────────────▼─────────────────────────┐
 │ 5 Read         CellReader adapter (worker)      │
 │                Phase 1: Tesseract (one sheet)   │
 │                Phase 2: DigitNet (plain JS)     │
 └───────────────────────┬─────────────────────────┘
                         │ candidates[24]
 ┌───────────────────────▼─────────────────────────┐
 │ 6 Decode       column range + uniqueness solver │
 │ 7 Review       confidence-highlighted grid      │
 │                → Apply → card editor            │
 │                → training sample → outbox       │──► POST /api/training
 └─────────────────────────────────────────────────┘
```

### File Layout

| File | Phase | Purpose |
|---|---|---|
| `scan/scan.html` | 1 | Page markup and wiring (existing; tuning panel removed) |
| `scan/style.css` | 1 | Styles, including overlay, confidence states, download progress |
| `scan/capture.js` | 1 | Camera start/stop, overlay drawing, steadiness detection, still capture |
| `scan/imaging.js` | 1 | Grayscale, downscale, adaptive threshold, connected components, homography solve, bilinear sampling |
| `scan/profiles.js` | 1 | Card profile definitions (§7.2) |
| `scan/geometry.js` | 1 | Profile auto-selection, window detection, homography fit, cell extraction, shutter/glare flags |
| `scan/readers/tesseract-reader.js` | 1 | `CellReader` adapter for Tesseract |
| `scan/readers/digitnet-reader.js` | 2 | `CellReader` adapter for DigitNet |
| `scan/nn.js` | 2 | Minimal neural-network inference (conv, ReLU, pooling, dense, softmax) |
| `scan/decoder.js` | 1 | Confusion-candidate expansion and column-constraint solver |
| `scan/training-store.js` | 1 | IndexedDB sample store and outbox, upload, JSON export, storage persistence |
| `scan/engine-loader.js` | 1 | Reads `engine/manifest.json`, downloads/caches engine files with progress |
| `scan/engine/manifest.json` | 1 | Current engine file list and versions (network-first) |
| `scan/engine/tesseract/…` | 1 | Self-hosted, pinned Tesseract files (cache-first) |
| `scan/engine/digitnet/…` | 2 | Versioned DigitNet weights + layer description (cache-first) |
| `scan/bench.html` | 0 | Benchmark sub-page (no back link; not linked from the launcher) |
| `api/bingo.php` | 1 | New `training` endpoint (§9.4) |
| `ocr.js`, `utils.js` | — | Retired at the end of Phase 1; logic moves to the files above |
| `tools/bingo-scan-testset/` | 0 | Hand-labeled test photos (not deployed) |
| `tools/bingo-model/` | 2 | Python training pipeline (not deployed) |
| `tools/bingo-model/data/` | 2 | Master training dataset (git-ignored; OneDrive-backed) |

---

## 6. UX Flow

1. User opens the **Scan** tab. If engine files are not cached, show **Download scanner (~X MB)** with size and a Wi-Fi hint; progress bar while downloading. Manual entry stays available throughout.
2. Live camera with a translucent **5×5 window outline** matching the last-used profile, plus a hint line: "Flash off · open all windows · fill the outline". A profile chip shows the detected format and can be tapped to override it.
3. Auto-capture when the frame is steady for ~600 ms and the detector finds ≥ 16 windows in the preview; a manual shutter button is always available. Gallery upload remains.
4. Review screen appears with values filled in. Cells are styled:
   - **Confident** (normal), **Check** (amber: low score or decoder changed the raw reading), **Missing** (red outline, blank), **Covered** (shutter detected closed).
5. Tapping a cell opens the existing column-restricted picker.
6. **First scan only:** an inline notice above the Apply button — "Scans help train the scanner. Only the number windows are sent. Change this in Settings." — dismissed with **OK**.
7. **Apply to Card Editor** writes the card and queues a training sample (unless contribution is off).
8. If detection fails, show "Couldn't find the windows" with **Retake** and **Adjust corners** (drag the four handles to the centers of the four corner cells).

---

## 7. Component Specifications

### 7.1 Capture (`capture.js`)
- `getUserMedia` with `facingMode: environment`, request ≥ 1920 px on the long side; fall back to any camera, then to gallery upload only. Graceful messages on permission denial or no camera.
- Overlay drawn on a canvas above the video. Geometry comes from the active profile.
- Steadiness: mean absolute difference of 64×64 grayscale thumbnails between consecutive frames; steady when below a threshold for ~600 ms.
- Still capture from the video track at full resolution (ImageCapture where supported, else a video-frame canvas draw).
- Torch is off by default (flash causes glare on plastic windows).

### 7.2 Card Profiles (`profiles.js`) — any format
A profile is a plain data object; the detector and overlay read it.

| Profile | Anchor | Notes | When |
|---|---|---|---|
| `slider` | Bright windows on darker card | Primary format (`example/` photos); shutter tint + glare checks | Phase 1 |
| `manual` | User-placed corner cell centers | Always available; equal spacing between corners; catches any unsupported format | Phase 1 |
| `shutter-wood` | Bright windows on wood/board | Same detector as `slider`, different thresholds | When a card is available |
| `paper-grid` | Dark ink grid lines enclosing cells | Cells touch; window = cell minus line width | When a card is available |
| `paper-plain` | Clusters of digit ink, no lines | Lattice fit from ink-blob centroids | When a card is available |

Scans of unsupported formats go through `manual` and are still uploaded as training samples (profile `manual`). Those uploads (with **Include full photo** on) are the source of test photos for building the next profile.

Fields per profile: anchor type, window size / pitch ratio defaults, threshold polarity, minimum blob count, whether a header exists and on which side, shutter-tint check on/off, overlay shape.

**Auto-selection:** run each detector (except `manual`) on the downscaled photo; score = windows found × (1 − normalized reprojection error). Pick the best score; ties go to the last-used profile. The chosen profile is recorded in the training sample and shown as a chip on the review screen with an override.

New formats are added by defining a new profile object plus test photos; no reader changes are needed.

### 7.3 Window Detection & Rectification (`geometry.js`, `imaging.js`)
Window-anchor profiles (`slider`, `shutter-wood`):
1. Downscale the photo to 1000 px on the long side (detection only).
2. Grayscale → adaptive mean threshold (block ≈ 1/25 of image width) to isolate bright regions.
3. Connected components (two-pass labeling with union-find) → blobs with area, bounding box, fill ratio, centroid.
4. Keep blobs with aspect 0.6–1.6, fill ratio ≥ 0.6, area within 0.4–2.5× the median candidate area.
5. **Grid assignment:** cluster blob centroids into rows by y-gap, then sort each row by x. Accept when ≥ 16 blobs land in a consistent 5×5 lattice.
6. **Homography fit:** least-squares fit (normal equations, 8 unknowns) from lattice indices `(col, row)` to blob centroids. Missing windows are predicted by the fit.
7. **Validation:** mean reprojection error < 8% of pitch; otherwise try the next profile, then fall back to manual corners.

Line-anchor (`paper-grid`): inverted threshold, enclosed-cell components, same steps 4–7.
Ink-anchor (`paper-plain`): dark-ink components merged per number (two digits close together), same steps 5–7.
Manual: homography fit from the four user-placed corner cell centers.

### 7.4 Cell Extraction
- For each lattice cell, sample a crop through the homography with bilinear interpolation from the **full-resolution** photo.
- Crop extent: window size from the profile (or measured median blob size) plus 8% inset to exclude window frames.
- **Canonical crop:** 96 × 64 px (w × h), RGB. All readers resize from this; training samples store this exact crop.
- Normalization for readers: grayscale, per-crop contrast stretch (2nd–98th percentile).
- **Shutter check** (window profiles): strong orange/red tint flags the cell `covered`.
- **Glare check:** near-white saturated pixels > 35% of the crop flags the cell `glare` (lowers confidence; shown amber).

### 7.5 Reader Contract (`readers/*.js`)

| Member | Description |
|---|---|
| `id`, `version` | e.g. `tesseract` / `5.x-fast`, `digitnet` / `1.0` |
| `load(onProgress)` | Fetch/initialize engine files through `engine-loader.js` |
| `read(crops[24])` | Returns, per cell, `{ raw, candidates: [{ value, score }] }` with `score` in 0–1 |
| `dispose()` | Free worker memory |

Readers run in a Web Worker. A **shadow reader** may run after the primary; its output is stored in the training sample but never shown to the user.

**Tesseract adapter (Phase 1):**
- Self-hosted, pinned tesseract.js (exact version recorded in `manifest.json`), LSTM core, **fast** English data.
- **Single-sheet recognition:** tile the 24 normalized crops into one image with white gutters ≥ 1 crop height, run **one** `recognize()` with sparse-text segmentation and a digits whitelist, then map each word's bounding-box center back to its tile. One call replaces ~480.
- Tiles with no word or confidence < 40 get **one** single-word retry on the individual crop. No other retries; no rotation search.
- Candidates: the recognized value plus confusion alternatives (§7.6).

### 7.6 Decoder (`decoder.js`)
1. **Candidate expansion** (for readers that return a single answer): add alternatives from a confusion table with reduced scores, e.g. 1↔7, 3↔8, 5↔6, 6↔8, 0↔8, 4↔9, 2↔7; and a dropped digit (a lone "4" in the G column expands to 46–49).
2. **Range filter:** discard candidates outside the cell's column range.
3. **Column solve:** per column, choose one candidate (or blank, with a fixed penalty) per cell to maximize the sum of log-scores with no repeated value. Exhaustive search; ≤ 5 cells × ≤ 6 options per column.
4. Card-wide uniqueness follows from column uniqueness (ranges don't overlap).
5. Each output cell carries `value`, `score`, `changedByDecoder`, and flags (`covered`, `glare`).
6. **Orientation check (Phase 2):** when the reader is fast, decode all four 90° lattice orientations and keep the one with the highest total score.

### 7.7 Review UI
- Reuse the existing review grid and column picker (`renderScannedGridReview`), adding Confident/Check/Missing/Covered states as CSS classes with tokens in `style.css`.
- Summary line above the grid: "21 read · 3 to check".
- Profile chip with override; square, centered cells; ≥ 44 px touch targets.

### 7.8 Debug Overlay (replaces the tuning panel)
Behind a **Show detection** toggle in settings:
- Detected blobs, lattice assignment, fitted grid, and each cell's value and score over the photo.
- Profile scores, timing per stage, primary and shadow reader id/version, persistent-storage status, outbox count.
- All Tesseract tuning inputs (thresholds, PSM, OEM, zoom, row/column offsets) are removed.

---

## 8. Engine Asset Hosting & Caching

### 8.1 Layout
- `scan/engine/manifest.json` — **network-first**, tiny. Lists each engine's files, versioned file names, byte sizes and SHA-256 hashes.
- `scan/engine/<engine>/<name>-<version>.<ext>` — immutable files. A new version is a new file name; files are never edited in place.

### 8.2 Service Worker Changes (`htdocs/sw.js`)
- New cache name constant `ENGINE_CACHE = 'bingo-scan-engine'` (no SW version in the name).
- `activate` cleanup must **skip** `ENGINE_CACHE` when deleting old caches.
- Requests under `/Bingo/scan/engine/` (except `manifest.json`) are **cache-first** and fetched **without** `cache: 'no-cache'`. No query-string cache-busting is ever added to engine URLs.
- Engine files are **not** added to `APP_SHELL`; they download on demand from the Scan tab.
- `/api/training` is already bypassed by the existing `/api/` rule.

### 8.3 Loader (`engine-loader.js`)
- Fetch the manifest. For each required file: use the cached copy if present; otherwise download with progress events, verify size/hash, and store in `ENGINE_CACHE`.
- After a successful download, delete files in `ENGINE_CACHE` that the manifest no longer lists.
- Call `navigator.storage.persist()` after the first engine download.
- Offline with no cached engine: "Scanner needs a one-time download — connect to Wi-Fi"; manual entry stays available.

### 8.4 Server Headers (`htdocs/.htaccess`)
- Under `Bingo/scan/engine/`: `Cache-Control: public, max-age=31536000, immutable` for `.wasm`, `.js`, `.traineddata`, `.gz`, `.bin`, `.txt`, and versioned `.json` layer files.
- `manifest.json` keeps the existing `no-cache` rule.
- `.wasm` served as `application/wasm`; `.bin` as `application/octet-stream`.
- Add rewrite rules for `api/training` and `api/training/<id>` following the existing `cards` pattern.

### 8.5 Size Budget

| Phase | Files | Approx. first download |
|---|---|---|
| 1 | tesseract.js + worker + LSTM core + fast `eng` data | 6–8 MB |
| 2 | DigitNet weights + layer description | 0.1–0.4 MB |
| 2 (after Tesseract removal) | Tesseract files deleted from devices | total drops to < 1 MB |

---

## 9. Training Data Collection & Upload (Phase 1)

### 9.1 When
On **Apply to Card Editor**, when **Contribute scans** is on. Default **on** for every user, signed in or not. Cells the user left blank are excluded from labels. Cards typed in by hand on the Manual tab are not recorded.

### 9.2 Sample Record

| Field | Content |
|---|---|
| `schema` | `1` |
| `id` | `crypto.randomUUID()` (client-generated; makes uploads idempotent) |
| `createdAt` | ISO timestamp |
| `appVersion` | scan page version |
| `profile` | chosen profile id + all profile scores |
| `reader` | `{ id, version }`; `shadow` reader in Phase 2 |
| `device` | short UA family + screen size |
| `sheet` | JPEG (q 0.9) of the 25 canonical crops tiled 5×5 (FREE included), 480 × 320 px |
| `cells[25]` | `{ label, predicted, score, corrected, covered, glare }` (`label` = confirmed value; `null` for FREE/blank) |
| `geometry` | detected window centers + homography (for improving detection) |
| `photo` (optional) | 1000 px JPEG of the original capture; only when **Include full photo** is on (default **off**) |

Typical upload: ~40–60 KB without photo; ~200 KB with photo.

### 9.3 Client Outbox (`training-store.js`)
- IndexedDB database `bingo-scan-training`: store `samples` (records + Blobs) with a `status` of `queued` / `uploaded` / `failed`.
- Drain on Apply and when connectivity returns, after a `/api/health` ping (same approach as `bingo-sync-architecture-spec.md`). Exponential backoff on failure.
- Delete the local sheet/photo after a `2xx`; keep a lightweight local count for the settings screen.
- Settings shows: Contribute toggle, Include full photo toggle, queued/uploaded counts, and **Export queued samples** (one `bingo-scan-samples-YYYYMMDD.json` file via download or Web Share) as a backup.

### 9.4 Server Endpoint (`api/bingo.php?endpoint=training`)

| Method | Path | Access | Behavior |
|---|---|---|---|
| `POST` | `/api/training` | Anyone | Validate and upsert one sample by `id`. Attaches the signed-in username when a token is present |
| `GET` | `/api/training?since=<iso>&limit=<n>&status=<s>` | Admin | Paged list including base64 images, for the training importer |
| `PATCH` | `/api/training/<id>` | Admin | Set `status` (`new` / `imported` / `rejected`) |
| `DELETE` | `/api/training/<id>` | Admin | Hard-delete one sample |
| `POST` | `/api/training?purge=1` | Admin | Body `{ ids: [...] }` (≤ 500 per call); hard-delete samples used by a completed training run. Only rows with status `imported` are deleted; the response lists deleted and skipped ids |
| `GET` | `/api/training?stats=1` | Admin | Row count, total bytes, per-profile and per-number label counts |

Admin access uses the existing `getAuthToken` / `authenticateUser` / `getUserAccess()['isAdmin']` in `api/auth.php`.

Table (created by `ensureBingoTablesInitialized`):

```sql
CREATE TABLE bingo_scan_samples (
    id            VARCHAR(36)  NOT NULL,          -- client UUID
    schema_ver    TINYINT      NOT NULL,
    created_at    DATETIME     NOT NULL,          -- client capture time
    received_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    app_version   VARCHAR(10)  NOT NULL,
    profile       VARCHAR(20)  NOT NULL,
    reader        VARCHAR(40)  NOT NULL,          -- id@version
    device        VARCHAR(100) NOT NULL DEFAULT '',
    uploaded_by   VARCHAR(100) DEFAULT NULL,      -- SuiteProfile username; NULL = guest
    ip_hash       CHAR(64)     NOT NULL,          -- salted SHA-256, used only for rate limiting
    cells         JSON         NOT NULL,
    meta          JSON         NOT NULL,          -- profile scores, geometry, shadow reader
    sheet         MEDIUMBLOB   NOT NULL,          -- JPEG, ≤ 100 KB
    photo         MEDIUMBLOB   DEFAULT NULL,      -- JPEG, ≤ 300 KB
    status        VARCHAR(10)  NOT NULL DEFAULT 'new',
    PRIMARY KEY (id),
    INDEX idx_scan_samples_received (received_at),
    INDEX idx_scan_samples_status (status),
    INDEX idx_scan_samples_ip (ip_hash, received_at)
);
```

### 9.5 Validation & Abuse Controls
- Request body ≤ 450 KB (base64 images inside the existing JSON payload format).
- `cells` must have 25 entries; index 12 null; each non-null `label` in its column range; no duplicate labels.
- Images must start with JPEG magic bytes and be within size limits; `sheet` must decode to 480 × 320.
- Rate limit: ≤ 30 samples per `ip_hash` per hour (`429` beyond).
- Global storage cap: a config constant (start at 150 MB of BLOB data). When reached, `POST` returns `507` and the client stops uploading and keeps samples locally until the next app version.
- Raw IP addresses are never stored.

### 9.6 Data Volume Goal
~30–50 confirmed examples per number (1–75) ≈ 100–150 scans for the primary format, plus ≥ 20 scans per additional format. The stats endpoint reports per-number counts so gaps are visible; synthetic samples (§13.2) fill them.

---

## 10. Benchmark & Test Set

- **Test set** lives outside the deployed tree at `tools/bingo-scan-testset/`: photos plus `labels.json` (per photo: `profile` and a 25-value array in row-major order, B-I-N-G-O columns). Photos are in `tools/bingo-scan-testset/photos/` (git-ignored, never deployed); `labels.json` and `README.md` are tracked. Each photo has a `card` id, a `split` (`tune` or `holdout`) and optional `hardCells`.
- Initial label (`20260721_195823.jpg`, slider, rows top to bottom):
  `[2,25,44,52,72, 12,20,39,53,74, 4,27,"FREE",49,73, 10,17,33,47,63, 3,26,37,54,67]` — 47 and 54 are washed out by glare/tint and are good hard cases.
- **Current set (15 labeled photos):**
  - **Slider, scored:** 9 photos of `crazy-1` (6 `tune`, 3 `holdout`: `195125`, `195821`, `195833`), labels `checked`; plus `20260804_200032_crop.jpg`, a second physical card (`crazy-2`, `holdout`), label `needs-review`.
  - **Paper/hard-card, not scored until a profile exists:** 5 photos (`paper-804022-a/b/c`, `paper-351959-br`, `hard-red-1`), cropped from larger photos, labels `needs-review`.
  - 9 further photos are listed under `unlabeled` in `labels.json` (selfies with small slider cards, heavily daubed paper sheets) with the reason each was skipped.
  - Crops are not tight, so the card still has to be found. `unnamed.webp` (an app screenshot) was deleted.
- Labels read from a single photo are `needs-review` and are excluded from headline scores until a person confirms them.
- With one card, tune detection thresholds on 6 photos and keep 3 held out as an unseen check, so geometry is not over-fitted to specific images.
- **Growing the set:** turn on **Include full photo** (§9.2) on the developer's own device. Every confirmed field scan then uploads a photo with user-confirmed labels, which can be copied into the test set (instead of being used for training) without hand-labeling.
- Target: ≥ 10 slider photos from ≥ 3 different cards. Add ≥ 3 photos of each other format before its profile is built (§7.2).
- **`scan/bench.html`:** loads photos via a folder/file picker, runs the full pipeline with a chosen primary and optional shadow reader, and reports per-format: detection success, profile auto-selection accuracy, per-cell accuracy, per-card exact match, and time per stage. In Phase 2 it also runs the DigitNet parity check (§13.3).
- Test photos are **never** used for training, and bench runs never upload samples.

---

### 10.1 Baseline: current pipeline (step 0.2)

Run 2026-10-29 with `scan/bench.html` v1.0 (`ocr.js` 1.4, `utils.js` 1.0, unchanged Tesseract 4 + OpenCV settings from the Scan tab), headless desktop Chrome. Raw results: `tools/bingo-scan-testset/baselines/0.2-current-pipeline.json`.

| Group | Photos | Cells correct | Cards exact | Median time |
|---|---|---|---|---|
| Slider, checked labels (headline) | 9 | **2 / 216 (0.9%)** | 0 / 9 | 10.0 s |
| — tune photos | 6 | 2 / 144 | 0 / 6 | 10.4 s |
| — holdout photos | 3 | 0 / 72 | 0 / 3 | 9.9 s |
| Slider, `needs-review` labels (`crazy-2`) | 1 | 0 / 24 | 0 / 1 | 7.7 s |
| Paper / other (not scored yet) | 5 | 17 / 120 (14%) | 0 / 5 | 7.5 s |

Observations:
- On slider photos, 5–9 cells per card are read as a wrong number and 14–19 are blank (rejected or de-duplicated). Almost nothing is correct, which matches the reported 1–2 correct squares per card.
- "Grid found" is not a useful signal: auto-crop returned a box (not the central-85% fallback) on all 15 photos, yet the result is wrong, which confirms the diagnosis that the detected box and the 25 equal tiles do not line up with the windows (D1–D3).
- Time per photo is ~10 s on a fast desktop. A phone is several times slower, which fits the reported minutes.
- Paper cards do better (up to 8/24) even though they have no dedicated handling, because their cells are evenly spaced.

Targets for Phase 1 are measured against the headline row. Re-run the bench after steps 1.3, 1.4 and 1.5 and add a row here.

## 11. Hosting Move (no longer required for Phases 1–2)
Move hosts only if one of these happens:
- The training uploads are blocked by host bot protection or quota.
- The MySQL quota can't hold enough samples even with periodic export-and-delete.
- PaddleOCR (§12) becomes necessary.

Requirements for a new host: per-file size ≥ 50 MB; header and MIME control; PHP 8.x + MySQL/MariaDB; no JavaScript bot-challenge on API or static requests; no meaningful file-count cap; ≥ 5 GB storage; HTTPS; FTP/SFTP or Git deploy compatible with `.github/workflows/deploy.yaml` (including the `/dev/` branch target).

---

## 12. PaddleOCR (on hold)
Revisit only if DigitNet fails the Phase 2 targets on a card format for which collecting more data isn't practical (PaddleOCR is a general reader and handles unseen fonts better). It would add `onnxruntime-web` (single-threaded WASM, pinned) plus a PP-OCR recognition model in ONNX form (RapidOCR conversions), ~20 MB total, which requires the hosting move. The `CellReader` contract already accommodates it.

---

## 13. Phase 2 — DigitNet

### 13.1 Tooling (`tools/bingo-model/`, not deployed)
- Python 3.11+, PyTorch (CPU is sufficient), NumPy, Pillow; `onnx` + `onnxruntime` for verification only.
- `README.md` with Windows setup (venv + `pip install -r requirements.txt`).
- Scripts:
  1. `pull.py` — download new samples from `GET /api/training` with an admin token, write each to `data/samples/<id>.json` + `.jpg`, verify the files read back, then mark them `imported` on the server.
  2. `import_export.py` — load manual JSON exports from phones (backup path).
  3. `slice.py` — cut sheets into labeled crops; per-number and per-profile counts.
  4. `synth.py` — render synthetic crops (§13.2).
  5. `train.py` — train, report accuracy on the test set, and write `data/runs/<run-id>.json` listing every sample id used.
  6. `export.py` — write versioned weights, layer description, parity vectors, and the `manifest.json` entry; also an ONNX file for cross-checking.
  7. `purge.py <run-id>` — after a completed training run, delete that run's sample ids from the server via `POST /api/training?purge=1`. Refuses to run if any listed sample is missing from `data/samples/`.

### 13.1a Data Retention
- `tools/bingo-model/data/` is the **master dataset** and is never deleted by the scripts. It is git-ignored (samples are not committed) and lives inside the OneDrive-synced project folder for backup.
- Server samples exist only between upload and the next completed training run.
- Sequence per run: `pull.py` → `train.py` → `purge.py <run-id>`. A failed or abandoned training run never purges.

### 13.2 Model
- Input: 32 × 48 grayscale from the canonical crop.
- Small CNN: 3 blocks of [3×3 conv → ReLU → 2×2 max-pool] (e.g. 16/32/64 channels) → dense 128 → two heads: **tens** (blank, 0–7) and **ones** (0–9). Batch-norm folded into conv weights at export.
- Score for value *n* = P(tens) × P(ones); the decoder applies the column range.
- Augmentation: perspective jitter, blur, glare blobs, color tint (closed-shutter look), contrast changes.
- Synthetic bootstrap: render 1–75 in fonts close to each format's numerals with the same augmentations, to cover rare numbers and new formats.
- Expected size: ~100–400 KB (float32), ~50–200 KB (float16).

### 13.3 Browser Inference (`nn.js`, `digitnet-reader.js`)
- Files: `digitnet-<ver>.json` (layer list, shapes, byte offsets, input normalization, label maps) and `digitnet-<ver>.bin` (little-endian float32 or float16 weights).
- `nn.js` implements only: conv2d (3×3, stride 1, pad 1), ReLU, max-pool 2×2, flatten, dense, softmax. Runs in the reader worker; 24 crops expected in < 50 ms on a mid-range phone.
- Candidates per cell: top-3 tens × top-3 ones, scored as above.
- **Parity check:** `export.py` writes 10 inputs with expected outputs; `bench.html` verifies `nn.js` matches within 1e-4.

### 13.4 Release Gate & Rollout
1. Ship DigitNet as a **shadow** reader behind Tesseract as soon as a first model exists, so field results are recorded.
2. Switch DigitNet to primary when it beats Tesseract on the test set on every metric and meets the Phase 2 targets for the primary format.
3. Run Tesseract as shadow for ≥ 50 field scans, then remove Tesseract from the manifest; devices delete the files.
4. Enable the 4-way orientation check (§7.6).
5. Retrain as samples accumulate; each release is a new versioned file listed in the manifest.

---

## 14. Roadmap

| Step | Deliverable | Exit criteria |
|---|---|---|
| **0.1** | Test set + `labels.json` in `tools/bingo-scan-testset/`; move `example/` there (drop `unnamed.webp`) — **done** | The 9 existing photos labeled — **done**; more added later from field uploads (§10) |
| **0.2** | `bench.html` running the **current** pipeline — **done**, baseline in §10.1 | Baseline numbers recorded in this spec — **done** |
| **1.1** | Engine caching: `ENGINE_CACHE`, SW skip/cache-first rule, `.htaccess`, `manifest.json`, `engine-loader.js`; self-hosted pinned Tesseract | Scanner works offline after one download; SW version bump does not re-download |
| **1.2** | `imaging.js` replaces OpenCV | OpenCV script tag removed |
| **1.3** | `profiles.js` (`slider`, `manual`) + `geometry.js` + canonical crops + shutter/glare flags + debug overlay | Slider detection succeeds on ≥ 90% of slider test photos |
| **1.4** | `CellReader` contract + Tesseract single-sheet adapter | ≤ 5 s per scan on a mid-range phone |
| **1.5** | `decoder.js` | Measurable accuracy gain over the raw reader on bench |
| **1.6** | Training pipeline: `training-store.js` outbox, `/api/training` endpoint + table + validation + admin routes, Contribute default on, first-scan notice, export backup | Samples arrive in MySQL from a phone; admin stats endpoint works |
| **1.7** | Review UI states, summary line, profile chip; tuning panel removed | — |
| **1.8** | Guided capture overlay + auto-shutter | Phase 1 slider targets in §1 met |
| **2.1** | `tools/bingo-model/` pull/slice/synth/train/export/purge | First model trained; test-set report; server purged of trained samples |
| **2.2** | `nn.js` + `digitnet-reader.js`; parity check in bench | Parity passes |
| **2.3** | DigitNet as shadow reader in production | Field comparison data recorded |
| **2.4** | DigitNet primary; Tesseract shadow, then removed; orientation check on | Phase 2 targets in §1 met |
| **2.5** | Retraining loop documented | Repeatable release in < 1 hour |
| **F.n** | New format profile (`shutter-wood`, `paper-grid`, `paper-plain`, or other), repeated per format when a card is available | ≥ 3 labeled test photos; auto-selection correct on that format's photos; format added to targets |

Step 1.6 follows 1.5 so data collection starts as early as possible; 1.7–1.8 can proceed in parallel once 1.6 lands. F steps are independent of the phase order. Each step bumps the version constant of every touched script/page by 0.1 and bumps `SW_VERSION` when `sw.js` changes.

---

## 15. Risks

| Risk | Mitigation |
|---|---|
| Tesseract accuracy ceiling stays low even with good crops | Phase 1 value is geometry, speed, decoder and training data; all carry forward to DigitNet |
| Window detection fails under strong glare or unusual cards | Profile fallback order; manual corners; debug overlay; per-format test photos |
| Labels wrong because the user didn't check every cell | Record `corrected` flag and reader score; down-weight unreviewed low-score cells; admin `rejected` status; hand-labeled test set |
| Anonymous uploads used for spam or junk | Strict validation, rate limit, global storage cap, admin delete/reject |
| MySQL quota reached on InfinityFree | Global cap with `507`; `purge.py` deletes trained samples after every run |
| Training data lost after server purge | Purge only after `pull.py` has verified local copies and a run has completed; dev-PC dataset backed up by OneDrive |
| Uploads blocked by host bot protection | Detect repeated non-JSON responses, keep samples locally, show "upload paused" in settings; export backup; hosting move trigger (§11) |
| Training data skewed to a few physical cards | Synthetic augmentation; per-number counts in stats endpoint |
| DigitNet doesn't generalize to new formats | Per-format test photos and targets; more samples per format; PaddleOCR fallback (§12) |
| `nn.js` output differs from PyTorch | Parity vectors checked in bench on every model release |
| iOS Safari camera/IndexedDB quirks | Gallery-upload fallback; outbox tolerant of storage loss; test on iOS before each phase exit |

---

## 16. Decisions Recorded
1. **Card formats:** support any format; the slider format in `example/` is primary. No other formats are available yet, so Phase 1 builds `slider` + `manual`; other profiles follow as cards turn up (step F.n).
2. **Training PC:** Python available on the dev PC; phones never train.
3. **PaddleOCR:** on hold.
4. **Contribution:** visible to everyone, **on by default**, uploads to the server.
5. **No card generation:** the app scans existing cards only; no printed-card QR path.
6. **Retention:** samples are deleted from the server once a training run has used them; the dev PC keeps the master dataset.

No open questions remain.

---

## 17. Required Updates to Agent Guidelines
To be made when Phase 1 implementation starts:
- **Root `AGENTS.md`, PWA & Caching:** add the exception — versioned, immutable engine/model assets under `*/engine/` are cache-first in a dedicated cache that survives SW version changes; their URLs are never cache-busted; updates happen only through a renamed file listed in a network-first manifest.
- **Root `AGENTS.md`, Core Stack:** note that `tools/` may contain dev-only Python tooling that is never deployed.
- **`htdocs/Bingo/AGENTS.md`:** update the `scan/` entry to describe the pipeline modules, card profiles, the `CellReader` contract, the training upload (default on), and `bench.html`.
