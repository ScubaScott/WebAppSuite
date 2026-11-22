/**
 * ScoreBoard setup dialog: New Game, Edit Match and Add Overtime, including the minutes:seconds roller.
 * Holds only the values being edited in the dialog. The console applies them to the game on submit.
 */

import { formatClock } from './format.js';
import { createThemeSelector } from './theme.js';
import { customThemeKey, parseCustomTheme } from './shared.js';
import { savePhoto, photosSupported } from './custom-photos.js';

const byId = (id) => document.getElementById(id);
const ROLLER_ITEM_HEIGHT = 40;
const STANDARD_PRESETS_MS = [720000, 1200000, 2100000, 2400000];
const OVERTIME_DEFAULT_MS = 600000;
const NEW_GAME_PERIODS = 2;
const NEW_GAME_LENGTH_MS = 2400000;

/**
 * @param {{
 *   onSubmit: function({mode: string, home: Object, away: Object, periodCount: number, periodLengthMs: number, theme: string}): (string|null),
 *   canChangePeriodLength: function(): boolean,
 *   canShare: function(): boolean,
 *   onThemePreview: function(string): void,
 *   onClose: function(): void
 * }} options `onSubmit` returns an error message to keep the dialog open, or null to close it.
 *   `onSubmit` values also carry `visibility` ('public' or 'private').
 *   `canShare` tells whether the sharing toggle is offered (signed-in users only).
 *   `onThemePreview` shows a theme while the dialog is open; `onClose` runs when the dialog closes.
 */
export function createSetup({ onSubmit, canChangePeriodLength, canShare, onThemePreview, onClose }) {
    const el = {
        modal: byId('match-setup-modal'),
        title: byId('match-setup-title'),
        submit: byId('btn-setup-submit'),
        cancel: byId('btn-setup-cancel'),
        closeX: byId('close-match-setup-x'),
        homeName: byId('setup-home-name'),
        homeColor: byId('setup-home-color'),
        homeSwatch: byId('setup-home-color-swatch'),
        awayName: byId('setup-away-name'),
        awayColor: byId('setup-away-color'),
        awaySwatch: byId('setup-away-color-swatch'),
        periodsMinus: byId('btn-period-minus'),
        periodsPlus: byId('btn-period-plus'),
        periodsValue: byId('setup-total-periods-val'),
        presets: byId('setup-duration-presets'),
        customButton: byId('btn-setup-custom-time'),
        rollerBox: byId('setup-roller-container'),
        rollerMinutes: byId('roller-minutes'),
        rollerSeconds: byId('roller-seconds'),
        durationSection: byId('setup-duration-section'),
        durationNote: byId('setup-duration-note'),
        themeSection: byId('setup-theme-section'),
        themeNote: byId('setup-theme-note'),
        customPanel: byId('setup-custom-theme'),
        customColor: byId('setup-custom-color'),
        customTeamColor: byId('btn-custom-team-color'),
        customPhotoBlock: byId('setup-custom-photo-block'),
        customPhotoAdd: byId('btn-custom-photo-add'),
        customPhotoClear: byId('btn-custom-photo-clear'),
        customPhotoInput: byId('setup-custom-photo-input'),
        teamSuggestions: byId('team-suggestions'),
        sharingSection: byId('setup-sharing-section'),
        sharePublic: byId('setup-share-public')
    };

    let mode = 'create';
    let periodCount = NEW_GAME_PERIODS;
    let periodLengthMs = NEW_GAME_LENGTH_MS;
    let lengthLocked = false;
    let theme = null;

    // The theme dropdown lives in this dialog; choosing a theme previews it behind the dialog.
    // A new custom theme starts with our team's color.
    const themeSelector = createThemeSelector({
        getTheme: () => theme,
        setTheme: (chosen) => {
            theme = chosen;
            syncCustomPanel();
            onThemePreview(chosen);
        },
        getSeedColor: () => el.homeColor.value
    });

    // ---- custom theme panel ---------------------------------------------

    /** Show the color and photo controls only while the chosen theme is a custom one. */
    function syncCustomPanel() {
        const custom = parseCustomTheme(theme);
        el.customPanel.classList.toggle('hidden', !custom);
        if (!custom) return;
        el.customColor.value = custom.color;
        // Photos need browser storage; without it only the color is offered
        el.customPhotoBlock.classList.toggle('hidden', !photosSupported());
        el.customPhotoAdd.textContent = custom.photoId ? 'Change photo' : 'Add photo';
        el.customPhotoClear.classList.toggle('hidden', !custom.photoId);
    }

    /** Make the theme a custom one with this color and (optional) photo, and preview it. */
    function setCustomTheme(color, photoId) {
        const key = customThemeKey(color, photoId);
        if (!key) return;
        theme = key;
        syncCustomPanel();
        themeSelector.update();
        onThemePreview(theme);
    }

    /** The photo id of the current custom theme, or null. */
    function currentPhotoId() {
        const custom = parseCustomTheme(theme);
        return custom ? custom.photoId : null;
    }

    /** Store the picture the user chose and use it as the background. */
    async function addPhoto(file) {
        const custom = parseCustomTheme(theme);
        const color = custom ? custom.color : el.customColor.value;
        try {
            const saved = await savePhoto(file, color);
            setCustomTheme(color, saved.id);
            themeSelector.render();
        } catch (error) {
            SuiteDialog.alert(error.message, { title: 'Photo not added' });
        }
    }

    // ---- roller ---------------------------------------------------------

    const isOpen = () => !el.modal.classList.contains('hidden');
    const rollerVisible = () => !el.rollerBox.classList.contains('hidden');

    /** Index of the item centered in a roller column. */
    function rollerIndex(column, max) {
        if (!column || column.clientHeight === 0) {
            const totalSeconds = Math.max(0, Math.floor(periodLengthMs / 1000));
            return column === el.rollerMinutes ? Math.min(99, Math.floor(totalSeconds / 60)) : Math.min(59, totalSeconds % 60);
        }
        return Math.min(max, Math.max(0, Math.round(column.scrollTop / ROLLER_ITEM_HEIGHT)));
    }

    /** Highlight the centered items and, while the roller is in use, take its value as the period length. */
    function updateRoller() {
        const minute = rollerIndex(el.rollerMinutes, 99);
        const second = rollerIndex(el.rollerSeconds, 59);
        [[el.rollerMinutes, minute], [el.rollerSeconds, second]].forEach(([column, active]) => {
            Array.from(column.children).forEach((item, i) => item.classList.toggle('roller-item-active', i === active));
        });
        if (isOpen() && rollerVisible() && el.rollerMinutes.clientHeight > 0) {
            periodLengthMs = (minute * 60 + second) * 1000;
            updatePresetButtons();
        }
    }

    function scrollRollerTo(type, index, smooth = true) {
        const column = type === 'minutes' ? el.rollerMinutes : el.rollerSeconds;
        const max = type === 'minutes' ? 99 : 59;
        column.scrollTo({ top: Math.min(max, Math.max(0, index)) * ROLLER_ITEM_HEIGHT, behavior: smooth ? 'smooth' : 'auto' });
    }

    function setRoller(ms, smooth = false) {
        const totalSeconds = Math.max(0, Math.floor(ms / 1000));
        scrollRollerTo('minutes', Math.min(99, Math.floor(totalSeconds / 60)), smooth);
        scrollRollerTo('seconds', Math.min(59, totalSeconds % 60), smooth);
        updateRoller();
    }

    function stepRoller(type, delta) {
        const column = type === 'minutes' ? el.rollerMinutes : el.rollerSeconds;
        const max = type === 'minutes' ? 99 : 59;
        scrollRollerTo(type, rollerIndex(column, max) + delta, true);
    }

    /** Mouse drag, wheel and snapping for one roller column. */
    function bindRollerColumn(column, max) {
        let dragging = false;
        let startY = 0;
        let startScroll = 0;
        let snapTimer = null;
        const snap = () => column.scrollTo({ top: Math.round(column.scrollTop / ROLLER_ITEM_HEIGHT) * ROLLER_ITEM_HEIGHT, behavior: 'smooth' });

        column.addEventListener('mousedown', (event) => {
            dragging = true;
            startY = event.pageY;
            startScroll = column.scrollTop;
            column.classList.add('roller-dragging');
        });
        window.addEventListener('mousemove', (event) => {
            if (dragging) column.scrollTop = startScroll - (event.pageY - startY);
        });
        window.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            column.classList.remove('roller-dragging');
            snap();
        });
        column.addEventListener('wheel', (event) => {
            event.preventDefault();
            const next = Math.min(max, Math.max(0, rollerIndex(column, max) + Math.sign(event.deltaY)));
            column.scrollTo({ top: next * ROLLER_ITEM_HEIGHT, behavior: 'smooth' });
        }, { passive: false });
        column.addEventListener('scroll', () => {
            updateRoller();
            clearTimeout(snapTimer);
            snapTimer = setTimeout(() => {
                const nearest = Math.round(column.scrollTop / ROLLER_ITEM_HEIGHT) * ROLLER_ITEM_HEIGHT;
                if (Math.abs(column.scrollTop - nearest) > 1) snap();
            }, 150);
        });
    }

    /** Fill the two columns with their numbers and attach the interaction handlers. */
    function buildRoller() {
        [['minutes', el.rollerMinutes, 99], ['seconds', el.rollerSeconds, 59]].forEach(([type, column, max]) => {
            column.innerHTML = '';
            for (let value = 0; value <= max; value++) {
                const item = document.createElement('div');
                item.className = 'roller-item';
                item.textContent = String(value).padStart(2, '0');
                item.addEventListener('click', () => scrollRollerTo(type, value, true));
                column.appendChild(item);
            }
            bindRollerColumn(column, max);
        });
        setRoller(periodLengthMs, false);
    }

    // ---- duration presets -------------------------------------------------

    /** Highlight the preset matching the length, or label the custom button with it. */
    function updatePresetButtons() {
        let matched = false;
        el.presets.querySelectorAll('.duration-preset-btn').forEach((button) => {
            const isMatch = Number(button.dataset.ms) === periodLengthMs;
            button.classList.toggle('active', isMatch);
            matched = matched || isMatch;
        });
        const arrow = rollerVisible() ? '▴' : '▾';
        el.customButton.textContent = matched
            ? `Custom Duration (Roller) ${arrow}`
            : `Custom: ${formatClock(periodLengthMs).replace(/\.0$/, '')} ${arrow}`;
    }

    // ---- dialog -----------------------------------------------------------

    /**
     * Open the dialog.
     * @param {'create'|'edit'|'overtime'} openMode
     * @param {Object} game The current game, used for the starting values.
     * @param {string} defaultTheme The theme offered when the game has none (the operator's last choice).
     */
    function open(openMode, game, defaultTheme) {
        mode = openMode;
        lengthLocked = openMode === 'edit' && !canChangePeriodLength();
        theme = openMode === 'create' ? defaultTheme : (game.theme || defaultTheme);
        // Overtime keeps the game's theme; after the first Start the theme can no longer change
        const themeLocked = openMode === 'overtime' || (openMode === 'edit' && game.startedAt !== null);
        el.themeSection.classList.toggle('hidden', openMode === 'overtime');
        el.themeNote.classList.toggle('hidden', !(openMode === 'edit' && themeLocked));
        el.themeSection.classList.toggle('is-locked', themeLocked);
        syncCustomPanel();
        themeSelector.render();
        themeSelector.discover();

        // Sharing belongs to the game: a new game starts public, an existing one shows its own setting
        el.sharingSection.classList.toggle('hidden', openMode === 'overtime' || !canShare());
        el.sharePublic.checked = openMode === 'create' ? true : game.visibility !== 'private';

        if (mode === 'create') {
            el.title.textContent = 'New Game Setup';
            el.submit.textContent = 'Ready';
            periodCount = NEW_GAME_PERIODS;
            periodLengthMs = NEW_GAME_LENGTH_MS;
        } else if (mode === 'overtime') {
            el.title.textContent = 'Add Overtime / Extra Period';
            el.submit.textContent = 'Add Overtime';
            periodCount = Math.max(game.periodCount + 1, game.regulationPeriods + 1);
            periodLengthMs = OVERTIME_DEFAULT_MS;
        } else {
            el.title.textContent = 'Edit Match Details';
            el.submit.textContent = 'Save Changes';
            periodCount = game.periodCount;
            periodLengthMs = game.periodLengthMs;
        }

        el.homeName.value = game.home.name;
        el.homeColor.value = game.home.color;
        el.homeSwatch.style.background = game.home.color;
        el.awayName.value = game.away.name;
        el.awayColor.value = game.away.color;
        el.awaySwatch.style.background = game.away.color;
        el.periodsValue.textContent = periodCount;

        // The length of a period that has started cannot change; say so instead of ignoring the edit
        el.durationSection.classList.toggle('hidden', lengthLocked);
        el.durationNote.classList.toggle('hidden', !lengthLocked);

        el.rollerBox.classList.toggle('hidden', STANDARD_PRESETS_MS.includes(periodLengthMs));
        updatePresetButtons();
        el.modal.classList.remove('hidden');
        requestAnimationFrame(() => setRoller(periodLengthMs, false));
    }

    function close() {
        themeSelector.close();
        el.modal.classList.add('hidden');
        el.rollerBox.classList.add('hidden');
        onClose();
    }

    function submit() {
        const error = onSubmit({
            mode,
            home: { name: el.homeName.value, color: el.homeColor.value },
            away: { name: el.awayName.value, color: el.awayColor.value },
            periodCount,
            periodLengthMs: lengthLocked ? undefined : periodLengthMs,
            theme,
            visibility: el.sharePublic.checked ? 'public' : 'private'
        });
        if (!error) close();
        return error;
    }

    // ---- wiring -----------------------------------------------------------

    el.submit.addEventListener('click', submit);
    el.cancel.addEventListener('click', close);
    el.closeX.addEventListener('click', close);

    el.periodsMinus.addEventListener('click', () => {
        if (mode !== 'overtime' && periodCount > 1) {
            periodCount -= 1;
            el.periodsValue.textContent = periodCount;
        }
    });
    el.periodsPlus.addEventListener('click', () => {
        if (mode !== 'overtime' && periodCount < 8) {
            periodCount += 1;
            el.periodsValue.textContent = periodCount;
        }
    });

    el.presets.querySelectorAll('.duration-preset-btn').forEach((button) => {
        button.addEventListener('click', () => {
            const ms = Number(button.dataset.ms);
            if (ms <= 0) return;
            periodLengthMs = ms;
            el.rollerBox.classList.add('hidden');
            updatePresetButtons();
            setRoller(ms, true);
        });
    });
    el.customButton.addEventListener('click', () => {
        el.rollerBox.classList.toggle('hidden');
        updatePresetButtons();
        if (rollerVisible()) requestAnimationFrame(() => setRoller(periodLengthMs, false));
    });

    // The "+" and "-" buttons above and below the roller wheels
    document.querySelectorAll('[data-roller-step]').forEach((button) => {
        button.addEventListener('click', () => stepRoller(button.dataset.rollerUnit, Number(button.dataset.rollerStep)));
    });

    // Custom theme controls: the color previews live as it is dragged
    el.customColor.addEventListener('input', () => setCustomTheme(el.customColor.value, currentPhotoId()));
    el.customTeamColor.addEventListener('click', () => setCustomTheme(el.homeColor.value, currentPhotoId()));
    el.customPhotoAdd.addEventListener('click', () => el.customPhotoInput.click());
    el.customPhotoClear.addEventListener('click', () => setCustomTheme(el.customColor.value, null));
    el.customPhotoInput.addEventListener('change', () => {
        const file = el.customPhotoInput.files && el.customPhotoInput.files[0];
        // Clear the input so choosing the same picture again still fires a change
        el.customPhotoInput.value = '';
        if (file) addPhoto(file);
    });

    el.homeColor.addEventListener('change', () => { el.homeSwatch.style.background = el.homeColor.value; });
    el.awayColor.addEventListener('change', () => { el.awaySwatch.style.background = el.awayColor.value; });

    buildRoller();

    /** Offer the user's past team names while typing our team's name. */
    function setTeamSuggestions(names) {
        el.teamSuggestions.textContent = '';
        names.forEach((name) => {
            const option = document.createElement('option');
            option.value = name;
            el.teamSuggestions.appendChild(option);
        });
    }

    return { open, close, setTeamSuggestions, discoverThemes: themeSelector.discover };
}
