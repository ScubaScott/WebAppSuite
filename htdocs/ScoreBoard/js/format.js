/**
 * ScoreBoard labels and formatters used by the game logic.
 * Pure functions with no DOM access.
 */

/**
 * User-facing period label: P1, P2, ... or OT / OT1, OT2 for periods beyond the regulation count.
 *
 * @param {number} periodNum 1-based period number.
 * @param {number} periodCount Total periods in the game now.
 * @param {number} regulationPeriods Periods set when the game was created.
 * @returns {string}
 */
export function getPeriodLabel(periodNum, periodCount = 2, regulationPeriods = 2) {
    const p = Number(periodNum) || 1;
    const regulation = Number(regulationPeriods) || 2;
    const total = Number(periodCount) || regulation;
    if (p <= regulation) {
        return `P${p}`;
    }
    // A single overtime period is labeled plainly; several are numbered
    return total === regulation + 1 ? 'OT' : `OT${p - regulation}`;
}

/**
 * Format a clock reading in milliseconds as [-]MM:SS.d (for example 03:24.5).
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatClock(ms) {
    const absMs = Math.abs(ms);
    const totalSeconds = Math.floor(absMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const tenths = Math.floor((absMs % 1000) / 100);
    const pad = (n) => String(n).padStart(2, '0');
    return `${ms < 0 ? '-' : ''}${pad(minutes)}:${pad(seconds)}.${tenths}`;
}

/**
 * Format a signed whole-minute adjustment for history text, for example "+1:00" or "-5:00".
 *
 * @param {number} deltaMs
 * @returns {string}
 */
export function formatAdjustment(deltaMs) {
    const sign = deltaMs < 0 ? '-' : '+';
    const totalSeconds = Math.floor(Math.abs(deltaMs) / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = String(totalSeconds % 60).padStart(2, '0');
    return `${sign}${minutes}:${seconds}`;
}
