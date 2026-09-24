// Options chain: on-demand ATM straddle lookup (REST by design, not a stream).
// MOCK for now. The real version will call Alpaca's option snapshots endpoint
// (GET https://data.alpaca.markets/v1beta1/options/snapshots/{underlying}) and pick
// the nearest-expiry at-the-money call and put.
//
// Results are cached per asset for CACHE_TTL_MS, so a strategy that asks on every
// 60s pipeline tick makes at most one request per asset per TTL, never a poll loop.
const CACHE_TTL_MS = 5 * 60 * 1000;

const MOCK_STRADDLE = Object.freeze({ callPrice: 4.20, putPrice: 3.80, ivp: 85 });

const cache = new Map(); // asset -> { at, value }

async function fetchStraddle(asset) { // eslint-disable-line no-unused-vars
  // TODO(Phase 10): replace with the Alpaca REST call described above.
  return { ...MOCK_STRADDLE };
}

async function getATMStraddle(asset, now = Date.now()) {
  const hit = cache.get(asset);
  if (hit && now - hit.at < CACHE_TTL_MS) return { ...hit.value };
  const value = await fetchStraddle(asset);
  cache.set(asset, { at: now, value });
  return { ...value };
}

module.exports = { getATMStraddle, CACHE_TTL_MS };
