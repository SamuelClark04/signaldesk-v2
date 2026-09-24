// Risk profiles: the share of the bankroll one new trade may lose at its stop.
// Chosen in Settings (riskProfile, persisted by ledger-store) and applied by the
// pipeline when it sizes each candidate. Open positions keep their original size.
const RISK_PROFILES = Object.freeze({
  conservative: 0.005, // 0.5% per trade
  balanced: 0.01, // 1.0% per trade
  aggressive: 0.02, // 2.0% per trade
});
const DEFAULT_PROFILE = 'balanced';

const riskPctFor = (profile) => RISK_PROFILES[profile] || RISK_PROFILES[DEFAULT_PROFILE];

module.exports = { RISK_PROFILES, DEFAULT_PROFILE, riskPctFor };
