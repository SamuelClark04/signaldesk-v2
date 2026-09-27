// Kraken Pro spot pairs (Phase 69A): the PUBLIC AssetPairs map (no key), cached PAIRS_TTL_MS,
// so SignalDesk symbols normalise to / from Kraken's pair codes and orders respect each pair's
// precision and minimums:
//   SignalDesk 'ETH-USD'  <->  Kraken wsname 'ETH/USD', pair key 'XETHZUSD', altname 'ETHUSD',
//   base asset code 'XETH' (Kraken's legacy X / Z prefixes; XBT = BTC, XDG = DOGE)
//   pair_decimals (price), lot_decimals (volume), ordermin (base), costmin (quote), tick_size
// Only USD and USDC pairs that are 'online' are kept. lists() / get() are synchronous on the
// cache (empty until the first load: the router then falls back to Coinbase and refreshes).
const PAIRS_TTL_MS = 6 * 60 * 60 * 1000;
const FAIL_RETRY_MS = 60 * 1000;
const TIMEOUT_MS = 8000;
const TO_SIGNALDESK = { XBT: 'BTC', XDG: 'DOGE' };
const TO_KRAKEN = { BTC: 'XBT', DOGE: 'XDG' };
const QUOTES = new Set(['USD', 'USDC']);

let cache = { at: 0, bySymbol: new Map(), byKey: new Map(), baseByCode: new Map(), codeByBase: new Map(), error: null };
let inflight = null;
const baseUrl = () => (process.env.KRAKEN_API_BASE_URL || 'https://api.kraken.com').replace(/\/+$/, '');

// One AssetPairs entry -> { symbol, key, altname, wsname, base, code, quote, pairDecimals, lotDecimals, ordermin, costmin, tick }.
function entryOf(key, p) {
  if (!p || !p.wsname || (p.status && p.status !== 'online')) return null;
  const [b, q] = String(p.wsname).split('/');
  if (!QUOTES.has(q)) return null;
  const base = TO_SIGNALDESK[b] || b;
  const pairDecimals = Number(p.pair_decimals);
  return { symbol: `${base}-${q}`, key, altname: p.altname, wsname: p.wsname, base, code: p.base, quote: q, pairDecimals, lotDecimals: Number(p.lot_decimals),
    ordermin: Number(p.ordermin) || 0, costmin: Number(p.costmin) || 0, tick: Number(p.tick_size) || 10 ** -pairDecimals };
}

function load(result, now = Date.now()) {
  const next = { at: now, bySymbol: new Map(), byKey: new Map(), baseByCode: new Map(), codeByBase: new Map(), error: null };
  for (const [key, p] of Object.entries(result || {})) {
    const e = entryOf(key, p);
    if (!e) continue;
    next.bySymbol.set(e.symbol, e);
    for (const k of [key, e.altname, e.wsname]) next.byKey.set(k, e);
    next.baseByCode.set(e.code, e.base);
    next.codeByBase.set(e.base, e.code);
  }
  cache = next;
  return cache.bySymbol.size;
}

async function refresh(force = false, now = Date.now()) {
  const fresh = cache.at && now - cache.at < (cache.error ? FAIL_RETRY_MS : PAIRS_TTL_MS);
  if (!force && fresh) return { ok: !cache.error, pairs: cache.bySymbol.size };
  if (!inflight) {
    inflight = (async () => {
      try {
        const res = await fetch(`${baseUrl()}/0/public/AssetPairs`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        const j = await res.json();
        if (!res.ok || (j.error && j.error.length)) throw new Error(`Kraken AssetPairs: ${(j.error || []).join(', ') || `HTTP ${res.status}`}`);
        const n = load(j.result);
        console.log(`[kraken] ${n} USD / USDC spot pairs`);
        return { ok: true, pairs: n };
      } catch (err) {
        cache = { ...cache, at: Date.now(), error: err.message };
        console.warn(`[kraken] pairs unavailable: ${err.message}`);
        return { ok: false, error: err.message };
      } finally { inflight = null; }
    })();
  }
  return inflight;
}

// The Kraken pair for a SignalDesk symbol ('ETH-USD'; 'ETH-USDC' for the USDC book), or null.
function get(symbol) {
  if (!cache.at || Date.now() - cache.at > PAIRS_TTL_MS) refresh().catch(() => {});
  return cache.bySymbol.get(String(symbol).toUpperCase()) || null;
}
const lists = (symbol) => !!get(symbol) || !!get(String(symbol).replace(/-USD$/, '-USDC')); // a USD or a USDC book
const byKraken = (pair) => cache.byKey.get(pair) || null; // a pair key / altname / wsname -> the entry
// A Kraken balance code -> the SignalDesk base ('XETH' -> 'ETH', 'ZUSD' -> 'USD'); earn / staked
// variants ('ETH.F', 'DOT.S') are not spot-tradable: null.
function baseOfCode(code) {
  const c = String(code);
  if (c.includes('.')) return null;
  if (c === 'ZUSD' || c === 'USD') return 'USD';
  if (cache.baseByCode.has(c)) return cache.baseByCode.get(c);
  const legacy = c.length === 4 && /^[XZ]/.test(c) ? c.slice(1) : c;
  return TO_SIGNALDESK[legacy] || legacy;
}
const codeOf = (base) => cache.codeByBase.get(base) || TO_KRAKEN[base] || base;

// Steps: volume floored to lot_decimals, price to the pair's tick (nearest).
const decimalsOf = (x) => { const t = Number(x).toFixed(12).replace(/0+$/, ''); const i = t.indexOf('.'); return i < 0 ? 0 : t.length - i - 1; };
const volume = (e, qty) => (Math.floor(qty * 10 ** e.lotDecimals + 1e-9) / 10 ** e.lotDecimals).toFixed(e.lotDecimals);
const price = (e, px) => (Math.round(px / e.tick) * e.tick).toFixed(Math.max(decimalsOf(e.tick), 0));
// Kraken's minimums: ordermin (base volume) and costmin (quote value). null when fine.
function minProblem(e, qty, px) {
  if (!(qty >= e.ordermin)) return `${qty} is under Kraken's ${e.wsname} minimum of ${e.ordermin}`;
  if (e.costmin && !(qty * px >= e.costmin)) return `$${(qty * px).toFixed(2)} is under Kraken's ${e.wsname} minimum cost of $${e.costmin}`;
  return null;
}

module.exports = { refresh, load, get, lists, byKraken, baseOfCode, codeOf, volume, price, minProblem, snapshot: () => ({ at: cache.at, pairs: cache.bySymbol.size, error: cache.error }), PAIRS_TTL_MS };
