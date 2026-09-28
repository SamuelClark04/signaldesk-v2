// OKX US v5 REST (Phase 69B): account, balances and order status for the #1 LIVE crypto venue.
// Same result shapes as coinbase-api.js / kraken-api.js, so the reconciler, [Close], re-arm and
// the profit ratchet treat a position by its broker alone (crypto-venues.js). Never throws:
// { ok, ... } or { ok: false, error, uncertain? }.
// Auth (private endpoints): headers OK-ACCESS-KEY, OK-ACCESS-PASSPHRASE, OK-ACCESS-TIMESTAMP (ISO
// 8601 UTC, ms) and OK-ACCESS-SIGN = base64( HMAC-SHA256( secret, timestamp + METHOD +
// requestPath (+ ?query) + body ) ). Keys / base URL: server/config.js (OKX_BASE_URL -> a mock).
// Order ids carry their instrument (OKX needs instId to read / cancel): 'ETH-USD:<ordId>', a
// stop (algo order) 'ETH-USD:algo:<algoId>'.
//   getAccount       trading account: cash = USD + USDC + USDT available; spot holdings; the
//                    funding account's cash (not tradable until moved to Trading) as fundingCash
//   getAvailable     a coin's available (availBal) and frozen balance
//   getOrder         status, accFillSz, avgPx, fee (USD), fillTime (real fill time). A BUY's fee
//                    is charged in the coin: filledQty is what was received (accFillSz - fee)
//   getOrderStatus   an entry + its protective stop / OCO (exit.tp, exit.kind by actualSide), else the stop
//                    attached to the entry (algoClOrdId = stopIdOf(the entry's clOrdId))
//   openOrders / closedOrders / cancelOrder (orders and algo stops)
const crypto = require('crypto');
const config = require('../config');
const pairs = require('./okx-pairs');

const TIMEOUT_MS = 8000;
const configured = () => { const c = config.okx(); return !!(c.apiKey && c.apiSecret && c.passphrase); };
const sign = (ts, method, requestPath, body, secret) => crypto.createHmac('sha256', secret).update(`${ts}${method}${requestPath}${body}`).digest('base64');

// Client ids: OKX takes 1-32 letters / digits. A SignalDesk id -> 'sd' + 30 hex (deterministic, so
// recovery / uncertain-sell lookups find their orders); the stop attached to it: 'sl' + the same.
const clientIdOf = (id) => `sd${crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 30)}`;
const stopIdOf = (clOrdId) => `sl${String(clOrdId).slice(2)}`;
const idOf = (instId, ordId) => `${instId}:${ordId}`;
const algoIdOf = (instId, algoId) => `${instId}:algo:${algoId}`;
const parseId = (id) => { const [instId, a, b] = String(id).split(':'); return a === 'algo' ? { instId, algoId: b } : { instId, ordId: a }; };

// No clear answer (timeout, transport, HTTP 429 / 5xx, OKX busy / rate-limited / timed out): the
// request may have been processed. Anything else (a code / sCode refusal) is definite.
const UNCERTAIN = new Set(['50001', '50004', '50011', '50013', '50026', '50061']);
const NOT_FOUND = new Set(['51603', '51001']);
function failure(err) {
  const reason = err.name === 'TimeoutError' ? `timed out after ${TIMEOUT_MS / 1000}s` : err.message;
  const uncertain = err.name === 'TimeoutError' || (!err.status && !err.okx) || err.status === 429 || err.status >= 500 || UNCERTAIN.has(err.okx);
  return { ok: false, error: reason.startsWith('OKX') ? reason : `OKX unreachable: ${reason}`, uncertain, code: err.okx || null };
}

// creds { apiKey, apiSecret, passphrase } (Phase 73, Settings > Accounts: Test & Save): candidate keys.
async function request(method, path, { query = null, body = null, creds = null } = {}) {
  const c = creds ? { ...config.okx(), ...creds } : config.okx();
  if (!(c.apiKey && c.apiSecret && c.passphrase)) throw Object.assign(new Error('OKX: OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE not set in .env'), { okx: 'config' });
  const qs = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString() : '';
  const requestPath = qs ? `${path}?${qs}` : path;
  const payload = body ? JSON.stringify(body) : '';
  const ts = new Date().toISOString();
  const res = await fetch(`${c.baseUrl}${requestPath}`, {
    method,
    headers: { 'OK-ACCESS-KEY': c.apiKey, 'OK-ACCESS-SIGN': sign(ts, method, requestPath, payload, c.apiSecret), 'OK-ACCESS-TIMESTAMP': ts, 'OK-ACCESS-PASSPHRASE': c.passphrase, 'Content-Type': 'application/json' },
    ...(payload ? { body: payload } : {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let j = null;
  try { j = await res.json(); } catch { /* non-JSON error page */ }
  if (res.status === 429 || res.status >= 500 || !j) throw Object.assign(new Error(`OKX HTTP ${res.status}`), { status: res.status });
  if (String(j.code) !== '0') {
    const d = Array.isArray(j.data) && j.data.find((x) => x && x.sCode && String(x.sCode) !== '0');
    throw Object.assign(new Error(`OKX: ${d ? `${d.sMsg || 'refused'} (${d.sCode})` : `${j.msg || 'error'} (${j.code})`}`), { okx: String(d ? d.sCode : j.code) });
  }
  return Array.isArray(j.data) ? j.data : [];
}
const call = (method, path, opts) => request(method, path, opts).then((data) => ({ ok: true, data }), failure);

// ---------- Balances ----------
const CASH = ['USD', 'USDC', 'USDT'];
async function getAccount() {
  const r = await call('GET', '/api/v5/account/balance');
  if (!r.ok) return r;
  const balances = { USD: 0, USDC: 0, USDT: 0 };
  const holdings = [];
  for (const d of (r.data[0] && r.data[0].details) || []) {
    if (CASH.includes(d.ccy)) { balances[d.ccy] += Number(d.availBal) || 0; continue; }
    const qty = Number(d.cashBal) || 0;
    if (qty > 0) holdings.push({ asset: d.ccy, code: d.ccy, qty, available: Number(d.availBal) || 0 });
  }
  const f = await call('GET', '/api/v5/asset/balances'); // the funding account: shown, not spendable by orders
  const fundingCash = f.ok ? f.data.filter((x) => CASH.includes(x.ccy)).reduce((s, x) => s + (Number(x.availBal) || 0), 0) : null;
  // spendable: the most ONE order can pay (it settles in one currency: USD, USDC or USDT).
  return { ok: true, buyingPower: balances.USD + balances.USDC + balances.USDT, spendable: Math.max(balances.USD, balances.USDC, balances.USDT), balances, holdings, fundingCash, currency: 'USD', environment: 'okx-live' };
}

// Account value for sizing: cash + every holding at its live (else mark) USD price.
async function getPortfolioValue() {
  const a = await getAccount();
  if (!a.ok) return a;
  const prices = require('../market/latest-prices');
  const priced = a.holdings.map((h) => ({ ...h, price: prices.getLatestPrice(`${h.asset}-USD`) || prices.getMarkPrice(`${h.asset}-USD`) || 0 }));
  return { ok: true, value: a.buyingPower + priced.reduce((s, h) => s + h.qty * h.price, 0), cash: a.buyingPower, spendable: a.spendable, fundingCash: a.fundingCash, holdings: priced };
}

// Available and frozen quantity of a SignalDesk base ('ETH'): { ok, available, hold }.
async function getAvailable(base) {
  const r = await call('GET', '/api/v5/account/balance', { query: { ccy: base } });
  if (!r.ok) return r;
  const d = ((r.data[0] && r.data[0].details) || []).find((x) => x.ccy === base) || {};
  return { ok: true, available: Number(d.availBal) || 0, hold: Number(d.frozenBal) || 0 };
}

// ---------- Orders ----------
const STATE = { live: 'open', partially_filled: 'open', filled: 'filled', canceled: 'canceled', mmp_canceled: 'canceled' };
function normOrder(o) {
  const base = String(o.instId).split('-')[0];
  const gross = Number(o.accFillSz) || 0;
  const avg = Number(o.avgPx) > 0 ? Number(o.avgPx) : null;
  const fee = -(Number(o.fee) || 0); // OKX: negative = charged, positive = rebate
  const inCoin = o.feeCcy === base;
  const filledQty = inCoin && o.side === 'buy' ? Math.max(0, gross - Math.max(fee, 0)) : gross;
  const status = STATE[o.state] || String(o.state || 'unknown');
  return { orderId: idOf(o.instId, o.ordId), clientOrderId: o.clOrdId || null, product: o.instId, side: String(o.side || '').toUpperCase(), ordertype: o.ordType, status, filledQty, grossQty: gross,
    avgFillPrice: avg, fees: inCoin ? fee * (avg || 0) : fee, terminal: status === 'filled' || status === 'canceled',
    filledAt: gross > 0 ? Number(o.fillTime) || Number(o.uTime) || null : null, openedAt: Number(o.cTime) || null,
    attachAlgoIds: (o.attachAlgoOrds || []).map((x) => x.attachAlgoId).filter(Boolean) };
}
async function getOrder(id, clOrdId = null) {
  const p = parseId(id);
  const r = await call('GET', '/api/v5/trade/order', { query: { instId: p.instId, ...(clOrdId ? { clOrdId } : { ordId: p.ordId }) } });
  if (!r.ok) return NOT_FOUND.has(r.code) ? { ok: false, notFound: true, error: `OKX: no order ${clOrdId || id}` } : r;
  return r.data[0] ? { ok: true, ...normOrder(r.data[0]) } : { ok: false, notFound: true, error: `OKX: no order ${clOrdId || id}` };
}
async function openOrders() {
  const r = await call('GET', '/api/v5/trade/orders-pending', { query: { instType: 'SPOT' } });
  return r.ok ? { ok: true, orders: r.data.map(normOrder) } : r;
}
async function closedOrders(sinceMs) {
  const r = await call('GET', '/api/v5/trade/orders-history', { query: { instType: 'SPOT', begin: String(Math.max(0, Math.floor(sinceMs))) } });
  return r.ok ? { ok: true, orders: r.data.map(normOrder) } : r;
}
async function cancelOrder(id) {
  const p = parseId(id);
  const r = p.algoId ? await call('POST', '/api/v5/trade/cancel-algos', { body: [{ instId: p.instId, algoId: p.algoId }] })
    : await call('POST', '/api/v5/trade/cancel-order', { body: { instId: p.instId, ordId: p.ordId } });
  return r.ok ? { ok: true } : { ok: false, error: r.error, uncertain: r.uncertain };
}

// ---------- Stops (algo orders) ----------
const ALGO = { live: 'open', pause: 'open', partially_effective: 'open', effective: 'triggered', canceled: 'canceled', order_failed: 'failed', partially_failed: 'failed' };
async function getAlgo(query) {
  const r = await call('GET', '/api/v5/trade/order-algo', { query });
  if (!r.ok) return NOT_FOUND.has(r.code) ? { ok: true, algo: null } : r;
  return { ok: true, algo: r.data[0] || null };
}
// A stop algo -> coinbase-api's exit shape. Triggered: its market sell's fill.
async function exitOf(a) {
  const tp = Number(a.tpTriggerPx) > 0 ? Number(a.tpTriggerPx) : null; // an OCO (70E): T1 rests at OKX too
  const kind = a.actualSide === 'tp' ? 'take_profit' : a.actualSide === 'sl' || !tp ? 'stop_loss' : null; // the side that fired
  const x = { kind, brokerExitId: algoIdOf(a.instId, a.algoId), stopPrice: Number(a.slTriggerPx) || null, tp, oco: !!tp, status: ALGO[a.state] || String(a.state), filledQty: 0, avgFillPrice: null, fees: 0, filledAt: null };
  if (x.status !== 'triggered') return { ok: true, exit: x };
  const ordId = a.ordId || (a.ordIdList || [])[0];
  if (!ordId) return { ok: true, exit: { ...x, status: 'open' } }; // triggered; its sell not listed yet
  const o = await getOrder(idOf(a.instId, ordId));
  if (!o.ok) return o;
  return { ok: true, exit: { ...x, status: o.status, filledQty: o.filledQty, avgFillPrice: o.avgFillPrice, fees: o.fees, filledAt: o.filledAt, sellOrderId: o.orderId } };
}

async function getOrderStatus(entryId, opts = {}) {
  if (!entryId) return { ok: false, error: 'missing broker order id' };
  const entry = await getOrder(entryId);
  if (!entry.ok) return entry;
  let a = null;
  const look = async (q) => { const g = await getAlgo(q); if (!g.ok) throw g; return g.algo; };
  try {
    if (opts.exitId) a = await look({ algoId: parseId(opts.exitId).algoId });
    if (!a && entry.filledQty > 0 && entry.clientOrderId) a = await look({ algoClOrdId: stopIdOf(entry.clientOrderId) });
    if (!a && entry.filledQty > 0 && entry.attachAlgoIds.length) a = await look({ algoId: entry.attachAlgoIds[0] });
  } catch (g) { return g; }
  const x = a ? await exitOf(a) : { ok: true, exit: null };
  if (!x.ok) return x;
  return { ok: true, status: entry.status, filledQty: entry.filledQty, avgFillPrice: entry.avgFillPrice, fees: entry.fees, terminal: entry.terminal, filledAt: entry.filledAt, exit: x.exit };
}

module.exports = { configured, getAccount, getPortfolioValue, getAvailable, getOrder, getOrderStatus, getAlgo, openOrders, closedOrders, cancelOrder,
  call, request, sign, failure, normOrder, clientIdOf, stopIdOf, idOf, algoIdOf, parseId };
