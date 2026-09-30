// Exit management for the pipeline (Phase 67, out of pipeline.js).
//   reconcile(broadcast)  first, orders Coinbase took that the ledger never recorded (Phase 68,
//                         order-recovery.js), then LIVE positions against broker truth (reconciler.js): real entry
//                         fills, broker exits (whole or an ended partial), voided entries and
//                         the bracket check (UNARMORED). It runs FIRST in every pass and once
//                         right at boot, so strategies, sizing and staging never see a position
//                         that already closed at the broker while SignalDesk was offline.
//                         Concurrent calls share one run; changes are broadcast at once.
//   run(broadcast)        held option quotes (real bids for marks and paper exits), Alpaca Paper option exits,
//                         time exits (Phase 76: options 3 days before expiry), then the
//                         PAPER exits (exit-monitor.js), then POSITIONS_UPDATED / JOURNAL_UPDATED.
const ledger = require('./paper-ledger');
const prices = require('../market/latest-prices');
const optionsData = require('../connectors/options-data');
const session = require('../market/market-session');
const { legSymbols } = require('./option-marks');
const { reconcileLivePositions } = require('./reconciler');
const recovery = require('./order-recovery'); // Phase 68 (P1-5): orders Coinbase took that the ledger never recorded

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
      const rec = await recovery.recover(ledger);
      if (rec.some((r) => r.action === 'recovered')) { out.positionsChanged = true; broadcast('QUEUE_UPDATED', ledger.getPendingOrders()); }
    } catch (err) {
      console.error('[pipeline] order recovery failed:', err.message);
    }
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

// Phase 73: one run at a time (a pass the watchdog released may still be inside it).
let runningExits = null;
function run(broadcast = () => {}) {
  if (!runningExits) runningExits = runOnce(broadcast).finally(() => { runningExits = null; });
  return runningExits;
}
async function runOnce(broadcast) {
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
  // Options held at Alpaca Paper (Phase 71): a premium stop / target sends the closing order there.
  try {
    const sent = await require('./alpaca-paper').exits(ledger);
    if (sent.length) { out.positionsChanged = true; out.journalChanged = true; }
  } catch (err) { console.error('[pipeline] Alpaca Paper exits failed:', err.message); }
  // Phase 82: every option spread closed at 2 DTE from 10:00 AM ET (time-exits.js); nothing else closes on time.
  try {
    const t = await require('./time-exits').run(ledger, { isBusy: require('./order-router').isBusy });
    if (t.some((x) => x.trade || x.pending || x.canceled)) { out.positionsChanged = true; out.journalChanged = true; }
  } catch (err) { console.error('[pipeline] time exits failed:', err.message); }
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

// Phase 73: PAPER stops / targets checked every FAST_EXIT_MS from the live prices, independent of the
// 60 s pass (a slow scan never delays an exit). Phase 83 (loop parity): options at Alpaca Paper are checked in
// the same 5 s loop (alpaca-paper.exits: limit exits stepped, targets resting), and the held option legs are
// re-quoted every QUOTE_REFRESH_MS during market hours so a stop never runs on a minute-old quote.
const FAST_EXIT_MS = 5000;
const QUOTE_REFRESH_MS = 12 * 1000;
let fastTimer = null;
let fastOptionsRun = null;
let quotesAt = 0;
async function fastOptions(broadcast = () => {}, now = Date.now()) {
  const held = ledger.getActivePositions().filter((p) => p.market === 'options' && p.optionsData);
  if (!held.length) return { quoted: false, exits: 0 };
  let quoted = false;
  if (session.isEquityMarketOpen(now) && now - quotesAt >= QUOTE_REFRESH_MS) {
    quotesAt = now;
    quoted = true;
    try { await optionsData.refreshQuotes(held.flatMap((p) => legSymbols(p.optionsData).filter(Boolean)), now, (u) => prices.getLatestPrice(u)); } catch (err) { console.error('[exits] option quotes failed:', err.message); }
  }
  const sent = await require('./alpaca-paper').exits(ledger, now);
  if (sent.length) publish(broadcast, { positionsChanged: true, journalChanged: true });
  return { quoted, exits: sent.length };
}
function fastTick(broadcast = () => {}) {
  try {
    const closed = ledger.monitorPositions(prices.getLatestPrices());
    closed.forEach(logClose);
    if (closed.length) publish(broadcast, { positionsChanged: true, journalChanged: true });
  } catch (err) { console.error('[exits] fast paper exit check failed:', err.message); }
  if (!fastOptionsRun) fastOptionsRun = fastOptions(broadcast).catch((err) => console.error('[exits] fast option exits failed:', err.message)).finally(() => { fastOptionsRun = null; });
}
function startFast(broadcast = () => {}) {
  if (fastTimer) return;
  fastTimer = setInterval(() => fastTick(broadcast), FAST_EXIT_MS);
  fastTimer.unref();
}
const stopFast = () => { clearInterval(fastTimer); fastTimer = null; };

module.exports = { reconcile, run, logClose, startFast, stopFast, fastTick, fastOptions, FAST_EXIT_MS, QUOTE_REFRESH_MS };
