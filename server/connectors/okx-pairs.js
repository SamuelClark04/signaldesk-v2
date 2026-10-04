// OKX US spot instruments (Phase 69B): the PUBLIC /api/v5/public/instruments?instType=SPOT list
// (no key), cached PAIRS_TTL_MS, so SignalDesk symbols map to OKX instIds and orders respect each
// instrument's steps and minimum:
//   SignalDesk 'ETH-USD' -> OKX's ETH-USD book if it lists one, else its 'ETH-USDC' / 'ETH-USDT' books (Phase 92,
//   checked 2026-10-04: OKX US lists NO BTC-USD / ETH-USD instrument; BTC-USDC / ETH-USDC settle in USDG, USD,
//   USDC or RLUSD, BTC-USDT / ETH-USDT in USDT only)
//   minSz (minimum base size), lotSz (size step), tickSz (price step)
//   tradeQuoteCcyList: the quote currencies one book settles in (an order pays with the one named in
//   tradeQuoteCcy); only USD / USDC / USDT balances are counted as spendable (QUOTES)
// Only 'live' USD / USDC / USDT instruments are kept. lists() / get() are synchronous on the
// cache (empty until the first load: the router's prepare() loads it before routing).
const config = require('../config');

const PAIRS_TTL_MS = 6 * 60 * 60 * 1000;
const FAIL_RETRY_MS = 60 * 1000;
const TIMEOUT_MS = 8000;
const QUOTES = ['USD', 'USDC', 'USDT'];

let cache = { at: 0, bySymbol: new Map(), error: null };
let inflight = null;

// One instrument -> { symbol, instId, base, quote, minSz, lotSz, tickSz, tradeQuotes }.
function entryOf(x) {
  if (!x || x.instType && x.instType !== 'SPOT' || x.state !== 'live' || !QUOTES.includes(x.quoteCcy)) return null;
  return { symbol: `${x.baseCcy}-${x.quoteCcy}`, instId: x.instId, base: x.baseCcy, quote: x.quoteCcy, minSz: Number(x.minSz) || 0,
    lotSz: Number(x.lotSz) || 1e-8, tickSz: Number(x.tickSz) || 1e-8, tradeQuotes: Array.isArray(x.tradeQuoteCcyList) && x.tradeQuoteCcyList.length ? x.tradeQuoteCcyList : [x.quoteCcy] };
}

function load(list, now = Date.now()) {
  const next = { at: now, bySymbol: new Map(), error: null };
  for (const x of list || []) {
    const e = entryOf(x);
    if (e) next.bySymbol.set(e.symbol, e);
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
        const res = await fetch(`${config.okx().baseUrl}/api/v5/public/instruments?instType=SPOT`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        const j = await res.json();
        if (!res.ok || String(j.code) !== '0') throw new Error(`OKX instruments: ${j.msg || `HTTP ${res.status}`}`);
        const n = load(j.data);
        console.log(`[okx] ${n} USD / USDC / USDT spot instruments`);
        return { ok: true, pairs: n };
      } catch (err) {
        cache = { ...cache, at: Date.now(), error: err.message };
        console.warn(`[okx] instruments unavailable: ${err.message}`);
        return { ok: false, error: err.message };
      } finally { inflight = null; }
    })();
  }
  return inflight;
}

// The OKX instrument for a SignalDesk symbol ('ETH-USD'; 'ETH-USDC' / 'ETH-USDT' books), or null.
function get(symbol) {
  if (!cache.at || Date.now() - cache.at > PAIRS_TTL_MS) refresh().catch(() => {});
  return cache.bySymbol.get(String(symbol).toUpperCase()) || null;
}
const baseOf = (symbol) => String(symbol).toUpperCase().replace(/-(USD|USDC|USDT)$/, '');
const books = (symbol) => QUOTES.map((q) => get(`${baseOf(symbol)}-${q}`)).filter(Boolean); // USD first
const lists = (symbol) => books(symbol).length > 0;

// Steps: size floored to lotSz, price rounded to the nearest tickSz.
const decimalsOf = (x) => { const t = Number(x).toFixed(12).replace(/0+$/, ''); const i = t.indexOf('.'); return i < 0 ? 0 : t.length - i - 1; };
const size = (e, qty) => (Math.floor(qty / e.lotSz + 1e-9) * e.lotSz).toFixed(decimalsOf(e.lotSz));
const price = (e, px) => (Math.round(px / e.tickSz) * e.tickSz).toFixed(decimalsOf(e.tickSz));
// OKX's minimum order size (base). null when fine.
const minProblem = (e, qty) => (qty >= e.minSz && qty > 0 ? null : `${qty} is under OKX's ${e.instId} minimum of ${e.minSz}`);

module.exports = { refresh, load, get, books, lists, baseOf, size, price, minProblem, snapshot: () => ({ at: cache.at, pairs: cache.bySymbol.size, error: cache.error }), PAIRS_TTL_MS, QUOTES };
