// Tests for js/storage.js with a fake storage backend.
// Run from htdocs/ScoreBoard: node --test tests/storage.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStorage, normalizePrefs, defaultPrefs, GAME_KEY, PREFS_KEY, LEGACY_KEYS } from '../js/storage.js';
import { STATUS } from '../js/state.js';

const fixture = (name) => readFileSync(new URL(`../docs/${name}`, import.meta.url), 'utf8');
let counter = 0;
const newId = () => `st${++counter}`;

function fakeBackend(initial = {}, { failWrites = false } = {}) {
    const data = { ...initial };
    return {
        data,
        getItem: (key) => (key in data ? data[key] : null),
        setItem: (key, value) => { if (failWrites) throw new Error('quota'); data[key] = String(value); },
        removeItem: (key) => { delete data[key]; }
    };
}

test('a record from an earlier version is converted when loaded', () => {
    const backend = fakeBackend({ timerStateV7: fixture('timerStateV7_Running.json') });
    const result = createStorage(backend, newId).loadGame(Date.now());
    assert.equal(result.converted, true);
    assert.equal(result.game.status, STATUS.RUNNING);
});

test('the earlier record is removed only after the current record exists', () => {
    const backend = fakeBackend({ timerStateV7: fixture('timerStateV7_Running.json'), scoreBoardCurrentGameIdV1: 'x' });
    const storage = createStorage(backend, newId);
    const { game } = storage.loadGame(Date.now());
    assert.equal(storage.removeLegacy(), false);
    assert.ok('timerStateV7' in backend.data);
    storage.saveGame(game);
    assert.equal(storage.removeLegacy(), true);
    LEGACY_KEYS.forEach((key) => assert.equal(key in backend.data, false, key));
    // The saved game now loads without conversion
    assert.equal(storage.loadGame(Date.now()).converted, false);
});

test('a write that storage refuses reports failure and keeps the earlier record', () => {
    const backend = fakeBackend({ timerStateV7: fixture('timerStateV7_Running.json') }, { failWrites: true });
    const storage = createStorage(backend, newId);
    const { game } = storage.loadGame(Date.now());
    assert.equal(storage.saveGame(game), false);
    assert.equal(storage.removeLegacy(), false);
    assert.ok('timerStateV7' in backend.data);
});

test('missing or unreadable data loads as nothing', () => {
    assert.equal(createStorage(fakeBackend(), newId).loadGame(0), null);
    assert.equal(createStorage(fakeBackend({ [GAME_KEY]: '{not json' }), newId).loadGame(0), null);
});

test('preferences load from the current key, else from the earlier record', () => {
    const fromRecord = createStorage(fakeBackend({ timerStateV7: fixture('timerStateV7_Running.json') }), newId).loadPrefs();
    assert.equal(fromRecord.theme, 'EdenPrarie.png');
    assert.equal(fromRecord.muted, true);
    assert.equal(fromRecord.showCards, true);
    assert.equal(fromRecord.splashHome, true);
    const stored = { ...defaultPrefs(), theme: 'chill-ice', savedAt: 5 };
    const backend = fakeBackend({ [PREFS_KEY]: JSON.stringify(stored), timerStateV7: fixture('timerStateV7_Running.json') });
    assert.equal(createStorage(backend, newId).loadPrefs().theme, 'chill-ice');
});

test('normalizing preferences understands both naming styles and fills defaults', () => {
    assert.equal(normalizePrefs(null), null);
    assert.equal(normalizePrefs({ homeScore: 1 }), null);
    const old = normalizePrefs({ selectedTheme: 'saber-dark', splashOnHome: false, showPenaltyCards: true, lastSavedAt: 9 });
    assert.equal(old.splashHome, false);
    assert.equal(old.splashAway, true);
    assert.equal(old.showCards, true);
    assert.equal(old.logPeriodStartStop, true);
    assert.equal(old.savedAt, 9);
});
