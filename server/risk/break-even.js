// Break-even, fee hurdle and cashout variance (Phase 63). One place for the maths the
// position card, the chart's BE line, the trade ticket, staged approvals and the
// Journal's execution audit all show:
//   breakEvenPrice   the SELL price (a long's fill: the best bid) at which closing nets $0
//                    after the entry fee and the exit taker fee: (cost + entry fee) /
//                    (size x (1 - exit rate)); short: the mirror image. Phase 65: for an
//                    open position it is a constant (no live spread term), so the BE line
//                    never moves with the ticks; the pre-trade hurdle alone adds the
//                    half-spread (spread) it will cross.
//   feeHurdle        before opening: the round-trip fees on `notional` and the % move
//                    needed to break even (entry at the ask for a taker entry, exit at
//                    the bid, both Coinbase fees). With a live bid / ask the EXACT fee
//                    rates are used (the spread is real); without one the cost model's
//                    per-leg rates (taker incl. the spread allowance). wide: > 2.5%.
//   spreadGate       Phase 65: a crypto setup whose live bid / ask is wider than 0.45% of
//                    the mid is never staged (WIDE_CRYPTO_SPREAD); no fresh book: not judged.
//   cashoutVariance  a live close's expected cashout (best bid x qty - fee, right
//                    before the sell) vs the actual fill (qty x avg price - real fee).
const { legRate, coinbaseFees } = require('./cost-authority');

const WIDE_HURDLE = 0.025;
const QUOTE_MAX_AGE_MS = 60 * 1000;
const MAX_CRYPTO_SPREAD = 0.0045;

// A leg's fee rate: Coinbase's exact fee in force (the account's tier once read), else the model's.
const exactRate = (market, liquidity = 'taker') => (market === 'crypto' ? coinbaseFees()[liquidity === 'maker' ? 'maker' : 'taker'] : legRate(market, liquidity));

// spread: last trade minus the price the close fills at (long: last - bid; short: ask - last).
function breakEvenPrice({ direction = 'long', fillPrice, size, entryFee = 0, exitRate, spread = 0 }) {
  if (!(fillPrice > 0 && size > 0) || !(exitRate >= 0 && exitRate < 1)) return null;
  const p = direction === 'short'
    ? (fillPrice * size - entryFee) / (size * (1 + exitRate)) - spread
    : (fillPrice * size + entryFee) / (size * (1 - exitRate)) + spread;
  return p > 0 ? p : null;
}

// A fresh Coinbase top of book for `product` ({ bid, ask } | null), from the ticker stream.
function liveQuote(product, now = Date.now()) {
  let t = null;
  try { t = require('../connectors/coinbase-socket').getLatest(product); } catch { return null; }
  const age = t && t.time ? now - Date.parse(t.time) : Infinity;
  return t && t.bid > 0 && t.ask >= t.bid && age <= QUOTE_MAX_AGE_MS ? { bid: t.bid, ask: t.ask, price: t.price } : null;
}

// Round-trip fee hurdle for opening `notional` at `price` (the live / reference price).
// quote: { bid, ask } or null. -> { entryFee, exitFee, fees, spreadCost, hurdlePct, breakEven, wide, basis }
function feeHurdle({ market, price, notional, direction = 'long', entryLiquidity = 'taker', quote = null }) {
  if (!(price > 0 && notional > 0) || market === 'options') return null;
  const real = market === 'crypto' && quote && quote.bid > 0 && quote.ask >= quote.bid;
  const mid = real ? (quote.bid + quote.ask) / 2 : price;
  const half = real ? (quote.ask - quote.bid) / 2 : 0;
  const long = direction !== 'short';
  const taker = entryLiquidity !== 'maker';
  const fill = long ? (taker ? mid + half : mid - half) : (taker ? mid - half : mid + half); // taker crosses, maker rests
  const inRate = real ? exactRate(market, entryLiquidity) : legRate(market, entryLiquidity);
  const outRate = real ? exactRate(market, 'taker') : legRate(market, 'taker');
  const size = notional / fill;
  const entryFee = notional * inRate;
  const breakEven = breakEvenPrice({ direction, fillPrice: fill, size, entryFee, exitRate: outRate, spread: half });
  if (!breakEven) return null;
  const exitFee = breakEven * size * outRate;
  const hurdlePct = long ? breakEven / mid - 1 : 1 - breakEven / mid;
  return { entryFee, exitFee, fees: entryFee + exitFee, spreadCost: 2 * half * size, spreadPct: real ? (quote.ask - quote.bid) / mid : null,
    hurdlePct, breakEven, wide: hurdlePct > WIDE_HURDLE, basis: real ? 'live bid / ask + Coinbase fees' : 'fee model' };
}

// A staged order's hurdle at its own size (crypto: the live Coinbase book).
function hurdleFor(order, now = Date.now()) {
  if (!order || order.market === 'options' || !(order.positionSize > 0 && order.entryPrice > 0)) return null;
  const quote = order.market === 'crypto' ? liveQuote(order.brokerProduct || order.asset, now) : null;
  return feeHurdle({ market: order.market, price: order.entryPrice, notional: order.positionSize * order.entryPrice, direction: order.direction, entryLiquidity: order.entryLiquidity, quote });
}

// Phase 65 hard gate: { ok, spreadPct, reason } for a crypto product's live book (no fresh book: ok, unjudged).
function spreadGate(product, now = Date.now()) {
  const q = liveQuote(product, now);
  if (!q) return { ok: true, spreadPct: null, reason: null };
  const spreadPct = (q.ask - q.bid) / ((q.ask + q.bid) / 2);
  return spreadPct > MAX_CRYPTO_SPREAD
    ? { ok: false, spreadPct, reason: `WIDE_CRYPTO_SPREAD: bid/ask spread ${(spreadPct * 100).toFixed(2)}% exceeds ${(MAX_CRYPTO_SPREAD * 100).toFixed(2)}% cap (${q.bid} / ${q.ask})` }
    : { ok: true, spreadPct, reason: null };
}

// Expected vs actual cashout of a sell. expected: best bid x qty - fee (before the sell);
// actual: filled qty x average price - Coinbase's fee. Scaled to the filled quantity.
function cashoutVariance({ expected, expectedQty, filledQty, avgFillPrice, fees = 0, expectedBid = null, basis = 'best bid' }) {
  if (!Number.isFinite(expected) || !(filledQty > 0 && avgFillPrice > 0)) return null;
  const exp = expectedQty > 0 ? expected * (filledQty / expectedQty) : expected;
  const actual = filledQty * avgFillPrice - fees;
  const variance = actual - exp;
  return { expected: exp, actual, variance, favorable: variance >= 0, expectedBid, avgFillPrice, filledQty, fees, basis };
}

module.exports = { breakEvenPrice, feeHurdle, hurdleFor, liveQuote, spreadGate, cashoutVariance, exactRate, WIDE_HURDLE, QUOTE_MAX_AGE_MS, MAX_CRYPTO_SPREAD };
