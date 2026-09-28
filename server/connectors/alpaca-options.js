// Options spreads at the Alpaca PAPER broker (Phase 71): one multi-leg order per trade.
//   openSpread   buy_to_open / sell_to_open every leg of the plan (optionsData.legs; a single
//                contract: one leg) as ONE limit order at the plan's net debit, day. Alpaca's mleg
//                limit_price is the NET price: positive = a debit (what a debit spread costs).
//   closeSpread  the opposite legs (sell_to_close / buy_to_close) as one MARKET order: SignalDesk
//                decides the exit (premium stop / target, exit-monitor.premiumExit) and Alpaca fills it.
// Refused outside regular hours (a queued day order fills far from the approved price).
// Never throws: { ok, brokerId, ... } or { ok: false, error }.
const { paper } = require('./alpaca-api');

const px2 = (x) => Math.max(0.01, Math.round(x * 100) / 100).toFixed(2);
const legsOf = (od) => (od && Array.isArray(od.legs) && od.legs.length ? od.legs : od && od.contract ? [{ side: 'buy', contract: od.contract, ratio: 1 }] : []).filter((l) => l.contract);

async function marketOpen() {
  const c = await paper.getClock();
  if (!c.ok) return c;
  return c.isOpen ? { ok: true } : { ok: false, error: `MARKET_CLOSED: US options market is closed (next open ${c.nextOpen ? new Date(c.nextOpen).toISOString() : 'unknown'})` };
}

async function place(body, what) {
  const r = await paper.request('/v2/orders', { method: 'POST', body });
  if (!r.ok) return { ...r, error: `Alpaca Paper refused the ${what}: ${r.error}` };
  return r.body && r.body.id ? { ok: true, brokerId: r.body.id, status: r.body.status } : { ok: false, error: `Alpaca Paper: ${what} response had no id` };
}

// limit: the net debit to send (Phase 74: execution/spread-entry.js prices it; default the plan's); suffix: a re-priced order's id tail.
async function openSpread(order, contracts, limit = null, suffix = '') {
  const od = order.optionsData;
  const legs = legsOf(od);
  if (!legs.length) return { ok: false, error: 'no option contract on this plan' };
  if (!(Number.isInteger(contracts) && contracts >= 1)) return { ok: false, error: `whole contracts only (got ${contracts})` };
  if (!(od.debit > 0)) return { ok: false, error: 'no net debit to limit the order at' };
  const open = await marketOpen();
  if (!open.ok) return open;
  const common = { qty: String(contracts), type: 'limit', limit_price: px2(limit || od.debit), time_in_force: 'day', client_order_id: `${String(order.id).slice(0, 120)}${suffix}` };
  const body = legs.length === 1 ? { ...common, symbol: legs[0].contract, side: 'buy' }
    : { ...common, order_class: 'mleg', legs: legs.map((l) => ({ symbol: l.contract, ratio_qty: String(l.ratio || 1), side: l.side, position_intent: l.side === 'buy' ? 'buy_to_open' : 'sell_to_open' })) };
  const r = await place(body, 'spread order');
  return r.ok ? { ...r, environment: 'alpaca-paper', entryType: 'limit', limitPrice: Number(px2(limit || od.debit)), product: od.label || order.asset } : r;
}

async function closeSpread(pos, clientOrderId) {
  const legs = legsOf(pos.optionsData);
  if (!legs.length) return { ok: false, error: 'no option contract on this position' };
  const open = await marketOpen();
  if (!open.ok) return open;
  const flip = (side) => (side === 'buy' ? 'sell' : 'buy');
  const common = { qty: String(pos.positionSize), type: 'market', time_in_force: 'day', client_order_id: String(clientOrderId).slice(0, 128) };
  const body = legs.length === 1 ? { ...common, symbol: legs[0].contract, side: 'sell' }
    : { ...common, order_class: 'mleg', legs: legs.map((l) => ({ symbol: l.contract, ratio_qty: String(l.ratio || 1), side: flip(l.side), position_intent: l.side === 'buy' ? 'sell_to_close' : 'buy_to_close' })) };
  return place(body, 'closing spread order');
}

module.exports = { openSpread, closeSpread, legsOf };
