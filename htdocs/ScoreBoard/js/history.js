/**
 * ScoreBoard history entry dialog: add a note, share, or remove one entry of the history.
 */

import { formatEventTime, formatGameTimeMmSs, parseEventDetails } from './shared.js';

const byId = (id) => document.getElementById(id);
const NOTE_MAX = 60;

/** One-line preview content: an icon and a text. */
function setPreview(element, icon, text) {
    element.textContent = '';
    const iconSpan = document.createElement('span');
    iconSpan.className = 'history-preview-icon';
    iconSpan.textContent = icon;
    const textSpan = document.createElement('span');
    textSpan.textContent = text;
    element.append(iconSpan, textSpan);
}

/**
 * @param {Object} options
 * @param {function(): Object} options.getGame Current game.
 * @param {function(): Array<Object>} options.getRows The history rows currently drawn (viewer shape).
 * @param {function(string, string): void} options.saveNote Store a note for an entry id.
 * @param {function(string): void} options.removeEntry Remove an entry id (the console reports any problem).
 * @param {function(string): void} options.share Share a text.
 */
export function createHistoryDialog({ getGame, getRows, saveNote, removeEntry, share }) {
    const el = {
        modal: byId('history-options-modal'),
        actions: byId('history-actions-menu'),
        editor: byId('history-note-editor'),
        input: byId('history-note-input'),
        counter: byId('history-note-counter'),
        previewEvent: byId('history-preview-event'),
        previewMeta: byId('history-preview-meta'),
        previewNote: byId('history-preview-note'),
        noteButtonText: byId('history-note-btn-text')
    };
    let activeId = null;

    const activeRow = () => getRows().find((row) => row.id === activeId) || null;

    function close() {
        el.modal.classList.add('hidden');
        activeId = null;
    }

    function open(id) {
        activeId = id;
        const row = activeRow();
        if (!row) {
            activeId = null;
            return;
        }
        const game = getGame();
        if (row.type === 'score') {
            setPreview(el.previewEvent, '🥅', `${row.teamName} (${row.currentScore})`);
            el.previewMeta.textContent = `Time: ${formatGameTimeMmSs(row) || 'N/A'}`;
        } else if (row.type === 'card') {
            setPreview(el.previewEvent, row.cardType === 'yellow' ? '🟨' : '🟥', row.teamName);
            el.previewMeta.textContent = `Time: ${formatGameTimeMmSs(row) || 'N/A'}`;
        } else {
            const { eventLabel } = parseEventDetails(row, game.periodCount, game.regulationPeriods);
            setPreview(el.previewEvent, '⏱️', eventLabel);
            const clockTime = formatEventTime(row.timestamp) || 'N/A';
            if (typeof row.positionMs === 'number') {
                // Position in the period, then the time of day it happened
                el.previewMeta.textContent = `Time: ${formatGameTimeMmSs({ periodElapsedMs: row.positionMs })} (${clockTime})`;
            } else if (row.adjustedMs) {
                el.previewMeta.textContent = `Time: ${clockTime} (pressed at ${formatEventTime(row.recordedTimestamp)})`;
            } else {
                el.previewMeta.textContent = `Time: ${clockTime}`;
            }
        }

        if (row.note) {
            el.previewNote.textContent = `Note: "${row.note}"`;
            el.previewNote.classList.remove('hidden');
            el.noteButtonText.textContent = 'Edit Note';
        } else {
            el.previewNote.textContent = '';
            el.previewNote.classList.add('hidden');
            el.noteButtonText.textContent = 'Add Note';
        }

        el.actions.classList.remove('hidden');
        el.editor.classList.add('hidden');
        el.modal.classList.remove('hidden');
    }

    function showNoteEditor() {
        const row = activeRow();
        if (!row) return;
        const note = row.note || '';
        el.input.value = note;
        el.counter.textContent = `${note.length} / ${NOTE_MAX}`;
        el.actions.classList.add('hidden');
        el.editor.classList.remove('hidden');
        el.input.focus();
    }

    function cancelNote() {
        el.editor.classList.add('hidden');
        el.actions.classList.remove('hidden');
    }

    function saveCurrentNote() {
        if (!activeRow()) return;
        saveNote(activeId, el.input.value.trim());
        close();
    }

    /** Ask for confirmation, then remove. Cancelling keeps this dialog open. */
    function removeCurrent() {
        const row = activeRow();
        if (!row) return;
        let message = 'Remove this entry from the history?';
        if (row.type === 'score') {
            message = 'Remove this goal? The score will go down by 1.';
        } else if (row.eventType === 'period_end') {
            message = 'Remove this period end? The game returns to that period.';
        } else if (row.eventType === 'clock_adjust') {
            message = 'Remove this clock correction? Times in this period move back.';
        }
        if (!window.confirm(message)) return;
        const id = activeId;
        close();
        removeEntry(id);
    }

    /** The text shared for an entry. */
    function shareText(row, game) {
        if (row.type === 'score') return `GOAL! ${row.teamName} ${row.currentScore}`;
        if (row.type === 'card') {
            const note = row.note ? ` (${row.note})` : '';
            return `${row.cardType === 'yellow' ? '🟨' : '🟥'} ${row.teamName}${note}`;
        }
        const { action, eventLabel, periodLabel } = parseEventDetails(row, game.periodCount, game.regulationPeriods);
        const note = row.note ? ` (${row.note})` : '';
        const isGameStart = (action === 'Start' && periodLabel === 'P1')
            || (row.eventType === 'period_start' && Number(row.period || 1) === 1);
        if (isGameStart) {
            return `Game on! ${game.home.name.trim()} vs. ${game.away.name.trim()}${note}`;
        }
        const time = formatEventTime(row.timestamp);
        const isPeriodEnd = row.eventType === 'period_end';
        const score = isPeriodEnd ? ` (${row.scoreSnapshot})` : '';
        return `${eventLabel}${time ? ` ${time}` : ''}${score}${note}`;
    }

    function shareCurrent() {
        const row = activeRow();
        if (!row) return;
        const text = shareText(row, getGame());
        close();
        share(text);
    }

    byId('history-close-btn').addEventListener('click', close);
    byId('history-note-btn').addEventListener('click', showNoteEditor);
    byId('history-share-btn').addEventListener('click', shareCurrent);
    byId('history-remove-btn').addEventListener('click', removeCurrent);
    byId('history-note-cancel-btn').addEventListener('click', cancelNote);
    byId('history-note-save-btn').addEventListener('click', saveCurrentNote);
    el.input.addEventListener('input', () => { el.counter.textContent = `${el.input.value.length} / ${NOTE_MAX}`; });
    el.input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            saveCurrentNote();
        }
    });
    el.modal.addEventListener('click', (event) => {
        if (event.target === el.modal) close();
    });

    return { open, close };
}
