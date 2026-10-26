// Tests for js/sync.js using a fake clock, fake timers and a fake server.
// Run from htdocs/ScoreBoard: node --test tests/sync.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, reduce, STATUS } from '../js/state.js';
import { createSyncer, SYNC_DELAY_MS } from '../js/sync.js';

const T0 = Date.parse('2026-10-26T17:00:00');

// A small harness: a store, a manual timer queue and a scriptable server
function harness({ replies = [] } = {}) {
    const ctx = { game: createGame(), sent: [], beacons: [], messages: [], timers: [], clock: T0, replies: [...replies], ids: 0 };
    ctx.id = () => `h${++ctx.ids}`;
    ctx.dispatch = (action) => { ctx.game = reduce(ctx.game, action); };
    ctx.syncer = createSyncer({
        getGame: () => ctx.game,
        getPrefs: () => ({ logPeriodStartStop: true }),
        dispatch: ctx.dispatch,
        send: async (payload) => {
            ctx.sent.push(payload);
            const reply = ctx.replies.shift();
            return typeof reply === 'function' ? reply(payload) : (reply || { success: true });
        },
        sendBeacon: (payload) => ctx.beacons.push(payload),
        getToken: () => 'session-token',
        now: () => ctx.clock,
        notify: (message) => ctx.messages.push(message),
        setTimer: (fn, ms) => { const timer = { fn, ms, active: true }; ctx.timers.push(timer); return timer; },
        clearTimer: (timer) => { if (timer) timer.active = false; }
    });
    ctx.run = async () => {
        // Fire every active timer once, then let pending promises finish
        const due = ctx.timers.filter((t) => t.active);
        due.forEach((t) => { t.active = false; t.fn(); });
        await new Promise((resolve) => setImmediate(resolve));
    };
    ctx.start = () => {
        ctx.dispatch({ type: 'new_game', gameId: 'g1', writeToken: 'tok', at: T0, periodCount: 2, periodLengthMs: 2400000 });
        ctx.dispatch({ type: 'start', at: T0, id: ctx.id() });
    };
    return ctx;
}

test('a game that has not started sends nothing', async () => {
    const ctx = harness();
    ctx.dispatch({ type: 'new_game', gameId: 'g1', writeToken: 'tok', at: T0, periodCount: 2, periodLengthMs: 2400000 });
    ctx.syncer.request();
    await ctx.run();
    assert.equal(ctx.sent.length, 0);
});

test('the first Start is sent at once with revision 1', async () => {
    const ctx = harness();
    ctx.start();
    ctx.syncer.request();
    assert.equal(ctx.timers.at(-1).ms, 0);
    await ctx.run();
    assert.equal(ctx.sent.length, 1);
    assert.equal(ctx.sent[0].rev, 1);
    assert.equal(ctx.sent[0].status, 'live');
    assert.equal(ctx.game.sync.lastAckRev, 1);
});

test('several quick changes become one request after the delay', async () => {
    const ctx = harness();
    ctx.start();
    ctx.syncer.request();
    await ctx.run();
    ctx.sent.length = 0;
    ctx.dispatch({ type: 'score', at: T0 + 1000, id: ctx.id(), teamId: 'home' });
    ctx.syncer.request();
    ctx.dispatch({ type: 'score', at: T0 + 2000, id: ctx.id(), teamId: 'home' });
    ctx.syncer.request();
    ctx.dispatch({ type: 'score', at: T0 + 3000, id: ctx.id(), teamId: 'away' });
    ctx.syncer.request();
    const active = ctx.timers.filter((t) => t.active);
    assert.equal(active.length, 1);
    assert.equal(active[0].ms, SYNC_DELAY_MS);
    await ctx.run();
    assert.equal(ctx.sent.length, 1);
    assert.equal(ctx.sent[0].snapshot.homeScore, 2);
    assert.equal(ctx.sent[0].snapshot.awayScore, 1);
    assert.equal(ctx.sent[0].rev, 2);
});

test('a status change is sent at once even while a delayed send is waiting', async () => {
    const ctx = harness();
    ctx.start();
    ctx.syncer.request();
    await ctx.run();
    ctx.sent.length = 0;
    ctx.dispatch({ type: 'score', at: T0 + 1000, id: ctx.id(), teamId: 'home' });
    ctx.syncer.request();
    ctx.dispatch({ type: 'pause', at: T0 + 2000, id: ctx.id() });
    ctx.syncer.request();
    const active = ctx.timers.filter((t) => t.active);
    assert.equal(active.length, 1);
    assert.equal(active[0].ms, 0);
    await ctx.run();
    assert.equal(ctx.sent.length, 1);
    assert.equal(ctx.sent[0].snapshot.isPaused, true);
});

test('a request for an unchanged game sends nothing', async () => {
    const ctx = harness();
    ctx.start();
    await ctx.syncer.publishNow();
    ctx.sent.length = 0;
    ctx.syncer.request();
    assert.equal(ctx.timers.filter((t) => t.active).length, 0);
});

test('a revision conflict adopts the server revision and resends once', async () => {
    const ctx = harness({ replies: [{ success: true }, { success: false, conflict: true, rev: 10 }, { success: true }] });
    ctx.start();
    await ctx.syncer.publishNow();
    ctx.dispatch({ type: 'score', at: T0 + 1000, id: ctx.id(), teamId: 'home' });
    await ctx.syncer.publishNow();
    assert.deepEqual(ctx.sent.map((p) => p.rev), [1, 2, 11]);
    assert.equal(ctx.game.sync.lastAckRev, 11);
});

test('a second conflict is not retried again', async () => {
    const ctx = harness({ replies: [{ success: false, conflict: true, rev: 5 }, { success: false, conflict: true, rev: 9 }] });
    ctx.start();
    await ctx.syncer.publishNow();
    assert.equal(ctx.sent.length, 2);
});

test('a conflict with a finalized game moves the console to final', async () => {
    const ctx = harness({ replies: [{ success: false, conflict: true, stopped: true, rev: 4 }] });
    ctx.start();
    await ctx.syncer.publishNow();
    assert.equal(ctx.game.status, STATUS.FINAL);
    assert.deepEqual(ctx.messages, ['Match was finalized on the server']);
    assert.equal(ctx.sent.length, 1);
});

test('a deleted game moves the console to final with a message', async () => {
    const ctx = harness({ replies: [{ success: false, error_code: 'game_deleted' }] });
    ctx.start();
    await ctx.syncer.publishNow();
    assert.equal(ctx.game.status, STATUS.FINAL);
    assert.deepEqual(ctx.messages, ['This game was deleted']);
});

test('an offline failure keeps the revision as sent and does not acknowledge it', async () => {
    const ctx = harness({ replies: [{ success: false, offline: true }] });
    ctx.start();
    await ctx.syncer.publishNow();
    assert.equal(ctx.game.sync.lastSentRev, 1);
    assert.equal(ctx.game.sync.lastAckRev, 0);
    await ctx.syncer.publishNow();
    assert.equal(ctx.sent[1].rev, 2);
});

test('the server decides visibility for an existing game', async () => {
    const ctx = harness({ replies: [{ success: true, visibility: 'private' }] });
    ctx.start();
    await ctx.syncer.publishNow();
    assert.equal(ctx.game.visibility, 'private');
});

test('one beacon per hidden period, with the token and a new revision', async () => {
    const ctx = harness();
    ctx.start();
    ctx.syncer.pageHidden();
    ctx.syncer.pageHidden();
    assert.equal(ctx.beacons.length, 1);
    assert.equal(ctx.beacons[0].token, 'session-token');
    assert.equal(ctx.beacons[0].rev, 1);
    ctx.syncer.pageVisible();
    ctx.syncer.pageHidden();
    assert.equal(ctx.beacons.length, 2);
    assert.equal(ctx.beacons[1].rev, 2);
});

test('no beacon before the game has started', () => {
    const ctx = harness();
    ctx.dispatch({ type: 'new_game', gameId: 'g1', writeToken: 'tok', at: T0, periodCount: 2, periodLengthMs: 2400000 });
    ctx.syncer.pageHidden();
    assert.equal(ctx.beacons.length, 0);
});

test('the heartbeat sends only while the clock runs', async () => {
    const ctx = harness();
    ctx.start();
    await ctx.syncer.heartbeat();
    assert.equal(ctx.sent.length, 1);
    ctx.dispatch({ type: 'pause', at: T0 + 1000, id: ctx.id() });
    await ctx.syncer.heartbeat();
    assert.equal(ctx.sent.length, 1);
});
