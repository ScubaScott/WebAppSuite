// Dominoes scoring core: pure game-state functions with no DOM access.
// Used by app.js in the browser and by tests/core.test.js in Node.
const DOMINO_CORE_VERSION = "1.1";

const DominoCore = (() => {
    // Values a new game starts with; the user can change all of them in Settings
    const DEFAULT_SETTINGS = Object.freeze({
        setMax: 12,             // highest pip count on one half (double-12 set)
        rounds: 13,             // number of rounds in a game (setMax + 1 for a full set)
        direction: 'down',      // 'down': engine double counts down from setMax; 'up': counts up from 0
        doubleBlankValue: 30,   // points for the 0|0 tile
        tileColor: 'auto'       // scanner polarity: 'auto', 'light' or 'dark'
    });
    const SET_MAXES = [6, 9, 12, 15];
    const MAX_PLAYERS = 10;
    const MAX_ROUNDS = 40;
    const MAX_HISTORY = 30;

    // Player colors: one preset per player, so no two players in a game share a color. The list is as long as the
    // largest game (MAX_PLAYERS), so every player can always have a color of their own.
    const PLAYER_COLORS = Object.freeze([
        { id: 'blue', name: 'Blue', hex: '#4da3ff' },
        { id: 'amber', name: 'Amber', hex: '#ffb000' },
        { id: 'green', name: 'Green', hex: '#2ecc9a' },
        { id: 'pink', name: 'Pink', hex: '#ff6f91' },
        { id: 'purple', name: 'Purple', hex: '#b388ff' },
        { id: 'orange', name: 'Orange', hex: '#ff7a2f' },
        { id: 'yellow', name: 'Yellow', hex: '#e6e64d' },
        { id: 'cyan', name: 'Cyan', hex: '#4dd8ff' },
        { id: 'lime', name: 'Lime', hex: '#a3e635' },
        { id: 'red', name: 'Red', hex: '#ff4d4d' }
    ]);

    // True when value is the hex of one of the preset colors
    function isPresetColor(value) {
        return PLAYER_COLORS.some(c => c.hex === value);
    }

    // The first preset hex that no player in the list uses; null when every preset is taken
    function freeColor(players) {
        const used = new Set(players.map(p => p.color));
        const free = PLAYER_COLORS.find(c => !used.has(c.hex));
        return free ? free.hex : null;
    }

    // Gives every player a preset color that no earlier player has. A player keeps the color they have when it is a
    // preset nobody before them uses; anyone else (no color, an unknown color, a repeat) gets the first free preset,
    // so games saved before colors existed come out in the order their seats used to be colored. Changes the players in place.
    function ensureColors(players) {
        const taken = new Set();
        players.forEach(p => {
            if (isPresetColor(p.color) && !taken.has(p.color)) taken.add(p.color);
            else p.color = null;
        });
        players.forEach(p => {
            if (p.color) return;
            const free = PLAYER_COLORS.find(c => !taken.has(c.hex));
            p.color = free ? free.hex : PLAYER_COLORS[0].hex;
            taken.add(p.color);
        });
        return players;
    }

    // Returns a unique id; falls back to a random string where crypto.randomUUID is unavailable (non-secure contexts)
    function uuid() {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
        return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }

    // Converts any value to an integer clamped to [min, max]; non-numbers become min
    function clampInt(value, min, max) {
        const n = Math.round(Number(value));
        if (!Number.isFinite(n)) return min;
        return Math.min(max, Math.max(min, n));
    }

    // Fills in missing or invalid settings fields so every consumer can trust the shape
    function normalizeSettings(raw) {
        const s = Object.assign({}, DEFAULT_SETTINGS, raw || {});
        s.setMax = SET_MAXES.includes(Number(s.setMax)) ? Number(s.setMax) : DEFAULT_SETTINGS.setMax;
        s.rounds = clampInt(s.rounds, 1, MAX_ROUNDS);
        s.direction = s.direction === 'up' ? 'up' : 'down';
        s.doubleBlankValue = clampInt(s.doubleBlankValue, 0, 999);
        s.tileColor = ['auto', 'light', 'dark'].includes(s.tileColor) ? s.tileColor : 'auto';
        return s;
    }

    // Resizes game.rounds to settings.rounds, keeping existing scores
    function ensureRounds(game) {
        game.settings = normalizeSettings(game.settings);
        while (game.rounds.length < game.settings.rounds) game.rounds.push({ scores: {} });
        game.rounds.length = game.settings.rounds;
    }

    // Creates a new game. players is a list of names or of { name, color } (colors are kept when they are valid presets)
    function newGame(names, settings) {
        const list = names && names.length ? names : ['Player 1', 'Player 2'];
        const game = {
            id: uuid(),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            settings: normalizeSettings(settings),
            players: list.slice(0, MAX_PLAYERS).map(entry => ({ id: uuid(), name: typeof entry === 'string' ? entry : entry.name, color: typeof entry === 'string' ? null : entry.color })),
            rounds: []
        };
        ensureColors(game.players);
        ensureRounds(game);
        return game;
    }

    // Validates a game loaded from storage or the server; returns a safe game object or null
    function normalizeGame(raw) {
        if (!raw || typeof raw !== 'object' || !Array.isArray(raw.players) || !Array.isArray(raw.rounds)) return null;
        const game = {
            id: typeof raw.id === 'string' ? raw.id : uuid(),
            createdAt: Number(raw.createdAt) || Date.now(),
            updatedAt: Number(raw.updatedAt) || 0,
            settings: normalizeSettings(raw.settings),
            players: raw.players
                .filter(p => p && typeof p.id === 'string')
                .slice(0, MAX_PLAYERS)
                .map(p => ({ id: p.id, name: String(p.name || 'Player').slice(0, 20), color: p.color })),
            rounds: raw.rounds.map(r => ({ scores: (r && typeof r.scores === 'object' && r.scores) || {} }))
        };
        ensureColors(game.players);
        ensureRounds(game);
        return game;
    }

    // Points for one tile [a, b]: pip total, except the double-blank which scores the configured value
    function tileScore(tile, blankValue) {
        const a = tile[0] | 0;
        const b = tile[1] | 0;
        return (a === 0 && b === 0) ? blankValue : a + b;
    }

    // Points for a hand of tiles
    function tilesScore(tiles, blankValue) {
        return tiles.reduce((sum, t) => sum + tileScore(t, blankValue), 0);
    }

    // The engine double for a round: counts down from setMax (or up from 0) and wraps around
    function roundDouble(settings, index) {
        const size = settings.setMax + 1;
        const raw = settings.direction === 'up' ? index : settings.setMax - index;
        return ((raw % size) + size) % size;
    }

    // Records a player's score for a round; entry is { points, source, tiles? }
    function setScore(game, roundIndex, playerId, entry) {
        const round = game.rounds[roundIndex];
        if (!round) return;
        round.scores[playerId] = {
            points: clampInt(entry.points, 0, 9999),
            source: entry.source || 'type',
            tiles: entry.tiles || undefined
        };
        game.updatedAt = Date.now();
    }

    // Removes a player's score for a round
    function clearScore(game, roundIndex, playerId) {
        const round = game.rounds[roundIndex];
        if (round) delete round.scores[playerId];
        game.updatedAt = Date.now();
    }

    // Removes a player and all of their scores
    function removePlayer(game, playerId) {
        game.players = game.players.filter(p => p.id !== playerId);
        game.rounds.forEach(r => { delete r.scores[playerId]; });
    }

    // Recomputes points for entries that kept their tiles (after the 0|0 value changes)
    function rescore(game) {
        const blank = game.settings.doubleBlankValue;
        game.rounds.forEach(r => {
            Object.values(r.scores).forEach(entry => {
                if (entry.tiles) entry.points = tilesScore(entry.tiles, blank);
            });
        });
    }

    // Index of the last round that has any score, or -1
    function lastScoredRound(game) {
        for (let i = game.rounds.length - 1; i >= 0; i--) {
            if (Object.keys(game.rounds[i].scores).length > 0) return i;
        }
        return -1;
    }

    // True when every player has a score in the round
    function isRoundComplete(game, index) {
        const round = game.rounds[index];
        return !!round && game.players.length > 0 && game.players.every(p => round.scores[p.id]);
    }

    // Index of the first round still missing a score, or -1 when every round is complete
    function firstIncompleteRound(game) {
        for (let i = 0; i < game.rounds.length; i++) {
            if (!isRoundComplete(game, i)) return i;
        }
        return -1;
    }

    // A game is final once every player has a score in every round
    function isFinal(game) {
        return game.players.length > 0 && firstIncompleteRound(game) === -1;
    }

    // True when at least one score has been entered
    function hasScores(game) {
        return lastScoredRound(game) !== -1;
    }

    // Map of playerId to total points across all rounds
    function totals(game) {
        const out = {};
        game.players.forEach(p => { out[p.id] = 0; });
        game.rounds.forEach(r => {
            game.players.forEach(p => { if (r.scores[p.id]) out[p.id] += r.scores[p.id].points; });
        });
        return out;
    }

    // Map of playerId to per-round points (null where the round has no score yet)
    function perRound(game) {
        const out = {};
        game.players.forEach(p => {
            out[p.id] = game.rounds.map(r => (r.scores[p.id] ? r.scores[p.id].points : null));
        });
        return out;
    }

    // Map of playerId to running totals (null where the round has no score yet)
    function cumulative(game) {
        const out = {};
        game.players.forEach(p => {
            let sum = 0;
            out[p.id] = game.rounds.map(r => {
                if (!r.scores[p.id]) return null;
                sum += r.scores[p.id].points;
                return sum;
            });
        });
        return out;
    }

    // Map of playerId to rank (1 = lowest total); tied totals share a rank
    function ranks(game) {
        const t = totals(game);
        const out = {};
        game.players.forEach(p => {
            out[p.id] = 1 + game.players.filter(q => t[q.id] < t[p.id]).length;
        });
        return out;
    }

    // Player ids holding the lowest total (the winners once the game is final)
    function winnerIds(game) {
        const t = totals(game);
        const best = Math.min(...game.players.map(p => t[p.id]));
        return game.players.filter(p => t[p.id] === best).map(p => p.id);
    }

    // Returns the players in display order: 'seat' (turn order), 'name', or 'score' (lowest first)
    function sortPlayers(game, mode) {
        const t = totals(game);
        const seated = game.players.map((p, seat) => ({ p, seat }));
        if (mode === 'name') {
            seated.sort((x, y) => x.p.name.localeCompare(y.p.name, undefined, { sensitivity: 'base' }) || x.seat - y.seat);
        } else if (mode === 'score') {
            seated.sort((x, y) => t[x.p.id] - t[y.p.id] || x.seat - y.seat);
        }
        return seated.map(s => s.p);
    }

    // Builds the history record for a game
    function historyRecord(game, complete) {
        const t = totals(game);
        const win = complete ? winnerIds(game) : [];
        return {
            id: game.id,
            finishedAt: game.updatedAt,
            complete: !!complete,
            roundsPlayed: game.rounds.filter((r, i) => isRoundComplete(game, i)).length,
            roundsTotal: game.rounds.length,
            players: game.players.map(p => ({ name: p.name, total: t[p.id], winner: win.includes(p.id) }))
        };
    }

    // Inserts or replaces a record (matched by game id), newest first, capped at MAX_HISTORY
    function upsertHistory(history, record) {
        const list = history.filter(h => h.id !== record.id);
        list.push(record);
        list.sort((a, b) => b.finishedAt - a.finishedAt);
        return list.slice(0, MAX_HISTORY);
    }

    // Removes a game's record from history
    function removeHistory(history, gameId) {
        return history.filter(h => h.id !== gameId);
    }

    // Combines local and cloud data: the game with the newer updatedAt wins; history records are unioned by id
    function mergeRemote(local, remote) {
        const remoteGame = remote && normalizeGame(remote.game);
        let game = local.game;
        let adopted = false;
        if (remoteGame && (!local.game || remoteGame.updatedAt > local.game.updatedAt)) {
            game = remoteGame;
            adopted = true;
        }
        let history = local.history.slice();
        if (remote && Array.isArray(remote.history)) {
            remote.history.forEach(rec => {
                if (rec && typeof rec.id === 'string' && !history.some(h => h.id === rec.id)) history.push(rec);
            });
            history.sort((a, b) => b.finishedAt - a.finishedAt);
            history = history.slice(0, MAX_HISTORY);
        }
        return { game, history, adopted };
    }

    return {
        VERSION: DOMINO_CORE_VERSION,
        DEFAULT_SETTINGS, SET_MAXES, MAX_PLAYERS, MAX_ROUNDS, PLAYER_COLORS,
        isPresetColor, freeColor, ensureColors,
        uuid, clampInt, normalizeSettings, normalizeGame, newGame, ensureRounds,
        tileScore, tilesScore, roundDouble,
        setScore, clearScore, removePlayer, rescore,
        lastScoredRound, isRoundComplete, firstIncompleteRound, isFinal, hasScores,
        totals, perRound, cumulative, ranks, winnerIds, sortPlayers,
        historyRecord, upsertHistory, removeHistory, mergeRemote
    };
})();

// Export for Node tests; browsers use the global
if (typeof module !== 'undefined' && module.exports) module.exports = DominoCore;
