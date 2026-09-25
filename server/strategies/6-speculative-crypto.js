// Strategy 6: Speculative Crypto Moonshots (ADDITIVE: Systems 1-5 are untouched).
// PROPOSER ONLY: returns Canonical Candidates tagged "Speculative Moonshot"; the
// risk engine sizes them at a small fraction of normal risk (risk-engine.js).
//
// Momentum straight from real Coinbase 5-minute candles (no warm-up after a
// restart): the live price vs the close 15 minutes back (5m frame) or 30 minutes
// back (15m bars built from the 5m ones), on relative volume: the latest bar
// vs the average bar of the hour before (12 x 5m, 4 x 15m; the old System 6
// measure of "the last 5 minutes vs the hour before").
// A surge of +2.5% to +12% on >= 2.2x relative volume, at a fresh 30-minute
// high, is then scored out of 100 (CONVICTION):
//   A  velocity + volume surge        0-50  (25 for +8% or more, 25 for 4.5x+)
//   B  buzz: Reddit mentions (RSS), CoinGecko trending, or Alpaca news
//      sentiment (connectors/crypto-social.js, news-sentiment.js)   0-30;
//      with >= 3.5x volume the surge is its own catalyst: at least 12, so coins
//      no news desk covers (e.g. ALEO) are not dead-locked
//   C  strength vs BTC over the same window (0-12) + spread quality from the
//      live Coinbase bid/ask (0-8)                                   0-20
// Score >= 60 qualifies. Levels: stop under the 30-minute low, never tighter
// than the taker-entry fee floor (a momentum entry crosses the spread); T1 2.0R
// (50%), T2 3R (runner). conviction = (score - 60) / 40 sets the "Smart
// Investment Amount": 10% (score 60) to 25% (score 100) of normal risk.
const { CRYPTO } = require('../market/universe');
const { getHistory } = require('../connectors/history-bars');
const { minStopPct } = require('../risk/cost-authority');
const sentiment = require('../connectors/news-sentiment');
const social = require('../connectors/crypto-social');
const coinbase = require('../connectors/coinbase-socket');
const { createTally } = require('./scan-tally');

const STRATEGY_ID = 'speculative-crypto';
const TAG = 'Speculative Moonshot';
const CONFIG = {
  symbols: [...CRYPTO], surgeMin: 0.025, surgeMax: 0.12, relVolMin: 2.2, volumeCatalyst: 3.5, qualify: 60,
  freshHighBars: 6, swingBars: 6, stopBufferPct: 0.003, entryBufferPct: 0.003, t1R: 2.0, t2R: 3, cooldownMs: 4 * 60 * 60 * 1000, // T1 >= 2R: the risk engine needs >= 1.25 : 1 net at T1 alone (Phase 54)
  tradeType: TAG, expectedDuration: 'Minutes to hours (momentum; exits at stop or targets)',
};
const SLOT_SEC = 300;

const decimals = (x) => (x >= 100 ? 2 : x >= 1 ? 4 : Math.min(12, 3 - Math.floor(Math.log10(x))));
const round = (x) => { const f = 10 ** decimals(x); return Math.round(x * f) / f; };
const floorPx = (x) => { const f = 10 ** decimals(x); return Math.floor(x * f) / f; };
const lookup = (src, key) => (src instanceof Map ? src.get(key) : src && src[key]);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

const candles = new Map(); // symbol -> { slot, bars } (completed 5m bars)
const lastSignal = new Map(); // symbol -> time of its last proposal (cooldown)
const tally = createTally();
let blocks = [];

async function bars5(symbol, now) {
  const slot = Math.floor(now / 1000 / SLOT_SEC);
  const hit = candles.get(symbol);
  if (hit && hit.slot === slot) return hit.bars;
  const r = await getHistory(symbol, '5m'); // paced + retried (history-bars.js)
  if (!r.ok) return hit ? hit.bars : []; // a failed fetch is never cached: the next pass retries it
  const list = r.bars.filter((b) => (b.time + SLOT_SEC) * 1000 <= now);
  candles.set(symbol, { slot, bars: list });
  return list;
}

// 5m bars -> completed 15m bars aligned to the quarter hour.
function to15(b) {
  const out = new Map();
  for (const x of b) {
    const t = Math.floor(x.time / 900) * 900;
    const g = out.get(t);
    if (!g) out.set(t, { ...x, time: t, n: 1 });
    else Object.assign(g, { high: Math.max(g.high, x.high), low: Math.min(g.low, x.low), close: x.close, volume: g.volume + x.volume, n: g.n + 1 });
  }
  return [...out.values()].filter((g) => g.n === 3);
}

// Both momentum frames at live price `live`: [{ frame, surge, relVol, minutes }] (null frames dropped).
function frames(b, live) {
  const out = [];
  if (b.length >= 16) out.push({ frame: '5m', minutes: 15, surge: live / b[b.length - 4].close - 1, relVol: b[b.length - 1].volume / avg(b.slice(-13, -1).map((x) => x.volume)) });
  const q = to15(b);
  if (q.length >= 7) out.push({ frame: '15m', minutes: 30, surge: live / q[q.length - 3].close - 1, relVol: q[q.length - 1].volume / avg(q.slice(-5, -1).map((x) => x.volume)) });
  return out.filter((f) => Number.isFinite(f.surge) && Number.isFinite(f.relVol));
}

// The 100-point conviction score. m: momentum frame; parts in, breakdown out.
function score({ m, btcSurge, buzz, news, spreadPct }) {
  const velocity = 25 * clamp01((m.surge - 0.02) / 0.06);
  const volume = 25 * clamp01((m.relVol - 1.5) / 3);
  const r = buzz && buzz.reddit;
  const reddit = r ? Math.min(15, 5 * r.recent + (r.mentions > r.recent ? 2 : 0) + (r.bullish > r.bearish ? 3 : 0)) : 0;
  const trend = buzz && buzz.trending ? (buzz.trending.rank <= 7 ? 15 : 10) : 0;
  const fresh = news && news.ok && news.score !== null ? (news.score >= 70 ? 15 : news.score >= 60 ? 8 : 0) : 0;
  const found = Math.min(30, reddit + trend + fresh);
  const catalyst = m.relVol >= CONFIG.volumeCatalyst && found < 12 ? 12 : 0;
  const buzzPts = Math.max(found, catalyst);
  const rs = 12 * clamp01((m.surge - (btcSurge || 0)) / 0.06);
  const spread = spreadPct === null ? 4 : 8 * clamp01((0.01 - spreadPct) / 0.009);
  const parts = { velocity, volume, buzz: buzzPts, rs, spread };
  const total = Math.round(Object.values(parts).reduce((s, x) => s + x, 0));
  return { total, parts, detail: { reddit, trend, news: fresh, volumeCatalyst: catalyst > 0 } };
}

const describe = (s) => `velocity ${s.parts.velocity.toFixed(0)}/25 + volume ${s.parts.volume.toFixed(0)}/25 + buzz ${s.parts.buzz.toFixed(0)}/30`
  + `${s.detail.volumeCatalyst ? ' (volume-catalyst credit)' : ` (Reddit ${s.detail.reddit}, trending ${s.detail.trend}, news ${s.detail.news})`}`
  + ` + vs BTC ${s.parts.rs.toFixed(0)}/12 + spread ${s.parts.spread.toFixed(0)}/8 = ${s.total}/100`;

function block(symbol, reason, now) {
  blocks.push({ id: `${STRATEGY_ID}:MOON:${symbol}:${new Date(now).toISOString().slice(0, 13)}`, reason,
    candidate: { asset: symbol, market: 'crypto', strategyId: STRATEGY_ID, setupType: TAG, direction: 'long', timeframe: '5m', speculative: true } });
}

async function evaluate(symbol, live, now, btc) {
  if (now - (lastSignal.get(symbol) || 0) < CONFIG.cooldownMs) return tally.skip(symbol, 'Proposed in the last 4 hours');
  const b = await bars5(symbol, now);
  const fs = frames(b, live);
  if (!fs.length) return tally.skip(symbol, 'Not enough 5-minute history');
  const ok = fs.filter((f) => f.surge >= CONFIG.surgeMin && f.surge <= CONFIG.surgeMax && f.relVol >= CONFIG.relVolMin);
  if (!ok.length) {
    const top = fs.reduce((a, x) => (x.surge > a.surge ? x : a));
    return tally.skip(symbol, top.surge > CONFIG.surgeMax ? `Overextended (${pct(top.surge)} in ${top.minutes}m): no chase`
      : top.surge < CONFIG.surgeMin ? `No surge (${pct(top.surge)} in ${top.minutes}m)` : `Volume only ${top.relVol.toFixed(1)}x normal`);
  }
  const m = ok.reduce((a, x) => (x.surge * x.relVol > a.surge * a.relVol ? x : a));
  // Fresh 30-minute high on CLOSES (a breakout bar usually closes under its own wick).
  if (!(live >= Math.max(...b.slice(-CONFIG.freshHighBars).map((x) => x.close)))) return tally.skip(symbol, 'Momentum faded (no fresh 30-minute closing high)');
  const btcFrame = btc ? frames(btc.bars, btc.live).find((f) => f.frame === m.frame) : null;
  const tick = coinbase.getLatest()[symbol];
  const spreadPct = tick && tick.ask > tick.bid && tick.bid > 0 ? (tick.ask - tick.bid) / ((tick.ask + tick.bid) / 2) : null;
  const [buzz, news] = await Promise.all([social.getSocial(symbol, now), sentiment.getSentiment(symbol, now)]);
  const s = score({ m, btcSurge: btcFrame ? btcFrame.surge : 0, buzz, news, spreadPct });
  const move = `${symbol} ${pct(m.surge)} in ${m.minutes}m on ${m.relVol.toFixed(1)}x volume`;
  if (s.total < CONFIG.qualify) {
    block(symbol, `SPECULATIVE_SCORE_LOW: ${move}, conviction ${s.total}/100 (needs ${CONFIG.qualify}): ${describe(s)}`, now);
    return tally.skip(symbol, `Rejected: conviction ${s.total}/100`);
  }

  const entryMax = round(live * (1 + CONFIG.entryBufferPct));
  const structural = Math.min(...b.slice(-CONFIG.swingBars).map((x) => x.low)) * (1 - CONFIG.stopBufferPct);
  const invalidation = floorPx(Math.min(structural, entryMax * (1 - minStopPct('crypto', 'taker'))));
  const risk = entryMax - invalidation;
  const conviction = Math.round(clamp01((s.total - CONFIG.qualify) / (100 - CONFIG.qualify)) * 100) / 100;
  lastSignal.set(symbol, now);
  tally.setup();
  const why = [buzz.reddit.titles[0], buzz.trending ? `CoinGecko trending #${buzz.trending.rank}` : null, news.ok && news.score !== null ? `news ${news.score}/100 (${news.label})` : null].filter(Boolean);
  return {
    id: `${STRATEGY_ID}:MOON:${symbol}:${new Date(now).toISOString().slice(0, 16)}`,
    asset: symbol, market: 'crypto', strategyId: STRATEGY_ID, setupType: TAG, tag: TAG, speculative: true, conviction, convictionScore: s.total, scoreParts: s.parts,
    direction: 'long', timeframe: m.frame, tradeType: CONFIG.tradeType, expectedDuration: CONFIG.expectedDuration,
    newsSentiment: news.ok && news.score !== null ? { score: news.score, label: news.label, source: news.source } : null,
    entryZone: { min: round(live), max: entryMax },
    invalidation,
    targets: [{ level: 1, price: round(entryMax + CONFIG.t1R * risk), allocation: 0.5 }, { level: 2, price: round(entryMax + CONFIG.t2R * risk), allocation: 0.5 }],
    catalyst: { type: why.length ? 'social' : 'volume', headline: why[0] || `Volume surge ${m.relVol.toFixed(1)}x`, sentimentScore: s.total },
    thesis: `SPECULATIVE MOONSHOT. ${move} (vs BTC ${btcFrame ? pct(btcFrame.surge) : 'n/a'}), at a fresh 30-minute high. Conviction ${s.total}/100: ${describe(s)}. `
      + `${why.length ? `Buzz: ${why.join('; ')}. ` : 'No forum or news coverage found: the volume surge is the catalyst. '}`
      + `Stop ${invalidation} (${((risk / entryMax) * 100).toFixed(1)}% under entry: ${invalidation < structural ? 'the crypto fee floor' : 'under the 30-minute low'}), `
      + `T1 ${CONFIG.t1R}R (50%), T2 ${CONFIG.t2R}R. Hype moves reverse fast: sized at ${Math.round((0.1 + 0.15 * conviction) * 100)}% of normal risk.`,
    confirmationCriteria: [
      `${pct(m.surge)} in ${m.minutes} min (needs ${pct(CONFIG.surgeMin)} to ${pct(CONFIG.surgeMax)}) on ${m.relVol.toFixed(1)}x relative volume (needs ${CONFIG.relVolMin}x)`,
      `Conviction ${s.total}/100 (needs ${CONFIG.qualify}): ${describe(s)}`,
      `Sources: ${buzz.sources}${buzz.errors.length ? ` (unavailable: ${buzz.errors.join('; ')})` : ''}`,
    ],
    timestamp: new Date(now).toISOString(),
  };
}

async function generateCandidates(latestPricesMap, now = Date.now()) {
  blocks = [];
  tally.start();
  const out = [];
  const btcLive = lookup(latestPricesMap, 'BTC-USD');
  const btc = btcLive > 0 ? { live: btcLive, bars: await bars5('BTC-USD', now) } : null;
  for (const symbol of CONFIG.symbols) {
    tally.checked();
    const live = lookup(latestPricesMap, symbol);
    if (!(live > 0)) { tally.skip(symbol, 'No live price'); continue; }
    try {
      const c = await evaluate(symbol, live, now, btc);
      if (c) out.push(c);
    } catch (err) {
      console.error(`[speculative-crypto] ${symbol} failed: ${err.message}`);
    }
  }
  return out;
}

function takeBlocks() { const b = blocks; blocks = []; return b; }
function reset() { candles.clear(); lastSignal.clear(); blocks = []; }

module.exports = { generateCandidates, takeBlocks, takeScan: tally.take, reset, frames, score, describe, bars5, to15, STRATEGY_ID, TAG, CONFIG };
