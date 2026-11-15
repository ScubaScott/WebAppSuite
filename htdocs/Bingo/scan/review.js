// Review-screen rules version identifier
const REVIEW_VERSION = '1.1';

// Decides how each scanned cell is shown on the review screen and how the summary line reads.
// Pure functions only (no DOM), so the rules can be tested anywhere JavaScript runs.
//
// Cell states:
//   confident  read cleanly; shown normally
//   check      amber: filled, but the decoder changed what the reader said, a look-alike or missing digit was
//              corrected, the window has glare, or the reader was not sure
//   missing    red outline: nothing usable was read
//   covered    the shutter over the number is closed, so nothing could be read
//   edited     the user picked this number by hand; counts as read
//   free       the FREE center cell
const Review = (() => {
    const FREE_INDEX = 12;

    // A reading below this confidence is shown as "check". Measured on the 9 checked slider photos: the silent
    // wrong readings scored 0.62, 0.63 and 0.86, and correct ones are mostly above 0.7, so 0.7 catches most of the
    // wrong readings while about 1 correct cell in 5 is also flagged.
    const CHECK_BELOW = 0.7;

    // State of one decoder cell: { state, reason, alternatives } where reason is a short phrase for the cell's tooltip and
    // alternatives are the next most likely numbers (shown highlighted in the number picker of a check or missing cell)
    function classifyCell(cell) {
        const flagged = (state, reason) => ({ state, reason, alternatives: cell.alternatives ? cell.alternatives.slice() : [] });
        if (cell.covered) return { state: 'covered', reason: 'The shutter over this number is closed', alternatives: [] };
        if (cell.value === null || cell.value === undefined) {
            return flagged('missing', cell.kind === 'ambiguous' ? 'Several numbers fit; pick one' : 'Nothing could be read');
        }
        if (cell.kind && cell.kind !== 'exact') return flagged('check', 'A digit was corrected using the card rules');
        if (cell.changedByDecoder) return flagged('check', 'Changed using the card rules');
        if (cell.glare) return flagged('check', 'Glare on the window');
        if (cell.score < CHECK_BELOW) return flagged('check', 'The reader was not sure');
        return { state: 'confident', reason: '', alternatives: [] };
    }

    // States for all 25 cells (row-major): decoded is the Decoder.decode result
    function classify(decoded) {
        const out = Array.from({ length: 25 }, () => ({ state: 'missing', reason: 'Nothing could be read', alternatives: [] }));
        out[FREE_INDEX] = { state: 'free', reason: '', alternatives: [] };
        for (const cell of decoded.cells) out[cell.index] = classifyCell(cell);
        return out;
    }

    // Counts for the summary line. "read" are cells needing no attention, "toCheck" everything else.
    function summarize(states) {
        const counts = { confident: 0, edited: 0, check: 0, missing: 0, covered: 0 };
        states.forEach((s, i) => { if (i !== FREE_INDEX && counts[s.state] !== undefined) counts[s.state]++; });
        const read = counts.confident + counts.edited;
        const toCheck = counts.check + counts.missing + counts.covered;
        return { read, toCheck, counts, text: `${read} read · ${toCheck} to check` };
    }

    return { VERSION: REVIEW_VERSION, CHECK_BELOW, FREE_INDEX, classifyCell, classify, summarize };
})();
