// OKX US LIVE orders (Phase 69B). Never throws: { ok, ... } or { ok: false, error, uncertain? }
// (uncertain: timeout / 429 / 5xx / OKX busy: the order may exist: coinbase-exit.js verifies).
//   submitOrder   BUY (market, sized in the coin: tgtCcy base_ccy; or a POST-ONLY limit for
//                 'maker' candidates) with an ATTACHED stop-loss (attachAlgoOrds: slTriggerPx =
//                 the stop, slOrdPx -1 = sell at market when triggered): OKX places the
//                 protective stop as the entry fills, so the position is protected even if
//                 SignalDesk is offline. As on Kraken, the resting exit is the stop; the T1
//                 target is taken by SignalDesk (ratchet.watch -> a market sell at T1).
//                 An OKX stop triggers a MARKET sell (no 5% stop-limit gap as on Coinbase).
//                 Book: the X-USD instrument paying with USD, else with USDC (OKX's USD books
//                 settle in either: tradeQuoteCcy), else the X-USDC / X-USDT book the cash covers.
//   placeBracket  a stand-alone stop (order-algo, ordType 'conditional', slOrdPx -1) for coins
//                 already held (re-arm after a refused / partial close, the ratchet's new stop)
//   sellMarket    a market SELL ([Close], T1)
//   listOrders / findOrderByClientId   pending + history (7 days) SPOT orders / one by clOrdId
const api = require('./okx-api');
const pairs = require('./okx-pairs');

async function place(path, body, what, idOf) {
  const r = await api.call('POST', path, { body });
  if (!r.ok) return { ...r, error: r.uncertain ? r.error : `OKX rejected ${what}: ${r.error.replace(/^OKX: /, '')}` };
  const d = r.data[0] || {};
  const id = d.ordId || d.algoId;
  return id ? { ok: true, brokerId: idOf(body.instId, id) } : { ok: false, error: `OKX: ${what} response had no id` };
}

// The book + the quote currency a BUY of `notional` pays with (balances unknown: the first book).
function bookFor(asset, notional, balances) {
  const list = pairs.books(asset);
  for (const e of list) {
    for (const q of e.tradeQuotes.filter((x) => pairs.QUOTES.includes(x))) if (!balances || (balances[q] || 0) >= notional) return { e, quote: q };
  }
  return list[0] ? { e: list[0], quote: list[0].quote } : null;
}

async function submitOrder(candidate, size, entryPrice, opts = {}) {
  const c = candidate;
  if (c.direction === 'short') return { ok: false, error: 'OKX order not sent: spot shorts are not supported' };
  await pairs.refresh();
  let balances = opts.balances;
  if (balances === undefined) { const a = await api.getAccount(); balances = a.ok ? a.balances : null; }
  const b = bookFor(c.asset, size * entryPrice, balances);
  if (!b) return { ok: false, error: `OKX order not sent: ${c.asset} is not listed on OKX US` };
  const { e, quote } = b;
  const maker = c.entryLiquidity === 'maker' && opts.bid > 0;
  const limit = maker ? Math.min(opts.bid, c.entryZone && c.entryZone.max > 0 ? c.entryZone.max : opts.bid) : null;
  const sz = pairs.size(e, size);
  const problem = pairs.minProblem(e, Number(sz)) || (!(c.invalidation > 0) ? 'no stop price' : null);
  if (problem) return { ok: false, error: `OKX order not sent: ${problem}` };
  const clOrdId = api.clientIdOf(c.id);
  const r = await place('/api/v5/trade/order', { instId: e.instId, tdMode: 'cash', side: 'buy', ordType: maker ? 'post_only' : 'market', sz, ...(maker ? { px: pairs.price(e, limit) } : { tgtCcy: 'base_ccy' }),
    clOrdId, ...(quote !== e.quote ? { tradeQuoteCcy: quote } : {}), attachAlgoOrds: [{ attachAlgoClOrdId: api.stopIdOf(clOrdId), slTriggerPx: pairs.price(e, c.invalidation), slOrdPx: '-1' }] }, 'order', api.idOf);
  if (!r.ok) return r;
  return { ...r, environment: 'okx-live', entryType: maker ? 'limit' : 'market', limitPrice: maker ? Number(pairs.price(e, limit)) : null, product: e.symbol, quoteCcy: quote, qty: Number(sz) };
}

const bookOf = (product) => pairs.get(product) || pairs.books(product)[0] || null;

// A BUY's fee is charged in the coin: a stop / sell for a little more than is free (the gross size,
// a rounding step) would be refused (51008). Within FEE_SLACK of the size: what is free instead.
const FEE_SLACK = 0.005;
async function fit(e, size) {
  const a = await api.getAvailable(e.base);
  return a.ok && a.available < size && a.available >= size * (1 - FEE_SLACK) ? a.available : size;
}

// Stand-alone protective stop for `size` already held (the target is watched by SignalDesk).
async function placeBracket(product, size, takeProfit, stop, clientOrderId) {
  await pairs.refresh();
  const e = bookOf(product);
  if (!e || !(size > 0) || !(stop > 0)) return { ok: false, error: `OKX stop not sent: invalid ${product} ${size} @ ${stop}` };
  const sz = pairs.size(e, await fit(e, size));
  if (!(Number(sz) > 0)) return { ok: false, error: `OKX stop not sent: ${size} is below ${e.instId}'s size step` };
  return place('/api/v5/trade/order-algo', { instId: e.instId, tdMode: 'cash', side: 'sell', ordType: 'conditional', sz, slTriggerPx: pairs.price(e, stop), slOrdPx: '-1',
    algoClOrdId: api.clientIdOf(clientOrderId) }, 'stop', api.algoIdOf);
}

async function sellMarket(product, size, clientOrderId) {
  await pairs.refresh();
  const e = bookOf(product);
  if (!e || !(size > 0)) return { ok: false, error: `OKX sell not sent: invalid ${product} ${size}` };
  const sz = pairs.size(e, await fit(e, size));
  if (!(Number(sz) > 0)) return { ok: false, error: `OKX sell not sent: ${size} is below ${e.instId}'s size step` };
  const r = await place('/api/v5/trade/order', { instId: e.instId, tdMode: 'cash', side: 'sell', ordType: 'market', sz, clOrdId: api.clientIdOf(clientOrderId) }, 'sell', api.idOf);
  return r.ok ? { ...r, qty: Number(sz), environment: 'okx-live' } : { ...r, qty: Number(sz) };
}

// Pending + recent SPOT orders since `sinceMs` for `products`' coins (any USD / USDC / USDT book).
async function listOrders({ sinceMs, side = null, products = [] } = {}) {
  const [open, closed] = await Promise.all([api.openOrders(), api.closedOrders(sinceMs - 5 * 60 * 1000)]);
  if (!open.ok) return open;
  if (!closed.ok) return closed;
  const bases = new Set(products.map(pairs.baseOf));
  return { ok: true, orders: [...open.orders, ...closed.orders].filter((o) => (!side || o.side === side) && (!bases.size || bases.has(pairs.baseOf(o.product)))) };
}

// The order SignalDesk sent as `clientOrderId` on `product` (OKX looks it up by clOrdId), or null.
async function findOrderByClientId(product, clientOrderId) {
  const e = bookOf(product);
  const r = await api.getOrder(`${e ? e.instId : product}:`, api.clientIdOf(clientOrderId));
  if (!r.ok) return r.notFound ? { ok: true, order: null } : r;
  return { ok: true, order: r };
}

module.exports = { submitOrder, placeBracket, sellMarket, listOrders, findOrderByClientId, clientIdOf: api.clientIdOf, bookFor };
