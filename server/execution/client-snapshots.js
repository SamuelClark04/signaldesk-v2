// Snapshots a newly connected client receives for the feeds added since Phase 55
// (server.js sends them in one line): the Moonshot Radar + the Coinbase gem
// catalog, and the after-hours options plans.
const radar = require('../intelligence/moonshot-radar');
const afterHours = require('./after-hours-plans');

function portfolioRisk() {
  const ledger = require('./paper-ledger');
  const s = ledger.getSettings();
  return ['PORTFOLIO_RISK', require('../risk/portfolio-risk').summary(ledger.getActivePositions(), s, { stocks: s.bankroll, crypto: s.cryptoBankroll })];
}
const shields = () => ['ENTRY_SHIELDS', require('../risk/entry-shields').status(require('./paper-ledger').getSettings())]; // Phase 81 banners
const snapshots = () => [...radar.snapshots(), ['OPTIONS_PLANS', afterHours.snapshot()], ['ACCOUNTS_STATUS', require('../security/vault').status()], portfolioRisk(), shields()]; // + accounts (73), book risk (77)

module.exports = { snapshots };
