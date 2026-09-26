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
//   cashout   what the close deposits (exit notional less the exit fee), Phase 61;
//             linear legs as the order was sized (exit taker for a manual close)
// Phase 63 (net first): every quote splits its friction into entryFee (Coinbase's real
// entry fee once reconciled: pos.entryFeeActual, else the model's) and exitCost, and
// carries breakEven (the price at which closing now nets $0) and net / gross %. A long
// crypto position priced NOW (issue) sells at Coinbase's best bid: cashout = bid x size
// less the exact taker fee, and the net is that cashout less the cost basis and entry
// fee (the last-trade-to-bid gap is part of the exit cost). Without a fresh bid, or
// for a level exit (stop / target), the last price with the model's taker rate.
// Manual close (closeManually): the client sends the `at` of the quote it SHOWED; if
// that quote was issued in the last QUOTE_MAX_AGE_MS it is booked as is (to the
// cent), else the position is re-quoted at the live price and that is booked.
const prices = require('../market/latest-prices');
const { saleValue } = require('./option-marks');
const { grossPnl, feeLegs } = require('../risk/scenarios');
const { estimateRoundTripFees, legRate, OPTIONS_COMMISSION_PER_LEG } = require('../risk/cost-authority');
const be = require('../risk/break-even');

const QUOTE_MAX_AGE_MS = 45 * 1000;
const MARK_MS = 5000;
const issued = new Map(); // position id -> recent quotes (newest last)

// The best bid a long crypto close would sell at now (null: none fresh, or not within 5% of `price`).
function bidOf(pos, price, at) {
  if (pos.market !== 'crypto' || pos.direction === 'short' || !(price > 0)) return null;
  const q = be.liveQuote(pos.brokerProduct || pos.asset, at) || be.liveQuote(pos.asset, at);
  return q && Math.abs(q.bid / price - 1) <= 0.05 ? q.bid : null;
}

// The exit of `pos` at underlying / asset price `price` now. kind: 'stop' (manual
// close, stop: taker exit) | 'target'. null when there is nothing to price it at.
// bid: Coinbase's best bid (long crypto priced now), else null.
function quote(pos, price, kind = 'stop', at = Date.now(), bid = null) {
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
  // Cashout (Phase 61): the cash a close puts in the account, after the EXIT fee only:
  // long stock / crypto size x price (Phase 63: the best bid) less the taker fee; options
  // the exit value x 100 less the closing commissions. null for shorts (a close buys).
  const opt = pos.market === 'options';
  const legs = opt ? ((pos.optionsData.legs || []).length || 1) : 0;
  const atBid = !opt && bid > 0 && kind === 'stop';
  const sellPrice = atBid ? bid : price;
  const exitRate = opt ? 0 : atBid ? be.exactRate(pos.market, 'taker') : legRate(pos.market, 'taker');
  const exitFee = opt ? OPTIONS_COMMISSION_PER_LEG * legs * size : sellPrice * size * exitRate;
  const modelled = estimateRoundTripFees(pos.market, size, pos.fillPrice, price, feeLegs(pos, kind));
  const entryFee = opt ? OPTIONS_COMMISSION_PER_LEG * legs * size : Number.isFinite(pos.entryFeeActual) ? pos.entryFeeActual : size * pos.fillPrice * legRate(pos.market, pos.entryLiquidity);
  const spreadCost = atBid ? (price - bid) * size : 0;
  const fees = atBid || Number.isFinite(pos.entryFeeActual) ? entryFee + spreadCost + exitFee : modelled;
  const net = q.gross - fees;
  const cashout = opt ? q.exitValue * pos.optionsData.multiplier * size - exitFee : pos.direction === 'long' ? sellPrice * size - exitFee : null;
  const cost = opt ? pos.optionsData.debit * pos.optionsData.multiplier * size : pos.fillPrice * size;
  const breakEven = opt ? null : be.breakEvenPrice({ direction: pos.direction, fillPrice: pos.fillPrice, size, entryFee, exitRate, spread: spreadCost / size });
  return { id: pos.id, at, underlying: price > 0 ? price : null, ...q, fees, net, exitFee, cashout, r: pos.dollarRisk > 0 ? net / pos.dollarRisk : null, kind,
    entryFee, entryFeeActual: Number.isFinite(pos.entryFeeActual), exitCost: fees - entryFee, spreadCost, sellPrice, sellBasis: atBid ? 'best bid' : 'last price', bid: atBid ? bid : null,
    netPct: cost > 0 ? net / cost : null, grossPct: cost > 0 ? q.gross / cost : null, breakEven, breakEvenPct: breakEven ? breakEven / pos.fillPrice - 1 : null };
}

// Quote and remember it (so the exact quote a client saw can be booked).
function issue(pos, price, at = Date.now()) {
  const q = quote(pos, price, 'stop', at, bidOf(pos, price, at));
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
  const q = seen && now - seen.at <= QUOTE_MAX_AGE_MS ? seen : quote(pos, live, 'stop', now, bidOf(pos, live, now));
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

module.exports = { quote, issue, bidOf, closeManually, start, stop, QUOTE_MAX_AGE_MS, MARK_MS };
