/**
 * ScoreBoard games list: Active Games (public) and My Games (signed-in users).
 * Rules: AGENTS.md section 9.
 */

import { deriveStatusPill, formatStartDate, normalizeRowViewModel, applySavedThemeReadOnly } from './shared.js';

// Application version constant (follows suite 2-part decimal convention)
const APP_VERSION = '1.2';

// Pagination page size for My Games archive
const PAGE_LIMIT = 20;

// Active tab tracking ('active' | 'mine')
let currentTab = 'active';

// Polling timer for active games feed
let activePollTimer = null;

// Pagination state for user matches
let mineOffset = 0;
let mineTotal = 0;

// Currently selected game in the My Games action sheet
let selectedMenuGame = null;

// My Games team filter: '' shows every team. The choice is remembered on this device.
const TEAM_FILTER_KEY = 'scoreboardMyGamesTeam';
let currentTeam = '';
try {
    currentTeam = localStorage.getItem(TEAM_FILTER_KEY) || '';
} catch (error) {
    // Storage unavailable: start with all teams
}

// DOM references
const tabBtnActive = document.getElementById('tab-btn-active');
const tabBtnMine = document.getElementById('tab-btn-mine');
const panelActive = document.getElementById('panel-active');
const panelMine = document.getElementById('panel-mine');
const activeListEl = document.getElementById('active-games-list');
const activeEmptyEl = document.getElementById('active-empty-state');
const mineListEl = document.getElementById('mine-games-list');
const mineEmptyEl = document.getElementById('mine-empty-state');
const minePaginationEl = document.getElementById('mine-pagination');
const teamChipsEl = document.getElementById('team-chips');
const btnPagePrev = document.getElementById('btn-page-prev');
const btnPageNext = document.getElementById('btn-page-next');
const paginationStatus = document.getElementById('pagination-status');

// Action sheet DOM references
const actionSheetModal = document.getElementById('action-sheet-modal');
const sheetTitleEl = document.getElementById('sheet-title');
const sheetMetaEl = document.getElementById('sheet-meta');
const btnSheetView = document.getElementById('btn-sheet-view');
const btnSheetVisibility = document.getElementById('btn-sheet-visibility');
const btnSheetVisText = document.getElementById('btn-sheet-vis-text');
const btnSheetDelete = document.getElementById('btn-sheet-delete');
const btnSheetCancel = document.getElementById('btn-sheet-cancel');

/**
 * Parses current tab parameter from URL query string.
 *
 * @returns {'active'|'mine'}
 */
function getInitialTabFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const tabParam = (params.get('tab') || '').toLowerCase();
    return (tabParam === 'mine') ? 'mine' : 'active';
}

/**
 * Switches the active tab view, updating URL query parameter via replaceState.
 *
 * @param {'active'|'mine'} tab
 */
function switchTab(tab) {
    // Guard: Guests attempting to access My Games are redirected to apps launcher
    if (tab === 'mine') {
        if (!window.SuiteProfile || window.SuiteProfile.isGuest()) {
            window.location.replace('../index.html');
            return;
        }
    }

    currentTab = tab;

    // Update URL without adding browser history stack entry
    const url = new URL(window.location);
    url.searchParams.set('tab', tab);
    window.history.replaceState(null, '', url.pathname + url.search);

    if (tab === 'active') {
        tabBtnActive.classList.add('active');
        tabBtnActive.setAttribute('aria-selected', 'true');
        tabBtnMine.classList.remove('active');
        tabBtnMine.setAttribute('aria-selected', 'false');
        panelActive.classList.remove('hidden');
        panelMine.classList.add('hidden');

        fetchActiveGames();
        startActivePolling();
    } else {
        tabBtnMine.classList.add('active');
        tabBtnMine.setAttribute('aria-selected', 'true');
        tabBtnActive.classList.remove('active');
        tabBtnActive.setAttribute('aria-selected', 'false');
        panelMine.classList.remove('hidden');
        panelActive.classList.add('hidden');

        stopActivePolling();
        loadMyGames();
    }
}

/**
 * Loads the team chips first (so a remembered team that no longer exists is dropped), then the games.
 */
async function loadMyGames() {
    await fetchMyTeams();
    fetchMyGames();
}

/**
 * Fetches the user's teams and draws the filter chips. With fewer than two teams there is nothing to
 * choose between, so the chips are hidden and every game is shown.
 */
async function fetchMyTeams() {
    let teams = [];
    try {
        const res = await window.SuiteProfile.games.listMyTeams();
        if (res && res.success && Array.isArray(res.teams)) teams = res.teams;
    } catch (error) {
        // Without the team list the page still shows every game
    }
    const known = teams.some((team) => team.name.toLowerCase() === currentTeam.toLowerCase());
    if (!known || teams.length < 2) setCurrentTeam('');
    renderTeamChips(teams);
}

function setCurrentTeam(name) {
    currentTeam = name;
    try {
        localStorage.setItem(TEAM_FILTER_KEY, name);
    } catch (error) {
        // The choice just is not remembered
    }
}

/**
 * Draws "All" plus one chip per team, each with its game count.
 *
 * @param {Array<{name: string, games: number}>} teams
 */
function renderTeamChips(teams) {
    teamChipsEl.textContent = '';
    if (teams.length < 2) {
        teamChipsEl.classList.add('hidden');
        return;
    }
    const total = teams.reduce((sum, team) => sum + team.games, 0);
    const entries = [{ name: '', label: `All (${total})` }].concat(
        teams.map((team) => ({ name: team.name, label: `${team.name} (${team.games})` })));

    entries.forEach((entry) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'team-chip';
        chip.textContent = entry.label;
        chip.setAttribute('aria-pressed', entry.name.toLowerCase() === currentTeam.toLowerCase() ? 'true' : 'false');
        chip.addEventListener('click', () => {
            setCurrentTeam(entry.name);
            mineOffset = 0;
            teamChipsEl.querySelectorAll('.team-chip').forEach((other) => other.setAttribute('aria-pressed', other === chip ? 'true' : 'false'));
            fetchMyGames();
        });
        teamChipsEl.appendChild(chip);
    });
    teamChipsEl.classList.remove('hidden');
}

/**
 * Creates an identical row element for a game matching the specification.
 * Safe against XSS: all variable text is inserted through DOM text nodes.
 *
 * @param {Object} game - Normalized view model
 * @param {'active'|'mine'} originTab
 * @returns {HTMLElement}
 */
function createGameRowElement(game, originTab) {
    const card = document.createElement('div');
    card.className = 'game-card-row';
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');

    // Top section: Title, Date, and Badges
    const topRow = document.createElement('div');
    topRow.className = 'game-row-top';

    const titleBlock = document.createElement('div');
    titleBlock.className = 'game-row-title-block';

    const titleEl = document.createElement('div');
    titleEl.className = 'game-row-title';
    titleEl.textContent = `${game.homeName} vs ${game.awayName}`;
    titleBlock.appendChild(titleEl);

    const dateEl = document.createElement('div');
    dateEl.className = 'game-row-date';
    dateEl.textContent = formatStartDate(game.startedAt);
    titleBlock.appendChild(dateEl);

    const badgesBlock = document.createElement('div');
    badgesBlock.className = 'game-row-badges';

    // Status Pill (Live / Paused / Stalled / Final)
    const pillData = deriveStatusPill(game);
    const statusPill = document.createElement('span');
    statusPill.className = `status-pill ${pillData.className}`;
    if (pillData.type === 'live') {
        const dot = document.createElement('span');
        dot.className = 'pill-live-dot';
        statusPill.appendChild(dot);
    }
    const statusText = document.createTextNode(pillData.text);
    statusPill.appendChild(statusText);
    badgesBlock.appendChild(statusPill);

    // Visibility Flag (Public / Private)
    const isPublic = (game.visibility === 'public');
    const visPill = document.createElement('span');
    visPill.className = isPublic ? 'status-pill pill-public' : 'status-pill pill-private';
    visPill.textContent = isPublic ? 'Public' : 'Private';
    badgesBlock.appendChild(visPill);

    topRow.appendChild(titleBlock);
    topRow.appendChild(badgesBlock);

    // Center section: Score display
    const scoreWrap = document.createElement('div');
    scoreWrap.className = 'game-row-score-wrap';

    const scoreEl = document.createElement('div');
    scoreEl.className = 'game-row-score';
    scoreEl.textContent = `${game.homeScore} – ${game.awayScore}`;
    scoreWrap.appendChild(scoreEl);

    card.appendChild(topRow);
    card.appendChild(scoreWrap);

    // Row click interaction
    if (originTab === 'active') {
        // Active tab tap: navigates directly to spectator Viewer
        const targetUrl = `ScoreBoardViewer.html?id=${encodeURIComponent(game.id)}&from=active`;
        card.addEventListener('click', () => {
            window.location.href = targetUrl;
        });
        card.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                window.location.href = targetUrl;
            }
        });
    } else {
        // My Games tab tap: opens row action menu
        card.addEventListener('click', () => {
            openActionSheet(game);
        });
        card.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openActionSheet(game);
            }
        });
    }

    return card;
}

/**
 * Fetches public games list and updates the Active Games feed.
 */
async function fetchActiveGames() {
    try {
        let res = null;
        if (window.SuiteProfile && window.SuiteProfile.games) {
            res = await window.SuiteProfile.games.listPublic();
        } else {
            const fetchRes = await fetch('../api/games.php?action=list_public');
            res = await fetchRes.json();
        }

        if (res && res.success && Array.isArray(res.games)) {
            renderActiveGames(res.games);
        } else {
            if (activeListEl.children.length === 0) {
                activeEmptyEl.classList.remove('hidden');
            }
        }
    } catch (err) {
        if (activeListEl.children.length === 0) {
            activeEmptyEl.classList.remove('hidden');
        }
    }
}

/**
 * Renders public games into the Active tab feed.
 *
 * @param {Array<Object>} games
 */
function renderActiveGames(games) {
    activeListEl.innerHTML = '';
    if (!games || games.length === 0) {
        activeEmptyEl.classList.remove('hidden');
        return;
    }

    activeEmptyEl.classList.add('hidden');
    games.forEach(rawGame => {
        const normalized = normalizeRowViewModel(rawGame, 'public');
        const rowEl = createGameRowElement(normalized, 'active');
        activeListEl.appendChild(rowEl);
    });
}

/**
 * Fetches paginated user matches and updates the My Games list.
 */
async function fetchMyGames() {
    if (!window.SuiteProfile || window.SuiteProfile.isGuest()) {
        window.location.replace('../index.html');
        return;
    }

    try {
        const res = await window.SuiteProfile.games.listMine(PAGE_LIMIT, mineOffset, currentTeam);
        if (res && res.success && Array.isArray(res.games)) {
            mineTotal = res.total || 0;
            renderMyGames(res.games);
            updateMinePagination();
        } else {
            mineListEl.innerHTML = '';
            mineEmptyEl.classList.remove('hidden');
            minePaginationEl.classList.add('hidden');
        }
    } catch (err) {
        // Section 6: Redirect to apps page upon session expiration
        if (err && (err.message && err.message.toLowerCase().includes('session expired'))) {
            window.location.replace('../index.html');
            return;
        }
        mineListEl.innerHTML = '';
        mineEmptyEl.textContent = 'Unable to load matches. Please check connection.';
        mineEmptyEl.classList.remove('hidden');
        minePaginationEl.classList.add('hidden');
    }
}

/**
 * Renders user matches into the My Games list.
 *
 * @param {Array<Object>} games
 */
function renderMyGames(games) {
    mineListEl.innerHTML = '';
    if (!games || games.length === 0) {
        mineEmptyEl.classList.remove('hidden');
        minePaginationEl.classList.add('hidden');
        return;
    }

    mineEmptyEl.classList.add('hidden');
    games.forEach(rawGame => {
        const normalized = normalizeRowViewModel(rawGame, 'mine');
        const rowEl = createGameRowElement(normalized, 'mine');
        mineListEl.appendChild(rowEl);
    });
}

/**
 * Updates pagination UI controls for My Games.
 */
function updateMinePagination() {
    if (mineTotal <= PAGE_LIMIT) {
        minePaginationEl.classList.add('hidden');
        return;
    }
    minePaginationEl.classList.remove('hidden');
    const currentPage = Math.floor(mineOffset / PAGE_LIMIT) + 1;
    const totalPages = Math.max(1, Math.ceil(mineTotal / PAGE_LIMIT));

    paginationStatus.textContent = `Page ${currentPage} of ${totalPages} (${mineTotal} matches)`;
    btnPagePrev.disabled = (mineOffset <= 0);
    btnPageNext.disabled = (mineOffset + PAGE_LIMIT >= mineTotal);
}

btnPagePrev.addEventListener('click', () => {
    if (mineOffset > 0) {
        mineOffset = Math.max(0, mineOffset - PAGE_LIMIT);
        fetchMyGames();
    }
});

btnPageNext.addEventListener('click', () => {
    if (mineOffset + PAGE_LIMIT < mineTotal) {
        mineOffset += PAGE_LIMIT;
        fetchMyGames();
    }
});

/**
 * Opens the bottom action sheet for a selected game on My Games tab.
 *
 * @param {Object} game
 */
function openActionSheet(game) {
    selectedMenuGame = game;
    sheetTitleEl.textContent = `${game.homeName} vs ${game.awayName}`;
    sheetMetaEl.textContent = `${game.homeScore} – ${game.awayScore} • ${formatStartDate(game.startedAt)}`;

    // Configure View button
    btnSheetView.href = `ScoreBoardViewer.html?id=${encodeURIComponent(game.id)}&from=mine`;

    // Configure Visibility button
    const isPublic = (game.visibility === 'public');
    btnSheetVisText.textContent = isPublic ? 'Make Private' : 'Make Public';
    btnSheetVisibility.disabled = false;

    // Configure Delete button: enabled only for final matches
    const isFinal = (game.status === 'final');
    if (isFinal) {
        btnSheetDelete.disabled = false;
        btnSheetDelete.textContent = 'Delete Match';
        btnSheetDelete.title = 'Permanently delete this completed match';
    } else {
        btnSheetDelete.disabled = true;
        btnSheetDelete.textContent = 'End game to delete';
        btnSheetDelete.title = 'Matches must be concluded before deletion';
    }

    actionSheetModal.classList.remove('hidden');
}

/**
 * Closes the row action sheet.
 */
function closeActionSheet() {
    actionSheetModal.classList.add('hidden');
    selectedMenuGame = null;
}

btnSheetCancel.addEventListener('click', closeActionSheet);
actionSheetModal.addEventListener('click', (e) => {
    if (e.target === actionSheetModal) {
        closeActionSheet();
    }
});

// Toggle visibility handler from action sheet
btnSheetVisibility.addEventListener('click', async () => {
    if (!selectedMenuGame) return;
    const targetGame = selectedMenuGame;
    const nextVis = (targetGame.visibility === 'public') ? 'private' : 'public';

    btnSheetVisibility.disabled = true;
    btnSheetVisText.textContent = 'Updating…';

    try {
        const res = await window.SuiteProfile.games.setVisibility(targetGame.id, nextVis);
        if (res && res.success) {
            targetGame.visibility = nextVis;
            closeActionSheet();
            fetchMyGames();
        } else {
            alert('Unable to update game visibility.');
            btnSheetVisibility.disabled = false;
            btnSheetVisText.textContent = (targetGame.visibility === 'public') ? 'Make Private' : 'Make Public';
        }
    } catch (err) {
        alert('Network error updating game visibility.');
        btnSheetVisibility.disabled = false;
        btnSheetVisText.textContent = (targetGame.visibility === 'public') ? 'Make Private' : 'Make Public';
    }
});

// Delete game handler from action sheet
btnSheetDelete.addEventListener('click', async () => {
    if (!selectedMenuGame) return;
    const targetGame = selectedMenuGame;
    if (targetGame.status !== 'final') {
        alert('This match is still active. Please finalize it before deleting.');
        return;
    }

    const confirmMsg = `Permanently delete this match record?\n\n${targetGame.homeName} vs ${targetGame.awayName}\nScore: ${targetGame.homeScore} – ${targetGame.awayScore}\nDate: ${formatStartDate(targetGame.startedAt)}`;
    if (!window.confirm(confirmMsg)) return;

    btnSheetDelete.disabled = true;
    btnSheetDelete.textContent = 'Deleting…';

    try {
        const res = await window.SuiteProfile.games.remove(targetGame.id);
        if (res && res.success) {
            closeActionSheet();
            loadMyGames();
        } else {
            alert('Unable to delete match record.');
            btnSheetDelete.disabled = false;
            btnSheetDelete.textContent = 'Delete Match';
        }
    } catch (err) {
        if (err && (err.error_code === 'game_live' || (err.message && err.message.toLowerCase().includes('live')))) {
            alert('Game is still active on server. End it before deleting.');
        } else {
            alert('Network error deleting match record.');
        }
        btnSheetDelete.disabled = false;
        btnSheetDelete.textContent = 'Delete Match';
    }
});

/**
 * Starts periodic polling for active matches.
 */
function startActivePolling() {
    stopActivePolling();
    activePollTimer = setInterval(() => {
        if (!document.hidden && currentTab === 'active') {
            fetchActiveGames();
        }
    }, 4000);
}

/**
 * Stops active matches polling.
 */
function stopActivePolling() {
    if (activePollTimer) {
        clearInterval(activePollTimer);
        activePollTimer = null;
    }
}

// Handle tab button click events
tabBtnActive.addEventListener('click', () => switchTab('active'));
tabBtnMine.addEventListener('click', () => switchTab('mine'));

// Mobile lifecycle: pause polling on hidden, resume and fetch immediately on visible
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        stopActivePolling();
    } else {
        if (currentTab === 'active') {
            fetchActiveGames();
            startActivePolling();
        } else if (currentTab === 'mine') {
            loadMyGames();
        }
    }
});

/**
 * Initializes page view and authentication-dependent elements.
 */
function initPage() {
    // Apply viewer's read-only theme
    applySavedThemeReadOnly();

    const isUserGuest = (!window.SuiteProfile || window.SuiteProfile.isGuest());

    // Section 4.5: Render My Games tab control only for authenticated users
    if (isUserGuest) {
        tabBtnMine.classList.add('hidden');
    } else {
        tabBtnMine.classList.remove('hidden');
    }

    const initialTab = getInitialTabFromUrl();
    if (initialTab === 'mine' && isUserGuest) {
        // Section 6: Guest opening ?tab=mine redirects to root apps launcher
        window.location.replace('../index.html');
        return;
    }

    switchTab(initialTab);
}

window.addEventListener('DOMContentLoaded', () => {
    const versionEl = document.getElementById('appVersion');
    if (versionEl) versionEl.textContent = APP_VERSION;

    if (window.SuiteProfile) {
        window.SuiteProfile.renderFooterIndicator(document.querySelector('.app-footer p'));
    }

    initPage();
});

// Handle profile changes dynamically
window.addEventListener('suite-profile-changed', () => {
    initPage();
});
