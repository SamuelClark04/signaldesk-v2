// Position adoption: put an external Coinbase holding (bought outside
// SignalDesk) under SignalDesk's watch with user-chosen stop and target.
// WATCH ONLY: nothing is ordered at the broker. SignalDesk alerts when the stop
// or target is reached (portfolio-monitor), and the user sells at Coinbase.
// Everything is checked against server truth: the synced holding (quantity and
// Coinbase's average entry), the fresh live price, and what is already managed.
const ledger = require('./paper-ledger');
const prices = require('../market/latest-prices');
const brokerSync = require('../connectors/broker-sync');

const STRATEGIES = Object.freeze({
  'adopted-hold': { setupType: 'Adopted: long-term hold', timeframe: '1d' },
  'adopted-swing': { setupType: 'Adopted: swing', timeframe: '4h' },
  'adopted-trend': { setupType: 'Adopted: trend follow', timeframe: '1h' },
});
const QTY_EPSILON = 1e-9;

const fail = (msg) => { throw new Error(`ADOPT_REJECTED: ${msg}`); };

// Quantity of this asset SignalDesk already manages at Coinbase (its own LIVE
// trades + earlier adoptions): only the rest of the holding can be adopted.
const managedQty = (asset) => ledger.getActivePositions()
  .filter((p) => p.execution === 'LIVE' && p.broker === 'Coinbase' && p.asset === asset)
  .reduce((s, p) => s + p.positionSize, 0);

// payload: { asset, size, avgEntryPrice?, stopLoss, takeProfit, strategy }
function adopt(payload = {}) {
  const asset = String(payload.asset || '').toUpperCase();
  if (!/^[A-Z0-9]{1,10}-USD$/.test(asset)) fail(`invalid asset "${String(payload.asset).slice(0, 20)}"`);
  const strategy = STRATEGIES[payload.strategy];
  if (!strategy) fail(`strategy must be one of ${Object.keys(STRATEGIES).join(', ')}`);

  const snap = brokerSync.getSnapshot().coinbase;
  if (!snap || !snap.ok) fail('Coinbase is not synced: press Sync Broker first');
  const holding = snap.positions.find((p) => p.asset === asset);
  if (!holding) fail(`no ${asset} holding in the last Coinbase sync`);
  const free = Math.round((holding.positionSize - managedQty(asset)) * 1e8) / 1e8; // 8 dp: no float noise
  const size = Number(payload.size);
  if (!(size > 0)) fail('quantity must be above 0');
  if (size > free + QTY_EPSILON) fail(`only ${free} ${asset.replace('-USD', '')} is not already managed`);

  const live = prices.getLatestPrice(asset);
  if (!(live > 0)) fail(`SignalDesk has no live price for ${asset}, so it could not watch the levels`);
  const stop = Number(payload.stopLoss);
  const target = Number(payload.takeProfit);
  if (!(stop > 0 && stop < live)) fail(`stop loss must be above 0 and below the live price ${live}`);
  if (!(target > live)) fail(`take profit must be above the live price ${live}`);

  // Entry: Coinbase's own average entry when it has one (server truth), else the
  // user's figure, else the price at adoption.
  const userEntry = Number(payload.avgEntryPrice);
  const entry = holding.fillPrice > 0 ? holding.fillPrice : userEntry > 0 ? userEntry : live;
  const now = Date.now();
  return ledger.adoptPosition({
    id: `adopt:${asset}:${now}`,
    asset,
    market: 'crypto',
    direction: 'long',
    positionSize: size,
    fillPrice: entry,
    entryPrice: entry,
    entryZone: { min: entry, max: entry },
    invalidation: stop,
    targets: [{ level: 1, price: target, allocation: 1 }],
    // Capital at risk FROM HERE: what is lost if price falls from now to the stop.
    dollarRisk: (live - stop) * size,
    adoptedPrice: live,
    broker: 'Coinbase',
    strategyId: payload.strategy,
    setupType: strategy.setupType,
    timeframe: strategy.timeframe,
    thesis: `External Coinbase holding adopted at ${live}. SignalDesk watches the stop ${stop} and target ${target} and alerts you; it places no orders at Coinbase.`,
    catalyst: { type: 'manual', headline: null, sentimentScore: 0 },
    confirmationCriteria: [],
    sizingBasis: 'coinbase-live',
    timestamp: new Date(now).toISOString(),
  });
}

module.exports = { adopt, managedQty, STRATEGIES };
