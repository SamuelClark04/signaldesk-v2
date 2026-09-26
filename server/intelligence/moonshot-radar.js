// Moonshot Gem Radar (Phase 55, full-exchange in Phase 56): the live 100-point
// Moonshot Conviction Score for every gem on the Active Gem Watchlist, on every
// pipeline pass (and at startup). The watchlist comes from the WHOLE Coinbase spot
// catalog (coinbase-discovery.js: ~390 coins swept every 5 minutes; mega-caps and
// stable / wrapped tokens excluded): trending + Reddit coins, 24h anomalies and
// curated high-beta small / mid-caps, up to 60. All scored rows go out as
// MOONSHOT_RADAR (sorted; the leaderboard shows the top TOP_N), even under 60.
// The score and the triggers are System 6's own (6-speculative-crypto.js assess()):
//   0-50  velocity (IGNITION) or coil pattern quality (COIL) + relative volume
//   0-30  buzz: Reddit (5 subreddits), CoinGecko trending, cached news sentiment
//   0-20  strength vs BTC (0-12) + live bid/ask spread (0-8)
// Badges: TRIGGERED >= 60 · HEATING UP 40-59 · WATCHING < 40. `trigger` says which
// entry is actually live (IGNITION / COIL); a TRIGGERED score alone is not a trade.
// Read-only: 5m candles from System 6's per-slot cache; news read from cache only.
const spec = require('../strategies/6-speculative-crypto');
const social = require('../connectors/crypto-social');
const sentiment = require('../connectors/news-sentiment');
const discovery = require('../connectors/coinbase-discovery');
const summary = require('./catalyst-summary'); // Phase 62: catalystSummary per row (why it scored + the gate verdict)

const TOP_N = 20;
const BADGES = [[60, 'TRIGGERED'], [40, 'HEATING UP'], [0, 'WATCHING']];
const lookup = (src, key) => (src instanceof Map ? src.get(key) : src && src[key]);
const badgeOf = (total) => BADGES.find(([min]) => total >= min)[1];
const round2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);

let radar = { at: null, rows: [], top: TOP_N, scanned: 0, ranked: 0, missing: [], buzz: null, btc: null, swept: 0, gems: 0 };
const getRadar = () => ({ ...radar, rows: radar.rows.map((r) => ({ ...r })) });
const rowOf = (symbol) => { const r = radar.rows.find((x) => x.symbol === symbol); return r ? { ...r } : null; };

// One gem's radar row (null: not enough 5m history).
async function rowFor(w, latest, btc, now) {
  const bars = await spec.bars5(w.symbol, now);
  const tick = lookup(latest, w.symbol);
  const live = tick > 0 ? tick : bars.length ? bars[bars.length - 1].close : null; // a gem still joining the stream: its last 5m close
  if (!(live > 0) || bars.length < 16) return null;
  const buzz = await social.getSocial(w.symbol, now);
  const a = spec.assess(bars, live, w.symbol, { btc, buzz, news: sentiment.peek(w.symbol) });
  const s = a.best;
  const { parts, detail } = s;
  const frame = (f) => { const x = a.ign.frames.find((y) => y.frame === f); return x ? round2(x.surge * 100) : null; };
  const nearest = a.trigger ? null : s.kind === 'COIL' ? `coil: ${a.coil.reason}` : a.ign.reason;
  return {
    symbol: w.symbol, name: w.name, price: live, live: tick > 0, score: s.total, badge: badgeOf(s.total), kind: s.kind, trigger: a.trigger, nearest,
    move5: frame('5m'), move15: frame('15m'), move1h: Number.isFinite(a.coil.move) ? round2(a.coil.move * 100) : null,
    relVol: round2(s.m.relVol), volVs6h: round2(a.coil.volRatio), vsBtc: round2((s.m.surge - spec.btcMove(btc, s.kind === 'COIL' ? '1h' : s.m.frame)) * 100),
    momentum: Math.round(parts.velocity + parts.volume), social: Math.round(parts.buzz), strength: Math.round(parts.rs + parts.spread),
    parts: { velocity: Math.round(parts.velocity), volume: Math.round(parts.volume), buzz: Math.round(parts.buzz), rs: Math.round(parts.rs), spread: Math.round(parts.spread) },
    buzzDetail: { reddit: detail.reddit, trending: detail.trend, news: detail.news, volumeCatalyst: detail.volumeCatalyst,
      mentions: buzz.reddit.mentions, recent: buzz.reddit.recent, trendingRank: buzz.trending ? buzz.trending.rank : null, title: buzz.reddit.titles[0] || null },
    spreadPct: round2(a.spreadPct === null ? null : a.spreadPct * 100), bars: bars.length, why: spec.describe({ ...s, pattern: s.kind === 'COIL' }),
    source: w.source, reasons: w.reasons, change24h: round2(w.change24h === null ? null : w.change24h * 100), volumeUsd: Math.round(w.volumeUsd || 0), volChange: Number.isFinite(w.volChange) ? w.volChange : null,
  };
}

// Scores every watchlist gem. Never throws (a gem that fails is skipped).
async function compute(latestPrices, now = Date.now()) {
  const btcLive = lookup(latestPrices, 'BTC-USD');
  const btc = btcLive > 0 ? { live: btcLive, bars: await spec.bars5('BTC-USD', now) } : null;
  const list = discovery.watchlist().length ? discovery.watchlist() : await spec.gemWatchlist(now);
  const rows = [];
  const missing = [];
  for (const w of list) {
    try {
      const r = await rowFor(w, latestPrices, btc, now);
      if (r) rows.push(r); else missing.push(w.symbol);
    } catch (err) {
      console.error(`[moonshot-radar] ${w.symbol} failed: ${err.message}`);
    }
  }
  rows.sort((a, b) => b.score - a.score || (b.move15 || 0) - (a.move15 || 0));
  const btcMoves = { move5: round2(spec.btcMove(btc, '5m') * 100), move15: round2(spec.btcMove(btc, '15m') * 100) };
  const ctx = summary.context();
  for (const r of rows) {
    try { r.catalystSummary = summary.forRow(r, btcMoves, ctx, now); } catch (err) { console.error(`[moonshot-radar] ${r.symbol} summary failed: ${err.message}`); }
  }
  const cat = discovery.snapshot();
  radar = { at: now, rows, top: TOP_N, scanned: list.length, ranked: rows.length, missing, swept: cat.swept, gems: cat.gems, catalogAt: cat.at, catalogError: cat.error,
    excluded: cat.excluded, buzz: social.snapshot(discovery.gems().map((c) => c.symbol), now),
    btc: btcMoves };
  return getRadar();
}

// Pipeline hook: compute and broadcast MOONSHOT_RADAR (+ GEM_CATALOG when the catalog was refreshed).
let catalogSent = 0;
async function publish(broadcast, latestPrices, now = Date.now()) {
  const r = await compute(latestPrices, now);
  broadcast('MOONSHOT_RADAR', r);
  if (r.catalogAt && r.catalogAt !== catalogSent) { catalogSent = r.catalogAt; broadcast('GEM_CATALOG', discovery.snapshot()); }
  return r;
}

// For a new client: the radar and the chartable Coinbase catalog.
const snapshots = () => [['MOONSHOT_RADAR', getRadar()], ['GEM_CATALOG', discovery.snapshot()]];

module.exports = { compute, publish, getRadar, rowOf, snapshots, badgeOf, TOP_N };
