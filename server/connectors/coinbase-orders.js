// Coinbase LIVE orders (Advanced Trade). Never throws: { ok, ... } or { ok: false, error }.
//   submitOrder  BUY for the risk-engine size with an ATTACHED take-profit/stop-
//                loss bracket (trigger_bracket_gtc): the exits live at Coinbase
//                and inherit the entry size, so the position is protected even if
//                SignalDesk is offline. Spot only (no shorts); client_order_id =
//                candidate id guards against duplicates.
//                Entry: 'maker' candidates (a limit inside the entry zone) are a
//                POST-ONLY limit (limit_limit_gtc) at min(best bid, best ask - one
//                quote step, zone top): it rests on the book (maker fee) and
//                Coinbase refuses it rather than let it cross. The reconciler
//                cancels it if still unfilled after 30 minutes. Otherwise market IOC.
//   sellMarket   plain market SELL (an approved Portfolio Pilot sell / trim / stop
//                on a broker-synced holding bought outside SignalDesk).
// USD vs USDC (Phase 54): the account's cash is USD + USDC, and Coinbase books
// USDC pairs separately. A BUY is routed to <BASE>-USDC when the USDC balance
// exceeds USD, or covers the order when USD cannot; otherwise <BASE>-USD. The
// balances are read fresh at approval (getAccount); unreadable -> -USD.
const { cbFetch, loadAuth, failure, productIncrements, getAccount, ORDERS_PATH } = require('./coinbase-api');

const base8 = (x) => (Math.floor(x * 1e8) / 1e8).toFixed(8).replace(/\.?0+$/, '');
const quotePx = (p) => (p >= 1 ? p.toFixed(2) : p.toFixed(6));
// Decimals of a step (1e-8 prints in exponent form, so go through toFixed).
const decimalsOf = (inc) => { const t = inc.toFixed(12).replace(/0+$/, ''); const i = t.indexOf('.'); return i < 0 ? 0 : t.length - i - 1; };
// x on the step `inc`: 'down' floors (sizes, buy limits), else nearest.
const onStep = (x, inc, mode) => (mode === 'down' ? Math.floor(x / inc + 1e-9) : Math.round(x / inc)) * inc;
const fmtStep = (x, inc, mode) => onStep(x, inc, mode).toFixed(decimalsOf(inc));

// The book a BUY of `notional` dollars goes to: { product, quote, balances }.
function routeProduct(asset, notional, balances) {
  const base = asset.replace(/-USDC?$/, '');
  const usd = (balances && balances.USD) || 0;
  const usdc = (balances && balances.USDC) || 0;
  const useUsdc = !!balances && (usdc > usd || (usd < notional && usdc >= notional));
  return { product: `${base}-${useUsdc ? 'USDC' : 'USD'}`, quote: useUsdc ? 'USDC' : 'USD', balances: balances || null };
}

function rejection(body, what) {
  const e = (body && body.error_response) || {};
  return { ok: false, error: `Coinbase rejected ${what}: ${e.error_details || e.message || e.new_order_failure_reason || e.preview_failure_reason || e.error || 'unknown reason'}` };
}

// opts: { bid, ask } the live best bid / ask (coinbase-socket); { balances } to skip the account read (tests).
async function submitOrder(candidate, size, entryPrice, opts = {}) {
  const c = candidate;
  const tp = c.targets && c.targets[0] && c.targets[0].price;
  const maker = c.entryLiquidity === 'maker';
  let balances = opts.balances;
  if (balances === undefined && c.market === 'crypto') { const a = await getAccount().catch(() => null); balances = a && a.ok ? a.balances : null; }
  const route = routeProduct(c.asset, size * entryPrice, balances);
  const inc = c.market === 'crypto' ? await productIncrements(route.product) : null;
  const px = (x, mode) => (inc ? fmtStep(x, inc.quote, mode) : quotePx(x));
  const qty = inc ? fmtStep(size, inc.base, 'down') : base8(size);
  const underAsk = opts.ask > 0 ? opts.ask - (inc ? inc.quote : 0) : Infinity;
  const limit = maker ? Math.min(c.entryZone.max, opts.bid > 0 ? opts.bid : entryPrice, underAsk) : null;
  const buyAt = maker ? Number(px(limit, 'down')) : entryPrice;
  let problem = null;
  if (c.market !== 'crypto') problem = `Coinbase live routing supports crypto only (got "${c.market}")`;
  else if (c.direction !== 'long') problem = 'spot accounts cannot open shorts';
  else if (!(size > 0) || !(Number(qty) > 0)) problem = `invalid size ${size}`;
  else if (!(tp > 0)) problem = 'no take-profit: live bracket orders need one (Portfolio Pilot core holdings have none, by design); nothing was sent. Buy it on paper, or at the broker';
  else if (!(c.invalidation > 0) || !(c.invalidation < buyAt && buyAt < tp)) problem = `levels out of order: stop ${c.invalidation}, entry ${buyAt}, target ${tp}`;
  if (problem) return { ok: false, error: `Coinbase order not sent: ${problem}` };

  const auth = loadAuth();
  if (auth.error) return { ok: false, error: auth.error };
  let body;
  try {
    body = await cbFetch(auth, 'POST', ORDERS_PATH, {
      body: {
        client_order_id: String(c.id),
        product_id: route.product,
        side: 'BUY',
        order_configuration: maker
          ? { limit_limit_gtc: { base_size: qty, limit_price: px(limit, 'down'), post_only: true } }
          : { market_market_ioc: { base_size: qty } },
        attached_order_configuration: {
          trigger_bracket_gtc: { limit_price: px(tp), stop_trigger_price: px(c.invalidation) },
        },
      },
    });
  } catch (err) {
    return failure(err);
  }
  // Coinbase reports rejections with HTTP 200 and success: false.
  if (!body || body.success !== true) return rejection(body, 'order');
  const orderId = body.success_response && body.success_response.order_id;
  if (!orderId) return { ok: false, error: 'Coinbase: order response had no order_id' };
  return { ok: true, brokerId: orderId, environment: 'coinbase-live', entryType: maker ? 'limit' : 'market', limitPrice: maker ? buyAt : null,
    product: route.product, quoteCurrency: route.quote };
}

async function sellMarket(product, size, clientOrderId) {
  if (!/^[A-Z0-9]{1,10}-USDC?$/.test(String(product)) || !(size > 0)) return { ok: false, error: `Coinbase sell not sent: invalid ${product} ${size}` };
  const inc = await productIncrements(product);
  const qty = inc ? fmtStep(size, inc.base, 'down') : (Math.floor(size * 1e8) / 1e8).toFixed(8);
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
  if (!body || body.success !== true) return rejection(body, 'sell');
  const orderId = body.success_response && body.success_response.order_id;
  return orderId ? { ok: true, brokerId: orderId, qty: Number(qty), environment: 'coinbase-live' } : { ok: false, error: 'Coinbase: order response had no order_id' };
}

// A stand-alone protective SELL bracket (take-profit limit + stop trigger) for `size`
// already held: re-arms a position whose attached bracket was canceled for a manual
// close that then could not sell (coinbase-exit.js, Phase 60), so it is never left bare.
async function placeBracket(product, size, takeProfit, stop, clientOrderId) {
  if (!/^[A-Z0-9]{1,10}-USDC?$/.test(String(product)) || !(size > 0) || !(stop > 0) || !(takeProfit > stop)) return { ok: false, error: `Coinbase bracket not sent: invalid ${product} ${size} ${stop}/${takeProfit}` };
  const inc = await productIncrements(product);
  const qty = inc ? fmtStep(size, inc.base, 'down') : base8(size);
  const px = (x) => (inc ? fmtStep(x, inc.quote) : quotePx(x));
  const auth = loadAuth();
  if (auth.error) return { ok: false, error: auth.error };
  let body;
  try {
    body = await cbFetch(auth, 'POST', ORDERS_PATH, { body: { client_order_id: String(clientOrderId), product_id: product, side: 'SELL',
      order_configuration: { trigger_bracket_gtc: { base_size: qty, limit_price: px(takeProfit), stop_trigger_price: px(stop) } } } });
  } catch (err) {
    return failure(err);
  }
  if (!body || body.success !== true) return rejection(body, 'bracket');
  const orderId = body.success_response && body.success_response.order_id;
  return orderId ? { ok: true, brokerId: orderId } : { ok: false, error: 'Coinbase: bracket response had no order_id' };
}

module.exports = { submitOrder, sellMarket, placeBracket, routeProduct };
