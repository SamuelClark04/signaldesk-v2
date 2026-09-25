// Phase 58 startup migration for OPEN Phase 57 package spreads (paper): they were
// opened before the Phase 58 stats existed. Once per position (statsVersion 58):
//   - expiry breakeven, width, max profit, 20-day HV and the entry stats (net
//     Greeks, POP; risk/spread-stats.js), theta per share
//   - the underlying T1 / T2 targets re-derived at MID-HOLD (max(1, round(0.65 x
//     DTE at entry)) days left) from the spread model anchored to the entry quote,
//     instead of the expiry intrinsic price (IWM 284/280: 281.06 -> ~277.5)
// The exits (exitRule stop / T1 / T2 values) are NOT changed. Live Greeks come
// from option-marks.js on every read.
const { getDailyBars } = require('../connectors/daily-bars');
const { realizedVols } = require('../risk/expected-move');
const spreadStats = require('../risk/spread-stats');
const { levelFor } = require('../strategies/options-spread-builder');

const VERSION = 58;
const cents = (x) => Math.round(x * 100) / 100;
const needs = (p) => p.market === 'options' && p.optionsData && p.optionsData.fill === 'package' && p.optionsData.statsVersion !== VERSION;

// Returns the number of positions migrated.
async function migrate(ledger) {
  const todo = ledger.getActivePositions().filter(needs);
  if (!todo.length) return 0;
  const hv = {};
  for (const a of new Set(todo.map((p) => p.asset))) hv[a] = realizedVols(await getDailyBars(a)).slice(-1)[0] || null;
  return ledger.updatePositions((p) => {
    if (!needs(p)) return false;
    const od = p.optionsData;
    const sign = od.type === 'put' ? -1 : 1;
    od.width = od.width || Math.abs(od.shortStrike - od.strike);
    od.maxProfit = cents(od.width - od.debit);
    od.breakeven = cents(spreadStats.breakeven(od));
    od.hv20 = hv[p.asset];
    od.stats = spreadStats.stats(od, od.refSpot, od.refAt, od.hv20);
    od.theta = od.stats.thetaDay === null ? null : od.stats.thetaDay / (od.multiplier || 100);
    od.netDelta = od.stats.netDelta;
    od.midHoldAt = spreadStats.midHoldAt(od, od.refAt);
    const at = (v) => levelFor(od, v, od.refSpot, od.midHoldAt);
    const t1 = at(od.exitRule.targetValue);
    if (t1 && sign * (t1 - od.refSpot) > 0 && p.targets[0]) { od.t1Before = p.targets[0].price; p.targets[0].price = cents(t1); } else od.t1Reach = 'expiry only';
    const t2 = od.exitRule.t2Value ? at(od.exitRule.t2Value) : null;
    if (t2 && p.targets[1]) p.targets[1].price = cents(t2);
    od.statsVersion = VERSION;
    od.migratedFrom = 57; // opened under the pre-Phase 58 rules (no net-delta floor): the UI flags a low net delta
    return true;
  });
}

// Startup: migrate, then tell the clients (POSITIONS_UPDATED).
function run(ledger, broadcast) {
  migrate(ledger).then((n) => {
    if (!n) return;
    console.log(`[options-migration] ${n} open option spread(s): Phase 58 stats + mid-hold targets`);
    broadcast('POSITIONS_UPDATED', ledger.getActivePositions());
  }).catch((err) => console.error('[options-migration] failed:', err.message));
}

module.exports = { migrate, run, VERSION };
