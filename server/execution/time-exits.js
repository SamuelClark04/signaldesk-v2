// Time exits (Phase 76 audit; Phase 82 rule): an option's expiration, not only its price, ends a trade.
//   AUTO_CLOSE_2_DTE  every open options position (automated or manual) is closed at the first daily check from
//                     10:00 AM ET (before the 3:45 PM cutoff) once it is within 2 days of expiration: 2 calendar days
//                     or 2 trading days, whichever comes first (a Monday expiry closes the Thursday before), profit or
//                     loss: pin / assignment and gamma risk. It replaced Phase 76's EXPIRY_EXIT (3 days, any hour).
// Phase 76B (the user's rule): NOTHING else is closed on time alone. A day trade that has not hit its stop or
// target by the bell carries into the next session (its Alpaca bracket is GTC), and a stale Moonshot is only
// flagged in the UI (Stale, 24 h+): stop, target and the user's manual exits decide.
// Session hours only (a closing order needs an open market). PAPER positions close in the internal ledger
// (at the exit quote, like [Close]) or at Alpaca Paper (alpaca-paper.sendClose: a working entry is canceled,
// never a closing trade). LIVE positions are never sold here: they are reported (the user closes them).
// One attempt per position per RETRY_MS; a position already closing is left alone.
const prices = require('../market/latest-prices');
const session = require('../market/market-session');
const et = require('../services/et-time');

const DTE_CLOSE = 2;
const CHECK_MIN = 10 * 60; // 10:00 AM ET
const CUTOFF_MIN = 15 * 60 + 45; // the options exit window's end (options-exit-window.js)
// Calendar and trading days (weekdays after today, through expiry) from `now` (New York date) to `expiration`.
function dte(expiration, now = Date.now()) {
  const today = et.ymd(now);
  const day = (ymd) => Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10));
  const calendar = Math.round((day(expiration) - day(today)) / 864e5);
  let trading = 0;
  for (let t = day(today) + 864e5; t <= day(expiration); t += 864e5) if (![0, 6].includes(new Date(t).getUTCDay())) trading += 1;
  return { calendar, trading };
}
const RETRY_MS = 60 * 1000;
const tries = new Map(); // position id -> last attempt (ms)
const warned = new Set();

// Why `p` must be closed now, or null.
function due(p, now = Date.now()) {
  const od = p.optionsData;
  if (p.market !== 'options' || !od || !/^\d{4}-\d{2}-\d{2}$/.test(od.expiration || '') || !session.isEquityMarketOpen(now)) return null;
  if (od.quickFlip) return null; // Phase 89: Quick Flips close the same day by their own rules (quickflip-exits.js)
  const clock = et.parts(now);
  const m = clock.h * 60 + clock.m;
  if (m < CHECK_MIN || m >= CUTOFF_MIN) return null;
  const d = dte(od.expiration, now);
  if (Math.min(d.calendar, d.trading) > DTE_CLOSE) return null;
  return { reason: 'AUTO_CLOSE_2_DTE', leg: 'auto_close_2_dte', why: `${d.calendar} calendar / ${d.trading} trading day(s) to its ${od.expiration} expiration (closed at ${DTE_CLOSE} DTE: pin / gamma risk)` };
}

// -> [{ id, reason, trade? | pending? | error? | live? }]
async function run(ledger, { isBusy = () => false } = {}, now = Date.now()) {
  const out = [];
  const ap = require('./alpaca-paper');
  for (const p of ledger.getActivePositions()) {
    const d = due(p, now);
    const exiting = p.paperExitOrderId && !(p.exitWork && p.exitWork.kind === 'target'); // a resting target is canceled by the close (Phase 83)
    if (!d || isBusy(p.id) || ap.isClosing(p.id) || exiting) continue;
    if (p.execution === 'LIVE') {
      if (!warned.has(`${p.id}:${d.reason}`)) console.warn(`[time-exit] ${p.id}: ${d.why}; LIVE positions are not sold automatically: close it at ${p.broker || 'the broker'}`);
      warned.add(`${p.id}:${d.reason}`);
      out.push({ id: p.id, reason: d.reason, live: true });
      continue;
    }
    if (now - (tries.get(p.id) || 0) < RETRY_MS) continue;
    tries.set(p.id, now);
    try {
      if (ap.isAtAlpaca(p)) {
        const r = await ap.sendClose(ledger, p, d.reason, d.leg);
        console.warn(`[time-exit] ${p.id}: ${d.why}: ${r.trade ? 'closed' : r.canceled ? 'working entry canceled' : r.pending ? 'closing order working' : 'already closed'} at ${ap.BROKER}`);
        out.push({ id: p.id, reason: d.reason, ...r });
        continue;
      }
      const px = prices.getLatestPrice(p.asset);
      if (!(px > 0)) continue;
      const trade = ledger.closePosition(p.id, px, d.reason, { exitLeg: d.leg });
      console.warn(`[time-exit] ${p.id}: ${d.why}: closed @ ${px}, net ${trade.netPnl.toFixed(2)}`);
      out.push({ id: p.id, reason: d.reason, trade });
    } catch (err) {
      console.error(`[time-exit] ${p.id}: ${d.reason} failed: ${err.message}`);
      out.push({ id: p.id, reason: d.reason, error: err.message });
    }
  }
  return out;
}

const reset = () => { tries.clear(); warned.clear(); };

module.exports = { run, due, dte, reset, DTE_CLOSE };
