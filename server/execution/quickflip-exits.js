// Options Quick Flips exits (Phase 89), the mode's own time / setup rules on top of the premium stop / target that every
// option position already has (exit-monitor premiumExit; at Alpaca Paper the resting target + stepped limit exits):
//   QF_DEADLINE      from 3:40 PM ET (optionsData.quickFlip.deadlineMin): closed, profit or loss. Never held overnight. 3:40
//                    leaves the stepped limit exit (60 s ladder) time to finish inside the 9:35-3:45 options exit window.
//   QF_MAX_HOLD      maxHoldMin (60) after the fill
//   QF_SETUP_FAILED  a 5-minute bar that ended after the fill (and after the signal bar) closed back through the session VWAP
//                    (long / calls: below; short / puts: above): quickflips-signals.failed on today's stream bars
// These are the ONLY time-based exits outside the 2-DTE option rule (the user's Phase 89 exception, Quick Flips only).
// PAPER only (a Quick Flip can never be live). Internal paper closes at the exit quote (the natural bid); Alpaca Paper through
// alpaca-paper.sendClose (a working entry is canceled, never a closing trade; a resting target is canceled first).
// One attempt per position per RETRY_MS; a position already closing is left alone.
const prices = require('../market/latest-prices');
const session = require('../market/market-session');
const et = require('../services/et-time');
const sig = require('../strategies/quickflips-signals');

const RETRY_MS = 20 * 1000;
const tries = new Map();
const isQf = (p) => p && p.strategyId === 'options-quickflips' && p.market === 'options' && p.optionsData && p.optionsData.quickFlip;

// Today's 5-minute bars + VWAP from the stream (no prior sessions needed for VWAP / closes).
function sessionOf(symbol, now) {
  const day = et.ymd(now);
  const list = (require('../connectors/alpaca-stock-socket').getLatestBars().get(symbol) || []).map((b) => {
    const p = et.parts(Date.parse(b.time));
    return p.ymd === day ? { min: p.h * 60 + p.m, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume } : null;
  }).filter(Boolean);
  const today = sig.slots(list);
  return sig.build([], today);
}

// Why `p` must close now, or null. sessionFor: tests.
function due(p, now = Date.now(), sessionFor = sessionOf) {
  if (!isQf(p) || p.execution === 'LIVE') return null;
  const q = p.optionsData.quickFlip;
  const t = et.parts(now); const min = t.h * 60 + t.m;
  if (min >= (q.deadlineMin || 940)) return { reason: 'QF_DEADLINE', leg: 'qf_deadline', why: `the ${et.clock(now)} same-day deadline` };
  if (p.fillEstimated) return null; // a working entry times out on its own (spread-entry.js, entryTimeoutMs)
  if (p.openedAt && now - p.openedAt >= (q.maxHoldMin || 60) * 60000) return { reason: 'QF_MAX_HOLD', leg: 'qf_max_hold', why: `held ${q.maxHoldMin} min` };
  const opened = et.parts(p.openedAt || now);
  const after = Math.max(q.signalEndMin || 0, opened.ymd === t.ymd ? opened.h * 60 + opened.m : 0);
  const bar = sig.failed(sessionFor(p.asset, now), p.direction, after);
  if (bar) return { reason: 'QF_SETUP_FAILED', leg: 'qf_setup_failed', why: `the ${p.asset} 5-minute close ${bar.c} is back ${p.direction === 'short' ? 'above' : 'below'} VWAP ${bar.vwap.toFixed(2)}` };
  return null;
}

// -> [{ id, reason, trade? | pending? | canceled? | error? }]
async function run(ledger, { isBusy = () => false, sessionFor = sessionOf } = {}, now = Date.now()) {
  const out = [];
  if (!session.isEquityMarketOpen(now)) return out;
  const ap = require('./alpaca-paper');
  for (const p of ledger.getActivePositions()) {
    if (!isQf(p)) continue;
    const exiting = p.paperExitOrderId && !(p.exitWork && p.exitWork.kind === 'target');
    if (exiting || isBusy(p.id) || ap.isClosing(p.id)) continue;
    let d;
    try { d = due(p, now, sessionFor); } catch (err) { console.error(`[quickflips] ${p.id}: exit check failed: ${err.message}`); continue; }
    if (!d || now - (tries.get(p.id) || 0) < RETRY_MS) continue;
    tries.set(p.id, now);
    try {
      if (ap.isAtAlpaca(p)) {
        const r = await ap.sendClose(ledger, p, d.reason, d.leg);
        console.warn(`[quickflips] ${p.id}: ${d.why}: ${r.trade ? 'closed' : r.canceled ? 'working entry canceled' : r.pending ? 'closing order working' : 'already closed'}`);
        out.push({ id: p.id, reason: d.reason, ...r });
        continue;
      }
      if (p.fillEstimated) continue;
      const px = prices.getLatestPrice(p.asset);
      if (!(px > 0)) continue;
      const trade = ledger.closePosition(p.id, px, d.reason, { exitLeg: d.leg });
      console.warn(`[quickflips] ${p.id}: ${d.why}: closed, net ${trade.netPnl.toFixed(2)}`);
      out.push({ id: p.id, reason: d.reason, trade });
    } catch (err) {
      console.error(`[quickflips] ${p.id}: ${d.reason} failed: ${err.message}`);
      out.push({ id: p.id, reason: d.reason, error: err.message });
    }
  }
  return out;
}

const reset = () => tries.clear();

module.exports = { run, due, isQf, reset, RETRY_MS };
