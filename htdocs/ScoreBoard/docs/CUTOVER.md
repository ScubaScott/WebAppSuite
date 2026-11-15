# ScoreBoard Cutover Plan (merge `full_refactor` to `main`)

Active document. Move it to `docs/old/` when the cutover is finished and the cleanup in step 14 is done.

Read with `AGENTS.md` section 13. The server script is `htdocs/api/migrate_scoreboard.php`.

## What changes for the data

| Data | Where | What happens |
| --- | --- | --- |
| Finished and archived games | `scoreboard_games.state_json` | `theme` is added (owner's theme from their profile record, else `saber-dark`). History rows are **not** rewritten: the viewer and games list read the old and new rows the same way. Guest games are skipped (they expire after 24 hours). |
| Profile record `scoreboard` | `suite_user_data` | Reduced from "whole old game + settings" to preferences only. |
| Team grouping | `home_name` column | Nothing to do. The index was added by `setup.php` already. |
| Saved game in a browser | `localStorage` `timerStateV7` | Converted by the app on first launch (`migrate.js`). Not reachable from the server. |
| Service worker cache | each browser | Network-first, so the new files arrive on the first online load. |

Because the new snapshot contains everything the old one did, the **old code can still read games recorded by the new code**. That is what makes a rollback of the server data possible (see Rollback).

## Before the cutover day

1. **Back up the database.** In phpMyAdmin export the whole database (at least `scoreboard_games`, `scoreboard_game_tombstones` and `suite_user_data`). Keep the file. This is the real safety net.
2. **Set the migration key.** On the server create a small file `api/migration_key.php` (in `htdocs/dev/api/` to rehearse, and in `htdocs/api/` for the cutover) containing:
   `<?php define('SCOREBOARD_MIGRATION_KEY', '<16+ random characters>');`
   Create it by hand on the server (file manager or FTP). Never commit it, and do not put the key in `config.php`: that file is in git and the deploy would overwrite the server's copy.
3. **Rehearse the dry run on the real data.** After this branch is deployed to `/dev/`, open
   `https://<site>/dev/api/migrate_scoreboard.php?key=<KEY>`
   A dry run writes nothing. Check the report:
   - `games seen` matches the number of rows you expect.
   - `unreadable snapshots` and `unreadable record` are 0. If not, send me those ids before going on.
   - "theme would be added" is roughly the number of owned games.
   - Any `LIVE GAMES` listed are only your own test games.
4. **Optional full rehearsal (apply).** The `/dev/` site shares the production database, so an apply there changes production data. To rehearse the apply, import the backup into a local MySQL, point a local copy of `config.php` at it, serve `htdocs/` with PHP (`php -S`), run the script with `&apply=1`, then again to see all zero counts, then with `&restore=1&apply=1` and confirm the data matches the export.
5. **Run the full `TEST-CHECKLIST.md` on `/dev/`** one last time, including:
   - the old-state conversion (load `docs/timerStateV7_Finalized.json` and `_Running.json` into `localStorage` as `timerStateV7` in a private window, then open the console);
   - the admin tab with an admin and a non-admin account;
   - the phone, not just the desktop.
6. **Pick the day.** Choose a time when nobody plays. Tell the people who use the production site that they may need to reload once.

## Cutover day

7. **Confirm there are no live games.** The public Active Games list is empty, and the dry run shows no `LIVE GAMES`. If a game is live, stop and wait. (Apply refuses to run anyway.)
8. **Merge** `full_refactor` into `main` (a pull request is easiest to review; do not squash away the phase commits unless you want to). Watch the GitHub Action finish: `main` goes to the site root.
9. **Run the dry run on production:**
   `https://<site>/api/migrate_scoreboard.php?key=<KEY>`
   The numbers should match the rehearsal (plus any games played since).
10. **Apply:**
    `https://<site>/api/migrate_scoreboard.php?key=<KEY>&apply=1`
    Then open the same URL **without** `apply` once more. Every "would be added" and "would be reduced" count must be 0.
11. **Smoke test on production**, in this order:
    - Open the site in a normal browser window; the footer shows the new version (console 7.1).
    - Games page: Active and My Games load; an old archived game opens in the viewer in its owner's theme with its history intact.
    - Team chips appear for a user with two or more teams.
    - Record a short game: New Game (choose a theme), Start, goals, End Period, Finalize. Watch it from a second device in the viewer.
    - Delete that test game from My Games.
    - On a device that had the old app with a saved game: reload; the game is converted and keeps its score and clock.

## After the cutover

12. **Watch for a week.** Look for: anyone seeing a blank history, wrong theme, or a lost game.
13. **Run the script once more** (dry run, then apply) about a week later. Tabs left open on the old code can still write an old-format profile record or a game without `theme`.
14. **Cleanup, in one commit** (this is "remove old-format readers"):
    - Delete `api/migrate_scoreboard.php` from the repo and the server; delete `api/migration_key.php` from the server.
    - Drop the `scoreboard_migration_backup` table once you are sure (keep it for at least a month).
    - In the code, after local converters have had time to run on every device in use: `migrate.js` (the old flat-record conversion; keep `isGameObject` if still used), the old key list and `timerStateV7` reads in `storage.js`, the old names in `normalizePrefs`, and `holdsOldGame` in `console.js`.
    - **Keep** the old-format history rendering in `shared.js` and `parseEventDetails`, and the viewer's `isCountingUp` handling: archived games still contain those rows.
    - Update `AGENTS.md` (status table, section 13) and move this file to `docs/old/`.

## Rollback

There is no fall back to an earlier point on this branch, but the cutover itself can be undone:

1. **Server code:** revert the merge commit on `main`; the Action redeploys the old code. The old code reads everything the new code wrote (the snapshot contract was kept compatible on purpose).
2. **Server data:** `migrate_scoreboard.php?key=<KEY>&restore=1&apply=1` puts the original `state_json` and profile records back from `scoreboard_migration_backup`. If that table is gone or damaged, import the export from step 1.
3. **Browsers:** a device that already converted its `timerStateV7` to `scoreboardGameV8` cannot go back. With no live games at the cutover, the only thing lost on such a device is an unfinished local draft. Finished games are on the server.

Decide the point of no return up front: **after step 11 passes**, do not roll back; fix forward.

## Checklist for the day (copy)

- [ ] DB export saved
- [ ] `migration_key.php` created on the server
- [ ] Dry run on real data reviewed (no unreadable rows)
- [ ] Full checklist passed on `/dev/`
- [ ] No live games
- [ ] Merged, Action finished
- [ ] Dry run on production matches
- [ ] Applied; second run shows zeros
- [ ] Smoke test passed
- [ ] Week-later re-run scheduled
- [ ] Cleanup commit done, script deleted, key removed
