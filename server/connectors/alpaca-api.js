// Alpaca Trading API (REST, on demand): account data + live order submission for
// the stock venue. Orders are bracket orders, so the stop and target live AT THE
// BROKER and protect the position even if SignalDesk is offline.
//
// Base URL: live by default. Point ALPACA_TRADING_BASE_URL at
// https://paper-api.alpaca.markets to test against an Alpaca Paper account
// (paper and live accounts use different key pairs).
//
// Never throws: every outcome is { ok: true, ... } or { ok: false, error }.
const DEFAULT_BASE_URL = 'https://api.alpaca.markets';
const TIMEOUT_MS = 8000;

const num = (x) => (x === undefined || x === null || x === '' ? null : Number(x));
const baseUrl = () => (process.env.ALPACA_TRADING_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
const environment = () => (baseUrl().includes('paper-api') ? 'alpaca-paper' : 'alpaca-live');
// Alpaca rejects sub-penny prices: 2 decimals at/above $1, 4 below.
const tick = (p) => (p >= 1 ? p.toFixed(2) : p.toFixed(4));

// One authenticated request. Resolves { ok, body } or { ok: false, error }.
async function alpacaFetch(path, { method = 'GET', body } = {}) {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_API_SECRET;
  if (!key || !secret) return { ok: false, error: 'ALPACA_API_KEY / ALPACA_API_SECRET not set in .env' };

  let res;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      method,
      headers: {
        'APCA-API-KEY-ID': key,
        'APCA-API-SECRET-KEY': secret,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? `timed out after ${TIMEOUT_MS / 1000}s` : err.message;
    return { ok: false, error: `Alpaca unreachable: ${reason}` };
  }

  let json = null;
  try { json = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok) {
    const message = (json && json.message) || res.statusText;
    // Alpaca also uses 403 for business rejections (e.g. insufficient buying power),
    // so only point at credentials when the message is actually about auth.
    const authProblem = res.status === 401 || (res.status === 403 && /forbidden|not authorized|unauthorized/i.test(message));
    const hint = authProblem ? ' (check keys, and live vs paper base URL)' : '';
    return { ok: false, error: `Alpaca HTTP ${res.status}: ${message}${hint}` };
  }
  return { ok: true, body: json };
}

async function getAccount() {
  const r = await alpacaFetch('/v2/account');
  if (!r.ok) return r;
  const body = r.body;
  if (!body || body.buying_power === undefined) return { ok: false, error: 'Alpaca: unexpected account response' };
  return {
    ok: true,
    buyingPower: num(body.buying_power),
    cash: num(body.cash),
    equity: num(body.equity),
    currency: body.currency || 'USD',
    status: body.status,
    tradingBlocked: Boolean(body.trading_blocked || body.account_blocked),
    environment: environment(),
  };
}

// Checks that make a bracket order safe to send, before any network call.
function validateOrder(c, size, entryPrice) {
  if (c.market !== 'stocks') return `Alpaca live routing supports stocks only (got "${c.market}")`;
  if (!Number.isInteger(size) || size < 1) return `bracket orders need a whole share quantity (got ${size}); Alpaca refuses fractional shares in a bracket, so fractional Pilot buys execute on paper`;
  const tp = c.targets && c.targets[0] && c.targets[0].price;
  if (!(tp > 0)) return 'no take-profit: live bracket orders need one (Portfolio Pilot core holdings have none, by design); nothing was sent. Buy it on paper, or at the broker';
  if (!(c.invalidation > 0) || !(entryPrice > 0)) return 'missing stop or entry price';
  const long = c.direction === 'long';
  if (long ? !(c.invalidation < entryPrice && entryPrice < tp) : !(tp < entryPrice && entryPrice < c.invalidation)) {
    return `levels out of order for a ${c.direction}: stop ${c.invalidation}, entry ${entryPrice}, target ${tp}`;
  }
  return null;
}

// Market entry + broker-side take-profit and stop-loss (OTO bracket).
// client_order_id = candidate id, so a retried request cannot create a duplicate order.
async function submitOrder(candidate, size, entryPrice) {
  const problem = validateOrder(candidate, size, entryPrice);
  if (problem) return { ok: false, error: `Alpaca order not sent: ${problem}` };

  // A 'day' market order sent outside regular hours is queued for the next open,
  // far from the price this setup was approved at. Refuse instead.
  const clock = await alpacaFetch('/v2/clock');
  if (!clock.ok) return clock;
  if (!clock.body || clock.body.is_open !== true) {
    return { ok: false, error: `MARKET_CLOSED: US equities market is closed (next open ${clock.body && clock.body.next_open})` };
  }

  const r = await alpacaFetch('/v2/orders', {
    method: 'POST',
    body: {
      symbol: candidate.asset,
      qty: String(size),
      side: candidate.direction === 'short' ? 'sell' : 'buy',
      type: 'market',
      time_in_force: 'day',
      order_class: 'bracket',
      client_order_id: String(candidate.id).slice(0, 128),
      take_profit: { limit_price: tick(candidate.targets[0].price) },
      stop_loss: { stop_price: tick(candidate.invalidation) },
    },
  });
  if (!r.ok) return r;
  if (!r.body || !r.body.id) return { ok: false, error: 'Alpaca: order response had no id' };
  return { ok: true, brokerId: r.body.id, status: r.body.status, environment: environment() };
}

// Open stock positions (Sync Broker, read-only): [{ asset, qty, avgEntry, costBasis, marketValue, unrealizedPnl }].
// US equities only (options / crypto classes are not synced).
async function getPositions() {
  const r = await alpacaFetch('/v2/positions');
  if (!r.ok) return r;
  if (!Array.isArray(r.body)) return { ok: false, error: 'Alpaca: unexpected positions response' };
  return { ok: true, environment: environment(), positions: r.body.filter((p) => p.asset_class === 'us_equity' && p.side === 'long').map((p) => ({
    asset: p.symbol, qty: num(p.qty), avgEntry: num(p.avg_entry_price), costBasis: num(p.cost_basis), marketValue: num(p.market_value), unrealizedPnl: num(p.unrealized_pl) })) };
}

// Plain market SELL of a holding bought outside SignalDesk (an approved Portfolio
// Pilot sell / trim / stop). Fractional quantities are fine for day market
// orders. Refused outside regular hours (a queued market order fills far from
// the price it was approved at). client_order_id = the Pilot action id.
async function sellMarket(symbol, qty, clientOrderId) {
  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(String(symbol)) || !(qty > 0)) return { ok: false, error: `Alpaca sell not sent: invalid ${symbol} ${qty}` };
  const clock = await alpacaFetch('/v2/clock');
  if (!clock.ok) return clock;
  if (!clock.body || clock.body.is_open !== true) return { ok: false, error: `MARKET_CLOSED: US equities market is closed (next open ${clock.body && clock.body.next_open})` };
  const r = await alpacaFetch('/v2/orders', { method: 'POST', body: { symbol, qty: String(Math.floor(qty * 1e6) / 1e6), side: 'sell', type: 'market', time_in_force: 'day',
    client_order_id: String(clientOrderId).slice(0, 128) } });
  if (!r.ok) return r;
  return r.body && r.body.id ? { ok: true, brokerId: r.body.id, status: r.body.status, environment: environment() } : { ok: false, error: 'Alpaca: order response had no id' };
}

// ---------- Order status (reconciliation) ----------
const qtyOf = (o) => num(o.filled_qty) || 0;
const TERMINAL = new Set(['filled', 'canceled', 'expired', 'rejected', 'done_for_day', 'replaced', 'stopped']);

// Entry order + its bracket exit legs. `brokerId` is the ENTRY (parent) order id;
// the stop-loss / take-profit are child legs, only returned with ?nested=true.
//   { ok, status, filledQty, avgFillPrice, terminal,
//     exit: { status, filledQty, avgFillPrice, kind, brokerExitId } | null }
// `exit` is the leg that has filled (fully or partly) if any, otherwise the
// still-working legs summarised as status 'open' (or 'none' when no leg is active).
async function getOrderStatus(brokerId) {
  if (!brokerId) return { ok: false, error: 'missing broker order id' };
  const r = await alpacaFetch(`/v2/orders/${encodeURIComponent(brokerId)}?nested=true`);
  if (!r.ok) return r;
  const o = r.body;
  if (!o || !o.id) return { ok: false, error: 'Alpaca: unexpected order response' };

  const legs = Array.isArray(o.legs) ? o.legs : [];
  const kindOf = (leg) => (leg.type === 'limit' ? 'take_profit' : 'stop_loss'); // stop / stop_limit
  const filledLeg = legs.find((l) => qtyOf(l) > 0);
  let exit = null;
  if (filledLeg) {
    exit = {
      status: filledLeg.status,
      filledQty: qtyOf(filledLeg),
      avgFillPrice: num(filledLeg.filled_avg_price),
      kind: kindOf(filledLeg),
      brokerExitId: filledLeg.id,
      fees: 0, // commission-free; small regulatory sell fees are not itemised on the order
    };
  } else if (legs.length) {
    const working = legs.some((l) => !TERMINAL.has(l.status));
    exit = { status: working ? 'open' : 'none', filledQty: 0, avgFillPrice: null, kind: null, brokerExitId: null };
  }

  return {
    ok: true,
    status: o.status,
    filledQty: qtyOf(o),
    avgFillPrice: num(o.filled_avg_price),
    fees: 0,
    terminal: TERMINAL.has(o.status),
    exit,
  };
}

module.exports = { getAccount, submitOrder, getOrderStatus, getPositions, sellMarket, DEFAULT_BASE_URL };
