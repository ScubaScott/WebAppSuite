/**
 * ScoreBoard store: holds the current game and applies actions through the reducer.
 * Every change goes through `dispatch`, which validates the action, replaces the game, and tells the
 * subscribers (render, save, sync) what happened.
 */

import { reduce, explain } from './state.js';

/**
 * @param {Object} initialGame
 * @returns {{
 *   getGame: function(): Object,
 *   dispatch: function(Object): {ok: boolean, error: (string|null)},
 *   subscribe: function(function(Object, Object, Object): void): function(): void
 * }}
 */
export function createStore(initialGame) {
    let game = initialGame;
    const listeners = new Set();

    return {
        getGame: () => game,

        /** Apply an action. A rejected action changes nothing and returns the reason. */
        dispatch(action) {
            const error = explain(game, action);
            if (error) return { ok: false, error };
            const previous = game;
            game = reduce(game, action);
            listeners.forEach((listener) => listener(game, action, previous));
            return { ok: true, error: null };
        },

        /** Register a listener called with (game, action, previousGame). Returns a function that removes it. */
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        }
    };
}
