// Unit tests for htdocs/Dominoes/core.js. Run with: node htdocs/Dominoes/tests/core.test.js
const assert = require('assert');
const C = require('../core.js');

let passed = 0;
function test(name, fn) {
    fn();
    passed++;
    console.log('ok - ' + name);
}

test('0|0 scores the configured blank value, other blanks score pips only', () => {
    assert.strictEqual(C.tileScore([0, 0], 30), 30);
    assert.strictEqual(C.tileScore([0, 5], 30), 5);
    assert.strictEqual(C.tileScore([12, 12], 30), 24);
    assert.strictEqual(C.tilesScore([[0, 0], [3, 4], [0, 9]], 25), 25 + 7 + 9);
});

test('engine double counts down by default and up when configured, wrapping', () => {
    const down = C.normalizeSettings({ setMax: 12, direction: 'down' });
    assert.strictEqual(C.roundDouble(down, 0), 12);
    assert.strictEqual(C.roundDouble(down, 12), 0);
    assert.strictEqual(C.roundDouble(down, 13), 12);
    const up = C.normalizeSettings({ setMax: 6, direction: 'up' });
    assert.strictEqual(C.roundDouble(up, 0), 0);
    assert.strictEqual(C.roundDouble(up, 7), 0);
});

test('new game has 13 empty rounds for a double-12 set and is not final', () => {
    const g = C.newGame(['A', 'B', 'C']);
    assert.strictEqual(g.rounds.length, 13);
    assert.strictEqual(C.isFinal(g), false);
    assert.strictEqual(C.firstIncompleteRound(g), 0);
    assert.strictEqual(C.hasScores(g), false);
});

test('totals, ranks (ties share a rank) and sorting', () => {
    const g = C.newGame(['Cy', 'Al', 'Bo']);
    const [cy, al, bo] = g.players;
    C.setScore(g, 0, cy.id, { points: 10 });
    C.setScore(g, 0, al.id, { points: 0 });
    C.setScore(g, 0, bo.id, { points: 10 });
    const t = C.totals(g);
    assert.deepStrictEqual([t[cy.id], t[al.id], t[bo.id]], [10, 0, 10]);
    const r = C.ranks(g);
    assert.deepStrictEqual([r[cy.id], r[al.id], r[bo.id]], [2, 1, 2]);
    assert.deepStrictEqual(C.sortPlayers(g, 'seat').map(p => p.name), ['Cy', 'Al', 'Bo']);
    assert.deepStrictEqual(C.sortPlayers(g, 'name').map(p => p.name), ['Al', 'Bo', 'Cy']);
    assert.deepStrictEqual(C.sortPlayers(g, 'score').map(p => p.name), ['Al', 'Cy', 'Bo']);
});

test('cumulative leaves unscored rounds null and per-round matches entries', () => {
    const g = C.newGame(['A', 'B']);
    const a = g.players[0].id;
    C.setScore(g, 0, a, { points: 5 });
    C.setScore(g, 2, a, { points: 7 });
    const cum = C.cumulative(g)[a];
    assert.deepStrictEqual(cum.slice(0, 4), [5, null, 12, null]);
    assert.deepStrictEqual(C.perRound(g)[a].slice(0, 3), [5, null, 7]);
});

test('rescore updates entries that kept their tiles and leaves typed scores alone', () => {
    const g = C.newGame(['A', 'B']);
    const [a, b] = g.players;
    C.setScore(g, 0, a.id, { points: 33, source: 'scan', tiles: [[0, 0], [1, 2]] });
    C.setScore(g, 0, b.id, { points: 40, source: 'type' });
    g.settings.doubleBlankValue = 50;
    C.rescore(g);
    assert.strictEqual(g.rounds[0].scores[a.id].points, 53);
    assert.strictEqual(g.rounds[0].scores[b.id].points, 40);
});

test('game becomes final when every player has every round, and winners are the lowest total', () => {
    const g = C.newGame(['A', 'B'], { rounds: 2 });
    const [a, b] = g.players;
    [0, 1].forEach(i => {
        C.setScore(g, i, a.id, { points: 4 });
        C.setScore(g, i, b.id, { points: i === 0 ? 0 : 3 });
    });
    assert.strictEqual(C.isFinal(g), true);
    assert.deepStrictEqual(C.winnerIds(g), [b.id]);
    assert.strictEqual(C.historyRecord(g, true).players.find(p => p.name === 'B').winner, true);
});

test('removing a player drops their scores and can leave the game final', () => {
    const g = C.newGame(['A', 'B'], { rounds: 1 });
    const [a, b] = g.players;
    C.setScore(g, 0, a.id, { points: 3 });
    assert.strictEqual(C.isFinal(g), false);
    C.removePlayer(g, b.id);
    assert.strictEqual(C.isFinal(g), true);
    assert.strictEqual(g.players.length, 1);
});

test('ensureRounds grows and shrinks while keeping scores', () => {
    const g = C.newGame(['A']);
    C.setScore(g, 1, g.players[0].id, { points: 8 });
    g.settings.rounds = 20;
    C.ensureRounds(g);
    assert.strictEqual(g.rounds.length, 20);
    g.settings.rounds = 5;
    C.ensureRounds(g);
    assert.strictEqual(g.rounds.length, 5);
    assert.strictEqual(g.rounds[1].scores[g.players[0].id].points, 8);
    assert.strictEqual(C.lastScoredRound(g), 1);
});

test('normalizeGame rejects junk and repairs settings', () => {
    assert.strictEqual(C.normalizeGame(null), null);
    assert.strictEqual(C.normalizeGame({ players: 1, rounds: 2 }), null);
    const g = C.normalizeGame({ players: [{ id: 'x', name: 'Z' }], rounds: [], settings: { setMax: 99, rounds: 3, direction: 'sideways' } });
    assert.strictEqual(g.settings.setMax, 12);
    assert.strictEqual(g.settings.direction, 'down');
    assert.strictEqual(g.rounds.length, 3);
});

test('mergeRemote prefers the newer game and unions history', () => {
    const local = { game: C.newGame(['A']), history: [{ id: 'h1', finishedAt: 1, players: [] }] };
    local.game.updatedAt = 100;
    const remoteGame = JSON.parse(JSON.stringify(local.game));
    remoteGame.updatedAt = 200;
    const merged = C.mergeRemote(local, { game: remoteGame, history: [{ id: 'h2', finishedAt: 5, players: [] }] });
    assert.strictEqual(merged.adopted, true);
    assert.strictEqual(merged.game.updatedAt, 200);
    assert.deepStrictEqual(merged.history.map(h => h.id), ['h2', 'h1']);
    remoteGame.updatedAt = 50;
    assert.strictEqual(C.mergeRemote(local, { game: remoteGame }).adopted, false);
});

test('upsertHistory replaces by id and caps the list', () => {
    let h = [];
    for (let i = 0; i < 40; i++) h = C.upsertHistory(h, { id: 'g' + i, finishedAt: i, players: [] });
    assert.strictEqual(h.length, 30);
    h = C.upsertHistory(h, { id: 'g39', finishedAt: 999, players: [] });
    assert.strictEqual(h.filter(r => r.id === 'g39').length, 1);
    assert.strictEqual(C.removeHistory(h, 'g39').some(r => r.id === 'g39'), false);
});

test('every player gets a distinct preset color, a full table of 10 included', () => {
    const g = C.newGame(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11']);
    assert.strictEqual(g.players.length, 10);
    assert.strictEqual(new Set(g.players.map(p => p.color)).size, 10);
    assert.ok(g.players.every(p => C.isPresetColor(p.color)));
    assert.strictEqual(C.PLAYER_COLORS.length, C.MAX_PLAYERS);
    const names = C.PLAYER_COLORS.map(c => c.name);
    assert.ok(names.includes('Pink') && names.includes('Purple'));
    assert.strictEqual(new Set(C.PLAYER_COLORS.map(c => c.hex)).size, C.PLAYER_COLORS.length);
});

test('a chosen color is kept, duplicates and unknown colors are replaced with free presets', () => {
    const pink = C.PLAYER_COLORS.find(c => c.id === 'pink').hex;
    const g = C.newGame([{ name: 'A', color: pink }, { name: 'B', color: pink }, { name: 'C', color: '#123456' }, 'D']);
    assert.strictEqual(g.players[0].color, pink);
    assert.strictEqual(new Set(g.players.map(p => p.color)).size, 4);
    assert.ok(g.players.every(p => C.isPresetColor(p.color)));
});

test('games saved without colors get the colors seats used to have, in seat order', () => {
    const raw = { id: 'x', players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }], rounds: [{ scores: {} }] };
    const g = C.normalizeGame(raw);
    assert.deepStrictEqual(g.players.map(p => p.color), C.PLAYER_COLORS.slice(0, 3).map(c => c.hex));
    assert.strictEqual(C.freeColor(g.players), C.PLAYER_COLORS[3].hex);
    assert.strictEqual(C.freeColor(C.newGame(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']).players), null);
});

test('colors survive a normalize round trip and a repeated color from the server is fixed', () => {
    const g = C.newGame(['A', 'B']);
    g.players[1].color = g.players[0].color;
    const fixed = C.normalizeGame(JSON.parse(JSON.stringify(g)));
    assert.notStrictEqual(fixed.players[0].color, fixed.players[1].color);
    assert.strictEqual(fixed.players[0].color, g.players[0].color);
});

console.log('\n' + passed + ' tests passed');
