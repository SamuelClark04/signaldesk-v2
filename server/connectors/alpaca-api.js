// Alpaca Trading API (REST, on demand): account data for the live stock/options venue.
// Read-only for now: no order endpoints are called from this file.
//
// Base URL: live by default. Point ALPACA_TRADING_BASE_URL at
// https://paper-api.alpaca.markets to test against an Alpaca Paper account
// (paper and live accounts use different key pairs).
//
// Never throws: every outcome is { ok: true, ... } or { ok: false, error }.
const DEFAULT_BASE_URL = 'https://api.alpaca.markets';
const TIMEOUT_MS = 8000;

const num = (x) => (x === undefined || x === null || x === '' ? null : Number(x));

async function getAccount() {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_API_SECRET;
  if (!key || !secret) return { ok: false, error: 'ALPACA_API_KEY / ALPACA_API_SECRET not set in .env' };

  const base = (process.env.ALPACA_TRADING_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  let res;
  try {
    res = await fetch(`${base}/v2/account`, {
      headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? `timed out after ${TIMEOUT_MS / 1000}s` : err.message;
    return { ok: false, error: `Alpaca unreachable: ${reason}` };
  }

  let body = null;
  try { body = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? ' (check keys, and live vs paper base URL)' : '';
    return { ok: false, error: `Alpaca HTTP ${res.status}: ${(body && body.message) || res.statusText}${hint}` };
  }
  if (!body || body.buying_power === undefined) return { ok: false, error: 'Alpaca: unexpected account response' };

  return {
    ok: true,
    buyingPower: num(body.buying_power),
    cash: num(body.cash),
    equity: num(body.equity),
    currency: body.currency || 'USD',
    status: body.status,
    tradingBlocked: Boolean(body.trading_blocked || body.account_blocked),
    environment: base.includes('paper-api') ? 'alpaca-paper' : 'alpaca-live',
  };
}

module.exports = { getAccount, DEFAULT_BASE_URL };
