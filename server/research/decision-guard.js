// The limits a pass (or an approval) decided with (Phase 93): copied beside each recorded rejection so the Decision Review can
// check that a rejection followed its own rule (a daily-loss block had today's loss past the limit, ...). Plain numbers only.
const KEYS = ['riskPct', 'riskProfile', 'maxCapitalPct', 'dailyLossLimitPaper', 'dailyLossLimitLive', 'maxOpenRiskPct', 'maxEquityPerDirection', 'maxTradesPerSector',
  'maxOptionEntriesPerDay', 'maxOpenPositions', 'macroShield', 'macroShieldCrypto', 'dailyProfitTargetOn', 'dailyProfitTarget', 'bankroll', 'cryptoBankroll', 'stockMode', 'cryptoMode'];

function limits(settings = {}) {
  const out = {};
  for (const k of KEYS) if (settings[k] !== undefined) out[k] = settings[k];
  return out;
}

module.exports = { limits, KEYS };
