// Decoder version identifier
const DECODER_VERSION = '1.0';

// Standard 75-ball bingo column ranges (B-I-N-G-O). A number outside its column's range is a misread.
const COLUMN_RANGES = [
    [1, 15],   // B
    [16, 30],  // I
    [31, 45],  // N
    [46, 60],  // G
    [61, 75],  // O
];

// Turns the reader's raw guesses for the 24 numbered cells into the most likely valid card, using what is known
// about bingo cards: every number belongs to its column's range and no number appears twice in a column.
//
// Input: an array of cells { index, col, row, raw, candidates: [{ value, score }], covered, glare } where
// candidates come from a reader (see the reader contract in bingo-scan-redesign-spec.md, section 7.5).
// Pure functions only (no DOM), so the decoder can be tested anywhere JavaScript runs.
const Decoder = (() => {
    // Digits that readers mix up. CONFUSIONS[read][true] is how plausible it is that the digit the reader saw is
    // really `true` (1 = as likely as the reading itself). Two tiers: pairs seen in the test photos (0.30) and the
    // usual look-alikes from the spec (0.12). The measured pairs come from one card photographed several times, so
    // re-measure them as more cards are available.
    const MEASURED = 0.30, USUAL = 0.12;
    const CONFUSIONS = {};
    const addPair = (read, truth, weight) => {
        CONFUSIONS[read] = CONFUSIONS[read] || {};
        CONFUSIONS[read][truth] = Math.max(CONFUSIONS[read][truth] || 0, weight);
    };
    // Measured on the tune photos (reader said first, was really second)
    [['3', '6'], ['3', '5'], ['1', '7'], ['2', '5'], ['1', '4'], ['8', '3'], ['9', '3'], ['5', '6']].forEach(([r, t]) => addPair(r, t, MEASURED));
    // Usual look-alikes, both directions
    [['1', '7'], ['3', '8'], ['5', '6'], ['6', '8'], ['0', '8'], ['4', '9'], ['2', '7']].forEach(([a, b]) => { addPair(a, b, USUAL); addPair(b, a, USUAL); });

    // Reading quality scores below this count as this much (a reader can report 0 for a correct digit)
    const SCORE_FLOOR = 0.05;
    // Leaving a cell empty is worth this much; below any real reading, so only conflicts push a cell to blank
    const BLANK_SCORE = 0.02;
    // A reading missing one digit of the real number ("2" for 72), and one with extra digits ("520" for 52)
    const DROP_WEIGHT = 0.3, EXTRA_WEIGHT = 0.5;
    // Options kept per cell for the column search
    const MAX_OPTIONS = 8;
    // A guessed number (anything but the reader's own answer) is only kept when it holds at least this share of the
    // likelihood of all the numbers the cell could be; otherwise the cell is left empty and the options are offered
    // as alternatives. A lone "3" in the N column could be nine different numbers, and a coin flip is worse than blank.
    const MIN_SHARE = 0.55;

    const inRange = (v, col) => v >= COLUMN_RANGES[col][0] && v <= COLUMN_RANGES[col][1];

    // Every number a cell could be, with how likely each is. Returns [{ value, logp, kind }] best first.
    // kind: 'exact' (the reading itself), 'swap' (a look-alike digit), 'drop' (a missing digit),
    //       'extra' (digits to ignore).
    function optionsFor(candidates, col) {
        const best = new Map();
        const add = (value, p, kind) => {
            if (!inRange(value, col)) return;
            const logp = Math.log(p);
            if (!best.has(value) || best.get(value).logp < logp) best.set(value, { value, logp, kind });
        };
        const [lo, hi] = COLUMN_RANGES[col];

        for (const c of candidates || []) {
            const s = Math.min(1, Math.max(SCORE_FLOOR, c.score));
            const raw = String(c.value);

            add(c.value, s, 'exact');

            // One digit replaced by a look-alike
            for (let i = 0; i < raw.length; i++) {
                const alts = CONFUSIONS[raw[i]];
                if (!alts) continue;
                for (const [t, w] of Object.entries(alts)) {
                    const v = parseInt(raw.slice(0, i) + t + raw.slice(i + 1), 10);
                    if (!isNaN(v)) add(v, s * w, 'swap');
                }
            }

            // A single digit read where the number has two: it is either the first or the last digit
            if (raw.length === 1) {
                for (let v = lo; v <= hi; v++) {
                    const str = String(v);
                    if (str.length === 2 && (str[0] === raw || str[1] === raw)) add(v, s * DROP_WEIGHT, 'drop');
                }
            }

            // More digits than a number can have (words from neighbors, noise): any one or two digits in a row
            if (raw.length >= 3) {
                for (let len = 2; len >= 1; len--) {
                    for (let i = 0; i + len <= raw.length; i++) add(parseInt(raw.slice(i, i + len), 10), s * EXTRA_WEIGHT, 'extra');
                }
            }
        }
        return Array.from(best.values()).sort((a, b) => b.logp - a.logp).slice(0, MAX_OPTIONS);
    }

    // Best way to fill one column: picks one option (or blank) per cell so the total log-likelihood is highest and
    // no number is used twice. Exhaustive search with pruning; a column has at most 5 cells of at most 9 options.
    function solveColumn(optionLists) {
        const blank = { value: null, logp: Math.log(BLANK_SCORE), kind: 'blank' };
        const lists = optionLists.map(opts => opts.concat([blank]));
        const bestRemaining = new Array(lists.length + 1).fill(0);
        for (let i = lists.length - 1; i >= 0; i--) bestRemaining[i] = bestRemaining[i + 1] + Math.max(...lists[i].map(o => o.logp));

        // Ties in the total (two cells that read the same digit and are corrected by the same look-alike weight)
        // go to the choice that keeps the most confident readings: the larger sum of squared likelihoods.
        let best = { total: -Infinity, spread: -Infinity, picks: [] };
        const picks = [];
        const used = new Set();
        const EPS = 1e-9;
        const walk = (i, total, spread) => {
            if (total + bestRemaining[i] < best.total - EPS) return;  // cannot reach the best found so far
            if (i === lists.length) {
                if (total > best.total + EPS || (Math.abs(total - best.total) <= EPS && spread > best.spread)) best = { total, spread, picks: picks.slice() };
                return;
            }
            for (const opt of lists[i]) {
                if (opt.value !== null && used.has(opt.value)) continue;
                if (opt.value !== null) used.add(opt.value);
                picks.push(opt);
                walk(i + 1, total + opt.logp, spread + Math.exp(2 * opt.logp));
                picks.pop();
                if (opt.value !== null) used.delete(opt.value);
            }
        };
        walk(0, 0, 0);
        return best.picks;
    }

    // What a reader's top answers give without any decoding: the best-scored candidate that fits the cell's
    // column range, and the later copy of a repeated number cleared. Used as the comparison for the decoder.
    function baseline(cells) {
        const grid = Array.from({ length: 5 }, () => Array(5).fill(null));
        grid[2][2] = 'FREE';
        const seen = new Set();
        for (const cell of cells) {
            const fit = (cell.candidates || []).find(c => inRange(c.value, cell.col));
            if (!fit || seen.has(fit.value)) continue;
            seen.add(fit.value);
            grid[cell.row][cell.col] = fit.value;
        }
        return grid;
    }

    // Decodes the card. Returns { grid, cells, score } where
    //   grid   5x5 array: numbers, null for an empty cell, 'FREE' in the center
    //   cells  one entry per input cell: { index, col, row, value, score, changedByDecoder, kind, covered, glare,
    //          alternatives } (score is the decoder's confidence 0-1; alternatives are the next best numbers)
    //   score  mean score of the filled cells
    function decode(cells) {
        const grid = Array.from({ length: 5 }, () => Array(5).fill(null));
        grid[2][2] = 'FREE';
        const base = baseline(cells);
        const out = [];

        for (let col = 0; col < 5; col++) {
            const inCol = cells.filter(c => c.col === col);
            const optionLists = inCol.map(c => (c.covered ? [] : optionsFor(c.candidates, col)));
            const picks = solveColumn(optionLists);
            inCol.forEach((cell, k) => {
                let pick = picks[k];
                // Too uncertain among look-alike options: leave the cell empty
                if (pick.value !== null && pick.kind !== 'exact') {
                    const total = optionLists[k].reduce((sum, o) => sum + Math.exp(o.logp), 0);
                    if (Math.exp(pick.logp) / total < MIN_SHARE) pick = { value: null, logp: Math.log(BLANK_SCORE), kind: 'ambiguous' };
                }
                const value = pick.value;
                if (value !== null) grid[cell.row][cell.col] = value;
                out.push({
                    index: cell.index, col: cell.col, row: cell.row,
                    value, kind: pick.kind,
                    score: value === null ? 0 : Math.exp(pick.logp),
                    changedByDecoder: value !== base[cell.row][cell.col],
                    covered: !!cell.covered, glare: !!cell.glare,
                    alternatives: optionLists[k].filter(o => o.value !== value).slice(0, 2).map(o => o.value)
                });
            });
        }
        out.sort((a, b) => a.index - b.index);
        const filled = out.filter(c => c.value !== null);
        return { grid, cells: out, score: filled.length ? filled.reduce((s, c) => s + c.score, 0) / filled.length : 0 };
    }

    return { VERSION: DECODER_VERSION, CONFUSIONS, optionsFor, solveColumn, baseline, decode };
})();
