// Strategy strictness dial: how demanding the setup gates are. A live setting
// (Settings tab -> UPDATE_SETTINGS -> ledger-store, persisted with the ledger),
// read at CALL time, so the next 60 s scan after a change already uses it; no
// restart. It never loosens the risk engine: position sizing, the fee gate
// (0.35R), the capital cap and the earnings shields apply unchanged.
//   strict   (default) crypto swing targets 3R; resistance is every daily swing
//            high in the ~100 days of history the strategies load
//   moderate crypto swing targets 2R; resistance only from the last 30 days,
//            so older tops no longer veto a setup
// Resistance under the target (risk/target-plan.js): the setup is kept when the
// level is at least snapMinR above entry (strict 1.75R, moderate 1.35R): T1
// (half the position) snaps just under it, T2 (the runner) keeps the full
// target, and the blended NET reward must still reach minNetR.
// No saved choice, or an unknown one, is strict: fail safe, never looser.
const LEVELS = Object.freeze({
  strict: Object.freeze({ level: 'strict', label: 'Strict (Institutional)', targetR: 3, resistanceLookbackDays: null, snapMinR: 1.75, minNetR: 1.75 }),
  moderate: Object.freeze({ level: 'moderate', label: 'Moderate (Active Trader)', targetR: 2, resistanceLookbackDays: 30, snapMinR: 1.35, minNetR: 1.25 }),
});
const DEFAULT_LEVEL = 'strict';

// Lazy: ledger-store loads the saved settings; requiring it here at load time
// would tie this pure-risk module's import order to the ledger's.
function getStrictness() {
  let level = DEFAULT_LEVEL;
  try { level = require('../execution/ledger-store').getSettings().strictness || DEFAULT_LEVEL; } catch { /* store not ready: default */ }
  return LEVELS[level] || LEVELS[DEFAULT_LEVEL];
}

const describe = (s = getStrictness()) => `${s.level} (crypto target ${s.targetR}R, resistance ${s.resistanceLookbackDays ? `last ${s.resistanceLookbackDays} days` : 'full history'})`;

module.exports = { getStrictness, describe, LEVELS, DEFAULT_LEVEL };
