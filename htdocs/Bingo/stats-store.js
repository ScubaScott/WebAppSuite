// Shared ball-call stats data layer, loaded by the board page (tracking.js) and the Stats page (stats.js).
// Version identifier for this module
const STATS_STORE_VERSION_ID = '1.0';

// ============================================================
// STATS SESSIONS (ball call tallies per location and per game)
// Stored under its own key so Clear Cards / session saves never touch it.
// activeId === null means the "Unsaved" bucket is being updated.
// Every bucket (a location or Unsaved) holds { games: { [gameKey]: tally } } where
// tally = { name, letters, callCounts, gamesPlayed }. `letters` lists the BINGO columns (0-4)
// the game's patterns touch, so stats can be filtered by the letters a game uses.
// ============================================================

const STATS_KEY = "bingoStatsSessions";
const STATS_VERSION = 2;
// Game key used while no game is selected
const NO_GAME_KEY = "none";
const ALL_LETTERS = [0, 1, 2, 3, 4];
let statsStore = null;

function emptyBucket() {
    return { games: {} };
}

// Loads the store from localStorage (call again to pick up changes made by the other page).
// A store written before tallies were kept per game starts with empty tallies.
function loadStatsStore() {
    let store = null;
    try {
        const raw = localStorage.getItem(STATS_KEY);
        if (raw) store = JSON.parse(raw);
    } catch (e) { store = null; }

    if (!store || typeof store !== "object") {
        store = { activeId: null, locations: {}, unsaved: emptyBucket() };
    }
    if (!store.locations || typeof store.locations !== "object") store.locations = {};
    if (store.version !== STATS_VERSION) {
        Object.values(store.locations).forEach(l => {
            l.games = {};
            delete l.callCounts;
            delete l.gamesPlayed;
        });
        store.unsaved = emptyBucket();
        store.version = STATS_VERSION;
    }
    Object.values(store.locations).forEach(l => { if (!l.games) l.games = {}; });
    if (!store.unsaved || !store.unsaved.games) store.unsaved = emptyBucket();
    if (store.activeId && !store.locations[store.activeId]) store.activeId = null;
    statsStore = store;
    saveStatsStore();
}

function saveStatsStore() {
    try { localStorage.setItem(STATS_KEY, JSON.stringify(statsStore)); } catch (e) { /* storage unavailable */ }
}

// The bucket currently receiving calls: the active location, or the Unsaved bucket
function getLocationBucket() {
    return (statsStore.activeId && statsStore.locations[statsStore.activeId]) || statsStore.unsaved;
}

function getActiveStatsName() {
    return statsStore.activeId ? statsStore.locations[statsStore.activeId].name : "Unsaved";
}

// Every bucket: Unsaved plus all locations
function getAllBuckets() {
    return [statsStore.unsaved, ...Object.values(statsStore.locations)];
}

// Returns a bucket's tally for a game, creating it when missing
function getGameTally(bucket, key) {
    if (!bucket.games[key]) {
        bucket.games[key] = {
            name: key === NO_GAME_KEY ? "No game selected" : "Unknown game",
            letters: ALL_LETTERS.slice(),
            callCounts: {},
            gamesPlayed: 0
        };
    }
    return bucket.games[key];
}

// Sums the tallies of the given buckets into one read-only tally.
// `selected` is a Set of game keys, or null for every game.
function sumTallies(buckets, selected) {
    const total = { callCounts: {}, gamesPlayed: 0 };
    buckets.forEach(bucket => {
        Object.entries(bucket.games).forEach(([key, t]) => {
            if (selected && !selected.has(key)) return;
            total.gamesPlayed += t.gamesPlayed || 0;
            for (const [n, c] of Object.entries(t.callCounts || {})) {
                total.callCounts[n] = (total.callCounts[n] || 0) + c;
            }
        });
    });
    return total;
}

// Games that have recorded calls or finished games in the given buckets, sorted by name
function listStatsGames(buckets) {
    const found = {};
    buckets.forEach(bucket => {
        Object.entries(bucket.games).forEach(([key, t]) => {
            if (Object.keys(t.callCounts || {}).length === 0 && !t.gamesPlayed) return;
            found[key] = { key, name: t.name, letters: t.letters || ALL_LETTERS };
        });
    });
    return Object.values(found).sort((a, b) => a.name.localeCompare(b.name));
}

// True if a bucket has any recorded ball calls
function bucketHasCalls(bucket) {
    return Object.values(bucket.games).some(t => Object.keys(t.callCounts || {}).length > 0);
}

// Creates a location (optionally seeded with the games of a bucket), makes it active and returns its id
function createStatsLocation(name, seed) {
    const id = "loc_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    statsStore.locations[id] = {
        name,
        games: seed ? seed.games : {},
        createdAt: new Date().toISOString()
    };
    statsStore.activeId = id;
    saveStatsStore();
    return id;
}

// True if another location already uses this name (case-insensitive)
function statsNameTaken(name, exceptId) {
    const lower = name.toLowerCase();
    return Object.entries(statsStore.locations).some(([id, l]) => id !== exceptId && l.name.toLowerCase() === lower);
}

loadStatsStore();
