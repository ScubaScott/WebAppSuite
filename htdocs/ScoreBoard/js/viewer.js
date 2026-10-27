/**
 * ScoreBoard spectator viewer: polls one game and shows it read-only.
 * Rules: AGENTS.md section 9.
 */

import { formatClock, getPeriodLabel } from './format.js';
import { STALL_THRESHOLD_MS, deriveStatusPill, formatAgeMinutes, renderHistoryRows, applySavedThemeReadOnly, applyThemeToBody } from './shared.js';

// Viewer tool version constant
const APP_VERSION = '1.9';

// Polling configuration
const BASE_POLL_INTERVAL_MS = 4000;
let pollTimer = null;
let tickerTimer = null;
let consecutiveErrors = 0;
// Set once the game is final or unavailable; polling and the clock ticker never restart after that
let feedHalted = false;

// URL parameters
const urlParams = new URLSearchParams(window.location.search);
const gameId = urlParams.get('id');
const fromParam = (urlParams.get('from') || 'active').toLowerCase();

// DOM elements
const btnBack = document.getElementById('btn-back');
const loadingView = document.getElementById('loading-view');
const unavailableView = document.getElementById('unavailable-view');
const scoreboardCard = document.getElementById('scoreboard-card');
const reconnectingBanner = document.getElementById('reconnecting-banner');
const matchTitleEl = document.getElementById('match-title');
const statusPillEl = document.getElementById('status-pill');
const stalledAgeIndicator = document.getElementById('stalled-age-indicator');
const homeTeamNameEl = document.getElementById('home-team-name');
const awayTeamNameEl = document.getElementById('away-team-name');
const scoreHomeEl = document.getElementById('score-home');
const scoreAwayEl = document.getElementById('score-away');
const periodDisplayEl = document.getElementById('period-display');
const clockLabelEl = document.getElementById('clock-label');
const timerDisplayEl = document.getElementById('timer-display');
const overageBadgeEl = document.getElementById('overage-badge');
const historyBodyEl = document.getElementById('history-body');

// State model for spectator display
let currentModel = null;
// Theme currently applied from the game (so it is only applied when it changes)
let appliedTheme = null;
let serverClockOffset = 0; // server_now - client Date.now()

/**
 * Resolves the navigation back link href per section 3.2.
 * If origin was 'mine' but viewing user is a guest, back resolves to ?tab=active.
 */
function configureBackLink() {
    let backTab = (fromParam === 'mine' || fromParam === 'all') ? fromParam : 'active';
    if (backTab === 'mine') {
        if (!window.SuiteProfile || window.SuiteProfile.isGuest()) {
            backTab = 'active';
        }
    }
    if (backTab === 'all') {
        if (!window.SuiteProfile || !window.SuiteProfile.isAdmin()) {
            backTab = 'active';
        }
    }
    btnBack.href = `ScoreBoardGames.html?tab=${backTab}`;
}

/**
 * Fetches latest match snapshot from API and updates presentation state.
 */
async function fetchGameSnapshot() {
    if (!gameId) {
        showUnavailableState();
        return;
    }

    try {
        let res = null;
        if (window.SuiteProfile && window.SuiteProfile.games) {
            res = await window.SuiteProfile.games.get(gameId);
        } else {
            const fetchRes = await fetch(`../api/games.php?action=get&id=${encodeURIComponent(gameId)}`);
            if (fetchRes.status === 404) {
                showUnavailableState();
                return;
            }
            res = await fetchRes.json();
        }

        if (!res || !res.success || !res.game) {
            // Section 5.5: Terminal 404 enters Unavailable state
            showUnavailableState();
            return;
        }

        consecutiveErrors = 0;
        hideReconnectingBanner();

        const serverNow = (typeof res.server_now === 'number') ? res.server_now : Date.now();
        serverClockOffset = serverNow - Date.now();

        const game = res.game;
        const snap = game.snapshot || game;

        // Merge server response into viewer presentation model
        currentModel = {
            id: game.game_id || game.id,
            homeTeamName: game.homeTeamName || snap.homeTeamName || 'Home',
            awayTeamName: game.awayTeamName || snap.awayTeamName || 'Away',
            homeScore: (game.homeScore !== undefined) ? Number(game.homeScore) : (snap.homeScore || 0),
            awayScore: (game.awayScore !== undefined) ? Number(game.awayScore) : (snap.awayScore || 0),
            homeTeamColor: snap.homeTeamColor || game.homeTeamColor || '#ef4444',
            awayTeamColor: snap.awayTeamColor || game.awayTeamColor || '#3b82f6',
            currentPeriod: game.currentPeriod || snap.currentPeriod || 1,
            totalPeriods: snap.totalPeriods || 2,
            basePeriods: snap.basePeriods || 2,
            status: (game.status || snap.status || 'live').toLowerCase(),
            timerRunning: Boolean(game.timerRunning !== undefined ? game.timerRunning : snap.timerRunning),
            isPaused: Boolean(game.isPaused !== undefined ? game.isPaused : snap.isPaused),
            isCountingUp: Boolean(snap.isCountingUp),
            timeLimit: (snap.timeLimit !== undefined) ? Number(snap.timeLimit) : 0,
            elapsedMs: (game.elapsedMs !== undefined) ? Number(game.elapsedMs) : (snap.elapsedMs || 0),
            lastUpdate: (typeof game.lastUpdate === 'number') ? game.lastUpdate : (serverNow - (res.age_ms || 0)),
            ageMs: (typeof res.age_ms === 'number') ? res.age_ms : (game.age_ms || 0),
            theme: (typeof snap.theme === 'string' && snap.theme) ? snap.theme : null,
            scoreHistory: Array.isArray(snap.scoreHistory) ? snap.scoreHistory : (Array.isArray(game.scoreHistory) ? game.scoreHistory : []),
            fetchLocalTs: Date.now()
        };

        renderBoard();

        // Section 5.5: Stop polling when game is final; the last render already shows the frozen clock
        if (currentModel.status === 'final') {
            feedHalted = true;
            stopPolling();
            stopTicker();
        }

    } catch (err) {
        // Section 5.5: Network error or 5xx never transitions to Unavailable; keep last state & reconnect
        consecutiveErrors++;
        if (currentModel) {
            showReconnectingBanner();
        } else {
            // Check if initial fetch was a 404 or network failure
            if (err && (err.message && err.message.includes('404'))) {
                showUnavailableState();
            } else {
                showReconnectingBanner();
            }
        }
    }
}

/**
 * Renders static board elements (scores, names, colors, period, history).
 */
function renderBoard() {
    if (!currentModel) return;

    loadingView.classList.add('hidden');
    unavailableView.classList.add('hidden');
    scoreboardCard.classList.remove('hidden');

    // The game's own theme, when it has one, replaces the viewer's saved theme
    if (currentModel.theme && currentModel.theme !== appliedTheme) {
        applyThemeToBody(currentModel.theme);
        appliedTheme = currentModel.theme;
    }

    // Match title
    matchTitleEl.textContent = `${currentModel.homeTeamName} vs ${currentModel.awayTeamName}`;

    // Team names & scores
    homeTeamNameEl.textContent = currentModel.homeTeamName;
    awayTeamNameEl.textContent = currentModel.awayTeamName;
    scoreHomeEl.textContent = currentModel.homeScore;
    scoreAwayEl.textContent = currentModel.awayScore;

    // Apply custom team colors
    homeTeamNameEl.style.color = currentModel.homeTeamColor;
    scoreHomeEl.style.color = currentModel.homeTeamColor;
    awayTeamNameEl.style.color = currentModel.awayTeamColor;
    scoreAwayEl.style.color = currentModel.awayTeamColor;

    // Period label
    periodDisplayEl.textContent = getPeriodLabel(currentModel.currentPeriod, currentModel.totalPeriods, currentModel.basePeriods);

    // Render score history using shared component in read-only mode
    renderHistoryRows(historyBodyEl, currentModel.scoreHistory, {
        interactive: false,
        homeTeamName: currentModel.homeTeamName,
        awayTeamName: currentModel.awayTeamName,
        homeTeamColor: currentModel.homeTeamColor,
        awayTeamColor: currentModel.awayTeamColor,
        totalPeriods: currentModel.totalPeriods,
        basePeriods: currentModel.basePeriods
    });

    // Update clock and status pills
    updateClockDisplay();
}

/**
 * High-frequency display update implementing the server-anchored clock model (section 5.4).
 * Calculates extrapolated elapsed time and renders remaining time without mutating state.
 */
function updateClockDisplay() {
    if (!currentModel) return;

    const now = Date.now();
    const serverNowEst = now + serverClockOffset;
    const elapsedSinceUpdate = Math.max(0, serverNowEst - currentModel.lastUpdate);

    // Compute current age in ms for status derivation
    const currentEffectiveAgeMs = (currentModel.ageMs || 0) + (now - currentModel.fetchLocalTs);

    // Derive status pill
    const pillInfo = deriveStatusPill({
        status: currentModel.status,
        isPaused: currentModel.isPaused,
        timerRunning: currentModel.timerRunning,
        ageMs: currentEffectiveAgeMs
    });

    // Render status pill
    statusPillEl.className = `status-pill ${pillInfo.className}`;
    statusPillEl.innerHTML = '';
    if (pillInfo.type === 'live') {
        const dot = document.createElement('span');
        dot.className = 'pill-live-dot';
        statusPillEl.appendChild(dot);
    }
    statusPillEl.appendChild(document.createTextNode(pillInfo.text));

    // Section 5.2: Age indicator shown ONLY when Stalled
    if (pillInfo.type === 'stalled') {
        stalledAgeIndicator.textContent = `Last update ${formatAgeMinutes(currentEffectiveAgeMs)}`;
        stalledAgeIndicator.classList.remove('hidden');
    } else {
        stalledAgeIndicator.classList.add('hidden');
    }

    // Section 5.4: Clock extrapolation logic
    let extrapolatedElapsed = currentModel.elapsedMs;
    const canExtrapolate = (
        currentModel.status !== 'final' &&
        currentModel.timerRunning &&
        !currentModel.isPaused
    );

    if (canExtrapolate) {
        const sinceUpdateClamped = Math.min(elapsedSinceUpdate, STALL_THRESHOLD_MS);
        const runningExtrapolated = currentModel.elapsedMs + sinceUpdateClamped;

        // Stop condition: clamp at period timeLimit unless scorer has already reported overage
        if (currentModel.timeLimit > 0 && currentModel.elapsedMs < currentModel.timeLimit) {
            extrapolatedElapsed = Math.min(runningExtrapolated, currentModel.timeLimit);
        } else {
            extrapolatedElapsed = runningExtrapolated;
        }
    }

    // Calculate display milliseconds
    const timeLimit = currentModel.timeLimit;
    let displayMs = 0;
    let isOverage = false;

    if (currentModel.isCountingUp) {
        clockLabelEl.textContent = 'Elapsed';
        displayMs = extrapolatedElapsed;
        if (timeLimit > 0 && extrapolatedElapsed > timeLimit) {
            isOverage = true;
        }
    } else {
        clockLabelEl.textContent = 'Remaining';
        if (timeLimit > 0) {
            displayMs = timeLimit - extrapolatedElapsed;
            if (extrapolatedElapsed > timeLimit) {
                isOverage = true;
            }
        } else {
            displayMs = extrapolatedElapsed;
        }
    }

    timerDisplayEl.textContent = formatClock(displayMs);

    if (isOverage) {
        overageBadgeEl.classList.remove('hidden');
    } else {
        overageBadgeEl.classList.add('hidden');
    }
}

/**
 * Transitions viewer to terminal Unavailable state.
 */
function showUnavailableState() {
    feedHalted = true;
    stopPolling();
    stopTicker();
    loadingView.classList.add('hidden');
    scoreboardCard.classList.add('hidden');
    hideReconnectingBanner();
    unavailableView.classList.remove('hidden');
}

function showReconnectingBanner() {
    reconnectingBanner.classList.remove('hidden');
}

function hideReconnectingBanner() {
    reconnectingBanner.classList.add('hidden');
}

/**
 * Starts periodic polling with backoff during network errors.
 */
function startPolling() {
    stopPolling();
    if (feedHalted) return;
    const delay = consecutiveErrors > 0 ? Math.min(10000, BASE_POLL_INTERVAL_MS * (consecutiveErrors + 1)) : BASE_POLL_INTERVAL_MS;
    pollTimer = setTimeout(async () => {
        if (!document.hidden) {
            await fetchGameSnapshot();
        }
        startPolling();
    }, delay);
}

function stopPolling() {
    if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
    }
}

function startTicker() {
    stopTicker();
    if (feedHalted) return;
    tickerTimer = setInterval(() => {
        if (!document.hidden && currentModel) {
            updateClockDisplay();
        }
    }, 100);
}

function stopTicker() {
    if (tickerTimer) {
        clearInterval(tickerTimer);
        tickerTimer = null;
    }
}

// Mobile lifecycle: pause polling and ticker on hidden, resume immediately on visible
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        stopPolling();
        stopTicker();
    } else {
        if (feedHalted) {
            // Do not resume polling for a final or unavailable match
            return;
        }
        fetchGameSnapshot();
        startPolling();
        startTicker();
    }
});

window.addEventListener('DOMContentLoaded', () => {
    const versionEl = document.getElementById('appVersion');
    if (versionEl) versionEl.textContent = APP_VERSION;

    if (window.SuiteProfile) {
        window.SuiteProfile.renderFooterIndicator(document.querySelector('.app-footer p'));
    }

    // Apply viewing user's selected theme (read-only)
    applySavedThemeReadOnly();

    // Set up dynamic back button
    configureBackLink();

    // Initial fetch and timer activation
    fetchGameSnapshot().then(() => {
        startTicker();
        startPolling();
    });
});
