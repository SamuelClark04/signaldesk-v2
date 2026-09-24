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
// Greeks fallback: when the indicative snapshot omits greeks.delta or
// impliedVolatility, IV is solved from the quote's mid and Delta / Gamma /
// Theta / Vega computed locally (risk/option-greeks.js); greeksSource says which.
// Liquidity (liquidity()): a fresh two-sided quote; a bid/ask spread within
// maxSpreadFor(underlying) (SPY / QQQ / IWM / DIA 5%, the liquid megacaps 8.5%,
// other stocks 7% of mid); and traded today (dailyBar volume > 0). The snapshot
// carries no open interest, and volume is often 0 or missing outside peak
// hours: a contract with none is still accepted within 2 strikes of the money,
// 21-60 DTE, with a spread <= 7%.
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

const INDEX_ETFS = new Set(['SPY', 'QQQ', 'IWM', 'DIA']);
const LIQUID_SINGLES = new Set(['NVDA', 'AAPL', 'TSLA', 'META', 'AMD', 'MSFT', 'AMZN', 'GOOGL']);
const maxSpreadFor = (u) => (INDEX_ETFS.has(u) ? 0.05 : LIQUID_SINGLES.has(u) ? 0.085 : 0.07);
const QUIET = { maxAtmStrikes: 2, minDte: 21, maxDte: 60, maxSpreadPct: 0.07 };

// Fill missing IV / greeks from the quote's mid (lazy require: option-greeks ->
// option-pricing -> this module).
function withModelGreeks(c, spot, now) {
  if (Number.isFinite(c.delta) && Number.isFinite(c.iv) && c.iv > 0) return { ...c, greeksSource: 'alpaca' };
  if (!(spot > 0) || !(c.mid > 0)) return { ...c, greeksSource: 'none' };
  const { impliedVol, greeks } = require('../risk/option-greeks');
  const T = Math.max(0, (expiryMs(c.expiration) - now) / (365 * 864e5));
  const iv = Number.isFinite(c.iv) && c.iv > 0 ? c.iv : impliedVol(c.mid, c.type, spot, c.strike, T);
  const g = iv ? greeks(c.type, spot, c.strike, T, iv) : null;
  if (!g) return { ...c, greeksSource: 'none' };
  return { ...c, iv, delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega, greeksSource: 'model' };
}

// One snapshot -> a flat contract record (null when the symbol is not OCC).
function toContract(symbol, s, now, spot) {
  const occ = parseOcc(symbol);
  if (!occ) return null;
  const q = s.latestQuote || {};
  const g = s.greeks || {};
  const bid = Number(q.bp) || 0;
  const ask = Number(q.ap) || 0;
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
  return withModelGreeks({
    symbol, underlying: occ.root, type: occ.type, strike: occ.strike, expiration: occ.expiration,
    dte: daysToExpiry(occ.expiration, now), bid, ask, mid, spread: mid ? ask - bid : null, spreadPct: mid ? (ask - bid) / mid : null,
    quoteTime: q.t ? Date.parse(q.t) : null, iv: Number.isFinite(s.impliedVolatility) ? s.impliedVolatility : null,
    delta: Number.isFinite(g.delta) ? g.delta : null, gamma: g.gamma ?? null, theta: g.theta ?? null, vega: g.vega ?? null,
    volume: s.dailyBar && Number.isFinite(s.dailyBar.v) ? s.dailyBar.v : null, openInterest: Number.isFinite(s.openInterest) ? s.openInterest : null,
  }, spot, now);
}

// Real chain for one underlying and window: { ok, contracts, fetchedAt, feed } or { ok:false, error }.
// opts: { type: 'call'|'put', minDte, maxDte, strikeMin, strikeMax, spot }. Cached
// CHAIN_TTL_MS. spot (the live underlying) lets missing greeks be modelled.
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
        const c = toContract(sym, snap, now, opts.spot);
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

// Is contract x tradeable? null when it is, else why not. `all` is the chain
// (to count strikes from the money at x's expiration), spot the live price.
function liquidity(x, all, spot, c, now = Date.now()) {
  if (!(x.bid >= c.minBid && x.ask > x.bid && x.quoteTime && now - x.quoteTime <= c.maxQuoteAgeMs)) return 'no fresh two-sided quote';
  const cap = maxSpreadFor(x.underlying);
  if (!(x.spreadPct <= cap)) return `spread over ${(cap * 100).toFixed(1)}% of mid`;
  if (x.volume > 0 || x.openInterest > 0) return null;
  const strikes = [...new Set(all.filter((y) => y.expiration === x.expiration && y.type === x.type).map((y) => y.strike))].sort((a, b) => a - b);
  const atm = strikes.reduce((best, k, i) => (Math.abs(k - spot) < Math.abs(strikes[best] - spot) ? i : best), 0);
  const away = Math.abs(strikes.indexOf(x.strike) - atm);
  if (away <= QUIET.maxAtmStrikes && x.dte >= QUIET.minDte && x.dte <= QUIET.maxDte && x.spreadPct <= QUIET.maxSpreadPct) return null;
  return 'no volume / open interest and not within 2 strikes of the money';
}

// Contract selection: of type c.type in [minDte, maxDte] (c.expiration pins
// one date), with |delta| in [minDelta, maxDelta] and tradeable (liquidity()),
// the one nearest targetDelta; ties: nearer the middle of the DTE window, then
// the tighter spread. { ok, contract, candidates } or { ok:false, error }.
function selectContract(contracts, c, now = Date.now(), spot = null) {
  const inWindow = contracts.filter((x) => x.dte >= c.minDte && x.dte <= c.maxDte && x.type === c.type && (!c.expiration || x.expiration === c.expiration));
  if (!inWindow.length) return { ok: false, error: `no ${c.type}s expiring in ${c.minDte}-${c.maxDte} days` };
  const inDelta = inWindow.filter((x) => Number.isFinite(x.delta) && Math.abs(x.delta) >= c.minDelta && Math.abs(x.delta) <= c.maxDelta);
  if (!inDelta.length) return { ok: false, error: `no contract with delta ${c.minDelta}-${c.maxDelta}` };
  const why = new Map(inDelta.map((x) => [x, liquidity(x, contracts, spot > 0 ? spot : x.strike, c, now)]));
  const liquid = inDelta.filter((x) => why.get(x) === null);
  if (!liquid.length) {
    const counts = {};
    for (const w of why.values()) counts[w] = (counts[w] || 0) + 1;
    return { ok: false, error: `none of ${inDelta.length} contracts with delta ${c.minDelta}-${c.maxDelta} is tradeable (${Object.entries(counts).map(([k, n]) => `${n}: ${k}`).join('; ')})` };
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
      // bid 0 is a real quote too (a short leg far out of the money is bought back at the ask).
      if (c && c.bid >= 0 && c.ask > 0) quotes.set(sym, { at: now, bid: c.bid, ask: c.ask, quoteTime: c.quoteTime, iv: c.iv, delta: c.delta });
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

module.exports = { getChain, selectContract, liquidity, maxSpreadFor, toContract, refreshQuotes, freshQuote, parseOcc, expiryMs, daysToExpiry, reset, CHAIN_TTL_MS, feed };
