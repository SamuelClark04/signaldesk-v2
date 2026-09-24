// Portfolio Pilot, long-term Trend Ranker. PROPOSER ONLY: reads real daily bars
// (260 sessions, connectors/history-bars.js '1d-long') and scores what is worth
// owning now; the allocator (4-portfolio-pilot.js) and the 4-action matrix
// (pilot-matrix.js) build on it.
//   Disqualified  price (live, else the last close) under its 200-day SMA: the
//                 Pilot never proposes buying an asset in a long-term downtrend
//   Score 0-100   200-day SMA slope (0-30: +3% over 20 sessions = full)
//                 50-day SMA above the 200-day (20)
//                 60-day relative strength: percentile of the 60-day return
//                 across the ranked universe (0-30)
//                 pullback proximity: within 2% above the 20- or 50-day SMA =
//                 20, fading to 0 at 10% above (0-20)
//                 more than 18% above the 50-day SMA: -25 (extended, no chasing)
// Rankings are cached RANK_TTL_MS (the bars themselves for hours).
const { getHistory } = require('../connectors/history-bars');

const UNIVERSE = Object.freeze(['SPY', 'QQQ', 'NVDA', 'AAPL', 'MSFT', 'META', 'AMZN', 'GOOGL', 'AVGO', 'TSLA', 'AMD', 'COST', 'LLY',
  'BTC-USD', 'ETH-USD', 'SOL-USD', 'LINK-USD', 'AVAX-USD']);
const CONFIG = { sma200: 200, sma50: 50, sma20: 20, slopeDays: 20, rsDays: 60, atrDays: 20, fullSlope: 0.03, nearPct: 0.02, farPct: 0.10, extendedPct: 0.18, extendedPenalty: 25 };
const BARS_TTL_MS = 6 * 60 * 60 * 1000;
const RANK_TTL_MS = 10 * 60 * 1000;
const cache = new Map(); // symbol -> { at, bars }
let ranked = { at: 0, list: [] };
const etDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const sma = (bars, n, end = bars.length) => bars.slice(end - n, end).reduce((s, b) => s + b.close, 0) / n;
function atr(bars, n) {
  const w = bars.slice(-n - 1);
  let sum = 0;
  for (let i = 1; i < w.length; i += 1) sum += Math.max(w[i].high - w[i].low, Math.abs(w[i].high - w[i - 1].close), Math.abs(w[i].low - w[i - 1].close));
  return sum / (w.length - 1);
}
const marketOf = (asset) => (asset.includes('-') ? 'crypto' : 'stocks');

// Completed daily bars (today's forming bar dropped), cached for hours.
async function dailyBars(symbol, now = Date.now()) {
  const hit = cache.get(symbol);
  if (!hit || now - hit.at >= BARS_TTL_MS) {
    const r = await getHistory(symbol, '1d-long');
    cache.set(symbol, { at: now, bars: r.ok ? r.bars : (hit ? hit.bars : []) });
  }
  const today = etDate.format(now);
  const done = symbol.includes('-') ? (b) => (b.time + 86400) * 1000 <= now : (b) => etDate.format(b.time * 1000) < today;
  return cache.get(symbol).bars.filter(done);
}

// Trend indicators at `price` (null: under 200 + 20 sessions of history).
function indicators(bars, price) {
  const n = bars.length;
  if (n < CONFIG.sma200 + CONFIG.slopeDays || !(price > 0)) return null;
  const s200 = sma(bars, CONFIG.sma200);
  const s200prev = sma(bars, CONFIG.sma200, n - CONFIG.slopeDays);
  const s50 = sma(bars, CONFIG.sma50);
  const s20 = sma(bars, CONFIG.sma20);
  return { price, lastClose: bars[n - 1].close, s200, s50, s20, slope200: s200 / s200prev - 1, atr: atr(bars, CONFIG.atrDays),
    ret60: price / bars[n - 1 - CONFIG.rsDays].close - 1, ext50: price / s50 - 1, buffer200: price / s200 - 1 };
}

// Score one asset's indicators; rets = the universe's 60-day returns (for the percentile).
function score(ind, rets) {
  const slope = 30 * clamp01(ind.slope200 / CONFIG.fullSlope);
  const align = ind.s50 > ind.s200 ? 20 : 0;
  const rs = 30 * (rets.length ? rets.filter((r) => r <= ind.ret60).length / rets.length : 0.5);
  const above = [ind.s20, ind.s50].map((m) => ind.price / m - 1).filter((d) => d >= -CONFIG.nearPct);
  const d = above.length ? Math.min(...above) : CONFIG.farPct;
  const pullback = 20 * clamp01(1 - Math.max(0, d - CONFIG.nearPct) / (CONFIG.farPct - CONFIG.nearPct));
  const extended = ind.ext50 > CONFIG.extendedPct;
  const total = Math.max(0, Math.min(100, Math.round(slope + align + rs + pullback - (extended ? CONFIG.extendedPenalty : 0))));
  return { total, parts: { slope: Math.round(slope), align, rs: Math.round(rs), pullback: Math.round(pullback) }, extended };
}

const why = (r) => `score ${r.score}: 200d slope ${(r.ind.slope200 * 100).toFixed(1)}% (${r.parts.slope}/30), 50d ${r.ind.s50 > r.ind.s200 ? '>' : '<'} 200d (${r.parts.align}/20), `
  + `60d ${(r.ind.ret60 * 100).toFixed(1)}% (${r.parts.rs}/30), ${(Math.min(r.ind.price / r.ind.s20 - 1, r.ind.ext50) * 100).toFixed(1)}% over the 20/50d SMA (${r.parts.pullback}/20)`
  + `${r.extended ? `, ${(r.ind.ext50 * 100).toFixed(0)}% above the 50d: extended (-${CONFIG.extendedPenalty})` : ''}`;

// Score any asset against a ranking's return distribution (the matrix uses it for holdings).
function scoreAsset(asset, bars, price, ranking) {
  const ind = indicators(bars, price);
  if (!ind) return null;
  const s = score(ind, (ranking || []).filter((r) => r.ind).map((r) => r.ind.ret60));
  return { asset, ind, score: s.total, parts: s.parts, extended: s.extended };
}

// The ranked universe, best first: [{ asset, market, price, qualified, score, parts,
// extended, reason, ind }]. priceOf(asset) -> live price (else the last close is used).
async function rankUniverse(priceOf, now = Date.now()) {
  if (now - ranked.at < RANK_TTL_MS && ranked.list.length) {
    return ranked.list.map((r) => ({ ...r, live: priceOf(r.asset) > 0, price: priceOf(r.asset) > 0 ? priceOf(r.asset) : r.price })); // scores cached, live status now
  }
  const rows = [];
  for (const asset of UNIVERSE) {
    const bars = await dailyBars(asset, now);
    const live = priceOf(asset);
    const price = live > 0 ? live : bars.length ? bars[bars.length - 1].close : null;
    rows.push({ asset, market: marketOf(asset), price, live: live > 0, ind: price ? indicators(bars, price) : null, days: bars.length });
  }
  const rets = rows.filter((r) => r.ind).map((r) => r.ind.ret60);
  const list = rows.map((r) => {
    if (!r.ind) return { ...r, qualified: false, score: 0, reason: `Not enough daily history (${r.days} sessions)` };
    const s = score(r.ind, rets);
    const row = { ...r, score: s.total, parts: s.parts, extended: s.extended };
    if (r.ind.price < r.ind.s200) return { ...row, qualified: false, reason: `Below its 200-day SMA ${r.ind.s200.toFixed(2)} (${(r.ind.buffer200 * 100).toFixed(1)}%): never bought` };
    return { ...row, qualified: true, reason: why(row) };
  }).sort((a, b) => b.qualified - a.qualified || b.score - a.score);
  ranked = { at: now, list };
  return list.map((r) => ({ ...r }));
}

function reset() { cache.clear(); ranked = { at: 0, list: [] }; }

module.exports = { rankUniverse, scoreAsset, indicators, score, dailyBars, sma, atr, marketOf, why, reset, UNIVERSE, CONFIG };
