// Plain market SELL at Coinbase for a holding bought outside SignalDesk (an
// approved Portfolio Pilot sell / trim / stop on a broker-synced balance). A
// market IOC order on the product's size step (rounded down, never more than
// asked); client_order_id = the Pilot action id, so a retry cannot sell twice.
// Never throws: { ok, brokerId } or { ok: false, error }.
const { cbFetch, loadAuth, failure, productIncrements, ORDERS_PATH } = require('./coinbase-api');

const decimalsOf = (inc) => { const t = inc.toFixed(12).replace(/0+$/, ''); const i = t.indexOf('.'); return i < 0 ? 0 : t.length - i - 1; };

async function sellMarket(product, size, clientOrderId) {
  if (!/^[A-Z0-9]{1,10}-USD$/.test(String(product)) || !(size > 0)) return { ok: false, error: `Coinbase sell not sent: invalid ${product} ${size}` };
  const inc = await productIncrements(product);
  const qty = inc ? (Math.floor(size / inc.base + 1e-9) * inc.base).toFixed(decimalsOf(inc.base)) : (Math.floor(size * 1e8) / 1e8).toFixed(8);
  if (!(Number(qty) > 0)) return { ok: false, error: `Coinbase sell not sent: ${size} is below ${product}'s size step` };
  const auth = loadAuth();
  if (auth.error) return { ok: false, error: auth.error };
  let body;
  try {
    body = await cbFetch(auth, 'POST', ORDERS_PATH, { body: { client_order_id: String(clientOrderId), product_id: product, side: 'SELL',
      order_configuration: { market_market_ioc: { base_size: qty } } } });
  } catch (err) {
    return failure(err);
  }
  if (!body || body.success !== true) {
    const e = (body && body.error_response) || {};
    return { ok: false, error: `Coinbase rejected sell: ${e.error_details || e.message || e.new_order_failure_reason || e.preview_failure_reason || e.error || 'unknown reason'}` };
  }
  const orderId = body.success_response && body.success_response.order_id;
  return orderId ? { ok: true, brokerId: orderId, qty: Number(qty), environment: 'coinbase-live' } : { ok: false, error: 'Coinbase: order response had no order_id' };
}

module.exports = { sellMarket };
