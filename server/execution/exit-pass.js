// Exit management for the pipeline (Phase 67, out of pipeline.js).
//   reconcile(broadcast)  LIVE positions against broker truth (reconciler.js): real entry
//                         fills, broker exits (whole or an ended partial), voided entries and
//                         the bracket check (UNARMORED). It runs FIRST in every pass and once
//                         right at boot, so strategies, sizing and staging never see a position
//                         that already closed at the broker while SignalDesk was offline.
//                         Concurrent calls share one run; changes are broadcast at once.
//   run(broadcast)        held option quotes (real bids for marks and paper exits), then the
//                         PAPER exits (exit-monitor.js), then POSITIONS_UPDATED / JOURNAL_UPDATED.
const ledger = require('./paper-ledger');
const prices = require('../market/latest-prices');
const optionsData = require('../connectors/options-data');
const { legSymbols } = require('./option-marks');
const { reconcileLivePositions } = require('./reconciler');

const logClose = (t) => console.log(`[ledger] closed ${t.id} ${t.exitReason} @ ${t.exitPrice}: `
  + `net ${t.netPnl.toFixed(2)} (${t.rMultiple.toFixed(2)}R)${t.exitLeg ? ` via ${t.exitLeg}` : ''}`);

function publish(broadcast, { positionsChanged, journalChanged }) {
  if (positionsChanged) broadcast('POSITIONS_UPDATED', ledger.getActivePositions());
  if (journalChanged) broadcast('JOURNAL_UPDATED', ledger.getTradeJournal());
}

let running = null;
function reconcile(broadcast = () => {}) {
  if (running) return running;
  running = (async () => {
    const out = { positionsChanged: false, journalChanged: false };
    try {
      for (const r of await reconcileLivePositions(ledger.getActivePositions(), ledger)) {
        if (r.trade) { logClose(r.trade); out.journalChanged = true; } // closed, or an ended partial exit booked
        if (r.action === 'voided') console.warn(`[reconcile] voided ${r.id}: ${r.detail}`);
        if (r.action === 'synced') console.log(`[reconcile] ${r.id}: entry synced to broker fill`);
        if (['closed', 'voided', 'synced', 'booked', 'flagged'].includes(r.action) || r.flagged) out.positionsChanged = true;
      }
    } catch (err) {
      console.error('[pipeline] broker reconciliation failed:', err.message);
    }
    try { publish(broadcast, out); } catch (err) { console.error('[pipeline] reconcile broadcast failed:', err.message); }
    return out;
  })().finally(() => { running = null; });
  return running;
}

async function run(broadcast = () => {}) {
  const out = { positionsChanged: false, journalChanged: false };
  // Held option contracts: one quote request per pass (only while any are open),
  // so marks and paper exits use the real bid. Re-sent every pass while held.
  const held = ledger.getActivePositions().filter((p) => p.market === 'options' && p.optionsData && p.optionsData.contract);
  if (held.length) {
    try {
      // Every leg of a spread; each quote remembers the underlying price then (delta interpolation, option-marks.js).
      await optionsData.refreshQuotes(held.flatMap((p) => legSymbols(p.optionsData).filter(Boolean)), Date.now(), (u) => prices.getLatestPrice(u));
    } catch (err) {
      console.error('[pipeline] option quotes failed:', err.message);
    }
    out.positionsChanged = true;
  }
  // PAPER exits from local prices (monitorPositions skips LIVE ones: the broker exits those).
  try {
    const closed = ledger.monitorPositions(prices.getLatestPrices());
    closed.forEach(logClose);
    if (closed.length) { out.positionsChanged = true; out.journalChanged = true; }
  } catch (err) {
    console.error('[pipeline] position monitor failed:', err.message);
  }
  publish(broadcast, out);
  return out;
}

module.exports = { reconcile, run, logClose };
