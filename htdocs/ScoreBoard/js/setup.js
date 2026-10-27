/**
 * ScoreBoard setup dialog: New Game, Edit Match and Add Overtime, including the minutes:seconds roller.
 * Holds only the values being edited in the dialog. The console applies them to the game on submit.
 */

import { formatClock } from './format.js';

const byId = (id) => document.getElementById(id);
const ROLLER_ITEM_HEIGHT = 40;
const STANDARD_PRESETS_MS = [720000, 1200000, 2100000, 2400000];
const OVERTIME_DEFAULT_MS = 600000;
const NEW_GAME_PERIODS = 2;
const NEW_GAME_LENGTH_MS = 2400000;

/**
 * @param {{
 *   onSubmit: function({mode: string, home: Object, away: Object, periodCount: number, periodLengthMs: number}): (string|null),
 *   canChangePeriodLength: function(): boolean
 * }} options `onSubmit` returns an error message to keep the dialog open, or null to close it.
 */
export function createSetup({ onSubmit, canChangePeriodLength }) {
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
        durationNote: byId('setup-duration-note')
    };

    let mode = 'create';
    let periodCount = NEW_GAME_PERIODS;
    let periodLengthMs = NEW_GAME_LENGTH_MS;
    let lengthLocked = false;

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
     */
    function open(openMode, game) {
        mode = openMode;
        lengthLocked = openMode === 'edit' && !canChangePeriodLength();

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
        el.modal.classList.add('hidden');
        el.rollerBox.classList.add('hidden');
    }

    function submit() {
        const error = onSubmit({
            mode,
            home: { name: el.homeName.value, color: el.homeColor.value },
            away: { name: el.awayName.value, color: el.awayColor.value },
            periodCount,
            periodLengthMs: lengthLocked ? undefined : periodLengthMs
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

    el.homeColor.addEventListener('change', () => { el.homeSwatch.style.background = el.homeColor.value; });
    el.awayColor.addEventListener('change', () => { el.awaySwatch.style.background = el.awayColor.value; });

    buildRoller();

    return { open, close };
}
