// Break-even, fee hurdle and cashout variance (Phase 63). One place for the maths the
// position card, the chart's BE line, the trade ticket, staged approvals and the
// Journal's execution audit all show:
//   breakEvenPrice   the market price (last trade) at which closing NOW nets $0 after
//                    the entry fee, the exit fee and, for a long crypto position, the
//                    current distance from the last trade down to the best bid (a
//                    market sell fills at the bid). Long: (cost + entry fee) / (size x
//                    (1 - exit rate)) + (last - bid); short: the mirror image.
//   feeHurdle        before opening: the round-trip fees on `notional` and the % move
//                    needed to break even (entry at the ask for a taker entry, exit at
//                    the bid, both Coinbase fees). With a live bid / ask the EXACT fee
//                    rates are used (the spread is real); without one the cost model's
//                    per-leg rates (taker incl. the spread allowance). wide: > 2.5%.
//   cashoutVariance  a live close's expected cashout (best bid x qty - fee, right
//                    before the sell) vs the actual fill (qty x avg price - real fee).
const { legRate, COINBASE_TAKER_FEE, COINBASE_MAKER_FEE } = require('./cost-authority');

const WIDE_HURDLE = 0.025;
const QUOTE_MAX_AGE_MS = 60 * 1000;

// A leg's fee rate: Coinbase's exact fee (a real bid / ask carries the spread), else the model's.
const exactRate = (market, liquidity = 'taker') => (market === 'crypto' ? (liquidity === 'maker' ? COINBASE_MAKER_FEE : COINBASE_TAKER_FEE) : legRate(market, liquidity));

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

// Expected vs actual cashout of a sell. expected: best bid x qty - fee (before the sell);
// actual: filled qty x average price - Coinbase's fee. Scaled to the filled quantity.
function cashoutVariance({ expected, expectedQty, filledQty, avgFillPrice, fees = 0, expectedBid = null, basis = 'best bid' }) {
  if (!Number.isFinite(expected) || !(filledQty > 0 && avgFillPrice > 0)) return null;
  const exp = expectedQty > 0 ? expected * (filledQty / expectedQty) : expected;
  const actual = filledQty * avgFillPrice - fees;
  const variance = actual - exp;
  return { expected: exp, actual, variance, favorable: variance >= 0, expectedBid, avgFillPrice, filledQty, fees, basis };
}

module.exports = { breakEvenPrice, feeHurdle, hurdleFor, liveQuote, cashoutVariance, exactRate, WIDE_HURDLE, QUOTE_MAX_AGE_MS };
