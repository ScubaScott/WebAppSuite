/**
 * ScoreBoard local storage: the saved game and the operator preferences.
 * The storage object is passed in (localStorage in the page, a fake in tests), and every access is guarded
 * because storage can be blocked or full.
 */

import { migrateGame } from './migrate.js';

export const GAME_KEY = 'scoreboardGameV8';
export const PREFS_KEY = 'scoreboardPrefsV1';

/** Keys written by earlier versions; read once by the migration, then removed. */
export const LEGACY_KEYS = [
    'timerStateV7',
    'scoreBoardCurrentGameIdV1',
    'scoreBoardCurrentGameWriteTokenV1',
    'scoreKeeperCurrentGameIdV1',
    'scoreBoardActiveGamesV1',
    'scoreKeeperActiveGamesV1'
];
const LEGACY_GAME_KEY = 'timerStateV7';

/** Preferences with their defaults. */
export function defaultPrefs() {
    return {
        theme: 'saber-dark',
        muted: false,
        pauseOnScore: false,
        logPauseResume: false,
        logPeriodStartStop: true,
        splashHome: true,
        splashAway: true,
        showCards: false,
        savedAt: 0
    };
}

/**
 * Normalize a stored preferences object. Accepts the current field names and the names used inside
 * records saved by earlier versions. Returns null when the object holds no preferences.
 */
export function normalizePrefs(source) {
    if (!source || typeof source !== 'object') return null;
    const names = ['theme', 'selectedTheme', 'muted', 'pauseOnScore', 'logPauseResume', 'logPeriodStartStop',
        'splashHome', 'splashOnHome', 'splashAway', 'splashOnAway', 'showCards', 'showPenaltyCards'];
    if (!names.some((name) => source[name] !== undefined)) return null;
    const defaults = defaultPrefs();
    const flag = (current, old, fallback) => {
        const value = source[current] !== undefined ? source[current] : source[old];
        return value !== undefined ? !!value : fallback;
    };
    return {
        theme: source.theme || source.selectedTheme || defaults.theme,
        muted: !!source.muted,
        pauseOnScore: !!source.pauseOnScore,
        logPauseResume: !!source.logPauseResume,
        logPeriodStartStop: source.logPeriodStartStop !== undefined ? !!source.logPeriodStartStop : defaults.logPeriodStartStop,
        splashHome: flag('splashHome', 'splashOnHome', defaults.splashHome),
        splashAway: flag('splashAway', 'splashOnAway', defaults.splashAway),
        showCards: flag('showCards', 'showPenaltyCards', defaults.showCards),
        savedAt: source.savedAt || source.lastSavedAt || 0
    };
}

/**
 * @param {{getItem: function, setItem: function, removeItem: function}} backend Usually localStorage.
 * @param {function(): string} newId Supplies ids for entries the migration builds.
 */
export function createStorage(backend, newId) {
    function read(key) {
        try {
            const raw = backend.getItem(key);
            return raw ? JSON.parse(raw) : null;
        } catch (error) {
            return null;
        }
    }

    function write(key, value) {
        try {
            backend.setItem(key, JSON.stringify(value));
            return true;
        } catch (error) {
            return false;
        }
    }

    return {
        /**
         * The saved game: the current record, otherwise the record written by earlier versions (converted).
         * @returns {{game: Object, converted: boolean}|null}
         */
        loadGame(now, theme) {
            const raw = read(GAME_KEY) || read(LEGACY_GAME_KEY);
            if (!raw) return null;
            return migrateGame(raw, { newId, now, theme });
        },

        /** Save the game. Returns false when storage refused it. */
        saveGame(game) {
            return write(GAME_KEY, game);
        },

        /** Preferences saved on this device, including any inside a record from an earlier version. */
        loadPrefs() {
            return normalizePrefs(read(PREFS_KEY)) || normalizePrefs(read(LEGACY_GAME_KEY));
        },

        savePrefs(prefs) {
            return write(PREFS_KEY, prefs);
        },

        /** True when preferences have been saved on this device. */
        hasPrefs() {
            return read(PREFS_KEY) !== null;
        },

        /** Normalize preferences that came from elsewhere (for example the profile). */
        normalize: normalizePrefs,

        /** Remove the records of earlier versions, but only once the current game record can be read back. */
        removeLegacy() {
            const current = read(GAME_KEY);
            if (!current || !Array.isArray(current.events)) return false;
            LEGACY_KEYS.forEach((key) => {
                try { backend.removeItem(key); } catch (error) { /* storage unavailable */ }
            });
            return true;
        }
    };
}
