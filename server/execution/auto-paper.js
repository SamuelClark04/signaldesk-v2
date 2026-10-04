// Automatic PAPER execution of qualified Options Quick Flips (Phase 89; the user chose it, settings.quickFlipsAutoPaper, default on).
// The replay entered ~1-2 minutes after the signal; a manual approval adds an unknown delay, so a Quick Flip that passed every
// gate (risk engine, book limits, entry shields incl. quickflip-rules) is approved right after it is staged, through the SAME
// path as a click (order-router.approveWithGuard: the guard, the shields and routing run again). Paper only: never when the
// stocks / options mode is live, and the router refuses a live Quick Flip anyway (QUICKFLIPS_PAPER_ONLY). Not awaited by the
// pipeline (an Alpaca Paper submit is a network call: no serial network waits in a pass); one attempt per setup.
const tried = new Set();

function eligible(order, settings = {}) {
  return !!order && order.strategyId === 'options-quickflips' && settings.quickFlipsAutoPaper !== false && settings.stockMode !== 'live'
    && order.sizingBasis === 'paper' && order.execution !== 'LIVE';
}

// -> a promise of { id, ok, error? } (null when not eligible / already tried / a user action is in flight)
function consider(order, { settings, broadcast = () => {}, router = require('./order-router'), ledger = require('./paper-ledger') } = {}) {
  if (!eligible(order, settings) || tried.has(order.id) || router.inFlight.has(order.id)) return null;
  tried.add(order.id);
  router.inFlight.add(order.id);
  return router.approveWithGuard(order.id)
    .then(() => { console.log(`[quickflips] ${order.id}: executed automatically on paper`); return { id: order.id, ok: true }; })
    .catch((err) => { console.warn(`[quickflips] ${order.id}: automatic paper execution refused: ${err.message}`); return { id: order.id, ok: false, error: err.message }; })
    .finally(() => {
      router.inFlight.delete(order.id);
      try { broadcast('QUEUE_UPDATED', ledger.getPendingOrders()); broadcast('POSITIONS_UPDATED', ledger.getActivePositions()); } catch { /* next pass */ }
    });
}

const reset = () => tried.clear();

module.exports = { consider, eligible, reset };
