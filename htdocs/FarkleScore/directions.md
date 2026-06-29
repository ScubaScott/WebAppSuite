# Overview
- code is in ./htdocs/FarkleScore/
- this is a score keeping app for Farkle, not a playable game, there should be no random roll generator.
- The actual dice roll will be done in real life, with real dice, then scored in the app.
- all score settings and player names should be stored using local storage.
- a page refresh should reload the current game if there is one in progress.
- enforce all the rules in rules.md file.
  
# Layout
- the main screen will consist of
- Title and manu
  - there should be a menus to adjust game settings, current standings and scores
- Player info
  - a player name
  - their currecnt score
  - their current place for the game (1st 2nd 3rd for example)
- Turn info
  - a temporary score for the round
- Turn "field"
  - there will be a "field" with rows of  up to 6 dice can be displayed as they are put in play.
  - each "roll" in a turn will be on it's own row.
-Dice Area
- the Dice Area with 6 dice, labeld 1 - 6
- both the field and dice buttons should be square (not rectangle) white boxes with the die value centered
- there will be buttons for "Roll", "Bank" and "Farkle"

# Functionaility  
- each push of a die in the Dice Area will add that die to the the "field", a maximum of 6 dice can be added.
- dice are not removed from the Dice Area.
- tapping a die on the field will remove it from the field, and the temp score re-calculated.
- the temporary score will update as dice are added.
- the Roll button serves to seperate scoring runs. getting three "2"s hitting roll, then adding another 2 does not equal 4 of a kind. each "roll" will keep the temp score, but disqualify existing dice from accumulating score.

# Flow
-an example round might look like this:
1. button 1 is pushed, a "1" die is added to the field, the temp score will show 100 pts since a single 1 = 100
2. button 1 is pushed again, another "1" die is added to the field, the temp score will show 200 pts since two 1's = 100 pts each.
3. button 1 is pushed again, another "1" die is added to the field, the temp score will show 1000 pts since three 1's = 1000 pts.
4. Re-Roll is pushed, temp score stays the same, and the field dice stay.
5. button 1 is pushed again, another "1" die is added to the field, the temp score will show 1100, since the last roll is complete with 1000 points, and the additional "1 earns an additional 100 points.
6. Bank is pushed. the 1100 points are recorded for the current user, and it moves to the next player. all 6 dice are not required to bank a score. banking ends that users turn.
7. if Farkle is pushed the no score is recorded for that user, and it moves to the next user.
8. if all 6 dice are used in the field and Re-Roll is pushed it becomes a "hot-dice" situation, and the temp score score remains, but all field dice are removed and the pattern repeats.
   - this can only happen if all 6 dice correctly match a scoring pattern. for exampe if the first roll shows 4 of a kind, then 3 and 4 are selected in the field, a re-roll can not occure as 3 and 4 are not a scoring combination.

- at the end of the players turn the screen will update the user score and move to the next player, and remove all the "field" dice.

- at the end of a round, (last player in list banks or farkles), a round summary screen is displayed. it will show all players with current scores, ordered from highest to lowest.
- ranking is always determined by score, not round count or turn score.
when a player reaches the winning score a message should be displayed indicating it will be the last round. all players are allowed 1 last round regardless of player order. play will stop when we return to the player that reached the winning score. the same summary screen should be shown with all users names and scores from highest to lowest. it's possible that the person who first reached the winning score is outscored in the last round. they do not get another turn. the game is over.

# Configuration
- each scoring value and winning score threshold should be adjustable on the config page.
- player setup, and scoring config pages shoule be thier own pages, not modal forms.
- player setup page should include a "start new game" this will clear current scores, and start a new game.
- players can be added and removed at any time. player names can be edited, and re-ordered at any time from the player setup page.
- there is no limit to the number of players.