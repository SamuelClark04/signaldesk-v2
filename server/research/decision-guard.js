// The limits a pass (or an approval) decided with (Phase 93): copied beside each recorded rejection so the Decision Review can
// check that a rejection followed its own rule (a daily-loss block had today's loss past the limit, ...). Plain numbers only.
const KEYS = ['riskPct', 'riskProfile', 'maxCapitalPct', 'dailyLossLimitPaper', 'dailyLossLimitLive', 'maxOpenRiskPct', 'maxEquityPerDirection', 'maxTradesPerSector',
  'maxOptionEntriesPerDay', 'maxOpenPositions', 'macroShield', 'macroShieldCrypto', 'dailyProfitTargetOn', 'dailyProfitTarget', 'bankroll', 'cryptoBankroll', 'stockMode', 'cryptoMode'];

function limits(settings = {}) {
  const out = {};
  for (const k of KEYS) if (settings[k] !== undefined) out[k] = settings[k];
  return out;
}

// Phase 94 S0-3: ONE event's guard: the shield state (entryShields.refresh / status) + the limits, stamped with the event's own time.
function snapshot(shield, settings = {}, at = Date.now()) {
  const s = shield || {};
  return { at, kill: s.kill || null, macroActive: !!(s.macro && s.macro.active), macroEvent: (s.macro && s.macro.event) || null, ...limits(settings) };
}

module.exports = { limits, snapshot, KEYS };
