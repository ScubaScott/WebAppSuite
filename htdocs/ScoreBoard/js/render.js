/**
 * ScoreBoard console rendering: draws the board, clocks, buttons and history from the game.
 * Reads the game and preferences; never changes them.
 */

import { STATUS, getElapsed, getScores, periodLabel } from './state.js';
import { formatClock } from './format.js';
import { buildHistory } from './snapshot.js';

/** The remaining time (ms) at or below which the countdown turns red. */
const WARNING_MS = 120000;

const byId = (id) => document.getElementById(id);

/** Look up the elements the board draws into. */
function findElements() {
    return {
        timerDisplay: byId('timer-display'),
        elapsedDisplay: byId('elapsed-time-display'),
        overageBadge: byId('overage-badge'),
        draftBadge: byId('draft-status-badge'),
        boardControls: byId('board-controls-wrap'),
        cardMenu: byId('btn-card-menu'),
        btnNewGame: byId('btn-new-game'),
        btnStart: byId('btn-start'),
        btnPause: byId('btn-pause'),
        btnResume: byId('btn-resume'),
        btnEndPeriod: byId('btn-end-period'),
        btnEndOt: byId('btn-end-ot'),
        scoreHome: byId('score-home'),
        scoreAway: byId('score-away'),
        nameHome: byId('home-team-name'),
        nameAway: byId('away-team-name'),
        period: byId('period-display'),
        historyBody: byId('history-body'),
        cardsRow: byId('penalty-cards-row'),
        muteButton: byId('mute-btn'),
        muteIcon: byId('mute-icon')
    };
}

// Speaker icons for the mute button
const ICON_SOUND = '<path d="M5 9v6h4l5 5V4L9 9H5zm12.5 3c0-1.17-.51-2.22-1.32-2.94l-1.42 1.42c.38.39.62.92.62 1.52s-.24 1.13-.62 1.52l1.42 1.42c.81-.72 1.32-1.77 1.32-2.94zm-2.91-4.24l-1.42 1.42C13.97 9.58 14.5 10.74 14.5 12s-.53 2.42-1.33 3.32l1.42 1.42C15.57 15.87 16.5 14.02 16.5 12s-.93-3.87-2.41-4.24z"/>';
const ICON_MUTED = '<path d="M16.5 12c0 1.17-.51 2.22-1.32 2.94l1.42 1.42c.81-.72 1.32-1.77 1.32-2.94s-.51-2.22-1.32-2.94l-1.42 1.42C15.97 10.58 16.5 11.74 16.5 12z"/><path d="M4.27 3L3 4.27l5 5V15h4l5 5 1.27-1.27L4.27 3zm6.73 12.73H9V8.27l4-4v11.45l-1 .01z"/>';

export function createRenderer() {
    const el = findElements();

    /** Show or hide an element with the `hidden` class. */
    const setHidden = (element, hidden) => {
        if (element) element.classList.toggle('hidden', hidden);
    };

    /** Everything that depends on the game's status or contents (not the ticking clock). */
    function renderBoard(game, prefs) {
        const scores = getScores(game);
        const draft = game.status === STATUS.READY;

        el.nameHome.textContent = game.home.name;
        el.nameHome.style.color = game.home.color;
        el.scoreHome.textContent = scores.home;
        el.scoreHome.style.color = game.home.color;
        el.nameAway.textContent = game.away.name;
        el.nameAway.style.color = game.away.color;
        el.scoreAway.textContent = scores.away;
        el.scoreAway.style.color = game.away.color;
        el.period.textContent = periodLabel(game);

        // Board controls are locked before a game exists, before the first Start, and after the game ends
        el.boardControls.classList.toggle('board-locked',
            game.status === STATUS.IDLE || game.status === STATUS.FINAL || draft);

        // Scoring and cards only work while the clock runs
        const scoringAllowed = game.status === STATUS.RUNNING;
        el.scoreHome.classList.toggle('score-disabled', !scoringAllowed);
        el.scoreAway.classList.toggle('score-disabled', !scoringAllowed);
        document.querySelectorAll('.foul-card-btn')
            .forEach((button) => button.classList.toggle('card-btn-disabled', !scoringAllowed));

        setHidden(el.draftBadge, !draft);
        setHidden(el.cardsRow, !prefs.showCards);

        // The edit button shows whenever the match can be edited
        setHidden(el.cardMenu, ![STATUS.READY, STATUS.PAUSED, STATUS.BETWEEN_PERIODS].includes(game.status));

        // Control bar: one primary button per status
        const showNew = game.status === STATUS.IDLE || game.status === STATUS.FINAL;
        const showStart = draft || game.status === STATUS.BETWEEN_PERIODS;
        const showPause = game.status === STATUS.RUNNING;
        const showResume = game.status === STATUS.PAUSED;
        setHidden(el.btnNewGame, !showNew);
        setHidden(el.btnStart, !showStart);
        setHidden(el.btnPause, !showPause);
        setHidden(el.btnResume, !showResume);
        // Intermediate periods can be ended early; the last period uses End / OT
        setHidden(el.btnEndPeriod, !(showResume && game.currentPeriod < game.periodCount));
        setHidden(el.btnEndOt, !(showResume || game.status === STATUS.BETWEEN_PERIODS));
    }

    /** The two clocks, redrawn on every tick. */
    function renderClock(game, now) {
        const elapsed = getElapsed(game, now);
        const remaining = game.periodLengthMs - elapsed;
        el.timerDisplay.textContent = formatClock(remaining);
        el.timerDisplay.style.color = remaining > WARNING_MS ? '#ffffff' : '#ef4444';
        setHidden(el.overageBadge, remaining >= 0);
        el.elapsedDisplay.textContent = formatClock(elapsed);
    }

    /**
     * The history table, newest first. `onRowClick` receives the id of the clicked entry.
     * Returns the rows that were drawn (the same shape older viewers read).
     */
    function renderHistory(game, prefs, onRowClick) {
        const rows = buildHistory(game, prefs);
        window.ScoreBoardShared.renderHistoryRows(el.historyBody, rows, {
            interactive: true,
            onRowClick: (index) => onRowClick(rows[index].id),
            homeTeamName: game.home.name,
            awayTeamName: game.away.name,
            homeTeamColor: game.home.color,
            awayTeamColor: game.away.color,
            totalPeriods: game.periodCount,
            basePeriods: game.regulationPeriods
        });
        return rows;
    }

    /** Speaker icon and state of the mute button. */
    function renderMute(muted) {
        el.muteIcon.innerHTML = muted ? ICON_MUTED : ICON_SOUND;
        el.muteButton.classList.toggle('fab-muted', muted);
    }

    return { renderBoard, renderClock, renderHistory, renderMute, elements: el };
}
