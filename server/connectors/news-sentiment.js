// News sentiment: a 0-100 score per symbol (0 = extreme bearish, 50 = neutral,
// 100 = extreme bullish), for stocks and crypto. REST on demand, cached.
//   1. Stocks with FINNHUB_API_KEY: Finnhub /news-sentiment (companyNewsScore
//      0-1 -> 0-100). That endpoint is not on every Finnhub plan; any refusal
//      falls through to (2), never to a made-up number.
//   2. Otherwise (and for crypto): recent headlines from Alpaca's news API
//      (last WINDOW_H hours; crypto as BTCUSD etc.) scored with SignalDesk's
//      headline dictionary (intelligence/sentiment-nlp.js). Only focused articles
//      count (the symbol is one of at most MAX_TAGS tagged tickers).
//      score = 50 + 50 * (bullish − bearish) / (bullish + bearish + 2)
//      (the +2 keeps a single headline from reading as "extreme").
// No relevant headlines -> score null ("no recent news"), not 50.
// headlines: the MAX_HEADLINES most recent focused Alpaca articles (the ones the
// headline score counts), newest first, each { title, url, at, source, tone }
// with tone = SignalDesk's reading of that headline (bullish/bearish/neutral).
// With a Finnhub score the same Alpaca headlines are attached for context.
// Never throws: { ok: true, score|null, label, source, bullish, bearish, neutral, total, headlines, at } | { ok: false, error }.
const { scoreHeadline } = require('../intelligence/sentiment-nlp');

const CACHE_MS = 90 * 60 * 1000;
const FAIL_MS = 15 * 60 * 1000;
const WINDOW_H = 48;
const MAX_TAGS = 6;
const MAX_HEADLINES = 5;
const TIMEOUT_MS = 8000;
const cache = new Map(); // symbol -> { at, result }

const label = (s) => (s === null ? 'No recent news' : s < 20 ? 'Extreme bearish' : s < 40 ? 'Bearish' : s <= 60 ? 'Neutral' : s <= 80 ? 'Bullish' : 'Extreme bullish');

async function getJson(url, headers) {
  const res = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
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

// One article for the UI. Only http(s) links are passed on (anything else: null).
function headlineOf(n, score) {
  const url = typeof n.url === 'string' && /^https?:\/\//i.test(n.url) ? n.url : null;
  return { title: String(n.headline || '').slice(0, 300), url, at: n.created_at || n.updated_at || null,
    source: n.source || n.author || null, tone: score > 0 ? 'bullish' : score < 0 ? 'bearish' : 'neutral' };
}

async function fromHeadlines(symbol) {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_API_SECRET;
  if (!key || !secret) return { ok: false, error: 'no news source: ALPACA_API_KEY / ALPACA_API_SECRET not set' };
  const tag = symbol.replace('-', ''); // BTC-USD -> BTCUSD (Alpaca news tags)
  const start = new Date(Date.now() - WINDOW_H * 3600000).toISOString();
  const base = (process.env.ALPACA_DATA_BASE_URL || 'https://data.alpaca.markets').replace(/\/+$/, '');
  const r = await getJson(`${base}/v1beta1/news?limit=50&sort=desc&start=${encodeURIComponent(start)}&symbols=${encodeURIComponent(tag)}`,
    { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret });
  if (!r.ok || !r.json || !Array.isArray(r.json.news)) return { ok: false, error: `Alpaca news HTTP ${r.status}` };
  const focused = r.json.news.filter((n) => Array.isArray(n.symbols) && n.symbols.includes(tag) && n.symbols.length <= MAX_TAGS);
  let bullish = 0; let bearish = 0;
  const headlines = [];
  for (const n of focused) { // newest first (sort=desc)
    const s = scoreHeadline(n.headline).score;
    if (s > 0) bullish += 1; else if (s < 0) bearish += 1;
    if (headlines.length < MAX_HEADLINES) headlines.push(headlineOf(n, s));
  }
  const total = focused.length;
  const score = total ? Math.round(50 + (50 * (bullish - bearish)) / (bullish + bearish + 2)) : null;
  return { ok: true, score, label: label(score), bullish, bearish, neutral: total - bullish - bearish, total, headlines,
    source: `${total} headline${total === 1 ? '' : 's'} in ${WINDOW_H}h (Alpaca news, SignalDesk scoring)` };
}

async function getSentiment(symbol, now = Date.now()) {
  const s = String(symbol || '').toUpperCase();
  if (!/^[A-Z0-9.]{1,10}(-USD)?$/.test(s)) return { ok: false, error: 'invalid symbol' };
  const hit = cache.get(s);
  if (hit && now - hit.at < (hit.result.ok ? CACHE_MS : FAIL_MS)) return { ...hit.result };
  let result;
  try {
    const finnhub = await fromFinnhub(s);
    const heads = await fromHeadlines(s);
    // A Finnhub score keeps its number; the Alpaca headlines are shown alongside it.
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

module.exports = { getSentiment, describe, label, CACHE_MS };
