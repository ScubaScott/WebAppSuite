/**
 * WebAppSuite ScoreBoard - Shared Utilities & Helpers
 * Provides standardized clock extrapolation, status pill derivation, history table formatting,
 * read-only theme application, and start-time formatting shared between the operator console,
 * unified Games screen, and spectator Viewer.
 */

// Shared module version constant
const SCOREBOARD_SHARED_VERSION = '1.1';

// Inactivity threshold (30 minutes in ms) after which an active game is considered stalled
const STALL_THRESHOLD_MS = 30 * 60 * 1000;

// Theme configuration catalog for read-only theme application
const SCOREBOARD_THEMES = {
    'saber-dark': {
        image: 'saber.png',
        bgColor: '#6b1a1a',
        label: 'Saber Dark'
    },
    'saber-light': {
        image: 'saber.png',
        bgColor: '#2a0808',
        label: 'Saber Light',
        filter: 'brightness(1.3) contrast(0.95)'
    },
    'chill-ice': {
        image: 'chill.png',
        bgColor: '#0d2238',
        label: 'Chill Ice'
    },
    'chill-night': {
        image: 'chill.png',
        bgColor: '#071522',
        label: 'Chill Night',
        filter: 'hue-rotate(200deg) brightness(0.55) saturate(1.4)'
    }
};

/**
 * Safely escapes characters for HTML insertion.
 *
 * @param {string|null|undefined} str
 * @returns {string}
 */
function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Formats milliseconds into [ - ]MM:SS.d format (e.g. 03:24.5 or -00:12.3).
 *
 * @param {number} ms
 * @returns {string}
 */
function formatTime(ms) {
    const absMs = Math.abs(ms);
    const totalSeconds = Math.floor(absMs / 1000);
    const totalMinutes = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    const decis = Math.floor((absMs % 1000) / 100);
    const pad = (n) => n.toString().padStart(2, '0');
    return `${ms < 0 ? '-' : ''}${pad(totalMinutes)}:${pad(s)}.${decis}`;
}

/**
 * Computes user-facing period label: P1, P2, ... or OT / OT1, OT2.
 *
 * @param {number} periodNum
 * @param {number} [totalPeriods=2]
 * @param {number} [basePeriods=2]
 * @returns {string}
 */
function getPeriodLabel(periodNum, totalPeriods = 2, basePeriods = 2) {
    const p = Number(periodNum) || 1;
    const b = Number(basePeriods) || 2;
    const t = Number(totalPeriods) || b;
    if (p <= b) {
        return `P${p}`;
    }
    const otIndex = p - b;
    if (t === b + 1) {
        return 'OT';
    }
    return `OT${otIndex}`;
}

/**
 * Formats game period elapsed time into MM:SS format without period prefix or subseconds.
 *
 * @param {Object} entry
 * @returns {string}
 */
function formatGameTimeMmSs(entry) {
    if (!entry) return '';
    if (entry.periodElapsedMs !== undefined && entry.periodElapsedMs !== null && !isNaN(entry.periodElapsedMs)) {
        const absMs = Math.abs(entry.periodElapsedMs);
        const totalSeconds = Math.floor(absMs / 1000);
        const totalMinutes = Math.floor(totalSeconds / 60);
        const s = totalSeconds % 60;
        const pad = (n) => n.toString().padStart(2, '0');
        return `${pad(totalMinutes)}:${pad(s)}`;
    }
    if (entry.gameTime) {
        let t = entry.gameTime.replace(/^(?:P(?:eriod)?\s*\d+|OT\d*)\s*[:-]\s*/i, '').trim();
        t = t.replace(/\.\d+$/, '');
        const parts = t.split(':');
        if (parts.length === 2) {
            return `${parts[0].padStart(2, '0')}:${parts[1].padStart(2, '0')}`;
        }
        return t;
    }
    return '';
}

/**
 * Formats timestamp into local time string without date (e.g. 4:05pm).
 *
 * @param {string|number} timestamp
 * @returns {string}
 */
function formatEventTime(timestamp) {
    if (!timestamp) return '';
    const d = new Date(timestamp);
    if (!isNaN(d.getTime())) {
        return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase().replace(/\s+/g, '');
    }
    return String(timestamp);
}

/**
 * Extracts period label and action details from an event entry.
 * Supports structured labelVersion: 2 entries as well as legacy entries.
 *
 * @param {Object} entry
 * @param {number} [totalPeriods=2]
 * @param {number} [basePeriods=2]
 * @returns {{periodLabel: string, action: string, eventLabel: string, rawText: string}}
 */
function parseEventDetails(entry, totalPeriods = 2, basePeriods = 2) {
    if (!entry) return { periodLabel: '', action: '', eventLabel: '', rawText: '' };
    const rawText = entry.text || '';

    // Structured clock events (labelVersion: 2)
    if (entry.labelVersion === 2) {
        const periodNum = (entry.period !== undefined && entry.period !== null) ? Number(entry.period) : 1;
        const periodLabel = getPeriodLabel(periodNum, totalPeriods, basePeriods);
        let action = 'Event';
        if (entry.eventType === 'period_start') {
            action = 'Start';
        } else if (entry.eventType === 'paused') {
            action = 'Paused';
        } else if (entry.eventType === 'resumed') {
            action = 'Resumed';
        } else if (entry.eventType === 'period_end') {
            action = 'End';
        }

        let qualSuffix = '';
        if (entry.qualifier === 'score') {
            qualSuffix = ' (Score)';
        } else if (entry.qualifier === 'final') {
            qualSuffix = ' (Final)';
        }

        const eventLabel = `${periodLabel} - ${action}${qualSuffix}`;
        return { periodLabel, action, eventLabel, rawText };
    }

    // Legacy entries without labelVersion 2: preserve existing stored text
    let periodLabel = entry.periodLabel || (entry.period ? getPeriodLabel(entry.period, totalPeriods, basePeriods) : '');
    let action = '';

    if (entry.eventType === 'period_start' || rawText.match(/\bStart\b/i)) {
        action = 'Start';
    } else if (entry.eventType === 'period_end' || rawText.match(/\bEnd\b/i)) {
        action = 'End';
    } else if (entry.eventType === 'paused' || rawText.match(/\bPaused\b/i)) {
        action = 'Paused';
    } else if (entry.eventType === 'resumed' || rawText.match(/\bResumed\b/i)) {
        action = 'Resumed';
    }

    if (!periodLabel) {
        const pMatch = rawText.match(/\b(P\d+|OT\d*)\b/i);
        if (pMatch) periodLabel = pMatch[1].toUpperCase();
    }

    const eventLabel = rawText || ((periodLabel && action) ? `${periodLabel} ${action}` : 'Event');
    return { periodLabel, action, eventLabel, rawText };
}

/**
 * Derives the authoritative match status pill based on specification section 4.3.
 * Evaluates conditions strictly in order:
 * 1. status === 'final' -> Final
 * 2. isPaused === true -> Paused
 * 3. age_ms >= STALL_THRESHOLD_MS -> Stalled
 * 4. timerRunning === false -> Paused
 * 5. otherwise -> Live
 *
 * @param {Object} game
 * @returns {{type: string, text: string, className: string}}
 */
function deriveStatusPill(game) {
    if (!game) {
        return { type: 'final', text: 'Final', className: 'pill-final' };
    }

    const status = (game.status || '').toLowerCase();
    const isPaused = Boolean(game.isPaused);
    const ageMs = (typeof game.ageMs === 'number') ? game.ageMs : ((typeof game.age_ms === 'number') ? game.age_ms : 0);
    const timerRunning = Boolean(game.timerRunning);

    if (status === 'final') {
        return { type: 'final', text: 'Final', className: 'pill-final' };
    }
    if (isPaused) {
        return { type: 'paused', text: 'Paused', className: 'pill-paused' };
    }
    if (ageMs >= STALL_THRESHOLD_MS) {
        return { type: 'stalled', text: 'Stalled', className: 'pill-stalled' };
    }
    if (!timerRunning) {
        return { type: 'paused', text: 'Paused', className: 'pill-paused' };
    }
    return { type: 'live', text: 'Live', className: 'pill-live' };
}

/**
 * Formats a match start time according to section 4.2:
 * Shows the local time (e.g. "7:42 PM") when started today; otherwise shows the local date (e.g. "Sep 28").
 *
 * @param {string|number|Date} dateVal
 * @returns {string}
 */
function formatStartDate(dateVal) {
    if (!dateVal) return '';
    let d = null;
    if (dateVal instanceof Date) {
        d = dateVal;
    } else if (typeof dateVal === 'number') {
        d = new Date(dateVal);
    } else if (typeof dateVal === 'string') {
        if (dateVal.indexOf('T') === -1 && dateVal.indexOf('Z') === -1 && dateVal.includes('-')) {
            d = new Date(dateVal.replace(' ', 'T') + 'Z');
        } else {
            d = new Date(dateVal);
        }
    }
    if (!d || isNaN(d.getTime())) return '';

    const now = new Date();
    const isToday = (
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate()
    );

    if (isToday) {
        return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/**
 * Formats elapsed age in milliseconds into a concise relative representation (e.g. "3m ago").
 *
 * @param {number} ms
 * @returns {string}
 */
function formatAgeMinutes(ms) {
    const totalMinutes = Math.floor(Math.max(0, ms) / 60000);
    if (totalMinutes <= 0) {
        return 'just now';
    }
    return `${totalMinutes}m ago`;
}

/**
 * Renders the 3-column Score History table (Team (Score), Note, Time) newest first.
 * Supports interactive (clickable) mode for the scorer and read-only mode for the spectator Viewer.
 *
 * @param {HTMLElement} tbodyEl
 * @param {Array<Object>} historyList
 * @param {Object} [options={}]
 * @param {boolean} [options.interactive=false]
 * @param {Function} [options.onRowClick]
 * @param {string} [options.homeTeamName='Home']
 * @param {string} [options.awayTeamName='Away']
 * @param {string} [options.homeTeamColor='#ef4444']
 * @param {string} [options.awayTeamColor='#3b82f6']
 * @param {number} [options.totalPeriods=2]
 * @param {number} [options.basePeriods=2]
 */
function renderHistoryRows(tbodyEl, historyList, options = {}) {
    if (!tbodyEl) return;
    tbodyEl.innerHTML = '';

    const items = Array.isArray(historyList) ? historyList : [];
    if (items.length === 0) {
        const emptyRow = document.createElement('tr');
        const emptyTd = document.createElement('td');
        emptyTd.colSpan = 3;
        emptyTd.style.padding = '12px';
        emptyTd.style.textAlign = 'center';
        emptyTd.style.color = '#94a3b8';
        emptyTd.style.fontStyle = 'italic';
        emptyTd.textContent = 'No recorded events yet.';
        emptyRow.appendChild(emptyTd);
        tbodyEl.appendChild(emptyRow);
        return;
    }

    const interactive = Boolean(options.interactive);
    const homeTeamColor = options.homeTeamColor || '#ef4444';
    const awayTeamColor = options.awayTeamColor || '#3b82f6';
    const totalPeriods = options.totalPeriods || 2;
    const basePeriods = options.basePeriods || 2;

    items.forEach((entry, index) => {
        const row = document.createElement('tr');
        row.className = interactive ? 'history-row history-row-interactive' : 'history-row history-row-readonly';

        if (interactive && typeof options.onRowClick === 'function') {
            row.onclick = () => options.onRowClick(index);
        }

        const noteText = entry.note || '';
        const noteDisplay = noteText ? escapeHtml(noteText) : '—';
        const noteTitle = noteText ? escapeHtml(noteText) : (interactive ? 'Tap to add note' : '');

        if (entry.type === 'event') {
            const { eventLabel } = parseEventDetails(entry, totalPeriods, basePeriods);
            const displayTime = formatEventTime(entry.timestamp);
            row.innerHTML = `
                <td style="padding:6px 6px 6px 12px;vertical-align:middle;">
                    <div class="history-team-cell" title="⏱️ ${escapeHtml(eventLabel)}">
                        <span class="history-watch-icon" style="font-size:1.05rem;line-height:1;margin-right:2px;">⏱️</span>
                        <span class="history-event-name" style="font-weight:700;color:#f3f4f6;">${escapeHtml(eventLabel)}</span>
                    </div>
                </td>
                <td style="padding:6px 6px;vertical-align:middle;" class="history-note-cell" title="${noteTitle}">${noteDisplay}</td>
                <td style="padding:6px 12px 6px 6px;text-align:right;vertical-align:middle;" class="history-time-cell" title="${escapeHtml(displayTime)}">${escapeHtml(displayTime)}</td>
            `;
        } else if (entry.type === 'card') {
            const isYellow = (entry.cardType === 'yellow' || (entry.degree && entry.degree.toLowerCase().includes('yellow')));
            const cardSymbol = isYellow ? '🟨' : '🟥';
            const color = entry.teamColor || (entry.teamId === 'home' ? homeTeamColor : awayTeamColor);
            const teamName = entry.teamName || (entry.teamId === 'home' ? (options.homeTeamName || 'Home') : (options.awayTeamName || 'Away'));
            const displayTime = formatGameTimeMmSs(entry);
            row.innerHTML = `
                <td style="padding:6px 6px 6px 12px;vertical-align:middle;">
                    <div class="history-team-cell" title="${cardSymbol} ${escapeHtml(teamName)}">
                        <span class="history-card-icon" style="font-size:1.05rem;line-height:1;margin-right:2px;">${cardSymbol}</span>
                        <span class="history-team-name" style="color:${color};">${escapeHtml(teamName)}</span>
                    </div>
                </td>
                <td style="padding:6px 6px;vertical-align:middle;" class="history-note-cell" title="${noteTitle}">${noteDisplay}</td>
                <td style="padding:6px 12px 6px 6px;text-align:right;vertical-align:middle;" class="history-time-cell" title="${escapeHtml(displayTime)}">${escapeHtml(displayTime)}</td>
            `;
        } else {
            const color = entry.teamColor || (entry.teamId === 'home' ? homeTeamColor : awayTeamColor);
            const teamName = entry.teamName || (entry.teamId === 'home' ? (options.homeTeamName || 'Home') : (options.awayTeamName || 'Away'));
            const displayTime = formatGameTimeMmSs(entry);
            row.innerHTML = `
                <td style="padding:6px 6px 6px 12px;vertical-align:middle;">
                    <div class="history-team-cell" title="${escapeHtml(teamName)} (${entry.currentScore})">
                        <span class="history-goal-icon" style="font-size:1.05rem;line-height:1;margin-right:2px;">🥅</span>
                        <span class="history-team-name" style="color:${color};">${escapeHtml(teamName)}</span>
                        <span class="history-score-tag">(${entry.currentScore !== undefined ? entry.currentScore : ''})</span>
                    </div>
                </td>
                <td style="padding:6px 6px;vertical-align:middle;" class="history-note-cell" title="${noteTitle}">${noteDisplay}</td>
                <td style="padding:6px 12px 6px 6px;text-align:right;vertical-align:middle;" class="history-time-cell" title="${escapeHtml(displayTime)}">${escapeHtml(displayTime)}</td>
            `;
        }

        // Newest event renders at the top of the history list
        tbodyEl.prepend(row);
    });
}

/**
 * Reads the viewing user's selected theme from localStorage or cache, and applies it to the document body.
 * Strictly read-only: performs zero writes to localStorage or SuiteProfile app data to prevent state corruption.
 */
function applySavedThemeReadOnly() {
    let themeName = 'saber-dark';
    try {
        const raw = localStorage.getItem('timerStateV7');
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && parsed.selectedTheme && SCOREBOARD_THEMES[parsed.selectedTheme]) {
                themeName = parsed.selectedTheme;
            }
        }
    } catch (_) {
        // Fall back to default theme
    }

    const theme = SCOREBOARD_THEMES[themeName] || SCOREBOARD_THEMES['saber-dark'];
    document.body.style.backgroundImage = `url("media/bgimages/${theme.image}")`;
    document.body.style.backgroundColor = theme.bgColor;
    document.body.style.backgroundPosition = 'right bottom';
    document.body.style.backgroundAttachment = 'fixed';
    document.body.style.backgroundRepeat = 'no-repeat';
    document.body.style.backgroundSize = 'cover';

    let overlay = document.getElementById('theme-filter-overlay');
    if (theme.filter) {
        document.body.dataset.themeFilter = theme.filter;
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'theme-filter-overlay';
            overlay.style.cssText = [
                'position:fixed', 'inset:0', 'z-index:-1',
                'pointer-events:none',
                `background:url("media/bgimages/${theme.image}") no-repeat right bottom / cover`,
                'background-attachment:fixed'
            ].join(';');
            document.body.appendChild(overlay);
        } else {
            overlay.style.background = `url("media/bgimages/${theme.image}") no-repeat right bottom / cover`;
            overlay.style.backgroundAttachment = 'fixed';
        }
        overlay.style.filter = theme.filter;
        document.body.style.backgroundImage = 'none';
    } else {
        if (overlay) overlay.remove();
        document.body.style.backgroundImage = `url("media/bgimages/${theme.image}")`;
    }
}

/**
 * Normalizes raw match records from either the public list or list_mine into a unified row view model.
 *
 * @param {Object} raw
 * @param {'public'|'mine'} source
 * @returns {Object}
 */
function normalizeRowViewModel(raw, source = 'public') {
    const snap = raw.snapshot || {};
    const gameId = raw.game_id || raw.id;
    const homeName = raw.homeTeamName || raw.home_name || snap.homeTeamName || 'Home';
    const awayName = raw.awayTeamName || raw.away_name || snap.awayTeamName || 'Away';
    const homeScore = (raw.homeScore !== undefined) ? Number(raw.homeScore) : ((raw.home_score !== undefined) ? Number(raw.home_score) : (snap.homeScore || 0));
    const awayScore = (raw.awayScore !== undefined) ? Number(raw.awayScore) : ((raw.away_score !== undefined) ? Number(raw.away_score) : (snap.awayScore || 0));
    const status = (raw.status || snap.status || 'live').toLowerCase();
    const isPaused = (raw.isPaused !== undefined) ? Boolean(raw.isPaused) : ((raw.is_paused !== undefined) ? Boolean(raw.is_paused) : Boolean(snap.isPaused));
    const timerRunning = (raw.timerRunning !== undefined) ? Boolean(raw.timerRunning) : ((raw.timer_running !== undefined) ? Boolean(raw.timer_running) : Boolean(snap.timerRunning));
    const ageMs = (typeof raw.age_ms === 'number') ? raw.age_ms : ((typeof raw.ageMs === 'number') ? raw.ageMs : ((typeof raw.age_seconds === 'number') ? raw.age_seconds * 1000 : 0));
    const visibility = (raw.visibility === 'private' || snap.visibility === 'private') ? 'private' : 'public';
    const startedAt = raw.startedAt || raw.started_at || snap.startedAt;
    const endedAt = raw.endedAt || raw.ended_at || snap.endedAt;

    return {
        id: gameId,
        gameId,
        homeName,
        awayName,
        homeScore,
        awayScore,
        status,
        isPaused,
        timerRunning,
        ageMs,
        visibility,
        startedAt,
        endedAt,
        isOwner: (source === 'mine')
    };
}

// Global namespace exposure for browser environments
if (typeof window !== 'undefined') {
    window.ScoreBoardShared = {
        VERSION: SCOREBOARD_SHARED_VERSION,
        STALL_THRESHOLD_MS,
        SCOREBOARD_THEMES,
        escapeHtml,
        formatTime,
        getPeriodLabel,
        formatGameTimeMmSs,
        formatEventTime,
        parseEventDetails,
        deriveStatusPill,
        formatStartDate,
        formatAgeMinutes,
        renderHistoryRows,
        applySavedThemeReadOnly,
        normalizeRowViewModel
    };
}
