// "Direction correct but the trade lost": WHY, only where the records support it (Phase 93 spec 6.5, [C4]). Otherwise UNATTRIBUTED,
// saying what evidence was missing. Several causes can apply. Inputs: the decision, its measurement, its class and its money result.
const MANUAL = /^(MANUAL|CLOSED_BY_USER|USER_CLOSE|RUN_RESET|CLOSE_NOW)/i;
const RULE_EXITS = /^(QF_SETUP_FAILED|QF_MAX_HOLD|QF_DEADLINE|AUTO_CLOSE_2_DTE|TIME_EXIT)/;

function attribute(d, m, cls, money) {
  if (!money || cls !== 'CORRECT_DIRECTION' || !(money.rNet < 0)) return null;
  const causes = []; const gaps = [];
  if (money.filled === false) causes.push({ cause: 'ENTRY_NOT_FILLED', evidence: money.why });
  if (money.rGross != null && money.rGross >= 0 && money.rNet < 0) causes.push({ cause: 'COSTS_EXCEEDED_EDGE', evidence: `gross ${money.rGross.toFixed(2)}R, net ${money.rNet.toFixed(2)}R` });
  const exits = (d.realized && d.realized.exits) || money.exits || [];
  const lastExit = exits.length ? exits[exits.length - 1] : null;
  const endH = m && m.horizons ? m.horizons.find((h) => h.key === 'H') : null;
  if (lastExit && lastExit.exitReason && endH && endH.m !== null) {
    if (MANUAL.test(lastExit.exitReason)) causes.push({ cause: 'CLOSED_BY_HAND_BEFORE_MOVE', evidence: `closed by hand (${lastExit.exitReason}); the underlying ended the holding period at ${endH.m.toFixed(2)} unit` });
    else if (RULE_EXITS.test(lastExit.exitReason)) causes.push({ cause: 'EXIT_RULE_BEFORE_MOVE', evidence: `${lastExit.exitReason}; the underlying ended the holding period at ${endH.m.toFixed(2)} unit` });
  }
  const o = d.option;
  if (o && o.bid > 0 && o.ask > o.bid) {
    const hs = (o.ask - o.bid) / 2;
    if (money.grossPerShare != null && 2 * hs >= money.grossPerShare) causes.push({ cause: 'ENTRY_SPREAD_COST', evidence: `recorded bid / ask ${o.bid} / ${o.ask}: the round-trip half-spreads ${(2 * hs).toFixed(2)} >= the gross gain` });
    if (o.delta != null && m && m.u && endH && endH.m !== null) {
      const moveUnder = Math.abs(endH.m * m.u);
      if (Math.abs(o.delta) * moveUnder < hs + 0.013) causes.push({ cause: 'CONTRACT_DELTA_TOO_LOW', evidence: `recorded delta ${o.delta} x the underlying move ${moveUnder.toFixed(2)} < the half-spread + fees per share` });
    } else gaps.push('the decision delta');
    gaps.push('an exit quote with IV (needed for time decay / volatility crush; the ledger keeps the exit value, not IV)');
  } else if (d.market === 'options') gaps.push('the decision bid / ask');
  if (!causes.length) return { causes: [{ cause: 'UNATTRIBUTED', evidence: gaps.length ? `not enough recorded evidence: missing ${gaps.join('; ')}` : 'no recorded cause matched' }] };
  return { causes, gaps };
}

module.exports = { attribute };
