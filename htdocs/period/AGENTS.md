# Period Tracker - Sub-Application AI Agent Guidelines

This document defines the parameters and architecture specific to the **Period** (cycle tracker) sub-application under `htdocs/period/`. The full behavioral specification is `docs/period-tech-spec.md`; section numbers below (§) refer to it.

---

## 1. Sub-App Overview

A private, local-first cycle tracker. Users log periods on a calendar, see predicted periods, ovulation and phases with honest, widening uncertainty, and view cycle statistics. It is not a conception or contraception tool and the disclaimer (§1) must stay visible at first run and in Settings > About.

### Primary Files
- `index.html`: Page shell: suite header (gear opens Settings), tab bar (Calendar / History / Stats), first-run container, toast, version footer.
- `core.js`: Pure logic with no DOM or storage (`PeriodCore`): date math on day numbers, cycle derivation, weighted-median/MAD estimates, prediction with overdue shift, per-day period probability, phases, ovulation and fertile window, health notes, statistics, entry validation and sanity checks. Also loads in Node.
- `store.js`: IndexedDB persistence (`PeriodStore`), one object store per record type, in-memory fallback when IndexedDB is unavailable.
- `app.js`: UI: rendering, logging flows, edit/flag sheets, backfill, settings, export/import, first-run wizard. Holds `APP_VERSION`.
- `style.css`: Dark theme tokens and the semantic calendar roles (logged, predicted, phase tints, ovulation markers, fertile window).

### Tests
`node tools/period-core-test.js` checks `core.js` against the spec's worked example (§5.11) and several edge cases. Run it after any change to `core.js`.

---

## 2. Data & Privacy Rules

- **Store only what the user entered** (§2): period entries, cycle flags, settings, dismissed notes. Predictions, cycles, phases, stats and flags-derived values are always recomputed by `PeriodCore.buildModel`; never persist them.
- **Dates are plain `YYYY-MM-DD` strings**; math uses UTC day numbers. Only `created_at` / `updated_at` are ISO timestamps.
- **Soft delete everywhere** (`deleted: true`); hard deletes happen only in "Delete all data" and "Replace all" import.
- **Nothing leaves the device.** Do not add `SuiteProfile` cloud sync (`loadAppData` / `saveAppData`) or any network calls for tracker data. `SuiteProfile` is used only for the footer indicator.
- Reserved empty stores (`daily_logs`, `sharing_grants`, `calendar_sync`) exist so later features need no migration (§3.6, §10); do not build those features without being asked.

---

## 3. Language Rules

- Calm, never alarming, never diagnostic (§2). Health notes say "worth mentioning to a doctor".
- The fertile window is an overlay; never call days "safe" or "unsafe".
- Always label defaults and early estimates (confidence label: Default / Early estimate / Personal / Established).

---

## 4. Access Control & Group Authorization

- **Group Restriction**: `suite_app_access` row `app_id = 'period'`, `min_group_id = 2` (`special`), seeded by `htdocs/api/setup.php` (run it once after deploying).
- **Launcher Visibility**: the app card carries `data-app-id="period"` and `hidden` in `htdocs/index.html`, placed just above Toys. Only signed-in `special` or `admin` users see it.
- **Cosmetic Protection Note**: as with Toys, this hides the launcher card only; direct URL navigation stays open unless server-side gating is added.

---

## 5. Coding & Maintenance Guidelines

- Follow the root `AGENTS.md`: comments describe current behavior only, no browser `alert/confirm/prompt` (use `SuiteDialog` or the in-app `openSheet` / `choose`), 44px touch targets, footer version, increment `APP_VERSION` by `0.1` per change.
- Keep the service worker `APP_SHELL` list in `htdocs/sw.js` in sync when adding or removing files in this folder.
