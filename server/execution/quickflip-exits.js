// Options Quick Flips exits (Phase 89), the mode's own time / setup rules on top of the premium stop / target that every
// option position already has (exit-monitor premiumExit; at Alpaca Paper the resting target + stepped limit exits):
//   QF_DEADLINE      from 3:40 PM ET on the day the position was opened (quickflip-alerts.deadlineAt), profit or loss; a position
//                    still open on a later day (it could not be closed) is due at once when the market opens.
//   QF_MAX_HOLD      maxHoldMin (60) after the fill
//   QF_SETUP_FAILED  a 5-minute bar that ended after the fill (and after the signal bar) closed back through the session VWAP
//                    (long / calls: below; short / puts: above): quickflips-signals.failed on today's stream bars
// These are the ONLY time-based exits outside the 2-DTE option rule (the user's Phase 89 exception, Quick Flips only). They are NOT
// gated by the 9:35-3:45 options exit window: a deadline close still runs after 3:45 PM while the market is open.
// PAPER only (a Quick Flip can never be live). Internal paper closes at the exit quote (the natural bid; no fresh quote: the model
// value, journal optionsExitBasis 'model', an estimate). Alpaca Paper through alpaca-paper.sendClose (a working entry is canceled,
// never a closing trade; a resting target is canceled first).
// Past the deadline a close that has not filled is re-priced every 20 s: URGENT_1 (2 min past: 25% under the best bid we have:
// fresh, else last known, else model) then URGENT_2 (10 min past, or any later day: 50% under). Marketable limits, never a market
// order: they make a fill likely, they do NOT guarantee a same-day close (a rejection, no fill, the close of the session). Anything
// still open is reported by quickflip-alerts (banner, log, email) and keeps being worked at the next session.
// One attempt per position per RETRY_MS; failures are recorded for the alert.
const prices = require('../market/latest-prices');
const session = require('../market/market-session');
const et = require('../services/et-time');
const sig = require('../strategies/quickflips-signals');
const qa = require('./quickflip-alerts');

const RETRY_MS = 20 * 1000;
const URGENT_1_MS = 2 * 60 * 1000; // 3:42 PM on the day
const URGENT_2_MS = 10 * 60 * 1000; // 3:50 PM on the day (and any later day)
const tries = new Map();
const isQf = (p) => p && p.strategyId === 'options-quickflips' && p.market === 'options' && p.optionsData && p.optionsData.quickFlip;

// Today's 5-minute bars + VWAP from the stream (no prior sessions needed for VWAP / closes).
function sessionOf(symbol, now) {
  const day = et.ymd(now);
  const list = (require('../connectors/alpaca-stock-socket').getLatestBars().get(symbol) || []).map((b) => {
    const p = et.parts(Date.parse(b.time));
    return p.ymd === day ? { min: p.h * 60 + p.m, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume } : null;
  }).filter(Boolean);
  return sig.build([], sig.slots(list));
}

// The discount for a close still working `now` (null: not yet urgent).
function urgency(p, now) {
  const past = now - qa.deadlineAt(p);
  if (past < URGENT_1_MS) return null;
  return past >= URGENT_2_MS ? 0.5 : 0.25;
}

// Why `p` must close now, or null. sessionFor: tests.
function due(p, now = Date.now(), sessionFor = sessionOf) {
  if (!isQf(p) || p.execution === 'LIVE') return null;
  const q = p.optionsData.quickFlip;
  if (now >= qa.deadlineAt(p)) return { reason: 'QF_DEADLINE', leg: 'qf_deadline', why: `past the ${et.clock(qa.deadlineAt(p))} deadline of ${et.ymd(qa.deadlineAt(p))}` };
  if (p.fillEstimated) return null; // a working entry times out on its own (spread-entry.js, entryDeadlineAt)
  if (p.openedAt && now - p.openedAt >= (q.maxHoldMin || 60) * 60000) return { reason: 'QF_MAX_HOLD', leg: 'qf_max_hold', why: `held ${q.maxHoldMin} min` };
  const t = et.parts(now); const opened = et.parts(p.openedAt || now);
  const after = Math.max(q.signalEndMin || 0, opened.ymd === t.ymd ? opened.h * 60 + opened.m : 0);
  const bar = sig.failed(sessionFor(p.asset, now), p.direction, after);
  if (bar) return { reason: 'QF_SETUP_FAILED', leg: 'qf_setup_failed', why: `the ${p.asset} 5-minute close ${bar.c} is back ${p.direction === 'short' ? 'above' : 'below'} VWAP ${bar.vwap.toFixed(2)}` };
  return null;
}

async function work(ledger, p, ap, opts, now, out) {
  const exiting = p.paperExitOrderId && !(p.exitWork && p.exitWork.kind === 'target');
  if (exiting) { // a close is working: past the deadline it is re-priced (marketable, bounded) until it fills
    const disc = urgency(p, now);
    if (!disc || !ap.isAtAlpaca(p)) return;
    const u = await require('./spread-exit').urgent(ledger, p, ap.exitDeps(), disc, now);
    if (u.error) qa.recordFailure(p.id, u.error, now);
    if (u.placed || u.trade) out.push({ id: p.id, reason: 'QF_DEADLINE', urgent: disc, ...u });
    return;
  }
  if (opts.sessionFor === sessionOf) await require('../strategies/7-options-quickflips').syncSession(p.asset, now).catch(() => null); // restart: REST bars first
  const d = due(p, now, opts.sessionFor);
  if (!d || now - (tries.get(p.id) || 0) < RETRY_MS) return;
  tries.set(p.id, now);
  if (ap.isAtAlpaca(p)) {
    const r = await ap.sendClose(ledger, p, d.reason, d.leg);
    console.warn(`[quickflips] ${p.id}: ${d.why}: ${r.trade ? 'closed' : r.canceled ? 'working entry canceled' : r.pending ? 'closing order working' : 'already closed'}`);
    out.push({ id: p.id, reason: d.reason, ...r });
    return;
  }
  if (p.fillEstimated) return;
  const px = prices.getLatestPrice(p.asset);
  if (!(px > 0)) { qa.recordFailure(p.id, `${d.reason}: no live ${p.asset} price to value the exit`, now); return; }
  const trade = ledger.closePosition(p.id, px, d.reason, { exitLeg: d.leg });
  console.warn(`[quickflips] ${p.id}: ${d.why}: closed, net ${trade.netPnl.toFixed(2)}`);
  out.push({ id: p.id, reason: d.reason, trade });
}

// -> [{ id, reason, trade? | pending? | canceled? | urgent? | error? }]. Alerts are refreshed on every call, market open or not.
async function run(ledger, { isBusy = () => false, sessionFor = sessionOf, notify = defaultNotify } = {}, now = Date.now()) {
  const out = [];
  const open = session.isEquityMarketOpen(now);
  if (open) {
    const ap = require('./alpaca-paper');
    for (const p of ledger.getActivePositions()) {
      if (!isQf(p) || isBusy(p.id) || ap.isClosing(p.id)) continue;
      try { await work(ledger, p, ap, { sessionFor }, now, out); } catch (err) {
        console.error(`[quickflips] ${p.id}: exit failed: ${err.message}`);
        qa.recordFailure(p.id, err.message, now);
        out.push({ id: p.id, error: err.message });
      }
    }
  }
  qa.refresh(ledger.getActivePositions(), { now, marketOpen: open, notify });
  return out;
}

const defaultNotify = (m) => require('./notifier').sendOperationalAlert(m);
const reset = () => { tries.clear(); qa.reset(); };

module.exports = { run, due, urgency, isQf, reset, RETRY_MS, URGENT_1_MS, URGENT_2_MS };
