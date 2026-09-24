// Per-pass tally of what a strategy concluded for each symbol it checked, for the
// live scanner log (execution/scan-log.js). A strategy calls start() at the top
// of generateCandidates, checked() per symbol, skip(symbol, reason) where it
// finds no setup (returns null, so `return tally.skip(...)` reads naturally) and
// setup() when it proposes one. The pipeline reads it with take().
// Observational only: it never changes what a strategy proposes.
function createTally() {
  let cur = null;
  return {
    start() { cur = { checked: 0, setups: 0, reasons: {} }; },
    checked() { if (cur) cur.checked += 1; },
    skip(symbol, reason) {
      if (cur) (cur.reasons[reason] = cur.reasons[reason] || []).push(symbol);
      return null;
    },
    setup() { if (cur) cur.setups += 1; },
    take() { const t = cur; cur = null; return t; },
  };
}

module.exports = { createTally };
