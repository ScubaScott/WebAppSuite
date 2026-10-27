# ScoreBoard Manual Test Checklist

Run this on the current app and again on the refactor branch. Results should match except where noted. Use a phone-sized window and a second browser window (or phone) for the viewer.

Test games appear on the public Active Games list. Set them to private or delete them afterwards.

## Setup

- [ ] Test once as a guest and once signed in. Items marked **(signed in)** need an account.
- [ ] Before testing the refactor branch, open the live app in the same browser and export your saved game for fixtures: DevTools > Application > Local Storage > copy the value of `timerStateV7` into a file. Do this once with a game in progress and once with a finished game.

## Core game flow

- [ ] New Game: set names, colors, 2 periods, 1-minute periods. Press Ready. Board shows READY, scores are dimmed.
- [ ] Start: clock counts down, Pause button appears. Tapping a score box adds 1 and a history row appears.
- [ ] Pause then Resume: scoring is blocked while paused ("Clock is stopped").
- [ ] Let period 1 run out: whistle plays (unless muted), board moves to P2 ready with clock reset.
- [ ] Start P2, let it run out: End / OT dialog opens.
- [ ] Add Overtime: setup dialog opens with 10 minutes, new period shows as OT.
- [ ] Finalize: board shows final, only New Game is available, history stays interactive.
- [ ] Penalty cards (Settings > Show Penalty Cards): yellow and red add history rows and play the card animation only while the clock runs.
- [ ] Pause on Score on: a goal pauses the clock. Score splash on/off works per team.

## Saved data (storage split)

- [ ] With the old fixture loaded into `timerStateV7` (and no `scoreboardGameV8`), open the app: the game appears as before, `scoreboardGameV8` and `scoreboardPrefsV1` now exist, and `timerStateV7` and the other old keys are gone.
- [ ] Settings (theme, mute, pause on score, log options, splash, cards) survive a reload. Change each one and reload.
- [ ] **(signed in)** The profile record holds preferences only: after one save, `loadAppData('scoreboard')` has no `scoreHistory` or `activeGameId`.
- [ ] **(signed in)** Open the app on a second browser profile with the same account: it shows the same settings and no game (a game does not move between devices).
- [ ] The viewer and games list show the saved theme.
- [ ] Log out: the game and preferences keys are cleared.

## Page structure (Phase 4)

- [ ] The console, viewer, games list and help page look the same as before on a phone-width window: card, score boxes, period box, clocks, history table, settings and dialogs.
- [ ] Tab to a score box and press Enter or Space: a goal is scored. The focus ring is visible. Same for the period box and the elapsed time.
- [ ] Open the viewer for a live game, a finished game and a deleted one; the Active Games and My Games tabs, the row action sheet, and the old redirect links (`ScoreBoardActiveGames.html`, `ScoreBoardMyGames.html`) all work.
- [ ] Go offline after one visit to each page and reload: all pages still open (the new `js/` files are cached).
- [ ] A theme with a filter (for example Chill Night) still shows its background on the console, viewer and games list.

## Clock corrections (refactor branch)

- [ ] Start a period, wait about 1 minute, tap the elapsed time, press +1 min: the clock reads about 2:00, the Start row shows a time one minute earlier, and a "P1 - Clock +1:00" row appears.
- [ ] Score a goal, then press +1 min: the goal's time in the history moves later by one minute.
- [ ] Pause for a while, resume, then correct: the pause length is unchanged and the clock follows the new start.
- [ ] Press -1 min right after a goal logged within the first 59 seconds: a message names the goal and nothing changes.
- [ ] Press -5 min within the first minute: a message says the clock cannot go below 0:00.
- [ ] Remove the "Clock +1:00" row: the clock and every time return to their earlier values.
- [ ] Correct while paused: it works. Correct between periods: the elapsed time cannot be opened.
- [ ] Reload after a correction: the clock and the Start row are unchanged.
- [ ] The Start row of a corrected period shows a `*`; tapping the row shows both the corrected time and when it was pressed.
- [ ] Pause and resume rows (with "Log Pause/Resume" on) and End rows show a position such as `13:00`; tapping one shows the position and the time of day.
- [ ] A game finished before this version still shows the times it showed before, and the viewer shows the same rows as the console.

## History

- [ ] Tap a row: Add Note, Share, Remove appear. A note saves and shows in the row.
- [ ] Remove a goal: a confirmation appears; Cancel keeps the entry and the dialog open; OK lowers the score.
- [ ] Remove a period end: confirmation says the game returns to that period.

## Reload and offline

- [ ] Start a clock, wait about 1 minute, reload the page: elapsed time is still about 1 minute and the clock keeps running (it must not restart near 00:00).
- [ ] Reload while paused: same elapsed time, still paused.
- [ ] Go offline (DevTools > Network > Offline), score twice, come back online: the viewer shows the new score within about 10 seconds.
- [ ] Reload twice in a row mid-game, then score: the viewer still updates (no stuck updates).

## Viewer and games list

- [ ] Open the viewer for a live game: score, period and clock match the console within about a second.
- [ ] Pause the console: viewer shows Paused. Resume: Live.
- [ ] Finalize: viewer shows Final and sends no more requests (Network tab goes quiet).
- [ ] Open a viewer link for a deleted or private game: "Game Unavailable", and no further requests.
- [ ] Active Games tab lists the game and updates every few seconds.

## Accounts and sharing

- [ ] **(signed in)** The "My Games" link under the board and the "Sharing & Privacy" section in Settings are visible. As a guest both are hidden.
- [ ] **(signed in)** During a live game, turn "Share on Active Games list" off: the game disappears from the public list and shows as Private in My Games. Turn it back on: it returns. Reload: the toggle matches.
- [ ] **(signed in)** Before the first Start, set the toggle to off, then Start: the game is created private.
- [ ] Sign in while a guest game is in progress: the game continues and appears in My Games.
- [ ] **(signed in)** My Games: change visibility, delete a finished game (confirmation), live games cannot be deleted.

## New Game and old games

- [ ] With a live game in progress, tap New Game, change both team names and the period count, press Ready. In My Games the old game is Final and still shows its **original** team names, scores and periods.
- [ ] Enter a 0:00 period length (roller) and press Ready / Save: a message appears and the dialog stays open.

## Stale and overrun prompts

- [ ] Overrun: start a 1-minute period, lock the phone (or leave the tab in the background) for more than 2 minutes, then return. Expect the period to have ended, or the "Period Limit Exceeded" prompt with both choices working. Do not test this by editing `timerStateV7` in DevTools: the page saves its in-memory state when it closes or reloads and overwrites the edit, and a signed-in newer cloud copy wins over local data.
- [ ] Stale: the 3-hour prompt cannot be reached by hand on the current app. On the refactor branch, test it with a saved-game fixture whose events are more than 3 hours old (see `TIMING-SPEC.md` section 10).
- [ ] On the refactor branch, also run the clock tests in `TIMING-SPEC.md` section 10.

## Two tabs

- [ ] Open the console in two tabs during a live game, score in one: the other tab does not start sending updates on its own (watch the Network tab for repeated `sync` calls).
