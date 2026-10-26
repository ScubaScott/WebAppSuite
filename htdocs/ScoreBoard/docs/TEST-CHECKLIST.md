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

- [ ] Overrun: in DevTools, edit `timerStateV7.startTime` to be older than the period length, reload: "Period Limit Exceeded" appears. Both choices work.
- [ ] Stale: set `startTime` and `lastSavedAt` to more than 3 hours ago, reload: "Finish Last Game?" appears. **Finish Game** stops the clock, shows Final with only New Game, and the viewer shows Final. **Resume Clock** continues the clock.

## Two tabs

- [ ] Open the console in two tabs during a live game, score in one: the other tab does not start sending updates on its own (watch the Network tab for repeated `sync` calls).
