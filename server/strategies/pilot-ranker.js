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
const { getLongDailyBars } = require('../connectors/daily-bars');

const UNIVERSE = Object.freeze(['SPY', 'QQQ', 'NVDA', 'AAPL', 'MSFT', 'META', 'AMZN', 'GOOGL', 'AVGO', 'TSLA', 'AMD', 'COST', 'LLY',
  'BTC-USD', 'ETH-USD', 'SOL-USD', 'LINK-USD', 'AVAX-USD']);
const CONFIG = { sma200: 200, sma50: 50, sma20: 20, minSessions: 30, slopeDays: 20, rsDays: 60, atrDays: 20, fullSlope: 0.03, nearPct: 0.02, farPct: 0.10, extendedPct: 0.18, extendedPenalty: 25 };
const RANK_TTL_MS = 10 * 60 * 1000;
let ranked = { at: 0, list: [] };

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const sma = (bars, n, end = bars.length) => bars.slice(end - n, end).reduce((s, b) => s + b.close, 0) / n;
function atr(bars, n) {
  const w = bars.slice(-n - 1);
  let sum = 0;
  for (let i = 1; i < w.length; i += 1) sum += Math.max(w[i].high - w[i].low, Math.abs(w[i].high - w[i - 1].close), Math.abs(w[i].low - w[i - 1].close));
  return sum / (w.length - 1);
}
const marketOf = (asset) => (asset.includes('-') ? 'crypto' : 'stocks');

// Completed daily bars (today's forming bar dropped), cached for hours; a failed
// fetch is retried within a minute (daily-bars.js: -USD, else the -USDC book).
const dailyBars = (symbol, now = Date.now()) => getLongDailyBars(symbol, now);

// The trend baseline a history supports (Phase 55): the 200-day SMA with 220+
// sessions; a newer listing falls back to its longest available average, the
// 50-day (70+ sessions) or the 20-day (30+), instead of waiting forever.
const baseline = (n) => (n >= CONFIG.sma200 + CONFIG.slopeDays ? CONFIG.sma200 : n >= CONFIG.sma50 + CONFIG.slopeDays ? CONFIG.sma50 : n >= CONFIG.minSessions ? CONFIG.sma20 : null);

// Trend indicators at `price` (null: under minSessions of history). `s200` is the
// baseline average (`basis` days: 200, else 50 / 20 for a newer listing).
function indicators(bars, price) {
  const n = bars.length;
  const basis = baseline(n);
  if (!basis || !(price > 0)) return null;
  const slopeDays = Math.min(CONFIG.slopeDays, n - basis);
  const s200 = sma(bars, basis);
  const s200prev = sma(bars, basis, n - slopeDays);
  const s50 = sma(bars, Math.min(CONFIG.sma50, n));
  const s20 = sma(bars, CONFIG.sma20);
  const back = Math.min(CONFIG.rsDays, n - 1);
  return { price, lastClose: bars[n - 1].close, s200, s50, s20, basis, sessions: n, slope200: s200 / s200prev - 1, atr: atr(bars, Math.min(CONFIG.atrDays, n - 1)),
    ret60: price / bars[n - 1 - back].close - 1, ext50: price / s50 - 1, buffer200: price / s200 - 1 };
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

const why = (r) => `score ${r.score}: ${r.ind.basis}d slope ${(r.ind.slope200 * 100).toFixed(1)}% (${r.parts.slope}/30), 50d ${r.ind.s50 > r.ind.s200 ? '>' : '<'} ${r.ind.basis}d (${r.parts.align}/20), `
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
    if (r.ind.price < r.ind.s200) return { ...row, qualified: false, reason: `Below its ${r.ind.basis}-day SMA ${r.ind.s200.toFixed(2)} (${(r.ind.buffer200 * 100).toFixed(1)}%): never bought` };
    return { ...row, qualified: true, reason: why(row) };
  }).sort((a, b) => b.qualified - a.qualified || b.score - a.score);
  ranked = { at: now, list };
  return list.map((r) => ({ ...r }));
}

function reset() { ranked = { at: 0, list: [] }; }

module.exports = { rankUniverse, scoreAsset, indicators, score, dailyBars, sma, atr, marketOf, why, reset, UNIVERSE, CONFIG };
