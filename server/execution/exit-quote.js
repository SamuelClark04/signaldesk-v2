// "What you see is what you get" exit accounting (Phase 59). ONE function, quote(),
// prices a paper exit: the ledger books every close with it (paper-ledger.js
// closePosition), every open position carries its result (exitQuote, via
// getActivePositions) and POSITION_MARKS re-sends it every MARK_MS, so the "Net if
// closed now" on screen and the Journal entry are the same numbers.
//   options   exitValue = what closing fetches per share (option-marks saleValue: a
//             package spread's net mid - 0.15 x combined leg bid/ask, charged ONCE;
//             single legs at the bid), midValue = the net mid (the mark);
//             gross = (exitValue - debit) x 100 x size; midGross the same at the mid
//   stocks / crypto  exit at the live price (grossPnl)
//   fees      estimateRoundTripFees: options $0.65 / leg / fill (entry + exit),
//             linear legs as the order was sized (exit taker for a manual close)
// Manual close (closeManually): the client sends the `at` of the quote it SHOWED; if
// that quote was issued in the last QUOTE_MAX_AGE_MS it is booked as is (to the
// cent), else the position is re-quoted at the live price and that is booked.
const prices = require('../market/latest-prices');
const { saleValue } = require('./option-marks');
const { grossPnl, feeLegs } = require('../risk/scenarios');
const { estimateRoundTripFees } = require('../risk/cost-authority');

const QUOTE_MAX_AGE_MS = 45 * 1000;
const MARK_MS = 5000;
const issued = new Map(); // position id -> recent quotes (newest last)

// The exit of `pos` at underlying / asset price `price` now. kind: 'stop' (manual
// close, stop: taker exit) | 'target'. null when there is nothing to price it at.
function quote(pos, price, kind = 'stop', at = Date.now()) {
  const size = pos.positionSize;
  let q;
  if (pos.market === 'options') {
    const m = saleValue(pos, price, at);
    if (!m) return null;
    const od = pos.optionsData;
    const k = od.multiplier * size;
    const mid = Number.isFinite(m.mid) ? m.mid : m.value;
    q = { exitValue: m.value, midValue: mid, gross: (m.value - od.debit) * k, midGross: (mid - od.debit) * k, basis: m.basis, interpolated: !!m.interpolated };
  } else {
    if (!(price > 0)) return null;
    const g = grossPnl(pos, pos.fillPrice, price);
    q = { exitValue: price, midValue: price, gross: g, midGross: g, basis: 'live', interpolated: false };
  }
  const fees = estimateRoundTripFees(pos.market, size, pos.fillPrice, price, feeLegs(pos, kind));
  const net = q.gross - fees;
  return { id: pos.id, at, underlying: price > 0 ? price : null, ...q, fees, net, r: pos.dollarRisk > 0 ? net / pos.dollarRisk : null, kind };
}

// Quote and remember it (so the exact quote a client saw can be booked).
function issue(pos, price, at = Date.now()) {
  const q = quote(pos, price, 'stop', at);
  if (!q) return null;
  const list = (issued.get(pos.id) || []).filter((x) => at - x.at <= QUOTE_MAX_AGE_MS);
  list.push(q);
  issued.set(pos.id, list.slice(-40));
  return q;
}

// MANUAL_CLOSE: book the quote the user saw (quoteAt), if still recent; else re-quote now.
function closeManually(ledger, id, quoteAt, now = Date.now()) {
  const pos = ledger.getActivePositions().find((p) => p.id === id);
  if (!pos) throw new Error(`no open position ${id}`);
  if (pos.execution === 'LIVE') throw new Error('LIVE_CLOSE_UNSUPPORTED');
  const live = prices.getLatestPrice(pos.asset);
  if (!(live > 0)) throw new Error('NO_LIVE_PRICE');
  const seen = (issued.get(id) || []).find((x) => x.at === Number(quoteAt));
  const q = seen && now - seen.at <= QUOTE_MAX_AGE_MS ? seen : quote(pos, live, 'stop', now);
  if (!q) throw new Error('NO_LIVE_PRICE');
  issued.delete(id);
  return ledger.closePosition(id, q.underlying || live, 'MANUAL_CLOSE', { exitQuote: { at: q.at, booked: seen === q ? 'as shown' : 're-quoted at close' } }, q);
}

// POSITION_MARKS every MARK_MS: every paper position's exit quote at the live price
// (option marks move with the underlying between chain polls: option-marks.js).
let timer = null;
let lastKey = '';
function start(ledger, broadcast) {
  if (timer) return;
  timer = setInterval(() => {
    try {
      const quotes = {};
      for (const p of ledger.getActivePositions()) if (p.exitQuote) quotes[p.id] = p.exitQuote;
      const key = JSON.stringify(Object.values(quotes).map((q) => [q.id, Math.round(q.net * 100), Math.round(q.midGross * 100)]));
      if (key !== lastKey) { lastKey = key; broadcast('POSITION_MARKS', { at: Date.now(), quotes }); }
    } catch (err) {
      console.error('[exit-quote] marks failed:', err.message);
    }
  }, MARK_MS);
  timer.unref();
}
function stop() { clearInterval(timer); timer = null; }

module.exports = { quote, issue, closeManually, start, stop, QUOTE_MAX_AGE_MS, MARK_MS };
