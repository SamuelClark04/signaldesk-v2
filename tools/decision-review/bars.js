// Market data for the Decision Review (Phase 93), FETCHED after the fact and cached on disk (reports/.cache, git-ignored).
//   stocks   Alpaca data v2 1-minute bars, feed 'sip' (what the market did: the outcome paths) or 'iex' (what the app's own chart
//            used: the pre-decision chart reconstruction); daily bars (sip). Keys from this PC's .env (data keys), headers only.
//   crypto   Coinbase Exchange public 1-minute candles (no key).
//   options  Alpaca option 1-minute TRADE bars (estimates only: prints, not quotes; the free plan has no historical quotes).
// One cache file per symbol / feed / New York day. Rows: [tMs, o, h, l, c, v], oldest first. Never prints a key.
const fs = require('fs');
const path = require('path');
const T = require('./time');

let CACHE = path.join(__dirname, '..', '..', 'reports', '.cache');
const setCache = (dir) => { CACHE = dir; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keys = () => {
  const id = process.env.ALPACA_API_KEY && process.env.ALPACA_API_SECRET ? process.env.ALPACA_API_KEY : process.env.ALPACA_PAPER_API_KEY;
  const secret = process.env.ALPACA_API_KEY && process.env.ALPACA_API_SECRET ? process.env.ALPACA_API_SECRET : process.env.ALPACA_PAPER_API_SECRET;
  return id && secret ? { 'APCA-API-KEY-ID': id, 'APCA-API-SECRET-KEY': secret } : null;
};
const DATA = () => (process.env.REVIEW_ALPACA_DATA_URL || 'https://data.alpaca.markets').replace(/\/+$/, '');
const COINBASE = () => (process.env.REVIEW_COINBASE_URL || 'https://api.exchange.coinbase.com').replace(/\/+$/, '');
let fetcher = (...a) => fetch(...a);
const setFetch = (f) => { fetcher = f || ((...a) => fetch(...a)); };
const stats = { requests: 0, cacheHits: 0, errors: 0, lastError: null };

async function getJson(url, headers = {}, tries = 4) {
  for (let i = 0; i < tries; i += 1) {
    stats.requests += 1;
    try {
      const r = await fetcher(url, { headers, signal: AbortSignal.timeout(20000) });
      if (r.status === 429 || r.status >= 500) { await sleep(1500 * (i + 1)); continue; }
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(`HTTP ${r.status}${j && j.message ? `: ${j.message}` : ''}`);
      return j;
    } catch (err) { if (i === tries - 1) { stats.errors += 1; stats.lastError = String(err.message).slice(0, 160); throw err; } await sleep(800 * (i + 1)); }
  }
  throw new Error('rate limited');
}

const file = (kind, symbol, day) => path.join(CACHE, kind, String(symbol).replace(/[^A-Za-z0-9._-]/g, '_'), `${day}.json`);
function readCache(f) { try { stats.cacheHits += 1; return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { stats.cacheHits -= 1; return null; } }
function writeCache(f, rows) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(rows)); }
const done = (day) => T.at(day, 23 * 60 + 59) + 60 * 60 * 1000 < Date.now(); // only finished days are cached

// One New York day of 1-minute stock bars (all hours Alpaca returns; callers filter the session). feed 'sip' | 'iex'.
async function stockDay(symbol, day, feed = 'sip') {
  const f = file(`stocks-${feed}`, symbol, day);
  const hit = readCache(f); if (hit) return hit;
  const h = keys(); if (!h) throw new Error('no Alpaca data keys in .env (ALPACA_API_KEY / ALPACA_PAPER_API_KEY)');
  const start = new Date(T.at(day, 4 * 60)).toISOString(); const end = new Date(Math.min(T.at(day, 20 * 60), Date.now() - 16 * 60 * 1000)).toISOString();
  const rows = []; let token = null;
  do {
    const u = `${DATA()}/v2/stocks/${encodeURIComponent(symbol)}/bars?timeframe=1Min&start=${start}&end=${end}&feed=${feed}&adjustment=raw&limit=10000${token ? `&page_token=${token}` : ''}`;
    const j = await getJson(u, h);
    for (const b of (j && j.bars) || []) rows.push([Date.parse(b.t), b.o, b.h, b.l, b.c, b.v]);
    token = j && j.next_page_token;
  } while (token);
  if (done(day)) writeCache(f, rows);
  return rows;
}

// Daily bars (sip) between two New York days, inclusive: [tMs(day start), o, h, l, c, v].
async function stockDaily(symbol, fromDay, toDay) {
  const f = file('stocks-daily', symbol, `${fromDay}_${toDay}`);
  const hit = readCache(f); if (hit) return hit;
  const h = keys(); if (!h) throw new Error('no Alpaca data keys in .env');
  const rows = []; let token = null;
  do {
    const end = new Date(Math.min(T.at(toDay, 23 * 60 + 59), Date.now() - 16 * 60 * 1000)).toISOString(); // the free plan refuses SIP from the last 15 min
    const u = `${DATA()}/v2/stocks/${encodeURIComponent(symbol)}/bars?timeframe=1Day&start=${new Date(T.at(fromDay, 0)).toISOString()}&end=${end}&feed=sip&adjustment=raw&limit=10000${token ? `&page_token=${token}` : ''}`;
    const j = await getJson(u, h);
    for (const b of (j && j.bars) || []) rows.push([Date.parse(b.t), b.o, b.h, b.l, b.c, b.v]);
    token = j && j.next_page_token;
  } while (token);
  if (done(toDay)) writeCache(f, rows);
  return rows;
}

// One UTC-aligned slice of Coinbase 1-minute candles per New York day (5 requests of 300).
async function cryptoDay(product, day) {
  const f = file('crypto', product, day);
  const hit = readCache(f); if (hit) return hit;
  const from = T.at(day, 0); const to = Math.min(from + T.DAY, Date.now() - 2 * 60 * 1000); // Coinbase refuses a start in the future
  const rows = [];
  for (let s = from; s < to; s += 300 * 60 * 1000) {
    const e = Math.min(to, s + 300 * 60 * 1000);
    const j = await getJson(`${COINBASE()}/products/${encodeURIComponent(product)}/candles?granularity=60&start=${new Date(s).toISOString()}&end=${new Date(e).toISOString()}`, { 'User-Agent': 'signaldesk-review' });
    for (const c of Array.isArray(j) ? j : []) { const t = c[0] * 1000; if (t >= s && t < e) rows.push([t, c[3], c[2], c[1], c[4], c[5]]); }
    await sleep(120);
  }
  rows.sort((a, b) => a[0] - b[0]);
  if (done(day)) writeCache(f, rows);
  return rows;
}

// Option trade bars for one contract and day (ESTIMATE tier).
async function optionDay(contract, day) {
  const f = file('options', contract, day);
  const hit = readCache(f); if (hit) return hit;
  const h = keys(); if (!h) throw new Error('no Alpaca data keys in .env');
  const u = `${DATA()}/v1beta1/options/bars?symbols=${encodeURIComponent(contract)}&timeframe=1Min&start=${new Date(T.at(day, 9 * 60)).toISOString()}&end=${new Date(T.at(day, 16 * 60 + 15)).toISOString()}&limit=10000`;
  const j = await getJson(u, h);
  const rows = (((j && j.bars) || {})[contract] || []).map((b) => [Date.parse(b.t), b.o, b.h, b.l, b.c, b.v]);
  if (done(day)) writeCache(f, rows);
  return rows;
}

// Minute rows for a span of New York days (the days without bars = holidays / no trades).
async function minutes(market, symbol, days, feed = 'sip') {
  const out = [];
  for (const d of days) {
    const rows = market === 'crypto' ? await cryptoDay(symbol, d) : await stockDay(symbol, d, feed);
    out.push(...rows);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

module.exports = { stockDay, stockDaily, cryptoDay, optionDay, minutes, setCache, setFetch, stats, keys };
