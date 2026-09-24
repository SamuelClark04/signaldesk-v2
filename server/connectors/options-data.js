// Options data: real option chains and quotes from Alpaca's options market data
// (REST, on demand; chains are large, so they are cached hard).
//   GET {data}/v1beta1/options/snapshots/{underlying}  chain: quotes + greeks + IV
//   GET {data}/v1beta1/options/snapshots?symbols=...    quotes for held contracts
// Feed: 'indicative' by default (free with any Alpaca account; real-time
// indicative quotes, not the consolidated OPRA NBBO). ALPACA_OPTIONS_FEED=opra
// needs the OPRA agreement / a paid plan. Keys travel in headers only.
//
// Contract symbols are OCC: ROOT + YYMMDD + C|P + strike x 1000 (8 digits),
// e.g. SPY261030C00650000 = SPY 30 Oct 2026 650 call.
const CHAIN_TTL_MS = 20 * 60 * 1000;
const CHAIN_FAIL_TTL_MS = 5 * 60 * 1000;
const QUOTE_TTL_MS = 60 * 1000;
const MAX_PAGES = 5;
const TIMEOUT_MS = 10000;

const chains = new Map(); // key -> { at, ok, contracts, error }
const quotes = new Map(); // contract symbol -> { at, bid, ask, quoteTime, iv, delta }

const dataBase = () => (process.env.ALPACA_DATA_BASE_URL || 'https://data.alpaca.markets').replace(/\/$/, '');
const feed = () => (process.env.ALPACA_OPTIONS_FEED || 'indicative').toLowerCase();
const headers = () => ({ 'APCA-API-KEY-ID': process.env.ALPACA_API_KEY, 'APCA-API-SECRET-KEY': process.env.ALPACA_API_SECRET, Accept: 'application/json' });
const hasKeys = () => !!(process.env.ALPACA_API_KEY && process.env.ALPACA_API_SECRET);
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

// 'SPY261030C00650000' -> { root, expiration: '2026-10-30', type: 'call', strike: 650 }
function parseOcc(symbol) {
  const m = /^([A-Z.]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(String(symbol));
  if (!m) return null;
  return { root: m[1], expiration: `20${m[2]}-${m[3]}-${m[4]}`, type: m[5] === 'C' ? 'call' : 'put', strike: Number(m[6]) / 1000 };
}

// Expiry: 16:00 New York time on the expiration date (DST-aware).
function expiryMs(expiration) {
  const noonUtc = Date.parse(`${expiration}T12:00:00Z`);
  const nyNoon = new Date(noonUtc).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit' });
  const offsetH = 12 - Number(nyNoon); // 4 (EDT) or 5 (EST)
  return Date.parse(`${expiration}T16:00:00Z`) + offsetH * 3600 * 1000;
}
const daysToExpiry = (expiration, now = Date.now()) => Math.ceil((Date.parse(`${expiration}T00:00:00Z`) - Date.parse(`${isoDate(now)}T00:00:00Z`)) / 864e5);

async function getJson(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: headers(), signal: ctl.signal });
    const text = await r.text();
    if (!r.ok) {
      let msg = text.slice(0, 160);
      try { msg = JSON.parse(text).message || msg; } catch { /* keep raw text */ }
      throw new Error(`HTTP ${r.status}: ${msg}`);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

// One snapshot -> a flat contract record (null when the symbol is not OCC).
function toContract(symbol, s, now) {
  const occ = parseOcc(symbol);
  if (!occ) return null;
  const q = s.latestQuote || {};
  const g = s.greeks || {};
  const bid = Number(q.bp) || 0;
  const ask = Number(q.ap) || 0;
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
  return {
    symbol, underlying: occ.root, type: occ.type, strike: occ.strike, expiration: occ.expiration,
    dte: daysToExpiry(occ.expiration, now), bid, ask, mid, spread: mid ? ask - bid : null, spreadPct: mid ? (ask - bid) / mid : null,
    quoteTime: q.t ? Date.parse(q.t) : null, iv: Number.isFinite(s.impliedVolatility) ? s.impliedVolatility : null,
    delta: Number.isFinite(g.delta) ? g.delta : null, gamma: g.gamma ?? null, theta: g.theta ?? null, vega: g.vega ?? null,
  };
}

// Real chain for one underlying and window: { ok, contracts, fetchedAt, feed } or { ok:false, error }.
// opts: { type: 'call'|'put', minDte, maxDte, strikeMin, strikeMax }. Cached CHAIN_TTL_MS.
async function getChain(underlying, opts, now = Date.now()) {
  if (!hasKeys()) return { ok: false, error: 'ALPACA_API_KEY / ALPACA_API_SECRET not set in .env' };
  const from = isoDate(now + opts.minDte * 864e5);
  const to = isoDate(now + opts.maxDte * 864e5);
  // Strikes rounded outward so small price moves reuse the cached chain.
  const lo = Math.floor(opts.strikeMin);
  const hi = Math.ceil(opts.strikeMax);
  const key = `${underlying}|${opts.type}|${from}|${to}|${lo}|${hi}`;
  const hit = chains.get(key);
  if (hit && now - hit.at < (hit.ok ? CHAIN_TTL_MS : CHAIN_FAIL_TTL_MS)) {
    return hit.ok ? { ok: true, contracts: hit.contracts.map((c) => ({ ...c })), fetchedAt: hit.at, feed: feed() } : { ok: false, error: hit.error };
  }
  let entry;
  try {
    const base = `${dataBase()}/v1beta1/options/snapshots/${encodeURIComponent(underlying)}?feed=${feed()}&type=${opts.type}`
      + `&expiration_date_gte=${from}&expiration_date_lte=${to}&strike_price_gte=${lo}&strike_price_lte=${hi}&limit=1000`;
    const contracts = [];
    let token = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body = await getJson(token ? `${base}&page_token=${encodeURIComponent(token)}` : base);
      for (const [sym, snap] of Object.entries(body.snapshots || {})) {
        const c = toContract(sym, snap, now);
        if (c) contracts.push(c);
      }
      token = body.next_page_token;
      if (!token) break;
    }
    entry = { at: now, ok: true, contracts };
  } catch (err) {
    entry = { at: now, ok: false, error: `options chain for ${underlying}: ${err.name === 'AbortError' ? 'timed out' : err.message}` };
  }
  chains.set(key, entry);
  return entry.ok ? { ok: true, contracts: entry.contracts.map((c) => ({ ...c })), fetchedAt: now, feed: feed() } : { ok: false, error: entry.error };
}

// Contract selection: the call in [minDte, maxDte] whose delta is closest to
// targetDelta inside [minDelta, maxDelta], with a live two-sided quote no older
// than maxQuoteAgeMs and a bid/ask spread at most maxSpreadPct of the mid.
// Ties: nearer the middle of the DTE window, then the tighter spread.
// { ok, contract, candidates } or { ok:false, error } (why nothing qualified).
function selectContract(contracts, c, now = Date.now()) {
  const inWindow = contracts.filter((x) => x.dte >= c.minDte && x.dte <= c.maxDte && x.type === c.type);
  if (!inWindow.length) return { ok: false, error: `no ${c.type}s expiring in ${c.minDte}-${c.maxDte} days` };
  const quoted = inWindow.filter((x) => x.bid >= c.minBid && x.ask > x.bid && x.quoteTime && now - x.quoteTime <= c.maxQuoteAgeMs);
  if (!quoted.length) return { ok: false, error: `no fresh two-sided quotes in ${c.minDte}-${c.maxDte} DTE` };
  const inDelta = quoted.filter((x) => Number.isFinite(x.delta) && Math.abs(x.delta) >= c.minDelta && Math.abs(x.delta) <= c.maxDelta);
  if (!inDelta.length) return { ok: false, error: `no quoted contract with delta ${c.minDelta}-${c.maxDelta}` };
  const liquid = inDelta.filter((x) => x.spreadPct <= c.maxSpreadPct);
  if (!liquid.length) {
    const best = Math.min(...inDelta.map((x) => x.spreadPct));
    return { ok: false, error: `spreads too wide (tightest ${(best * 100).toFixed(1)}% of mid, limit ${(c.maxSpreadPct * 100).toFixed(0)}%)` };
  }
  const midDte = (c.minDte + c.maxDte) / 2;
  const score = (x) => [Math.abs(Math.abs(x.delta) - c.targetDelta), Math.abs(x.dte - midDte), x.spreadPct];
  liquid.sort((a, b) => { const sa = score(a); const sb = score(b); return sa[0] - sb[0] || sa[1] - sb[1] || sa[2] - sb[2]; });
  return { ok: true, contract: liquid[0], candidates: liquid.length };
}

// Fresh quotes for held contracts (one request for all), cached QUOTE_TTL_MS.
// Used to mark open option positions and to book paper exits at the real bid.
async function refreshQuotes(symbols, now = Date.now()) {
  const stale = [...new Set(symbols)].filter((s) => parseOcc(s) && !(quotes.has(s) && now - quotes.get(s).at < QUOTE_TTL_MS));
  if (!stale.length || !hasKeys()) return;
  try {
    const body = await getJson(`${dataBase()}/v1beta1/options/snapshots?symbols=${stale.map(encodeURIComponent).join(',')}&feed=${feed()}`);
    for (const [sym, snap] of Object.entries(body.snapshots || {})) {
      const c = toContract(sym, snap, now);
      if (c && c.bid > 0) quotes.set(sym, { at: now, bid: c.bid, ask: c.ask, quoteTime: c.quoteTime, iv: c.iv, delta: c.delta });
    }
  } catch (err) {
    console.warn(`[options-data] quote refresh failed: ${err.message}`);
  }
}

// The last real quote for a contract if its own timestamp is within maxAgeMs, else null.
function freshQuote(symbol, maxAgeMs = 3 * 60 * 1000, now = Date.now()) {
  const q = quotes.get(symbol);
  return q && q.quoteTime && now - q.quoteTime <= maxAgeMs && now - q.at <= maxAgeMs ? { ...q } : null;
}

// Test hook.
function reset() { chains.clear(); quotes.clear(); }

module.exports = { getChain, selectContract, refreshQuotes, freshQuote, parseOcc, expiryMs, daysToExpiry, reset, CHAIN_TTL_MS, feed };
