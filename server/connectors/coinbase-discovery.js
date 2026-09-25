// Coinbase full-exchange gem discovery (Phase 56). One free public request every
// REFRESH_MS (GET /api/v3/brokerage/market/products?product_type=SPOT, no key)
// returns every spot product with its 24h price change, volume, volume change
// and range. From it:
//   catalog   every coin with an online USD book (not cancel-only, limit-only,
//             view-only, disabled or delisted): ~390 coins, all chartable
//   gems      the catalog minus mega-cap majors (BTC ETH SOL XRP DOGE ADA LTC BCH
//             LINK AVAX XLM DOT UNI SUI SHIB HBAR TON, + BNB) and stablecoins /
//             wrapped / staked / pegged tokens. Majors belong to Systems 2 and 4,
//             never to System 6 or the Moonshot Radar.
//   watchlist the Active Gem Watchlist (<= WATCH_MAX), rebuilt every pass:
//             1. every gem on CoinGecko Trending or in the Reddit forums (matched
//                against the whole catalog by ticker or name, crypto-social.js)
//             2. 24h anomalies across all gems: +3% to +40% gainers, volume
//                waking up vs the prior 24h, new listings, range expansion
//             3. curated high-beta small / mid-caps (AI, DeFi, L2, meme, infra)
//             4. pinned: open / staged speculative trades (their exits need prices)
// Watchlist gems join the live Coinbase ticker stream (coinbase-socket.js).
// Never throws: a failed refresh keeps the last catalog and reports the error.
const coinbaseSocket = require('./coinbase-socket');

const REFRESH_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 10000;
const WATCH_MAX = 60;
const ANOMALY_MAX = 30;
const MIN_VOLUME_USD = 150000; // anomalies + curated: enough liquidity to trade a small size
const MIN_SOCIAL_VOLUME_USD = 25000; // a trending / discussed coin only needs a live market
const NEW_LISTING_DAYS = 14;
const MAJORS = new Set(['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'LTC', 'BCH', 'LINK', 'AVAX', 'XLM', 'DOT', 'UNI', 'SUI', 'SHIB', 'HBAR', 'TON', 'BNB']);
const PEGGED = new Set(['USDT', 'USDC', 'DAI', 'PYUSD', 'USDS', 'EURC', 'EUROC', 'GUSD', 'TUSD', 'FDUSD', 'RLUSD', 'USD1', 'USDE', 'SUSDE', 'PAXG', 'XAUT',
  'CBETH', 'CBBTC', 'WBTC', 'WETH', 'STETH', 'WSTETH', 'RETH', 'LSETH', 'JITOSOL', 'MSOL', 'WRON', 'WAXL']);
const PEGGED_NAME = /\b(wrapped|staked|pegged|stablecoin)\b/i;
// Curated high-beta small / mid-caps, interleaved by sector (only those Coinbase lists are used).
const CURATED = ['VIRTUAL', 'MORPHO', 'ARB', 'BONK', 'QNT', 'FET', 'PENDLE', 'OP', 'PEPE', 'PYTH', 'RENDER', 'ONDO', 'STRK', 'WIF', 'ZRO',
  'TAO', 'ENA', 'IMX', 'PENGU', 'HNT', 'AKT', 'AERO', 'ZK', 'DEGEN', 'JASMY', 'IO', 'DRIFT', 'POL', 'TOSHI', 'SWFTC', 'KAITO', 'ORCA', 'ZETA',
  'TURBO', 'PRIME', 'PROMPT', 'RAY', 'EIGEN', 'MOG', 'BIGTIME', 'GRT', 'SYRUP', 'MANTLE', 'PNUT', 'RARE', 'AIOZ', 'JTO', 'SEI', 'MOODENG', 'SUPER',
  'COOKIE', 'EUL', 'TIA', 'FLOKI', 'AXS', 'GRASS', 'COW', 'INJ', 'POPCAT', 'ILV', 'FLOCK', 'CVX', 'APT', 'SPX', 'GODS', 'SAPIEN', 'KMNO', 'NEAR', 'FARTCOIN', 'BEAM'];

let catalog = { at: 0, coins: [], swept: 0, products: 0, error: null };
let watch = { at: 0, list: [] };
let inflight = null;

const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : null; };
const tradable = (p) => p.status === 'online' && !p.trading_disabled && !p.cancel_only && !p.limit_only && !p.is_disabled && !p.view_only && !p.auction_mode;

// One product row -> a catalog coin (USD book; the USDC book is its alias at Coinbase).
function toCoin(p, now) {
  const base = String(p.base_currency_id || '').toUpperCase();
  const price = num(p.price);
  const newAt = Date.parse(p.new_at || '') || null;
  return {
    symbol: `${base}-USD`, base, name: p.base_name || base, price, change24h: num(p.price_percentage_change_24h) === null ? null : num(p.price_percentage_change_24h) / 100,
    volumeUsd: num(p.approximate_quote_24h_volume) || (num(p.volume_24h) || 0) * (price || 0), volChange: num(p.volume_percentage_change_24h) === null ? null : num(p.volume_percentage_change_24h) / 100,
    high24h: num(p.high_24h), low24h: num(p.low_24h), isNew: !!p.new || (newAt !== null && now - newAt < NEW_LISTING_DAYS * 86400000),
    major: MAJORS.has(base), pegged: PEGGED.has(base) || PEGGED_NAME.test(p.base_name || ''),
  };
}

async function refresh(now = Date.now(), { force = false } = {}) {
  if (!force && now - catalog.at < REFRESH_MS && catalog.coins.length) return catalog;
  if (inflight) return inflight;
  const url = `${(process.env.COINBASE_API_BASE_URL || 'https://api.coinbase.com').replace(/\/+$/, '')}/api/v3/brokerage/market/products?product_type=SPOT`;
  inflight = (async () => {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const products = ((await res.json()).products || []).filter((p) => p.product_type === 'SPOT');
      const coins = products.filter((p) => p.quote_currency_id === 'USD' && tradable(p) && /^[A-Z0-9]{1,10}$/.test(String(p.base_currency_id).toUpperCase()))
        .map((p) => toCoin(p, now)).filter((c) => c.price > 0);
      catalog = { at: now, coins, swept: coins.length, products: products.length, error: null };
      console.log(`[discovery] Coinbase spot: ${coins.length} tradable coins (${gems().length} gems after excluding majors + pegged) of ${products.length} products`);
    } catch (err) {
      catalog = { ...catalog, at: now, error: err.name === 'TimeoutError' ? 'timed out' : err.message };
      console.warn(`[discovery] catalog refresh failed (${catalog.error}); keeping ${catalog.coins.length} coins`);
    } finally {
      inflight = null;
    }
    return catalog;
  })();
  return inflight;
}

const gems = () => catalog.coins.filter((c) => !c.major && !c.pegged);
const coinOf = (symbol) => catalog.coins.find((c) => c.symbol === symbol) || null;
const isGem = (symbol) => { const c = coinOf(symbol); return !!c && !c.major && !c.pegged; };
const isExcluded = (symbol) => { const base = String(symbol).split('-')[0].toUpperCase(); return MAJORS.has(base) || PEGGED.has(base); };
// A CoinGecko / Reddit coin -> its Coinbase product: by ticker, else by name (CoinGecko "LIT" = Coinbase "Lighter").
function resolve(symbol, name) {
  const base = String(symbol || '').toUpperCase();
  const byBase = catalog.coins.find((c) => c.base === base);
  if (byBase) return byBase;
  const n = String(name || '').trim().toLowerCase();
  return n.length >= 3 ? catalog.coins.find((c) => c.name.toLowerCase() === n) || null : null;
}

// 24h anomaly strength 0-1 (0: not an anomaly): gain in the +3%..+40% band,
// volume waking up vs the prior 24h, range expansion, a fresh listing.
function anomaly(c) {
  if (!(c.volumeUsd >= MIN_VOLUME_USD)) return { score: 0, reasons: [] };
  const ch = c.change24h;
  const gain = ch !== null && ch >= 0.03 && ch <= 0.40 ? Math.min(1, (ch - 0.03) / 0.17) : 0;
  const wake = c.volChange !== null && c.volChange >= 0.5 ? Math.min(1, c.volChange / 2) : 0;
  const range = c.high24h > 0 && c.low24h > 0 ? Math.max(0, Math.min(1, (c.high24h / c.low24h - 1 - 0.06) / 0.2)) : 0;
  const score = 0.5 * gain + 0.35 * wake + 0.15 * range + (c.isNew ? 0.2 : 0);
  const reasons = [gain ? `24h ${ch >= 0 ? '+' : ''}${(ch * 100).toFixed(1)}%` : null, wake ? `volume +${Math.round(c.volChange * 100)}% vs prior 24h` : null,
    c.isNew ? 'new listing' : null].filter(Boolean);
  return { score: gain || wake || c.isNew ? score : 0, reasons };
}

// buzz: crypto-social snapshot ({ trending: [{ symbol, name, rank, product }], reddit: [{ symbol, mentions, recent }] });
// pinned: symbols that must stay streamed. -> [{ symbol, name, source, reasons, change24h, volumeUsd, volChange }]
function buildWatchlist(buzz = {}, pinned = [], now = Date.now()) {
  const out = new Map();
  const add = (c, source, reason) => {
    if (!c || c.major || c.pegged) return;
    const row = out.get(c.symbol);
    if (row) { if (reason && !row.reasons.includes(reason)) row.reasons.push(reason); return; }
    if (out.size >= WATCH_MAX && source !== 'pinned') return;
    out.set(c.symbol, { symbol: c.symbol, name: c.name, source, reasons: reason ? [reason] : [], change24h: c.change24h, volumeUsd: c.volumeUsd, volChange: c.volChange, isNew: c.isNew });
  };
  for (const s of pinned) add(coinOf(s), 'pinned', 'open / staged trade');
  for (const t of buzz.trending || []) { const c = t.product && coinOf(t.product); if (c && c.volumeUsd >= MIN_SOCIAL_VOLUME_USD) add(c, 'social', `CoinGecko trending #${t.rank}`); }
  for (const r of buzz.reddit || []) { const c = coinOf(r.symbol); if (c && c.volumeUsd >= MIN_SOCIAL_VOLUME_USD) add(c, 'social', `Reddit ${r.mentions} mention${r.mentions === 1 ? '' : 's'}${r.recent ? ` (${r.recent} new)` : ''}`); }
  const anomalies = gems().map((c) => ({ c, a: anomaly(c) })).filter((x) => x.a.score > 0).sort((x, y) => y.a.score - x.a.score).slice(0, ANOMALY_MAX);
  for (const { c, a } of anomalies) { add(c, 'anomaly', a.reasons[0]); for (const r of a.reasons.slice(1)) add(c, 'anomaly', r); }
  for (const base of CURATED) { const c = catalog.coins.find((x) => x.base === base); if (c && c.volumeUsd >= MIN_VOLUME_USD) add(c, 'curated', 'curated high-beta'); }
  watch = { at: now, list: [...out.values()] };
  return watch.list.map((w) => ({ ...w, reasons: [...w.reasons] }));
}

// Watchlist (and charted) gems stream live ticks; the socket keeps them for reconnects.
function stream(symbols) {
  const list = symbols.filter((s) => coinOf(s));
  return list.length ? coinbaseSocket.addProducts(list) : [];
}

const watchlist = () => watch.list.map((w) => ({ ...w, reasons: [...w.reasons] }));
const names = () => Object.fromEntries(catalog.coins.map((c) => [c.symbol, c.name]));
const nameOf = (symbol) => { const c = coinOf(symbol); return c ? c.name : null; };
// GEM_CATALOG for clients: every tradable coin (chart / symbol picker) + the sweep facts.
const snapshot = () => ({ at: catalog.at || null, swept: catalog.swept, gems: gems().length, products: catalog.products, error: catalog.error,
  symbols: catalog.coins.map((c) => c.symbol).sort(), names: names(), excluded: [...MAJORS] });

function reset() { catalog = { at: 0, coins: [], swept: 0, products: 0, error: null }; watch = { at: 0, list: [] }; }

module.exports = { refresh, buildWatchlist, stream, watchlist, gems, coinOf, isGem, isExcluded, resolve, anomaly, names, nameOf, snapshot, reset, toCoin,
  MAJORS, PEGGED, CURATED, WATCH_MAX, REFRESH_MS };
