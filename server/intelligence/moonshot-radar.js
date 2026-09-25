// Moonshot Radar (Phase 55): the live 100-point Moonshot Conviction Score for
// EVERY monitored coin, on every pipeline pass (and at startup), not only the
// ones that already surged. The top TOP_N go out as MOONSHOT_RADAR, even under
// 60/100, so the Opportunities → [Moonshots] view shows what is heating up.
// The score is System 6's own (strategies/6-speculative-crypto.js score()):
//   0-50  price velocity (the best of the 5m frame: 15-minute move, and the 15m
//         frame: 30-minute move) + relative volume (latest bar vs the hour before)
//   0-30  buzz: Reddit RSS mentions, CoinGecko trending, cached news sentiment
//   0-20  strength vs BTC over the same window (0-12) + live bid/ask spread (0-8)
// Badges: TRIGGERED >= 60 · HEATING UP 40-59 · WATCHING < 40. A TRIGGERED score
// is not a trade by itself: System 6 still needs a +2.5-12% surge at a fresh
// 30-minute high, and the risk engine sizes it (10-25% of normal risk).
// Read-only: 5m candles come from System 6's per-slot cache (fetched once per
// 5 minutes, paced + retried by history-bars.js); news is only read from cache.
const { CRYPTO, NAMES } = require('../market/universe');
const spec = require('../strategies/6-speculative-crypto');
const social = require('../connectors/crypto-social');
const sentiment = require('../connectors/news-sentiment');
const coinbase = require('../connectors/coinbase-socket');

const TOP_N = 12;
const BADGES = [[60, 'TRIGGERED'], [40, 'HEATING UP'], [0, 'WATCHING']];
const lookup = (src, key) => (src instanceof Map ? src.get(key) : src && src[key]);
const badgeOf = (total) => BADGES.find(([min]) => total >= min)[1];
const round2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);

let radar = { at: null, rows: [], scanned: 0, missing: [], buzz: null, btc: null };
const getRadar = () => ({ ...radar, rows: radar.rows.map((r) => ({ ...r })) });

function spreadOf(symbol) {
  const t = coinbase.getLatest()[symbol];
  return t && t.ask > t.bid && t.bid > 0 ? (t.ask - t.bid) / ((t.ask + t.bid) / 2) : null;
}

// One coin's radar row (null: no live price or not enough 5m history).
async function rowFor(symbol, live, btcFrames, now) {
  const bars = await spec.bars5(symbol, now);
  const fs = spec.frames(bars, live);
  if (!fs.length) return null;
  const buzz = await social.getSocial(symbol, now);
  const spreadPct = spreadOf(symbol);
  const news = sentiment.peek(symbol);
  const scored = fs.map((m) => {
    const b = btcFrames.find((x) => x.frame === m.frame);
    return { m, btcSurge: b ? b.surge : 0, s: spec.score({ m, btcSurge: b ? b.surge : 0, buzz, news, spreadPct }) };
  });
  const best = scored.reduce((a, x) => (x.s.total > a.s.total ? x : a));
  const { parts, detail } = best.s;
  const frame = (f) => { const x = fs.find((y) => y.frame === f); return x ? round2(x.surge * 100) : null; };
  return {
    symbol, name: NAMES[symbol] || symbol, price: live, score: best.s.total, badge: badgeOf(best.s.total), frame: best.m.frame,
    move5: frame('5m'), move15: frame('15m'), relVol: round2(best.m.relVol), vsBtc: round2((best.m.surge - best.btcSurge) * 100),
    momentum: Math.round(parts.velocity + parts.volume), social: Math.round(parts.buzz), strength: Math.round(parts.rs + parts.spread),
    parts: { velocity: Math.round(parts.velocity), volume: Math.round(parts.volume), buzz: Math.round(parts.buzz), rs: Math.round(parts.rs), spread: Math.round(parts.spread) },
    buzzDetail: { reddit: detail.reddit, trending: detail.trend, news: detail.news, volumeCatalyst: detail.volumeCatalyst,
      mentions: buzz.reddit.mentions, recent: buzz.reddit.recent, trendingRank: buzz.trending ? buzz.trending.rank : null, title: buzz.reddit.titles[0] || null },
    spreadPct: round2(spreadPct === null ? null : spreadPct * 100), bars: bars.length, why: spec.describe(best.s),
  };
}

// Scores every coin; keeps the top TOP_N. Never throws (a coin that fails is skipped).
async function compute(latestPrices, now = Date.now()) {
  const btcLive = lookup(latestPrices, 'BTC-USD');
  const btcFrames = btcLive > 0 ? spec.frames(await spec.bars5('BTC-USD', now), btcLive) : [];
  const rows = [];
  const missing = [];
  let scanned = 0;
  for (const symbol of CRYPTO) {
    const live = lookup(latestPrices, symbol);
    if (!(live > 0)) continue;
    scanned += 1;
    try {
      const r = await rowFor(symbol, live, btcFrames, now);
      if (r) rows.push(r); else missing.push(symbol);
    } catch (err) {
      console.error(`[moonshot-radar] ${symbol} failed: ${err.message}`);
    }
  }
  rows.sort((a, b) => b.score - a.score || (b.move15 || 0) - (a.move15 || 0));
  const btc = { move5: null, move15: null };
  for (const f of btcFrames) btc[f.frame === '5m' ? 'move5' : 'move15'] = round2(f.surge * 100);
  radar = { at: now, rows: rows.slice(0, TOP_N), scanned, ranked: rows.length, missing, buzz: social.snapshot([...CRYPTO], now), btc };
  return getRadar();
}

// Pipeline hook: compute and broadcast MOONSHOT_RADAR.
async function publish(broadcast, latestPrices, now = Date.now()) {
  const r = await compute(latestPrices, now);
  broadcast('MOONSHOT_RADAR', r);
  return r;
}

module.exports = { compute, publish, getRadar, badgeOf, TOP_N };
