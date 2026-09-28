// News sentiment: a 0-100 score per symbol (0 = extreme bearish, 50 = neutral,
// 100 = extreme bullish), for stocks and crypto. REST on demand, cached.
//   1. Stocks with FINNHUB_API_KEY: Finnhub /news-sentiment (companyNewsScore
//      0-1 -> 0-100). That endpoint is not on every Finnhub plan; any refusal
//      falls through to (2), never to a made-up number.
//   2. Otherwise (and for crypto): the Catalyst Feed's own news for the symbol
//      (Phase 66, data/news-feed.js: the last 48 hours, only articles whose headline
//      or first sentence names it or that tag at most 3 symbols; Alpaca, plus
//      CoinDesk / Cointelegraph / Decrypt for crypto) scored with SignalDesk's
//      headline dictionary (intelligence/sentiment-nlp.js):
//      score = 50 + 50 * (bullish − bearish) / (bullish + bearish + 2)
//      (the +2 keeps a single headline from reading as "extreme").
// No relevant headlines -> score null ("no recent news"), not 50.
// headlines: the 5 most recent of those articles, newest first, each { title, url,
// at, source, tone } (tone = SignalDesk's reading: bullish / bearish / neutral).
// With a Finnhub score the same headlines are attached for context. The feed stores
// its reading here (store) whenever it is refreshed, so both always match.
// Never throws: { ok: true, score|null, label, source, bullish, bearish, neutral, total, headlines, at } | { ok: false, error }.
const CACHE_MS = 10 * 60 * 1000; // the feed's news is cached 2.5 min and re-stores this whenever it is viewed (Phase 66)
const FAIL_MS = 15 * 60 * 1000;
const TIMEOUT_MS = 8000;
const cache = new Map(); // symbol -> { at, result }

const label = (s) => (s === null ? 'No recent news' : s < 20 ? 'Extreme bearish' : s < 40 ? 'Bearish' : s <= 60 ? 'Neutral' : s <= 80 ? 'Bullish' : 'Extreme bullish');

async function getJson(url, headers) {
  const res = await require('./net-guard').guardedFetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { ok: res.ok, status: res.status, json };
}

async function fromFinnhub(symbol) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key || symbol.includes('-')) return null;
  const base = (process.env.FINNHUB_BASE_URL || 'https://finnhub.io/api/v1').replace(/\/+$/, '');
  const r = await getJson(`${base}/news-sentiment?symbol=${encodeURIComponent(symbol)}`, { 'X-Finnhub-Token': key }).catch(() => null);
  const s = r && r.ok && r.json && Number(r.json.companyNewsScore);
  if (!Number.isFinite(s)) return null; // plan without access, or no data: use headlines
  const score = Math.round(Math.max(0, Math.min(1, s)) * 100);
  const bull = r.json.sentiment && r.json.sentiment.bullishPercent;
  return { ok: true, score, label: label(score), source: `Finnhub news sentiment${Number.isFinite(bull) ? ` (${Math.round(bull * 100)}% bullish articles)` : ''}` };
}

// Phase 66: the headlines are the Catalyst Feed's own news for the symbol (48 h, subject-
// filtered, Alpaca + crypto RSS: data/news-feed.js), so every screen counts the same ones.
async function fromHeadlines(symbol) {
  const feed = require('../data/news-feed'); // lazy: news-feed requires this module
  const n = await feed.newsFor(symbol);
  return feed.sentimentOf(symbol, n.items, n.errors);
}
// Store a result computed elsewhere (the feed's sentimentOf) as the symbol's current reading.
function store(result, now = Date.now()) {
  if (!result || !result.symbol) return result;
  const s = String(result.symbol).toUpperCase();
  cache.set(s, { at: now, result: { ...result, symbol: s, at: now } });
  return { ...result, symbol: s, at: now };
}
const usesFinnhub = (symbol) => !!process.env.FINNHUB_API_KEY && !String(symbol).includes('-');

async function getSentiment(symbol, now = Date.now()) {
  const s = String(symbol || '').toUpperCase();
  if (!/^[A-Z0-9.]{1,10}(-USD)?$/.test(s)) return { ok: false, error: 'invalid symbol' };
  const hit = cache.get(s);
  if (hit && now - hit.at < (hit.result.ok ? CACHE_MS : FAIL_MS)) return { ...hit.result };
  let result;
  try {
    const finnhub = await fromFinnhub(s);
    const heads = await fromHeadlines(s);
    // A Finnhub score keeps its number; the feed's headlines are shown alongside it.
    result = finnhub ? { ...finnhub, headlines: heads.ok ? heads.headlines : [], headlineSource: heads.ok ? heads.source : null } : heads;
  } catch (err) {
    result = { ok: false, error: err.name === 'TimeoutError' ? 'news source timed out' : err.message };
  }
  result = { ...result, symbol: s, at: now };
  cache.set(s, { at: now, result });
  return { ...result };
}

// One sentence for a thesis.
function describe(sent) {
  if (!sent || !sent.ok) return 'News sentiment unavailable.';
  if (sent.score === null) return `News sentiment: no recent headlines (${sent.source}).`;
  return `News sentiment is ${sent.label} (${sent.score}/100, ${sent.source}).`;
}

// Cached result only (no fetch): the Moonshot Radar scores 42 coins a minute without
// spending news quota; null until a strategy / the chart has asked for the symbol.
const peek = (symbol) => { const hit = cache.get(String(symbol || '').toUpperCase()); return hit ? { ...hit.result } : null; };

module.exports = { getSentiment, peek, describe, label, store, usesFinnhub, CACHE_MS };
