# Cycle Tracker — Technical Specification (v1)

Audience: a coding agent. This document defines **data, algorithms, features and behavior**. It deliberately does **not** define platform/PWA setup, layout, colors or styling; those come from the existing design and PWA specs. Visual elements are named only by **semantic role** (listed in §9) so the design system can map them.

---

## 1. Product summary

A private, local-first cycle tracker for adults. Users log current and past periods on a calendar, see statistics about regularity, and see predicted future periods and ovulation with honest, widening uncertainty. The long-term focus is understanding **mood and libido across the cycle** (daily logs come after v1). It is **not** a conception or contraception tool.

Required disclaimer (shown at first run and in Settings > About):
> Predictions are estimates based on your past cycles. They are not reliable for preventing pregnancy and are not medical advice.

### v1 scope
- First-run setup (§6.1)
- Calendar with logged periods, predicted periods, phase tints, ovulation and fertile window (§6.2)
- Logging and editing periods, backfill of past cycles (§6.3, §6.4)
- Cycle history with "unusual cycle" flags (§6.5)
- Stats: average cycle length, average period length, regularity rating, cycle-length bar chart (§6.6)
- Gentle health notes (§5.9)
- Settings, export/import, delete all data (§6.7, §7)

### Out of v1 (design data for it, don't build): see §10.

---

## 2. Principles

1. **Store only what the user entered.** Predictions, cycles, phases, stats and flags are derived on the fly from stored records. Never persist derived values (a memory cache is fine).
2. **Sync-ready from day one.** Every record has a UUID, `created_at`, `updated_at`, and a soft-delete flag. No hard deletes except "Delete all data".
3. **Dates are calendar dates, not timestamps.** All cycle dates are local `YYYY-MM-DD` strings. "Today" is the device's local date. Day arithmetic is done on dates (no time-of-day, no DST bugs). Only audit fields (`created_at`, `updated_at`) are ISO-8601 UTC timestamps.
4. **Honest uncertainty.** Always say when a number is a default or an early estimate.
5. **Calm language.** Health notes are "worth mentioning to a doctor", never alarming, never diagnostic.

---

## 3. Data model

Storage in v1: IndexedDB, one object store per record type, keyed by `id`. Records are designed to map 1:1 to future SQL tables.

### 3.1 Common fields (every record)
| Field | Type | Notes |
|---|---|---|
| `id` | string (UUID v4) | Generated on the client |
| `created_at` | ISO-8601 UTC string | Set once |
| `updated_at` | ISO-8601 UTC string | Set on every change, including soft delete |
| `deleted` | boolean | Soft delete; default `false`. Deleted records are ignored by all derivations but kept for export/sync |

### 3.2 `period_entries`
One record per period (bleed).

| Field | Type | Notes |
|---|---|---|
| `start_date` | `YYYY-MM-DD` | Required |
| `end_date` | `YYYY-MM-DD` or `null` | `null` = ongoing (only allowed for the most recent entry) |
| `start_precision` | `"exact"` \| `"approximate"` | Default `exact` for live logging, chosen by user in backfill |
| `end_precision` | `"exact"` \| `"approximate"` | Default `approximate` when end was auto-filled from usual length |
| `source` | `"live"` \| `"backfill"` \| `"quick_setup"` \| `"import"` | For analytics/debugging only |

Index: `start_date`.

Constraints (enforced in UI, see §8): `end_date >= start_date`; entries must not overlap; at most one entry with `end_date = null`.

### 3.3 `cycle_flags`
Marks the cycle that **begins** with a given period as unusual.

| Field | Type | Notes |
|---|---|---|
| `period_entry_id` | UUID | The period that starts the flagged cycle |
| `reason` | `"pregnancy"` \| `"miscarriage"` \| `"birth_control_change"` \| `"illness"` \| `"other"` | |
| `note` | string or `null` | Free text, optional |
| `exclude_from_stats` | boolean | Default `true` |

Index: `period_entry_id`. At most one non-deleted flag per period entry.

### 3.4 `settings` (single record, fixed `id = "settings"`)
| Field | Type | Default |
|---|---|---|
| `usual_cycle_length` | integer days or `null` | `null` (means use 28) |
| `usual_period_length` | integer days or `null` | `null` (means use 5) |
| `hormonal_birth_control` | `"yes"` \| `"no"` \| `"unsure"` | set at first run |
| `show_ovulation` | boolean | `true` unless `hormonal_birth_control = "yes"` |
| `show_fertile_window` | boolean | same as `show_ovulation` |
| `show_phase_tints` | boolean | `true` |
| `week_starts_on` | `0`–`6` | locale default |
| `onboarding_completed_at` | timestamp or `null` | |
| `disclaimer_acknowledged_at` | timestamp or `null` | |
| `last_export_at` | timestamp or `null` | |
| `export_nudge_snoozed_until` | `YYYY-MM-DD` or `null` | |
| `schema_version` | integer | `1` |

### 3.5 `health_note_dismissals`
| Field | Type | Notes |
|---|---|---|
| `note_type` | enum from §5.9 | |
| `evidence_key` | string | Hash/string of the data that triggered it (e.g. the ids of the cycles involved). A dismissed note reappears only if its `evidence_key` changes |

### 3.6 Reserved for later (create stores in v1 so no migration is needed, leave empty)
- `daily_logs` (§10.1)
- `sharing_grants` (§10.3)
- `calendar_sync` (§10.4)

---

## 4. Derived structures

### 4.1 Cycles
Sort non-deleted `period_entries` by `start_date`. For consecutive entries `E[i]`, `E[i+1]`:

```
cycle_i.start        = E[i].start_date
cycle_i.length       = days(E[i+1].start_date - E[i].start_date)
cycle_i.period_length = E[i].end_date ? days(E[i].end_date - E[i].start_date) + 1 : null
cycle_i.weight       = (E[i].start_precision == "exact" && E[i+1].start_precision == "exact") ? 1.0 : 0.5
cycle_i.flagged      = a non-deleted cycle_flag on E[i] with exclude_from_stats = true
cycle_i.complete     = true
```

The last entry starts the **current cycle** (`complete = false`, length unknown).

### 4.2 Eligible cycles (used for stats and predictions)
A complete cycle is **eligible** if:
- not `flagged`, and
- `15 <= length <= 90`.

Cycles outside 15–90 days are kept in history and still feed health notes (§5.9), but never feed predictions. Use the **most recent 12** eligible cycles (the "window"). `n` = number of eligible cycles in the window.

Period-length window: the most recent 12 completed periods (`end_date` not null), excluding periods in flagged cycles. Period weight = 1.0 if both precisions exact, else 0.5.

---

## 5. Algorithms

All math in floating point; round only for display (round half up to whole days).

### 5.1 Weighted median
Sort values ascending with their weights. Let `W = Σw`. The weighted median is the first value whose cumulative weight `>= W/2`. If cumulative weight equals exactly `W/2` at value `x_j`, return `(x_j + x_{j+1}) / 2`.

### 5.2 Robust spread (MAD)
```
m        = weighted_median(lengths, weights)
MAD      = weighted_median(|length_i - m|, weights)
σ_p      = max(1.0, 1.4826 × MAD)        // 1-day floor
```

### 5.3 Priors (defaults)
```
μ0 = settings.usual_cycle_length  ?? 28
P0 = settings.usual_period_length ?? 5
σ0 = 3.0
```

### 5.4 Personal estimate with blending
```
μ_p = weighted_median(eligible cycle lengths)

Cycle length μ:
  n = 0      → μ = μ0
  n = 1, 2   → μ = (n·μ_p + (3 − n)·μ0) / 3
  n ≥ 3      → μ = μ_p

Spread σ:
  n < 2      → σ = σ0
  2 ≤ n < 6  → σ = (n·σ_p + (6 − n)·σ0) / 6
  n ≥ 6      → σ = σ_p

Period length P:
  same blending as μ, using the period-length window, its own count n_P, and P0.
```

Confidence level (displayed alongside predictions and stats):
| n | Label | Meaning shown to user |
|---|---|---|
| 0 | Default | "Based on a typical 28-day cycle until you log more." (use the user's usual length if they gave one) |
| 1–2 | Early estimate | "Getting to know your cycle." |
| 3–5 | Personal | "Based on your last n cycles." |
| ≥ 6 | Established | "Based on your last n cycles." |

### 5.5 Future period predictions
Let `L` = start date of the most recent period entry. For cycle `k = 1, 2, …`:

```
c_k = L + k·μ                // predicted start center (fractional days)
s_k = σ · sqrt(k)            // spread for k cycles ahead
```

**Overdue adjustment:** if `today > round(c_1)` and no new period is logged, the period is late. Set `shift = today + 1 − c_1` and use `c_k' = c_k + shift` for all k. Show "Period is X days late" where `X = today − round(c_1)`. (Keep `s_k` unchanged.)

**Projection horizon:** include cycle `k` while `4·s_k ≤ μ / 2` (the ±2σ band is no wider than half a cycle), up to a maximum of 12. Always include `k = 1`.

**Per-day period probability** (drives the fade of the predicted band). For a calendar day `D` and cycle `k`:
```
p_k(D) = Φ((D − c_k + 0.5) / s_k) − Φ((D − (P − 1) − c_k − 0.5) / s_k)
p(D)   = min(1, Σ_k p_k(D))
```
`Φ` is the standard normal CDF (implement with a standard `erf` approximation, e.g. Abramowitz–Stegun 7.1.26). This is the probability the period has started on or before `D` and not yet finished.

Render days with `p(D) ≥ 0.05` as **predicted period band**, with intensity proportional to `p(D)`. Days with `p(D) ≥ 0.5` are **predicted period, most likely**. The band never covers days already inside a logged period or in the past.

Text summary for the next period:
```
most likely start = round(c_1)
likely range      = round(c_1 − s_1) … round(c_1 + s_1)
```
e.g. "Next period likely Dec 3–6, most likely Dec 4." When `n = 0`, prefix with "Default estimate:".

### 5.6 Ongoing period
If the latest entry has `end_date = null`:
- Days from `start_date` to today are **logged period**.
- Days from tomorrow to `start_date + round(P) − 1` are **predicted period end** (still part of the ongoing period, shown as expected).
- On day `round(P) + 3` with no end logged, prompt once per day: "Has your period ended?" with options *Ended today*, *Ended on…*, *Still going*.
- If still unset after 14 days, show the long-period health note (§5.9) and keep prompting.

### 5.7 Ovulation and fertile window
Luteal phase is modeled as a fixed 14 days.

**Past cycles** (complete): `O = next_start − 14`.
**Current and future cycles:** `O_k = c_k − 14` with spread `s_k` (same as the period it precedes). Display the ovulation marker on `round(O_k)`; for future cycles beyond k = 1 it uses the **predicted** ovulation marker role.

**Fertile window:** `round(O) − 5` through `round(O) + 1` (7 days).

Rules:
- Hidden entirely when `show_ovulation = false` (default when on hormonal birth control).
- If `O` falls on or before the last day of that cycle's period, do not show ovulation or fertile window for that cycle (very short cycle).
- Fertile window is an overlay, not a phase. Never describe it as "safe" or "unsafe" days.

### 5.8 Phases
For any cycle with start `S`, period length `p` (actual, or `round(P)` if unknown/ongoing), next start `N` (actual, or `round(c_k)` for predicted), and `O = N − 14`:

| Phase | Days |
|---|---|
| Menstrual | `S` … `S + p − 1` |
| Follicular | `S + p` … `O − 2` |
| Ovulatory | `O − 1` … `O + 1` |
| Luteal | `O + 2` … `N − 1` |

Clamping: if a range is empty or negative, skip it. Ovulatory never overlaps menstrual (start it at `max(O − 1, S + p)`).

Computed for all past cycles, the current cycle, and predicted cycles within the horizon. Predicted cycles use the **predicted phase tint** role (a softer variant).

On hormonal birth control (`hormonal_birth_control = "yes"`): show only the menstrual phase (as "bleed"); hide follicular/ovulatory/luteal tints, because hormonal contraception typically suppresses ovulation. "Unsure" behaves like "no" but shows a one-time note that phases may not apply.

**Cycle day:** `today − S + 1` for the current cycle. Shown with the current phase, e.g. "Day 9 · Follicular".

### 5.8b Typical mood curve
A general-pattern line drawn across each calendar week (not a prediction, hidden on hormonal birth control). For a cycle with start `S`, period length `p`, next start `N`, ovulation `O = N − 14` (peak = `max(O, S + p + 1)`), the level (0–1) is cosine-eased between these landmarks:

| Day | Level |
|---|---|
| `S` | 0.30 |
| `S + p − 1` | 0.35 |
| peak (ovulation) | 1.00 |
| peak + 2 | 0.70 |
| `N − 8` | 0.55 |
| `N − 1` | 0.15 |
| `N` (next cycle start) | 0.30 |

Landmarks that are not strictly later than the previous one are dropped (short cycles). Days on predicted cycles or after today are drawn dashed. Toggle: `show_mood_line` (default true).

### 5.9 Health notes ("worth mentioning to a doctor")
Evaluated over the window plus the current cycle. Each note has a title, one calm sentence, and "Dismiss". Never shown during onboarding. Excluded cycles (flagged) never trigger notes, except "no period" which is suppressed while the latest cycle is flagged pregnancy.

| `note_type` | Trigger | Requires |
|---|---|---|
| `cycle_length_out_of_range` | Typical cycle length `μ_p` < 21 or > 35, **or** ≥ 2 of the last 6 complete cycles are < 21 or > 35 days | n ≥ 3 |
| `high_variation` | Variation (§5.10) > 9 days | n ≥ 6 |
| `no_period_60` | `today − L ≥ 60` with no new period | always |
| `no_period_90` | `today − L ≥ 90` (replaces the 60-day note, slightly firmer wording) | always |
| `long_period` | Any period ≥ 10 days, or ≥ 2 of the last 6 periods > 7 days | — |

Suggested copy (adapt tone to design voice):
- Out of range: "Your cycles are often shorter than 21 or longer than 35 days. That can be normal for some people, but it's worth mentioning to a doctor."
- High variation: "Your cycle length varies by more than 9 days. Worth mentioning at your next check-up."
- No period 60: "It's been over 60 days since your last period. If you're not pregnant, consider checking in with a doctor."
- No period 90: "It's been 90 days or more since your last period. It's a good idea to talk to a doctor."
- Long period: "Some of your periods last longer than 7 days. Worth mentioning to a doctor."

On hormonal birth control: suppress `cycle_length_out_of_range` and `high_variation`.

Dismissal: store `note_type` + `evidence_key` (e.g. sorted ids of cycles that triggered it, or `L` for no-period). Re-show only if the key changes.

### 5.10 Statistics
Requires `n ≥ 1` to show numbers; shown with the confidence label.

- **Average cycle length** = `round(μ)` (blended per §5.4; labeled "Default" at n = 0). Computed as the weighted median, labeled "average" for users.
- **Average period length** = `round(P)`.
- **Variation** = `max − min` of eligible cycle lengths in the window. If `n ≥ 6`, first remove at most one outlier: the single value with the largest `|x − μ_p|`, only if `|x − μ_p| > 3·σ_p`.
- **Regularity rating** (requires n ≥ 3; below that show "Log 3 cycles to see your regularity"):

| Rating | Variation | One-line explanation |
|---|---|---|
| Regular | ≤ 4 days | "Your cycles stay within a few days of each other." |
| Somewhat irregular | 5–8 days | "Your cycle length shifts a bit from month to month, which is common." |
| Irregular | > 8 days | "Your cycle length varies quite a lot, so predictions are less certain." |

No numeric scores.

- **Cycle length bar chart:** one bar per complete cycle, most recent 12 (including flagged and out-of-range cycles, which use the **excluded cycle bar** role and a label with the reason). Y = cycle length in days. Shaded **normal range band** from `round(μ_p − 2σ_p)` to `round(μ_p + 2σ_p)` once n ≥ 3; before that, shade the general reference range 21–35 using the **reference range band** role. Tapping a bar opens that cycle in history.

### 5.11 Worked example (use as a unit test)
Period starts (all exact, 5-day periods): 2026-01-01, 01-29, 02-26, 03-27, 04-24, 05-22, 06-20. Today = 2026-06-25.
- Cycle lengths: 28, 28, 29, 28, 28, 29 → n = 6
- μ_p = 28, MAD = 0 → σ_p = 1.0 → σ = 1.0
- c_1 = 2026-07-18; likely range Jul 17–19; most likely Jul 18
- Ovulation (k=1): 2026-07-04; fertile window Jun 29 – Jul 5
- Horizon: `4·√k ≤ 14` → k ≤ 12.25 → 12 cycles (cap)
- Variation = 1 → Regular; confidence "Established"
- Cycle day on Jun 25 = 6, phase Follicular (menstrual Jun 20–24)

---

## 6. Features and behavior

### 6.1 First-run flow
1. **Welcome & privacy.** "Your data stays on this device." Show the disclaimer (§1); user taps "I understand" → set `disclaimer_acknowledged_at`.
2. **Birth control.** "Are you using hormonal birth control (pill, patch, ring, implant, hormonal IUD, shot)?" Yes / No / Not sure. Sets `hormonal_birth_control` and ovulation defaults. Explain: "This decides whether we show ovulation. You can change it anytime."
3. **Last period.** "When did your last period start?" Date picker (past dates only) + "Exact / Approximate" toggle. Then "Is it still going?" Yes (ongoing) / No → "When did it end?" (prefilled with start + usual − 1). Option: "I don't remember / skip" → no entries, defaults apply.
4. **Usual lengths.** "How long is your cycle usually?" (number, prefilled 28, "Not sure" keeps default) and "How many days does your period usually last?" (prefilled 5). Stored in settings as priors.
5. **Past cycles (optional).** "Add past periods for better predictions. Even 3 helps; 6 makes predictions much more reliable." Buttons: *Add past periods* (§6.4) / *Skip for now*.
6. **Done.** Land on the calendar with the next prediction and its confidence label visible. Set `onboarding_completed_at`.

All steps are skippable except the disclaimer. Everything is editable later.

### 6.2 Calendar (home)
- Month view, scrollable to the past and future; jump-to-today control.
- Each day can show, in priority order: logged period > predicted period (with intensity) > phase tint. Overlays: ovulation marker, fertile window, today marker.
- Header summary: cycle day and phase, next-period text (§5.5), confidence label, late notice if overdue, any active health note (one at a time; most severe first: no_period_90, no_period_60, long_period, cycle_length_out_of_range, high_variation).
- There are no separate start/end buttons: all logging happens by tapping calendar days (below).
- Tap a day → day detail: date, cycle day, phase, whether logged/predicted, and actions: *Mark period start here*, *Mark period end here*, *Edit this period*, *Delete this period* (soft delete with undo).
- Optional typical mood line across each week (§5.8b).
- Legend accessible from the calendar explaining each semantic role in plain words.

### 6.3 Logging rules
- **Start:** creates a `period_entry` (`end_date = null` if start is today or within the last `round(P)` days; otherwise `end_date = start + round(P) − 1`, `end_precision = approximate`).
- **End:** sets `end_date` on the ongoing entry.
- **Start within 7 days after the previous period's end:** ask "Is this part of your last period?" → *Yes, extend it* (sets previous `end_date`) / *No, it's a new period*.
- **Resulting cycle < 15 or > 60 days:** ask "That's a [short/long] cycle. Did you miss an entry?" → *Add a missed period* / *It's correct* / *Mark as unusual* (opens flag sheet).
- Future dates cannot be logged.
- Editing a period recomputes everything immediately.

### 6.4 Backfill
- Entry points: onboarding step 5, Settings, and Stats when n < 3.
- Scrolling calendar going backward from the earliest known period. User taps a **start date**; a period of `round(P)` days is placed (adjustable by tapping an end date). Each entry has an Exact/Approximate toggle (default Approximate in backfill).
- Progress text: "3 of 12 added". Prompt stops at 12 but the user can keep adding without further prompts.
- **Quick shortcut:** "Fill in from my usual cycle" → generate up to 12 entries backward from the earliest known start using `usual_cycle_length` and `usual_period_length`, all `approximate`, `source = quick_setup`. Show them for review before saving. These count at weight 0.5.
- Same sanity prompts as §6.3.
- Dates only. No mood or other daily data when backfilling.

### 6.5 Cycle history
- List of cycles, newest first: start date, cycle length, period length, precision, flag badge.
- Actions per cycle: edit dates, toggle precision, **Mark as unusual** (reason picker: pregnancy, miscarriage, starting/stopping birth control, illness, other + optional note), remove flag, delete.
- Explanation on the flag sheet: "Unusual cycles stay in your history but don't affect predictions or stats."

### 6.6 Stats screen
Shows items in §5.10, each with the confidence label, plus a short note when n < 6: "Predictions get more reliable after 6 cycles." Stats never show for n = 0 except the default values clearly labeled.

### 6.7 Settings
- Usual cycle and period length (priors)
- Hormonal birth control (Yes/No/Not sure); toggles for ovulation, fertile window, phase tints
- Week start
- Add past periods (backfill)
- Export data / Import data (§7)
- Delete all data (double confirmation, hard delete of all stores, returns to first run)
- About: disclaimer, how predictions work (plain-language version of §5)

---

## 7. Export / import

### 7.1 Export
JSON file, name `period-backup-YYYY-MM-DD.json`:
```json
{
  "app": "period-tracker",
  "schema_version": 1,
  "exported_at": "2026-11-22T23:00:00Z",
  "records": {
    "period_entries": [ ... ],
    "cycle_flags": [ ... ],
    "settings": [ { ... } ],
    "health_note_dismissals": [ ... ],
    "daily_logs": []
  }
}
```
Include soft-deleted records. Set `settings.last_export_at`.

### 7.2 Import
- Validate `app` and `schema_version` (refuse newer versions with a clear message; migrate older).
- Validate every record (required fields, date formats, UUIDs). Reject the whole file if invalid; report what was wrong.
- Offer **Merge** (default) or **Replace all**.
- Merge: match by `id`; keep the record with the later `updated_at`. Then re-check for overlapping non-deleted period entries; if any, show them and ask which to keep.
- Show a summary before committing: "Adds 14 periods, updates 2."

### 7.3 Export nudges
Show a gentle, dismissible nudge on the calendar when all are true:
- at least 3 period entries exist,
- `last_export_at` is null or more than 60 days ago,
- at least one record changed since the last export,
- today is after `export_nudge_snoozed_until`.

Dismissing sets `export_nudge_snoozed_until = today + 30`. Copy: "Your data lives only on this device. Save a backup?"

---

## 8. Edge cases

| Case | Behavior |
|---|---|
| No data | Defaults (28/5 or user priors), "Default" label, projection horizon from σ0 (typically 1 cycle) |
| Only one period logged | n = 0 cycles; predictions from priors anchored on that start |
| Ongoing period overdue for ending | §5.6 prompts; long-period note at ≥ 10 days |
| Period late | Overdue shift (§5.5), "X days late" text; no-period notes at 60/90 days |
| Overlapping entries | Prevented in UI; on import, user resolves |
| Two starts < 15 days apart | Sanity prompt (§6.3); if confirmed, cycle stays in history but is ineligible |
| Cycle > 90 days | Kept, ineligible for predictions, still triggers health notes |
| All recent cycles flagged | n = 0 → priors; label explains "Recent cycles are marked unusual" |
| Hormonal BC changes | Updating the setting immediately changes ovulation/phase display; suggest flagging the transition cycle as `birth_control_change` |
| Very short cycle, ovulation inside period | Hide ovulation/fertile window for that cycle (§5.7) |
| Editing past entries | Everything derived recomputes; no stored predictions to invalidate |
| Device date moves backward | Derivations simply use the new "today"; never delete entries in the "future" — show them as logged |
| Leap years / month lengths | Use date-only arithmetic (e.g. convert to day numbers since epoch in UTC for math) |
| Time zone travel | Dates are stored as plain dates; no conversion |
| Soft-deleted entry restored via undo | Set `deleted = false`, bump `updated_at` |
| Import of older schema | Run migrations in order before merge |

---

## 9. Semantic visual roles (for the design system)

| Role | Used for |
|---|---|
| `logged-period` | Days of a logged period (solid) |
| `predicted-period-end` | Remaining expected days of an ongoing period |
| `predicted-period-likely` | Predicted days with p ≥ 0.5 (lighter than logged) |
| `predicted-period-band` | Predicted days with 0.05 ≤ p < 0.5, intensity scaled by p (fades toward the edges) |
| `phase-menstrual`, `phase-follicular`, `phase-ovulatory`, `phase-luteal` | Phase tints, past and current cycles |
| `predicted-phase-tint` | Softer variant of the four phase tints for predicted cycles |
| `ovulation-marker` | Estimated ovulation day (past/current) |
| `predicted-ovulation-marker` | Ovulation in future predicted cycles |
| `fertile-window` | Overlay for the 7-day window |
| `today-marker` | Today |
| `late-notice` | Period-late text |
| `confidence-label` | Default / Early estimate / Personal / Established |
| `health-note` | Gentle doctor notes |
| `export-nudge` | Backup reminder |
| `cycle-bar`, `excluded-cycle-bar` | Stats chart bars |
| `normal-range-band`, `reference-range-band` | Stats chart shading |

---

## 10. Future roadmap (not in v1; data reserved)

### 10.1 Daily log
Store `daily_logs`:
| Field | Type |
|---|---|
| common fields | §3.1 |
| `date` | `YYYY-MM-DD` (unique among non-deleted) |
| `mood` | integer 1–5 or null |
| `libido` | integer 1–5 or null |
| `sex` | boolean or null |
| `symptom_tags` | array of strings (e.g. `cramps`, `headache`, `bloating`, `breast_tenderness`, `acne`, `fatigue`, `cravings`) |
| `note` | string or null |

Cycle day and phase are **derived** at read time from §4/§5.8, so they stay correct when periods are edited. No logging during backfill.

### 10.2 Mood / libido / sex charts
- Average mood and libido by cycle day (normalized to the user's typical cycle length) and by phase, across cycles.
- Sex frequency by phase.
- Requires ≥ 2 cycles with logs; show confidence the same way as stats.

### 10.3 Partner sharing
- Read-only partner role inside the same app, off by default, revocable anytime.
- Tiers (each includes the previous): 1) period dates and predictions, 2) phases, 3) daily logs.
- `sharing_grants`: `partner_account_id`, `tier` (1–3), `status` (`invited`/`active`/`revoked`), `invited_at`, `revoked_at`.
- Requires server sync and accounts.

### 10.4 Google Calendar sync
- Push **predictions only** (next period, optionally ovulation), never logs.
- Neutral, user-chosen event names (default e.g. "Reminder"), no health wording.
- `calendar_sync`: `provider`, `calendar_id`, `event_name_period`, `event_name_ovulation`, `enabled`, `last_synced_at`, map of predicted cycle → external event id.
- Update/delete pushed events when predictions change.

### 10.5 Server sync
- Server SQL database mirroring the stores in §3 (one table per store, `id` primary key).
- Sync by `updated_at` (last-write-wins per record); soft deletes propagate.
- Accounts, encryption at rest; local data stays usable offline.

---

## 11. Assumptions made (small calls, easy to change)

1. "Average" cycle and period length are computed as the **weighted median** (robust to outliers) but labeled "average" for users.
2. Approximate dates use weight **0.5**; a cycle is approximate if either bounding start is approximate.
3. Default population spread **σ0 = 3 days**; spread floor **1 day**.
4. Uncertainty band drawn to **±2 spreads**; projection stops when that full band exceeds half the cycle, capped at **12 cycles**. At defaults this typically shows only the next cycle.
5. Late periods shift all predictions forward rather than widening the band.
6. Cycles outside **15–90 days** are kept but excluded from predictions.
7. High-variation health note triggers at **> 9 days** (top of the commonly cited 7–9 day normal range), with n ≥ 6; the "Irregular" rating starts at > 8 days.
8. Long-period note: any period ≥ 10 days, or 2 of the last 6 longer than 7 days (single 8-day periods are common).
9. On hormonal birth control, only the bleed is shown, and cycle-length/variation notes are suppressed.
10. Ovulatory phase is 3 days centered on estimated ovulation; fertile window is a separate overlay.
11. Backfilled entries default to Approximate; the quick shortcut always creates Approximate entries.
12. A start within 7 days after a period's end triggers "part of your last period?".
13. Export nudge: after 60 days without export and changes since, snoozable for 30 days.
14. Empty stores for daily logs, sharing and calendar sync are created in v1 to avoid a migration later.
