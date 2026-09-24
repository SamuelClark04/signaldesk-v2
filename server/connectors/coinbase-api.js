// Coinbase Advanced Trade API (REST, on demand) for the live crypto venue:
// account balances and holdings (read-only), and live order submission/status.
//
// Auth: CDP API keys. Every request carries a short-lived JWT signed with the key:
//   COINBASE_API_KEY    = key name, e.g. organizations/{org}/apiKeys/{id}
//   COINBASE_API_SECRET = ECDSA private key PEM (literal "\n" sequences allowed in .env),
//                         or a base64 Ed25519 secret (newer CDP key format)
// Built on node:crypto: no external dependencies.
//
// Never throws: every outcome is { ok: true, ... } or { ok: false, error }.
const crypto = require('crypto');

const HOST = 'api.coinbase.com';
const ACCOUNTS_PATH = '/api/v3/brokerage/accounts';
const TIMEOUT_MS = 8000;
const MAX_PAGES = 10;
const CASH_CURRENCIES = ['USD', 'USDC'];

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

// PEM -> ECDSA (ES256); otherwise a base64 64-byte Ed25519 secret (seed + public key) -> EdDSA.
function loadSigningKey(secret) {
  const text = secret.replace(/\\n/g, '\n').trim();
  if (text.includes('BEGIN')) {
    const key = crypto.createPrivateKey(text);
    if (key.asymmetricKeyType !== 'ec') throw new Error(`unsupported PEM key type "${key.asymmetricKeyType}"`);
    return { key, alg: 'ES256' };
  }
  const raw = Buffer.from(text, 'base64');
  if (raw.length !== 64) throw new Error('secret is neither an EC PEM nor a 64-byte base64 Ed25519 key');
  const key = crypto.createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', d: b64url(raw.subarray(0, 32)), x: b64url(raw.subarray(32)) },
    format: 'jwk',
  });
  return { key, alg: 'EdDSA' };
}

// JWT bound to one request (method + host + path, no query string), valid 2 minutes.
function buildJwt(keyName, signingKey, method, path, nowSec = Math.floor(Date.now() / 1000)) {
  const header = { alg: signingKey.alg, typ: 'JWT', kid: keyName, nonce: crypto.randomBytes(16).toString('hex') };
  const payload = { iss: 'cdp', sub: keyName, nbf: nowSec, exp: nowSec + 120, uri: `${method} ${HOST}${path}` };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = signingKey.alg === 'ES256'
    ? crypto.sign('sha256', Buffer.from(input), { key: signingKey.key, dsaEncoding: 'ieee-p1363' })
    : crypto.sign(null, Buffer.from(input), signingKey.key);
  return `${input}.${b64url(sig)}`;
}

// One signed request (fresh JWT bound to method + path). Throws on transport/HTTP errors.
async function cbFetch(auth, method, path, { query = '', body } = {}) {
  const base = (process.env.COINBASE_API_BASE_URL || `https://${HOST}`).replace(/\/+$/, '');
  const jwt = buildJwt(auth.keyName, auth.signingKey, method, path);
  const res = await fetch(`${base}${path}${query}`, {
    method,
    headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok) {
    const hint = res.status === 401 ? ' (check key name/secret; Advanced Trade needs an ECDSA CDP key)' : '';
    throw new Error(`Coinbase HTTP ${res.status}: ${(json && (json.message || json.error)) || res.statusText}${hint}`);
  }
  return json;
}

// Credentials from .env, or an { error } explaining why they can't be used.
function loadAuth() {
  const keyName = process.env.COINBASE_API_KEY;
  const secret = process.env.COINBASE_API_SECRET;
  if (!keyName || !secret) return { error: 'COINBASE_API_KEY / COINBASE_API_SECRET not set in .env' };
  try {
    return { keyName, signingKey: loadSigningKey(secret) };
  } catch (err) {
    return { error: `Coinbase key unusable: ${err.message}` };
  }
}

const failure = (err) => {
  const reason = err.name === 'TimeoutError' ? `timed out after ${TIMEOUT_MS / 1000}s` : err.message;
  return { ok: false, error: reason.startsWith('Coinbase') ? reason : `Coinbase unreachable: ${reason}` };
};

async function getAccount() {
  const auth = loadAuth();
  if (auth.error) return { ok: false, error: auth.error };

  const balances = Object.fromEntries(CASH_CURRENCIES.map((c) => [c, 0]));
  try {
    let cursor = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = `?limit=250${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const body = await cbFetch(auth, 'GET', ACCOUNTS_PATH, { query });
      if (!body || !Array.isArray(body.accounts)) throw new Error('Coinbase: unexpected accounts response');
      for (const a of body.accounts) {
        const cur = a.currency || (a.available_balance && a.available_balance.currency);
        if (cur in balances) balances[cur] += Number((a.available_balance && a.available_balance.value) || 0);
      }
      if (!body.has_next || !body.cursor) break;
      cursor = body.cursor;
    }
  } catch (err) {
    return failure(err);
  }

  return {
    ok: true,
    buyingPower: balances.USD + balances.USDC, // cash available to buy crypto
    balances,
    currency: 'USD',
    environment: 'coinbase-live',
  };
}

// ---------- Holdings (read-only) ----------
// Spot positions of the DEFAULT portfolio, with Coinbase's own cost basis and
// average entry price: { ok, portfolio, positions: [spot_positions item], balances }.
const PORTFOLIOS_PATH = '/api/v3/brokerage/portfolios';

async function getPortfolioBreakdown() {
  const auth = loadAuth();
  if (auth.error) return { ok: false, error: auth.error };
  try {
    const list = await cbFetch(auth, 'GET', PORTFOLIOS_PATH);
    const portfolios = ((list && list.portfolios) || []).filter((p) => !p.deleted);
    const chosen = portfolios.find((p) => p.type === 'DEFAULT') || portfolios[0];
    if (!chosen) throw new Error('Coinbase: no portfolio found on this key');
    const path = `${PORTFOLIOS_PATH}/${encodeURIComponent(chosen.uuid)}`;
    const body = await cbFetch(auth, 'GET', path, { query: '?currency=USD' });
    const breakdown = body && body.breakdown;
    if (!breakdown || !Array.isArray(breakdown.spot_positions)) throw new Error('Coinbase: unexpected portfolio breakdown response');
    return { ok: true, portfolio: chosen.name || chosen.uuid, positions: breakdown.spot_positions, balances: breakdown.portfolio_balances || {} };
  } catch (err) {
    return failure(err);
  }
}

// ---------- Orders ----------
const ORDERS_PATH = '/api/v3/brokerage/orders';
const base8 = (x) => (Math.floor(x * 1e8) / 1e8).toFixed(8).replace(/\.?0+$/, '');
const quotePx = (p) => (p >= 1 ? p.toFixed(2) : p.toFixed(6));

// Market BUY for the risk-engine size, with an ATTACHED take-profit/stop-loss
// bracket (trigger_bracket_gtc): the exits live at Coinbase and inherit the entry
// size, so the position is protected even if SignalDesk is offline. Spot only:
// shorts are refused. client_order_id = candidate id guards against duplicates.
async function submitOrder(candidate, size, entryPrice) {
  const c = candidate;
  const tp = c.targets && c.targets[0] && c.targets[0].price;
  let problem = null;
  if (c.market !== 'crypto') problem = `Coinbase live routing supports crypto only (got "${c.market}")`;
  else if (c.direction !== 'long') problem = 'spot accounts cannot open shorts';
  else if (!(size > 0) || base8(size) === '0') problem = `invalid size ${size}`;
  else if (!(tp > 0) || !(c.invalidation > 0) || !(c.invalidation < entryPrice && entryPrice < tp)) {
    problem = `levels out of order: stop ${c.invalidation}, entry ${entryPrice}, target ${tp}`;
  }
  if (problem) return { ok: false, error: `Coinbase order not sent: ${problem}` };

  const auth = loadAuth();
  if (auth.error) return { ok: false, error: auth.error };

  let body;
  try {
    body = await cbFetch(auth, 'POST', ORDERS_PATH, {
      body: {
        client_order_id: String(c.id),
        product_id: c.asset,
        side: 'BUY',
        order_configuration: { market_market_ioc: { base_size: base8(size) } },
        attached_order_configuration: {
          trigger_bracket_gtc: { limit_price: quotePx(tp), stop_trigger_price: quotePx(c.invalidation) },
        },
      },
    });
  } catch (err) {
    return failure(err);
  }
  // Coinbase reports rejections with HTTP 200 and success: false.
  if (!body || body.success !== true) {
    const e = (body && body.error_response) || {};
    return { ok: false, error: `Coinbase rejected order: ${e.error_details || e.message || e.new_order_failure_reason || e.error || 'unknown reason'}` };
  }
  const orderId = body.success_response && body.success_response.order_id;
  if (!orderId) return { ok: false, error: 'Coinbase: order response had no order_id' };
  return { ok: true, brokerId: orderId, environment: 'coinbase-live' };
}

// ---------- Order status (reconciliation) ----------
const HISTORICAL_PATH = '/api/v3/brokerage/orders/historical/';
const TERMINAL = new Set(['filled', 'canceled', 'expired', 'failed']);
// Coinbase statuses are UPPERCASE and spell CANCELLED; normalise to Alpaca-style.
const normStatus = (s) => String(s || 'unknown').toLowerCase().replace('cancelled', 'canceled');
const numOrNull = (x) => (x === undefined || x === null || x === '' ? null : Number(x));

async function fetchOrder(auth, orderId) {
  const body = await cbFetch(auth, 'GET', `${HISTORICAL_PATH}${encodeURIComponent(orderId)}`);
  if (!body || !body.order) throw new Error('Coinbase: unexpected order response');
  return body.order;
}

// Entry order + its attached TP/SL order. `brokerId` is the ENTRY order id; the
// protective exit is a separate order linked by `attached_order_id`.
//   { ok, status, filledQty, avgFillPrice, terminal,
//     exit: { status, filledQty, avgFillPrice, kind: null, brokerExitId } | null }
// kind is null: one trigger-bracket order serves both exits, so the caller infers
// take-profit vs stop-loss from the fill price.
async function getOrderStatus(brokerId) {
  if (!brokerId) return { ok: false, error: 'missing broker order id' };
  const auth = loadAuth();
  if (auth.error) return { ok: false, error: auth.error };
  try {
    const entry = await fetchOrder(auth, brokerId);
    let exit = null;
    if (entry.attached_order_id) {
      const a = await fetchOrder(auth, entry.attached_order_id);
      const status = normStatus(a.status);
      exit = {
        status: TERMINAL.has(status) || numOrNull(a.filled_size) > 0 ? status : 'open',
        filledQty: numOrNull(a.filled_size) || 0,
        avgFillPrice: numOrNull(a.average_filled_price),
        fees: numOrNull(a.total_fees) || 0,
        kind: null,
        brokerExitId: a.order_id || entry.attached_order_id,
      };
    }
    const status = normStatus(entry.status);
    return {
      ok: true,
      status,
      filledQty: numOrNull(entry.filled_size) || 0,
      avgFillPrice: numOrNull(entry.average_filled_price),
      fees: numOrNull(entry.total_fees) || 0,
      terminal: TERMINAL.has(status),
      exit,
    };
  } catch (err) {
    return failure(err);
  }
}

module.exports = { getAccount, getPortfolioBreakdown, submitOrder, getOrderStatus, buildJwt, loadSigningKey };
