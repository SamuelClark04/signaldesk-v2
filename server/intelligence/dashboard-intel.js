// Dashboard intelligence: gathers live inputs, runs the Portfolio Attention and
// Market Context engines, and publishes DASHBOARD_INTELLIGENCE. Called by the
// pipeline every pass and after approvals; broadcasts only when the content
// actually changed.
const ledger = require('../execution/paper-ledger');
const prices = require('../market/latest-prices');
const alpacaStocks = require('../connectors/alpaca-stock-socket');
const coinbase = require('../connectors/coinbase-socket');
const { generateAttentionAlerts } = require('./portfolio-monitor');
const { getMarketContext } = require('./market-context');
const referencePrices = require('../market/reference-prices');
const external = require('../execution/external-holdings');

let lastKey = null;

function buildIntelligence(now = Date.now()) {
  return {
    // Every holding: SignalDesk's own positions + external ones (manual / broker-synced) at mark prices.
    attention: generateAttentionAlerts([...ledger.getActivePositions(), ...external.positions()], prices.getMarkPrices(now), now),
    context: getMarketContext({ stockBars: alpacaStocks.getLatestBars(), cryptoTicks: coinbase.getLatest(), references: referencePrices.snapshot() }, now),
    generatedAt: now,
  };
}

// Returns the payload if broadcast, or null when nothing changed.
function publishIntelligence(broadcast, now = Date.now()) {
  const intel = buildIntelligence(now);
  const key = JSON.stringify([intel.attention, intel.context]);
  if (key === lastKey) return null;
  lastKey = key;
  broadcast('DASHBOARD_INTELLIGENCE', intel);
  return intel;
}

module.exports = { buildIntelligence, publishIntelligence };
