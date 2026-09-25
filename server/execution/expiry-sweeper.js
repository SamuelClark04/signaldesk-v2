// Expiry sweeper (Phase 54): every SWEEP_MS, staged setups older than the order
// guard's approval window (30 minutes from the setup's own timestamp) are
// discarded with reason EXPIRED and every client gets the new queue, so an
// expired setup never lingers in Approvals, Setups, Today -> Ready for review or
// the Scanner with a live Approve button. An order whose approval is in flight
// right now (message-handler's lock) is left alone: the guard decides it.
const ledger = require('./paper-ledger');
const { MAX_CANDIDATE_AGE_MS } = require('./order-guard');
const { recordRejection } = require('./rejection-stats');
const scanLog = require('./scan-log');

const SWEEP_MS = 30 * 1000;
let timer = null;

const createdAt = (o) => { const t = typeof o.timestamp === 'number' ? o.timestamp : Date.parse(o.timestamp); return Number.isFinite(t) ? t : o.stagedAt; };

function sweep(broadcast, now = Date.now()) {
  const busy = (id) => { try { return require('./message-handler').isBusy(id); } catch { return false; } };
  const expired = ledger.getPendingOrders().filter((o) => !(now - createdAt(o) <= MAX_CANDIDATE_AGE_MS) && !busy(o.id));
  for (const o of expired) {
    try {
      ledger.discardOrder(o.id);
      recordRejection(o.id, 'EXPIRED', o);
      scanLog.rejected(o.id, 'EXPIRED', o);
    } catch (err) { console.warn(`[sweeper] ${o.id}: ${err.message}`); }
  }
  if (expired.length) {
    console.log(`[sweeper] expired ${expired.length} setup(s) past the ${MAX_CANDIDATE_AGE_MS / 60000}-minute approval window: ${expired.map((o) => o.asset).join(', ')}`);
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
