# Phase 3 Plan: Single Game Object and Event-Based Clock

Goal: replace the console's ~45 globals and overlapping status flags with one `game` object changed only by a reducer, with the clock calculated from events as described in `TIMING-SPEC.md`. Then remove the stored old-format fields.

Rule for every step: pure logic goes in a module with tests under `tests/` (run `node --test tests/<file>.mjs` from `htdocs/ScoreBoard`); the console only calls it. A step is finished when its tests pass, and steps that change the UI are finished when the matching part of `docs/TEST-CHECKLIST.md` passes in a browser.

| Step | Work | Done when |
| --- | --- | --- |
| 3.1 | `js/clock.js`: positions, effective start, expiry time, adjustment checks | **Done.** 16 tests pass |
| 3.2 | `js/state.js`: the `game` shape, `createGame`, `reduce(game, action)` for every action in the status table (new game, ready, start, pause, resume, score, card, remove event, note, adjust clock, delete adjustment, end period, expire, add overtime, edit match, finalize), selectors (scores, flags, labels, elapsed) | **Done.** 30 tests cover every row of the status table and the event rules. Added `js/format.js` (period labels and clock formatting); step 3.6 makes `scoreboard-shared.js` use it so there is one copy |
| 3.3 | `js/migrate.js`: old saved record (`scoreboardGameV8` as written by 5.3, or `timerStateV7`) to a `game`; builds `period_start` / `paused` events for a live game from its saved clock; keeps stored positions on old entries | **Done.** 11 tests convert both fixtures and constructed records (paused, score pause, expired final period, between periods, draft, idle, old red/blue names); the converted games report the same scores, period, status and clock as the originals |
| 3.4 | `js/snapshot.js` (`toSnapshot`, with the derived positions and team names old viewers read), `js/sync.js` (send scheduler, revisions, conflicts, beacon), `js/storage.js` (saved game and preferences) | **Done.** 26 tests: each converted fixture produces the same snapshot fields and history rows as the old console; the scheduler, conflict retry, deleted/final handling and beacon run against a fake server |
| 3.5 | `js/console.js`: replaces the inline script. `dispatch` then render then persist. Sub-steps: (a) boot, load, render a game read-only; (b) scoring, cards, history, notes, removal; (c) start / pause / resume / display loop / expiry; (d) clock adjustment panel and its history row; (e) New Game, Edit Match, Add Overtime, finalize, themes; (f) stale and overrun prompts, tab and sign-in events | Each sub-step passes the matching checklist section |
| 3.6 | `scoreboard-shared.js`: history renderer shows derived positions, the `clock_adjust` row, and the "adjusted" mark on the start row; old-format entries still display | Viewer and games list show old and new games correctly |
| 3.7 | Server migration script (AGENTS.md section 13) and cutover notes | Dry run against a copy of the real data reports every row converted |
| 3.8 | Remove dead code: `isCountingUp`, the old global names, the legacy record reader that is no longer needed on `/dev/` | Full checklist passes |

Things that change together:
- `sw.js` precache list when files are added.
- Version numbers on every page touched.
- The HTML markup: the module cannot use inline `onclick` as the old script does. Until Phase 4 moves the remaining handlers, `console.js` attaches the existing handler names to `window`. Do not add new inline handlers.
- `docs/TEST-CHECKLIST.md`: add the clock tests from `TIMING-SPEC.md` section 10 when step 3.5(d) lands.

Risks to watch:
- Step 3.5 is the largest. Keep the old inline script working until 3.5(c) passes, then switch the page over in one commit.
- Positions of old entries must not change when a game is converted.
- The snapshot contract (AGENTS.md section 6) must stay readable by the live viewer until the merge.
