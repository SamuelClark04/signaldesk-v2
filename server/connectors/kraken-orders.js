// Kraken Pro LIVE orders (Phase 69A). Never throws: { ok, ... } or { ok: false, error, uncertain? }
// (uncertain: timeout / 429 / 5xx / Kraken busy: the order may exist: coinbase-exit.js verifies).
//   submitOrder   BUY (market IOC, or a POST-ONLY limit for 'maker' candidates) with a
//                 CONDITIONAL CLOSE stop-loss (close[ordertype]=stop-loss, close[price]=stop):
//                 Kraken places the protective stop the moment the entry fills, so the position
//                 is protected even if SignalDesk is offline. Kraken spot holds ONE resting sell
//                 per quantity (the coins go on hold), so the resting exit is the stop; the T1
//                 target is taken by SignalDesk (ratchet.watch -> a market sell at T1).
//                 A Kraken stop-loss triggers a MARKET sell (no 5% stop-limit gap as on Coinbase).
//                 Routed to the USD book, or the USDC book when USD cash cannot cover it.
//   placeBracket  a stand-alone stop-loss SELL (re-arm after a refused / partial close, the
//                 Phase 68 ratchet's new stop); the target argument is SignalDesk's to watch
//   sellMarket    a market SELL ([Close], T1)
//   clientIdOf    Kraken's cl_ord_id is a UUID (or <= 18 chars): SignalDesk ids map to a
//                 deterministic UUID, so recovery / uncertain-sell lookups find their orders
//   listOrders / findOrderByClientId   open + closed orders since a time, by product / side
const crypto = require('crypto');
const api = require('./kraken-api');
const pairs = require('./kraken-pairs');

const clientIdOf = (id) => {
  const h = crypto.createHash('sha256').update(String(id)).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

async function addOrder(params, what) {
  const r = await api.call('AddOrder', params);
  if (!r.ok) return { ...r, error: r.uncertain ? r.error : `Kraken rejected ${what}: ${r.error.replace(/^Kraken: /, '')}` };
  const txid = r.result && Array.isArray(r.result.txid) ? r.result.txid[0] : null;
  return txid ? { ok: true, brokerId: txid, descr: r.result.descr || null } : { ok: false, error: 'Kraken: order response had no txid' };
}

// The book a BUY goes to: the USD pair, or the USDC pair when only USDC covers it.
async function bookFor(asset, notional, balances) {
  const usd = pairs.get(asset.replace(/-USDC$/, '-USD'));
  const usdc = pairs.get(asset.replace(/-USD$/, '-USDC'));
  if (usd && usdc && balances && balances.USD < notional && balances.USDC >= notional) return usdc;
  return usd || usdc;
}

async function submitOrder(candidate, size, entryPrice, opts = {}) {
  const c = candidate;
  if (c.direction === 'short') return { ok: false, error: 'Kraken order not sent: spot shorts are not supported' };
  await pairs.refresh();
  let balances = opts.balances;
  if (balances === undefined) { const a = await api.getAccount(); balances = a.ok ? a.balances : null; }
  const e = await bookFor(c.asset, size * entryPrice, balances);
  if (!e) return { ok: false, error: `Kraken order not sent: ${c.asset} is not listed on Kraken Pro` };
  const maker = c.entryLiquidity === 'maker' && opts.bid > 0;
  const limit = maker ? Math.min(opts.bid, c.entryZone && c.entryZone.max > 0 ? c.entryZone.max : opts.bid) : null;
  const vol = pairs.volume(e, size);
  const problem = pairs.minProblem(e, Number(vol), limit || entryPrice) || (!(c.invalidation > 0) ? 'no stop price' : null);
  if (problem) return { ok: false, error: `Kraken order not sent: ${problem}` };
  const r = await addOrder({ pair: e.altname, type: 'buy', ordertype: maker ? 'limit' : 'market', volume: vol, ...(maker ? { price: pairs.price(e, limit), oflags: 'post' } : {}),
    cl_ord_id: clientIdOf(c.id), 'close[ordertype]': 'stop-loss', 'close[price]': pairs.price(e, c.invalidation) }, 'order');
  if (!r.ok) return r;
  return { ...r, environment: 'kraken-live', entryType: maker ? 'limit' : 'market', limitPrice: maker ? Number(pairs.price(e, limit)) : null, product: e.symbol, qty: Number(vol) };
}

// Stand-alone protective stop-loss SELL for `size` already held (the target is watched by SignalDesk).
async function placeBracket(product, size, takeProfit, stop, clientOrderId) {
  await pairs.refresh();
  const e = pairs.get(product);
  if (!e || !(size > 0) || !(stop > 0)) return { ok: false, error: `Kraken stop not sent: invalid ${product} ${size} @ ${stop}` };
  const vol = pairs.volume(e, size);
  if (!(Number(vol) > 0)) return { ok: false, error: `Kraken stop not sent: ${size} is below ${e.wsname}'s volume step` };
  return addOrder({ pair: e.altname, type: 'sell', ordertype: 'stop-loss', price: pairs.price(e, stop), volume: vol, cl_ord_id: clientIdOf(clientOrderId) }, 'stop');
}

async function sellMarket(product, size, clientOrderId) {
  await pairs.refresh();
  const e = pairs.get(product);
  if (!e || !(size > 0)) return { ok: false, error: `Kraken sell not sent: invalid ${product} ${size}` };
  const vol = pairs.volume(e, size);
  if (!(Number(vol) > 0)) return { ok: false, error: `Kraken sell not sent: ${size} is below ${e.wsname}'s volume step` };
  const r = await addOrder({ pair: e.altname, type: 'sell', ordertype: 'market', volume: vol, cl_ord_id: clientIdOf(clientOrderId) }, 'sell');
  return r.ok ? { ...r, qty: Number(vol), environment: 'kraken-live' } : { ...r, qty: Number(vol) };
}

// Open + closed orders since `sinceMs` on `products` (SignalDesk symbols; all when empty), one side or both.
async function listOrders({ sinceMs, side = null, products = [] } = {}) {
  const [open, closed] = await Promise.all([api.openOrders(), api.closedOrders(sinceMs - 5 * 60 * 1000)]);
  if (!open.ok) return open;
  if (!closed.ok) return closed;
  const orders = [...open.orders, ...closed.orders].filter((o) => (!side || o.side === side) && (!products.length || products.includes(o.product)));
  return { ok: true, orders };
}

async function findOrderByClientId(product, clientOrderId, sinceMs) {
  const r = await listOrders({ sinceMs, side: 'SELL', products: [product] });
  if (!r.ok) return r;
  const want = clientIdOf(clientOrderId);
  return { ok: true, order: r.orders.find((o) => o.clientOrderId === want) || null };
}

module.exports = { submitOrder, placeBracket, sellMarket, listOrders, findOrderByClientId, clientIdOf };
