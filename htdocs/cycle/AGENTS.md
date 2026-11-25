# Cycle Tracker - Sub-Application AI Agent Guidelines

This document defines the parameters and architecture specific to the **Cycle** tracker sub-application under `htdocs/cycle/`. The full behavioral specification is `docs/cycle-tech-spec.md`; section numbers below (§) refer to it.

---

## 1. Sub-App Overview

A private, local-first cycle tracker. Users log periods directly on calendar days (tap a day to mark a period start or end, or to edit or delete it; there are no separate "Period started" buttons), see predicted periods, ovulation and phases with honest, widening uncertainty, and view cycle statistics. It is not a conception or contraception tool and the disclaimer (§1) must stay visible at first run and in Settings > About.

### Primary Files
- `index.html`: Page shell: suite header (gear opens Settings), tab bar (Calendar / History / Stats), first-run container, toast, version footer.
- `core.js`: Pure logic with no DOM or storage (`CycleCore`): date math on day numbers, cycle derivation, weighted-median/MAD estimates, prediction with overdue shift, per-day period probability, phases, ovulation and fertile window, typical mood curve (`moodLevel`), health notes, statistics, entry validation and sanity checks. Also loads in Node.
- `store.js`: IndexedDB persistence (`CycleStore`), one object store per record type, in-memory fallback when IndexedDB is unavailable.
- `sync.js`: Optional server backup (`CycleSync.create(deps)`): dirty tracking, pull/merge, push, enable/disable, replace-server. No UI. Runs in Node for tests.
- `app.js`: UI: rendering, logging flows (all period logging is by tapping calendar days: Mark start / Mark end / Remove in one row), day and period notes, the History cycle report, edit/flag sheets, backfill, settings (including the Server backup section), export/import, first-run wizard. Holds `APP_VERSION`.
- `../api/cycle.php`: Server endpoint for the backup (tables `period_sync_state`, `period_records` in `api/schema.sql`).
- `style.css`: Dark theme tokens and the semantic calendar roles (logged, predicted, phase tints, ovulation markers, fertile window).

### Tests
- `node tools/cycle-core-test.js` checks `core.js` against the spec's worked example (§5.11) and several edge cases. Run it after any change to `core.js`.
- `node tools/cycle-sync-test.js` runs `sync.js` with two simulated devices against an in-memory fake of `cycle.php`. Run it after any change to `sync.js` or the `cycle.php` contract (keep the fake in the test in step with the PHP).

---

## 2. Data & Privacy Rules

- **Store only what the user entered** (§2): period entries (with an optional `note`), cycle flags, settings, dismissed notes, daily logs (`daily_logs`: intimacy entries and day notes). Predictions, cycles, phases, stats and flags-derived values are always recomputed by `CycleCore.buildModel`; never persist them.
- **Dates are plain `YYYY-MM-DD` strings**; math uses UTC day numbers. Only `created_at` / `updated_at` are ISO timestamps.
- **Soft delete everywhere** (`deleted: true`); hard deletes happen only in "Delete all data" and "Replace all" import.
- **Nothing leaves the device unless the user turns on Server backup** (Settings, off by default, per profile). Do not add any other network calls for tracker data, and do not use `SuiteProfile.loadAppData` / `saveAppData` for it.
- **Intimacy tracking** (`daily_logs` records `{date, sex_types: ['intercourse'|'oral'|'other']}`, one per date, merged per date when devices duplicate): shown only when the setting `show_sex_tracking` is on (default off). Off is a privacy hide of the day-sheet heart/lips/hand toggles, calendar icons, legend entry and the Stats "Intimacy" card; it never deletes data. Stats come from `CycleCore.sexStats`. The records sync with Server backup like all other records (server-readable); the enable dialog says so. Keep wording neutral, never "safe/unsafe".
- **Notes**: a day note lives in that date's `daily_logs` record (`note`, string or null) and can be added to any date from the day sheet; a period note lives on the period entry (`note`). Notes are not tied to the sex-tracking setting. Day-sheet notes save when the sheet closes and before a period action runs (so that action works on the saved record). `writeDayLog` in `app.js` merges a date's duplicate records (types and distinct notes) into one and soft-deletes the rest.
- **Cycle report** (top of History): pick the current cycle (default) or a past cycle by start date; `buildReport` derives Timing, Notes and Day by day from the model and stored records at read time (never persisted). Copy / Share give the plain-text version from `reportText`, which ends with the disclaimer. Intimacy appears in it only when `show_sex_tracking` is on; ovulation, fertile window and phases follow the same settings and birth-control rules as the calendar and are labeled estimates.
- Reserved empty stores (`sharing_grants`, `calendar_sync`) exist so later features need no migration (§3.6, §10); do not build those features without being asked.

---

## 3. Language Rules

- Calm, never alarming, never diagnostic (§2). Health notes say "worth mentioning to a doctor".
- The fertile window is an overlay; never call days "safe" or "unsafe".
- Per-phase mood and libido notes (`PHASE_MOOD` in `app.js`) are general population tendencies, always shown with "Everyone is different", hidden on hormonal birth control, and never phrased as a prediction for a given day.
- The calendar's typical mood line (`drawMoodLine` in `app.js`, curve in `CycleCore.moodLevel`) is a general pattern, not a prediction: one smooth line per week row, dashed on predicted days, hidden on hormonal birth control, before any period is logged, or when `show_mood_line` is off. Its caption in the legend says "everyone is different". It is never built from the user's own logs.
- Always label defaults and early estimates (confidence label: Default / Early estimate / Personal / Established).

---

## 4. Access Control & Group Authorization

- **Group Restriction**: `suite_app_access` row `app_id = 'cycle'`, `min_group_id = 2` (`special`), seeded by `htdocs/api/setup.php` (run it once after deploying).
- **Launcher Visibility**: the app card carries `data-app-id="cycle"` and `hidden` in `htdocs/index.html`, placed just above Toys. Only signed-in `special` or `admin` users see it.
- **Cosmetic Protection Note**: as with Toys, this hides the launcher card only; direct URL navigation to the page stays open. The server backup API (`api/cycle.php`) is gated server-side (section 6).

---

## 5. Coding & Maintenance Guidelines

- Follow the root `AGENTS.md`: comments describe current behavior only, no browser `alert/confirm/prompt` (use `SuiteDialog` or the in-app `openSheet` / `choose`), 44px touch targets, footer version, increment `APP_VERSION` by `0.1` per change.
- Keep the service worker `APP_SHELL` list in `htdocs/sw.js` in sync when adding or removing files in this folder.

---

## 6. Optional Server Backup (multi-device sync)

- **Opt-in per user.** Needs a signed-in profile with access to `cycle`. Device-local state (enabled, owning username, pull cursor, dirty list) lives in `localStorage` key `period_sync_state`. A different profile signing in turns sync off on that device.
- **Record-level, last-write-wins** by `updated_at` (spec §10.5). Soft deletes sync as ordinary records. The server keeps one JSON row per record in `period_records`, ordered by a per-user `change_seq` that is the pull cursor (device clocks never decide ordering).
- **Server-readable** by design so partner sharing can later be a permission check on `user_id` (spec §10.3). Do not claim the data is private from the site admin; the enable dialog says it is readable.
- **Endpoint** `api/cycle.php` (`status`, `enable`, `push`, `pull`, `reset`, `delete_data`) requires a session and `cycle` in `getAllowedRestrictedApps`, so unlike the launcher card it is a real server-side gate. Timestamps sent must be fixed-format `YYYY-MM-DDTHH:mm:ss.sssZ` (the server compares them as text); `sync.js` normalizes before pushing.
- **Flow:** local writes go through `CycleStore`, whose change hook marks records dirty (writes flagged `{ remote: true }` are not). Sync is pull, merge, push, and adopts the server's newer copy for records it rejected as stale. It runs about 2 s after a change, on page open, on tab focus, when back online, and every 60 s while visible.
- A fresh device's default settings record has an epoch `updated_at` so restored settings always win. Keep that when changing `defaultSettings()`.
- Destructive flows with backup on: "Replace all" import calls `replaceServerWithLocal()` (server `reset` writes deletion markers so other devices drop old records, then local records are re-stamped newer and pushed); "Delete all data" asks whether to delete the server copy and always turns sync off locally.
- Run `htdocs/api/setup.php` after deploying to create the two tables.
