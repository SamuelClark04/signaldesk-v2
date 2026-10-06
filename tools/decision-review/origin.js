// Phase 94 S0-5: account data vs test-harness examples (decided by the command line, never guessed), and the target-order flag.
// Harness records never enter a count, a statistic or a pattern: they are shown in their own section, as examples.
const partition = (R) => ({ account: R.filter((r) => r.d.origin !== 'HARNESS'), harness: R.filter((r) => r.d.origin === 'HARNESS') });

// A long whose T2 sits below T1 (a short: above). Seen on Equity Swing (PFE 2026-10-01 / 02): under SEPARATE investigation
// (docs/research/phase94-pfe-target-order.md). Only a flag: the analysis is unchanged and no trading rule changes here.
function targetOrderFlag(d) {
  const L = d.levels;
  if (!L || !(L.t1 > 0) || !(L.t2 > 0)) return null;
  return d.d * (L.t2 - L.t1) < 0 ? `TARGET_ORDER: T2 ${L.t2} is ${d.d > 0 ? 'below' : 'above'} T1 ${L.t1} (under separate investigation; no trading change)` : null;
}

module.exports = { partition, targetOrderFlag };
