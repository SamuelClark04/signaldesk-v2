// Kraken Pro REST (Phase 69A): account, balances and order status for the LIVE crypto venue.
// Same result shapes as coinbase-api.js, so the reconciler, [Close], re-arm and the profit
// ratchet treat a position by its broker alone (crypto-venues.js). Never throws: { ok, ... }
// or { ok: false, error, uncertain? }.
// Auth (private endpoints): headers API-Key = KRAKEN_API_KEY and API-Sign =
//   base64( HMAC-SHA512( base64decode(KRAKEN_API_SECRET), uriPath + SHA256(nonce + postData) ) )
// with a strictly increasing nonce (microseconds since the epoch, never repeated); private calls are
// serialized so nonces also ARRIVE in order.
// KRAKEN_API_BASE_URL points it at a local mock in tests / the harness.
//   getAccount       Balance: cash = ZUSD + USD + USDC; spot holdings by SignalDesk base
//   getAvailable     BalanceEx: balance + credit - credit_used - hold_trade (coins free to sell)
//   getOrder         QueryOrders: status, vol_exec, avg price, fee, closetm (real fill time)
//   getOrderStatus   an entry + its protective stop: the re-armed stop (exitId), else the
//                    conditional-close stop Kraken created from it (refid = the entry's txid)
//   openOrders / closedOrders / cancelOrder
const crypto = require('crypto');
const pairs = require('./kraken-pairs');

const TIMEOUT_MS = 8000;
let lastNonce = 0;
const baseUrl = () => (process.env.KRAKEN_API_BASE_URL || 'https://api.kraken.com').replace(/\/+$/, '');
const configured = () => !!(process.env.KRAKEN_API_KEY && process.env.KRAKEN_API_SECRET);

function nonce(now = Date.now()) {
  lastNonce = Math.max(now * 1000, lastNonce + 1);
  return String(lastNonce);
}
function sign(path, postData, nonceValue, secret) {
  const sha = crypto.createHash('sha256').update(nonceValue + postData).digest();
  return crypto.createHmac('sha512', Buffer.from(secret, 'base64')).update(Buffer.concat([Buffer.from(path), sha])).digest('base64');
}

// No clear answer (timeout, transport, HTTP 429 / 5xx, Kraken busy / rate-limited): the
// request may have been processed. Anything else is a definite refusal.
const UNCERTAIN = /^E(Service|API:Rate limit|General:Temporary lockout)/;
function failure(err) {
  const reason = err.name === 'TimeoutError' ? `timed out after ${TIMEOUT_MS / 1000}s` : err.message;
  const uncertain = err.name === 'TimeoutError' || (!err.status && !err.kraken) || err.status === 429 || err.status >= 500 || (err.kraken || []).some((e) => UNCERTAIN.test(e));
  return { ok: false, error: reason.startsWith('Kraken') ? reason : `Kraken unreachable: ${reason}`, uncertain };
}

// Kraken rejects a nonce lower than the last one it SAW (EAPI:Invalid nonce), so two requests in
// flight at once can fail when the network reorders them (Phase 70's broker tile + waterfall strip
// read the balance together). Private calls therefore go out ONE AT A TIME, each nonce taken at
// send time; an "Invalid nonce" refusal (never processed by Kraken) is retried once.
let queue = Promise.resolve();
function privateCall(method, params = {}) {
  const run = queue.then(() => sendPrivate(method, params)).catch((err) => {
    if (!(err.kraken || []).some((e) => /^EAPI:Invalid nonce/.test(e))) throw err;
    return sendPrivate(method, params);
  });
  queue = run.catch(() => {});
  return run;
}

async function sendPrivate(method, params = {}) {
  if (!configured()) throw Object.assign(new Error('Kraken: KRAKEN_API_KEY / KRAKEN_API_SECRET not set in .env'), { kraken: ['EAPI:not configured'] });
  const path = `/0/private/${method}`;
  const n = nonce();
  const postData = new URLSearchParams({ nonce: n, ...Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null)) }).toString();
  const res = await fetch(`${baseUrl()}${path}`, {
    method: 'POST',
    headers: { 'API-Key': process.env.KRAKEN_API_KEY, 'API-Sign': sign(path, postData, n, process.env.KRAKEN_API_SECRET), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: postData,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let j = null;
  try { j = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok) throw Object.assign(new Error(`Kraken HTTP ${res.status}`), { status: res.status });
  if (j && Array.isArray(j.error) && j.error.length) throw Object.assign(new Error(`Kraken: ${j.error.join(', ')}`), { kraken: j.error });
  if (!j || j.result === undefined) throw Object.assign(new Error('Kraken: unexpected response'), { kraken: ['EGeneral:Unexpected'] });
  return j.result;
}
const call = (method, params) => privateCall(method, params).then((result) => ({ ok: true, result }), failure);

// ---------- Balances ----------
const CASH = { ZUSD: 'USD', USD: 'USD', USDC: 'USDC' };
async function getAccount() {
  const r = await call('Balance');
  if (!r.ok) return r;
  const balances = { USD: 0, USDC: 0 };
  const holdings = [];
  for (const [code, v] of Object.entries(r.result || {})) {
    const qty = Number(v) || 0;
    if (CASH[code]) { balances[CASH[code]] += qty; continue; }
    const base = pairs.baseOfCode(code);
    if (base && qty > 0) holdings.push({ asset: base, code, qty });
  }
  // spendable: the most ONE order can pay (a buy settles in the USD or the USDC book, not both).
  return { ok: true, buyingPower: balances.USD + balances.USDC, spendable: Math.max(balances.USD, balances.USDC), balances, holdings, currency: 'USD', environment: 'kraken-live' };
}

// Account value for sizing: cash + every holding at its live (else mark) USD price.
async function getPortfolioValue() {
  const a = await getAccount();
  if (!a.ok) return a;
  const prices = require('../market/latest-prices');
  const priced = a.holdings.map((h) => ({ ...h, price: prices.getLatestPrice(`${h.asset}-USD`) || prices.getMarkPrice(`${h.asset}-USD`) || 0 }));
  return { ok: true, value: a.buyingPower + priced.reduce((s, h) => s + h.qty * h.price, 0), cash: a.buyingPower, spendable: a.spendable, holdings: priced };
}

// Available (not on hold) and held quantity of a SignalDesk base ('ETH'): { ok, available, hold }.
async function getAvailable(base) {
  const r = await call('BalanceEx');
  if (!r.ok) return r;
  const code = pairs.codeOf(base);
  const row = (r.result || {})[code] || (r.result || {})[base] || {};
  const bal = Number(row.balance) || 0;
  const hold = Number(row.hold_trade) || 0;
  return { ok: true, available: bal + (Number(row.credit) || 0) - (Number(row.credit_used) || 0) - hold, hold };
}

// ---------- Orders ----------
const STATUS = { pending: 'open', open: 'open', closed: 'filled', canceled: 'canceled', expired: 'expired' };
function normOrder(txid, o) {
  const d = o.descr || {};
  const filledQty = Number(o.vol_exec) || 0;
  const status = STATUS[o.status] || String(o.status || 'unknown');
  const pair = pairs.byKraken(d.pair);
  return { orderId: txid, clientOrderId: o.cl_ord_id || null, userref: Number(o.userref) || null, refid: o.refid || null, product: pair ? pair.symbol : d.pair, side: String(d.type || '').toUpperCase(), ordertype: d.ordertype,
    status, filledQty, avgFillPrice: Number(o.price) > 0 ? Number(o.price) : null, fees: Number(o.fee) || 0, terminal: ['filled', 'canceled', 'expired'].includes(status),
    filledAt: filledQty > 0 && o.closetm ? Math.round(Number(o.closetm) * 1000) : null, openedAt: o.opentm ? Math.round(Number(o.opentm) * 1000) : null, stopPrice: Number(d.price) || null };
}
async function queryOrders(ids) {
  const r = await call('QueryOrders', { txid: ids.join(',') });
  return r.ok ? { ok: true, orders: Object.entries(r.result || {}).map(([id, o]) => normOrder(id, o)) } : r;
}
async function getOrder(txid) {
  const r = await queryOrders([txid]);
  if (!r.ok) return r;
  const o = r.orders[0];
  return o ? { ok: true, ...o } : { ok: false, error: `Kraken: no order ${txid}` };
}
async function openOrders() {
  const r = await call('OpenOrders');
  return r.ok ? { ok: true, orders: Object.entries((r.result && r.result.open) || {}).map(([id, o]) => normOrder(id, o)) } : r;
}
async function closedOrders(sinceMs) {
  const r = await call('ClosedOrders', { start: Math.floor(Math.max(0, sinceMs) / 1000) });
  return r.ok ? { ok: true, orders: Object.entries((r.result && r.result.closed) || {}).map(([id, o]) => normOrder(id, o)) } : r;
}
async function cancelOrder(txid) {
  const r = await call('CancelOrder', { txid: String(txid) });
  return r.ok && Number(r.result && r.result.count) > 0 ? { ok: true } : { ok: false, error: r.ok ? `Kraken did not cancel ${txid}` : r.error };
}

// The entry + its protective stop, in coinbase-api.getOrderStatus's shape (exit.kind 'stop_loss':
// on Kraken the resting exit is always the stop; SignalDesk takes T1 itself).
async function getOrderStatus(entryId, opts = {}) {
  if (!entryId) return { ok: false, error: 'missing broker order id' };
  const q = await queryOrders([entryId, ...(opts.exitId ? [opts.exitId] : [])]);
  if (!q.ok) return q;
  const entry = q.orders.find((o) => o.orderId === entryId);
  if (!entry) return { ok: false, error: `Kraken: no order ${entryId}` };
  let stop = opts.exitId ? q.orders.find((o) => o.orderId === opts.exitId) : null;
  if (!stop && entry.filledQty > 0) { // the conditional close Kraken created on the fill (refid = the entry)
    const open = await openOrders();
    if (!open.ok) return open;
    stop = open.orders.find((o) => o.refid === entryId);
    if (!stop) {
      const closed = await closedOrders((entry.openedAt || Date.now()) - 60000);
      if (!closed.ok) return closed;
      stop = closed.orders.filter((o) => o.refid === entryId).sort((a, b) => (b.filledAt || 0) - (a.filledAt || 0))[0] || null;
    }
  }
  const exit = stop ? { status: stop.status, filledQty: stop.filledQty, avgFillPrice: stop.avgFillPrice, fees: stop.fees, kind: 'stop_loss', brokerExitId: stop.orderId, filledAt: stop.filledAt } : null;
  return { ok: true, status: entry.status, filledQty: entry.filledQty, avgFillPrice: entry.avgFillPrice, fees: entry.fees, terminal: entry.terminal, filledAt: entry.filledAt, exit };
}

module.exports = { configured, getAccount, getPortfolioValue, getAvailable, getOrder, getOrderStatus, openOrders, closedOrders, cancelOrder, call, privateCall, sign, nonce, failure, normOrder };
