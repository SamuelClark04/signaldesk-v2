// Alpaca Trading API (REST, on demand): account data + live order submission for
// the stock venue. Orders are bracket orders, so the stop and target live AT THE
// BROKER and protect the position even if SignalDesk is offline.
//
// Base URL: live by default. Point ALPACA_TRADING_BASE_URL at
// https://paper-api.alpaca.markets to test against an Alpaca Paper account
// (paper and live accounts use different key pairs).
//
// DATA-ONLY keys (Phase 70G): Alpaca PAPER keys ("PK...", or the paper-api base URL) serve the
// free IEX stock / options market data, the news feed and the market clock, but are never a
// broker: account, positions and orders are refused ({ ok: false, dataOnly: true }), so a paper
// account's $100k cash and positions never reach Sync Broker, Live / External holdings, spendable
// cash, live stock sizing or a live order. ALPACA_ACCOUNT_ROLE=trading overrides it (use the
// account as the stock broker); =data forces data-only for any keys; unset / auto: by the keys.
// PAPER BROKER (Phase 71): `paper` is the same client against the Alpaca PAPER account
// (ALPACA_PAPER_BASE_URL, default https://paper-api.alpaca.markets; keys ALPACA_PAPER_API_KEY /
// SECRET, else the PK... keys above): SignalDesk's paper stock / options orders execute there
// (execution/alpaca-paper.js). Its cash and holdings are paper money: never live (broker-sync
// keeps them in their own `alpacaPaper` snapshot, shown on the Paper side only).
// Never throws: every outcome is { ok: true, ... } or { ok: false, error }.
const DEFAULT_BASE_URL = 'https://api.alpaca.markets';
const PAPER_BASE_URL = 'https://paper-api.alpaca.markets';
const TIMEOUT_MS = 8000;

const num = (x) => (x === undefined || x === null || x === '' ? null : Number(x));
const baseUrl = () => (process.env.ALPACA_TRADING_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
const environment = () => (baseUrl().includes('paper-api') ? 'alpaca-paper' : 'alpaca-live');
function dataOnly() {
  const role = String(process.env.ALPACA_ACCOUNT_ROLE || 'auto').trim().toLowerCase();
  if (role === 'trading') return false;
  if (role === 'data') return true;
  return String(process.env.ALPACA_API_KEY || '').trim().startsWith('PK') || baseUrl().includes('paper-api');
}
const BROKER_PATHS = /^\/v2\/(account|positions|orders)/; // what a data-only key may never touch
// The request context: LIVE (the trading account, data-only guard) or PAPER (the paper broker).
const LIVE = { paper: false };
const PAPER = { paper: true };
function credentials(ctx) {
  if (!ctx.paper) return { key: process.env.ALPACA_API_KEY, secret: process.env.ALPACA_API_SECRET, base: baseUrl() };
  const own = process.env.ALPACA_PAPER_API_KEY && process.env.ALPACA_PAPER_API_SECRET;
  const paperKeys = String(process.env.ALPACA_API_KEY || '').trim().startsWith('PK') || baseUrl().includes('paper-api');
  return { key: own ? process.env.ALPACA_PAPER_API_KEY : paperKeys ? process.env.ALPACA_API_KEY : null, secret: own ? process.env.ALPACA_PAPER_API_SECRET : paperKeys ? process.env.ALPACA_API_SECRET : null,
    base: (process.env.ALPACA_PAPER_BASE_URL || PAPER_BASE_URL).replace(/\/+$/, '') };
}
const paperConfigured = () => { const c = credentials(PAPER); return !!(c.key && c.secret); };
// Phase 73: the keys for MARKET DATA / NEWS / streams: the live keys, else the Alpaca Paper keys (both
// serve the free IEX feed), so a family install with only paper keys still gets charts and scans.
function dataKeys() {
  if (process.env.ALPACA_API_KEY && process.env.ALPACA_API_SECRET) return { key: process.env.ALPACA_API_KEY, secret: process.env.ALPACA_API_SECRET };
  const p = credentials(PAPER);
  return p.key && p.secret ? { key: p.key, secret: p.secret } : null;
}
const envOf = (ctx) => (ctx.paper ? 'alpaca-paper' : environment());
const DATA_ONLY_ERROR = 'Alpaca keys are a PAPER account: used for market data / news only, never as a broker (set ALPACA_ACCOUNT_ROLE=trading to use it as one)';
// Alpaca rejects sub-penny prices: 2 decimals at/above $1, 4 below.
const tick = (p) => (p >= 1 ? p.toFixed(2) : p.toFixed(4));

// One authenticated request. Resolves { ok, body } or { ok: false, error }.
async function alpacaFetch(path, { method = 'GET', body } = {}, ctx = LIVE) {
  const { key, secret, base } = credentials(ctx);
  if (!key || !secret) return { ok: false, error: ctx.paper ? 'Alpaca Paper keys not set (PK... ALPACA_API_KEY / SECRET, or ALPACA_PAPER_API_KEY / SECRET)' : 'ALPACA_API_KEY / ALPACA_API_SECRET not set in .env' };
  if (!ctx.paper && BROKER_PATHS.test(path) && dataOnly()) return { ok: false, dataOnly: true, error: DATA_ONLY_ERROR };

  let res;
  try {
    res = await fetch(`${base}${path}`, {
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
    return { ok: false, status: res.status, error: `Alpaca${ctx.paper ? ' Paper' : ''} HTTP ${res.status}: ${message}${hint}` };
  }
  return { ok: true, body: json };
}

async function getAccount(ctx = LIVE) {
  const r = await alpacaFetch('/v2/account', {}, ctx);
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
    environment: envOf(ctx),
  };
}

// Checks that make a bracket order safe to send, before any network call.
function validateOrder(c, size, entryPrice) {
  if (c.market !== 'stocks') return `Alpaca bracket routing supports stocks only (got "${c.market}")`;
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
async function submitOrder(candidate, size, entryPrice, ctx = LIVE) {
  const problem = validateOrder(candidate, size, entryPrice);
  if (problem) return { ok: false, error: `Alpaca order not sent: ${problem}` };

  // A 'day' market order sent outside regular hours is queued for the next open,
  // far from the price this setup was approved at. Refuse instead.
  const clock = await alpacaFetch('/v2/clock', {}, ctx);
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
  }, ctx);
  if (!r.ok) return r;
  if (!r.body || !r.body.id) return { ok: false, error: 'Alpaca: order response had no id' };
  return { ok: true, brokerId: r.body.id, status: r.body.status, environment: envOf(ctx), entryType: 'market', product: candidate.asset };
}

// Open stock positions (Sync Broker, read-only): [{ asset, qty, avgEntry, costBasis, marketValue, unrealizedPnl }].
// US equities only (options / crypto classes are not synced).
async function getPositions(ctx = LIVE) {
  const r = await alpacaFetch('/v2/positions', {}, ctx);
  if (!r.ok) return r;
  if (!Array.isArray(r.body)) return { ok: false, error: 'Alpaca: unexpected positions response' };
  return { ok: true, environment: envOf(ctx), positions: r.body.filter((p) => p.asset_class === 'us_equity' && p.side === 'long').map((p) => ({
    asset: p.symbol, qty: num(p.qty), avgEntry: num(p.avg_entry_price), costBasis: num(p.cost_basis), marketValue: num(p.market_value), unrealizedPnl: num(p.unrealized_pl) })) };
}

// Plain market SELL of a holding bought outside SignalDesk (an approved Portfolio
// Pilot sell / trim / stop). Fractional quantities are fine for day market
// orders. Refused outside regular hours (a queued market order fills far from
// the price it was approved at). client_order_id = the Pilot action id.
async function sellMarket(symbol, qty, clientOrderId, ctx = LIVE) {
  if (!ctx.paper && dataOnly()) return { ok: false, dataOnly: true, error: DATA_ONLY_ERROR }; // before the clock check (70G)
  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(String(symbol)) || !(qty > 0)) return { ok: false, error: `Alpaca sell not sent: invalid ${symbol} ${qty}` };
  const clock = await alpacaFetch('/v2/clock', {}, ctx);
  if (!clock.ok) return clock;
  if (!clock.body || clock.body.is_open !== true) return { ok: false, error: `MARKET_CLOSED: US equities market is closed (next open ${clock.body && clock.body.next_open})` };
  const r = await alpacaFetch('/v2/orders', { method: 'POST', body: { symbol, qty: String(Math.floor(qty * 1e6) / 1e6), side: 'sell', type: 'market', time_in_force: 'day',
    client_order_id: String(clientOrderId).slice(0, 128) } }, ctx);
  if (!r.ok) return r;
  return r.body && r.body.id ? { ok: true, brokerId: r.body.id, status: r.body.status, environment: envOf(ctx), qty: Number(qty) } : { ok: false, error: 'Alpaca: order response had no id' };
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
async function getOrderStatus(brokerId, opts = {}, ctx = LIVE) {
  if (!brokerId) return { ok: false, error: 'missing broker order id' };
  const r = await alpacaFetch(`/v2/orders/${encodeURIComponent(brokerId)}?nested=true`, {}, ctx);
  if (!r.ok) return r;
  const o = r.body;
  if (!o || !o.id) return { ok: false, error: 'Alpaca: unexpected order response' };

  const legs = Array.isArray(o.legs) && o.order_class !== 'mleg' ? o.legs : []; // an options spread's legs are not exits (71)
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
      filledAt: Number.isFinite(Date.parse(filledLeg.filled_at)) ? Date.parse(filledLeg.filled_at) : null, // Phase 68: the real fill time
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
    filledAt: Number.isFinite(Date.parse(o.filled_at)) ? Date.parse(o.filled_at) : null,
    legIds: legs.filter((l) => !TERMINAL.has(l.status)).map((l) => l.id), // working bracket legs (a paper close cancels them)
    exit,
  };
}

// The market clock (read-only): { ok, isOpen, nextOpen, nextClose } in ms (market/market-session.js).
async function getClock(ctx = null) { // Phase 73: the live keys, else the paper account's (same market clock)
  const c = ctx || (process.env.ALPACA_API_KEY && process.env.ALPACA_API_SECRET ? LIVE : PAPER);
  const r = await alpacaFetch('/v2/clock', {}, c);
  if (!r.ok) return r;
  const b = r.body || {};
  return { ok: true, isOpen: b.is_open === true, nextOpen: Date.parse(b.next_open) || null, nextClose: Date.parse(b.next_close) || null };
}

// A single order: { ok, status, filledQty, avgFillPrice, terminal, filledAt } (a paper close / options spread order).
async function getOrder(id, ctx = LIVE) {
  const r = await alpacaFetch(`/v2/orders/${encodeURIComponent(id)}`, {}, ctx);
  if (!r.ok) return r;
  const o = r.body || {};
  return { ok: true, orderId: o.id, status: o.status, filledQty: qtyOf(o), avgFillPrice: num(o.filled_avg_price), terminal: TERMINAL.has(o.status), filledAt: Date.parse(o.filled_at) || null };
}
async function cancelOrder(id, ctx = LIVE) {
  const r = await alpacaFetch(`/v2/orders/${encodeURIComponent(id)}`, { method: 'DELETE' }, ctx);
  return r.ok || r.status === 422 ? { ok: true } : r; // 422: already filled / canceled
}

// The PAPER broker: the same calls against the Alpaca Paper account (Phase 71).
const paper = {
  configured: paperConfigured,
  getAccount: () => getAccount(PAPER),
  getPositions: () => getPositions(PAPER),
  submitOrder: (c, size, px) => submitOrder(c, size, px, PAPER),
  getOrderStatus: (id, opts) => getOrderStatus(id, opts, PAPER),
  getOrder: (id) => getOrder(id, PAPER),
  cancelOrder: (id) => cancelOrder(id, PAPER),
  sellMarket: (symbol, qty, clientOrderId) => sellMarket(symbol, qty, clientOrderId, PAPER),
  getClock: () => getClock(PAPER),
  request: (path, opts) => alpacaFetch(path, opts, PAPER),
  validateOrder,
};

module.exports = { dataKeys, credentials, PAPER, LIVE, getAccount, submitOrder, getOrderStatus, getPositions, sellMarket, getClock, getOrder, cancelOrder, dataOnly, paper, DEFAULT_BASE_URL, PAPER_BASE_URL };
