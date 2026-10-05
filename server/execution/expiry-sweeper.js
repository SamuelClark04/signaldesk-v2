// Expiry sweeper (Phase 54): every SWEEP_MS, staged setups past their approval window
// (Phase 66, setup-ttl.js: 8 min Momentum Ignition, 15 min Accumulation Coil / Crypto
// Intraday, 30 min the rest), or a fast setup the price already ran 1.5% past or through
// its stop, are discarded with the reason (EXPIRED: unapproved after 8m / PRICE_ESCAPED /
// INVALIDATED) and every client gets the new queue, so an
// expired setup never lingers in Approvals, Setups, Today -> Ready for review or
// the Scanner with a live Approve button. An order whose approval is in flight
// right now (message-handler's lock) is left alone: the guard decides it.
const ledger = require('./paper-ledger');
const { staleness } = require('./setup-ttl');
const prices = require('../market/latest-prices');
const { recordRejection } = require('./rejection-stats');
const scanLog = require('./scan-log');

const SWEEP_MS = 30 * 1000;
let timer = null;


function sweep(broadcast, now = Date.now()) {
  const busy = (id) => { try { return require('./order-router').isBusy(id); } catch { return false; } };
  const expired = ledger.getPendingOrders().filter((o) => !busy(o.id)).map((o) => ({ o, why: staleness(o, prices.getLatestPrice(o.asset), now) })).filter((x) => x.why);
  for (const { o, why } of expired) {
    try {
      ledger.discardOrder(o.id);
      recordRejection(o.id, why, o);
      scanLog.rejected(o.id, why, o);
      require('../research/decision-recorder').record('EXPIRED', o.id, { reason: why, candidate: o }); // Phase 93: record-only
    } catch (err) { console.warn(`[sweeper] ${o.id}: ${err.message}`); }
  }
  if (expired.length) {
    console.log(`[sweeper] removed ${expired.length} stale setup(s): ${expired.map((x) => `${x.o.asset} (${x.why})`).join(', ')}`);
    broadcast('QUEUE_UPDATED', ledger.getPendingOrders());
  }
  return expired.length;
}

function start(broadcast) {
  if (timer) return;
  sweep(broadcast);
  timer = setInterval(() => sweep(broadcast), SWEEP_MS);
  timer.unref();
}
const stop = () => { clearInterval(timer); timer = null; };

module.exports = { start, stop, sweep, SWEEP_MS };
