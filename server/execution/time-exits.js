// Time exits (Phase 76 audit): the plan's clock, not only its price, ends a trade.
//   SESSION_CLOSE  an equity-day (ORB) trade is a DAY trade ("closed by the end of the session"):
//                  FLATTEN_MIN minutes before the bell (the Alpaca clock: 1 pm early closes too) it is
//                  closed at market. Its Alpaca 'day' bracket would otherwise expire at the close and
//                  leave the shares unprotected overnight.
//   EXPIRY_EXIT    an automated options position (System 5) is closed EXPIRY_DAYS calendar days before
//                  its expiration: a debit spread held into expiry week carries pin / assignment risk and
//                  the fastest theta, which the plan (exits "well before expiry") never meant to take.
// Session hours only (a closing order needs an open market). PAPER positions close in the internal ledger
// (at the exit quote, like [Close]) or at Alpaca Paper (alpaca-paper.sendClose: a working entry is canceled,
// never a closing trade). LIVE positions are never sold here: they are reported (the user closes them).
// One attempt per position per RETRY_MS; a position already closing is left alone.
const prices = require('../market/latest-prices');
const session = require('../market/market-session');
const { daysToExpiry } = require('../connectors/options-data');

const FLATTEN_MIN = 10;
const EXPIRY_DAYS = 3;
const RETRY_MS = 60 * 1000;
const tries = new Map(); // position id -> last attempt (ms)
const warned = new Set();

// Why `p` must be closed now, or null.
function due(p, now = Date.now()) {
  if (!session.isEquityMarketOpen(now)) return null;
  if (p.strategyId === 'equity-day' && p.market === 'stocks' && session.closeMs(now) - now <= FLATTEN_MIN * 60000) {
    return { reason: 'SESSION_CLOSE', leg: 'session_close', why: `day trade: flattened ${FLATTEN_MIN} min before the close` };
  }
  const od = p.optionsData;
  if (p.market === 'options' && p.strategyId === 'options-system' && od && od.expiration && daysToExpiry(od.expiration, now) <= EXPIRY_DAYS) {
    return { reason: 'EXPIRY_EXIT', leg: 'expiry_exit', why: `${daysToExpiry(od.expiration, now)} day(s) to its ${od.expiration} expiration (exits ${EXPIRY_DAYS} days before)` };
  }
  return null;
}

// -> [{ id, reason, trade? | pending? | error? | live? }]
async function run(ledger, { isBusy = () => false } = {}, now = Date.now()) {
  const out = [];
  const ap = require('./alpaca-paper');
  for (const p of ledger.getActivePositions()) {
    const d = due(p, now);
    if (!d || isBusy(p.id) || ap.isClosing(p.id) || p.paperExitOrderId) continue;
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

module.exports = { run, due, reset, FLATTEN_MIN, EXPIRY_DAYS };
