// Coinbase Advanced Trade API (REST, on demand): account balances for the live crypto venue.
// Read-only for now: no order endpoints are called from this file.
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

async function fetchPage(keyName, signingKey, cursor) {
  const base = (process.env.COINBASE_API_BASE_URL || `https://${HOST}`).replace(/\/+$/, '');
  const query = `?limit=250${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
  const jwt = buildJwt(keyName, signingKey, 'GET', ACCOUNTS_PATH);
  const res = await fetch(`${base}${ACCOUNTS_PATH}${query}`, {
    headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok) {
    const hint = res.status === 401 ? ' (check key name/secret; Advanced Trade needs an ECDSA CDP key)' : '';
    throw new Error(`Coinbase HTTP ${res.status}: ${(body && (body.message || body.error)) || res.statusText}${hint}`);
  }
  if (!body || !Array.isArray(body.accounts)) throw new Error('Coinbase: unexpected accounts response');
  return body;
}

async function getAccount() {
  const keyName = process.env.COINBASE_API_KEY;
  const secret = process.env.COINBASE_API_SECRET;
  if (!keyName || !secret) return { ok: false, error: 'COINBASE_API_KEY / COINBASE_API_SECRET not set in .env' };

  let signingKey;
  try {
    signingKey = loadSigningKey(secret);
  } catch (err) {
    return { ok: false, error: `Coinbase key unusable: ${err.message}` };
  }

  const balances = Object.fromEntries(CASH_CURRENCIES.map((c) => [c, 0]));
  try {
    let cursor = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await fetchPage(keyName, signingKey, cursor);
      for (const a of body.accounts) {
        const cur = a.currency || (a.available_balance && a.available_balance.currency);
        if (cur in balances) balances[cur] += Number((a.available_balance && a.available_balance.value) || 0);
      }
      if (!body.has_next || !body.cursor) break;
      cursor = body.cursor;
    }
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? `timed out after ${TIMEOUT_MS / 1000}s` : err.message;
    return { ok: false, error: reason.startsWith('Coinbase') ? reason : `Coinbase unreachable: ${reason}` };
  }

  return {
    ok: true,
    buyingPower: balances.USD + balances.USDC, // cash available to buy crypto
    balances,
    currency: 'USD',
    environment: 'coinbase-live',
  };
}

module.exports = { getAccount, buildJwt, loadSigningKey };
