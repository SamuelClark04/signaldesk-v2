// Strategy 6: Speculative Crypto Moonshots, the Gem Hunter (ADDITIVE: Systems 1-5
// are untouched). PROPOSER ONLY: returns Canonical Candidates tagged "Speculative
// Moonshot"; the risk engine sizes them at a small fraction of normal risk.
//
// Universe (Phase 56): the Active Gem Watchlist from coinbase-discovery.js, rebuilt
// every pass from the WHOLE Coinbase spot catalog (~390 coins): trending / Reddit
// coins, 24h volume + momentum anomalies and curated high-beta small / mid-caps.
// Mega-caps (BTC ETH SOL XRP DOGE ADA LTC BCH LINK AVAX XLM DOT UNI SUI SHIB HBAR
// TON BNB) and stable / wrapped / staked tokens are never scanned here.
// Two entry triggers on real Coinbase 5-minute candles (gem-triggers.js):
//   IGNITION  +2.5% to +14% in 15 / 30 min on >= 2.2x relative volume, at a fresh
//             30-minute (5m) / 2-hour (15m) closing high. Stop under the 30-minute
//             low, never tighter than the taker fee floor.
//   COIL      early accumulation: 15m / 1h volume >= 2.8x its prior 6 hours, higher
//             lows (EMA9 > EMA21, close in the bar's top 30%), a break above a tight
//             3-hour base on a +1.5% to +5% move. A resting post-only limit entry
//             (maker), so its floor is the maker one (4.6%); stop under the base low
//             through the Phase 54 chart-stop rule (< 3.2% rejected, widened to 4.6%).
// Both are scored out of 100 (CONVICTION), >= 60 qualifies:
//   A  0-50  velocity (IGNITION) or coil pattern quality (COIL) 0-25, + volume 0-25
//   B  0-30  buzz: Reddit (5 subreddits), CoinGecko trending, news sentiment; with
//            >= 3.5x volume the volume is its own catalyst (at least 12)
//   C  0-20  strength vs BTC over the same window (0-12) + live spread (0-8)
// IGNITION T1 2.1R (50%), T2 3R; COIL T1 2.25R, T2 3.5R. At each trigger's fee floor
// (6.7% taker / 4.6% maker) a 2R T1 nets only 1.249 / 1.23 : 1, and the risk engine
// needs T1 alone >= 1.25 : 1 net of fees (Phase 54).
// conviction = (score - 60) / 40: the Smart Investment Amount, 10-25% of normal risk.
const { getHistory } = require('../connectors/history-bars');
const { minStopPct } = require('../risk/cost-authority');
const { chartStop } = require('../risk/reality-gate');
const sentiment = require('../connectors/news-sentiment');
const social = require('../connectors/crypto-social');
const coinbase = require('../connectors/coinbase-socket');
const discovery = require('../connectors/coinbase-discovery');
const gem = require('./gem-triggers');
const { createTally } = require('./scan-tally');

const STRATEGY_ID = 'speculative-crypto';
const TAG = 'Speculative Moonshot';
const CONFIG = {
  volumeCatalyst: 3.5, qualify: 60, swingBars: 6, stopBufferPct: 0.003, entryBufferPct: 0.003, t1R: 2.1, t2R: 3, coilT1R: 2.25, coilT2R: 3.5, cooldownMs: 4 * 60 * 60 * 1000,
  tradeType: TAG, expectedDuration: 'Minutes to hours (momentum; exits at stop or targets)', ...gem.CONFIG.ignition,
};
const LABEL = { IGNITION: 'Momentum Ignition', COIL: 'Accumulation Coil' };
const SLOT_SEC = 300;

const decimals = (x) => (x >= 100 ? 2 : x >= 1 ? 4 : Math.min(12, 3 - Math.floor(Math.log10(x))));
const round = (x) => { const f = 10 ** decimals(x); return Math.round(x * f) / f; };
const floorPx = (x) => { const f = 10 ** decimals(x); return Math.floor(x * f) / f; };
const lookup = (src, key) => (src instanceof Map ? src.get(key) : src && src[key]);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
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

// The 100-point conviction score. m: { surge, relVol }; parts in, breakdown out.
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

const describe = (s) => `${s.pattern ? 'coil pattern' : 'velocity'} ${s.parts.velocity.toFixed(0)}/25 + volume ${s.parts.volume.toFixed(0)}/25 + buzz ${s.parts.buzz.toFixed(0)}/30`
  + `${s.detail.volumeCatalyst ? ' (volume-catalyst credit)' : ` (Reddit ${s.detail.reddit}, trending ${s.detail.trend}, news ${s.detail.news})`}`
  + ` + vs BTC ${s.parts.rs.toFixed(0)}/12 + spread ${s.parts.spread.toFixed(0)}/8 = ${s.total}/100`;

const spreadOf = (symbol) => {
  const t = coinbase.getLatest()[symbol];
  return t && t.ask > t.bid && t.bid > 0 ? (t.ask - t.bid) / ((t.ask + t.bid) / 2) : null;
};
// BTC's move over a frame ('5m', '15m') or the last hour ('1h'), for relative strength.
function btcMove(btc, frame) {
  if (!btc) return 0;
  if (frame === '1h') { const q = gem.to15(btc.bars); return q.length >= 5 ? btc.live / q[q.length - 5].close - 1 : 0; }
  const f = gem.frames(btc.bars, btc.live).find((x) => x.frame === frame);
  return f ? f.surge : 0;
}

// Both triggers + their scores for one gem (shared with moonshot-radar.js, so the
// radar and the strategy always agree). ctx: { buzz, news, btc }.
// -> { ign, coil, trigger: 'IGNITION'|'COIL'|null, best: { kind, total, parts, detail, m } }
function assess(b, live, symbol, ctx) {
  const spreadPct = spreadOf(symbol);
  const ign = gem.ignition(b, live);
  const coil = gem.coil(b, live);
  const scored = [];
  for (const f of ign.frames) scored.push({ kind: 'IGNITION', m: f, ok: ign.ok && ign.m === f, ...score({ m: f, btcSurge: btcMove(ctx.btc, f.frame), buzz: ctx.buzz, news: ctx.news, spreadPct }) });
  if (Number.isFinite(coil.volRatio)) {
    const m = { surge: coil.move, relVol: coil.volRatio, frame: '15m', minutes: 60 };
    const s = score({ m, btcSurge: btcMove(ctx.btc, '1h'), buzz: ctx.buzz, news: ctx.news, spreadPct });
    const parts = { ...s.parts, velocity: gem.coilPattern(coil) };
    scored.push({ kind: 'COIL', m, ok: coil.ok, pattern: true, parts, detail: s.detail, total: Math.round(Object.values(parts).reduce((x, y) => x + y, 0)) });
  }
  const pick = (list) => (list.length ? list.reduce((a, x) => (x.total > a.total ? x : a)) : null);
  const triggered = pick(scored.filter((x) => x.ok));
  return { ign, coil, spreadPct, trigger: triggered ? triggered.kind : null, best: triggered || pick(scored) };
}

function block(symbol, reason, now, kind = 'MOON') {
  blocks.push({ id: `${STRATEGY_ID}:${kind}:${symbol}:${new Date(now).toISOString().slice(0, 13)}`, reason,
    candidate: { asset: symbol, market: 'crypto', strategyId: STRATEGY_ID, setupType: TAG, direction: 'long', timeframe: '5m', speculative: true } });
}

async function evaluate(symbol, live, now, btc, watchRow) {
  if (now - (lastSignal.get(symbol) || 0) < CONFIG.cooldownMs) return tally.skip(symbol, 'Proposed in the last 4 hours');
  const b = await bars5(symbol, now);
  const probe = assess(b, live, symbol, { btc }); // triggers first: social / news only for a triggered gem
  if (!probe.trigger) {
    // Grouped in the Scanner log by cause (the radar shows each gem's numbers).
    return tally.skip(symbol, probe.ign.frames.length ? `Ignition: ${probe.ign.short} · Coil: ${probe.coil.short}` : 'Not enough 5-minute history');
  }
  const [buzz, news] = await Promise.all([social.getSocial(symbol, now), sentiment.getSentiment(symbol, now)]);
  const a = assess(b, live, symbol, { btc, buzz, news });
  const s = { ...a.best };
  const kind = a.trigger || probe.trigger;
  const move = kind === 'COIL'
    ? `${symbol} ${pct(a.coil.move)} in 1h breaking a ${pct(a.coil.baseRange)} 3-hour base on ${a.coil.volRatio.toFixed(1)}x its 6-hour volume`
    : `${symbol} ${pct(a.ign.m.surge)} in ${a.ign.m.minutes}m on ${a.ign.m.relVol.toFixed(1)}x volume`;
  if (!a.trigger || s.total < CONFIG.qualify) {
    block(symbol, `SPECULATIVE_SCORE_LOW: ${LABEL[kind]}: ${move}, conviction ${s.total}/100 (needs ${CONFIG.qualify}): ${describe(s)}`, now, kind === 'COIL' ? 'COIL' : 'MOON');
    return tally.skip(symbol, `Rejected: ${LABEL[kind]} conviction ${s.total}/100`);
  }

  const entryMax = round(live * (1 + CONFIG.entryBufferPct));
  const floor = minStopPct('crypto', kind === 'COIL' ? 'maker' : 'taker'); // coil: resting limit at the breakout (4.6%); ignition crosses the spread (6.7%)
  let invalidation;
  let stopBasis;
  if (kind === 'COIL') {
    const cs = chartStop(entryMax, a.coil.structural, floor);
    if (!cs.ok) { block(symbol, `CHART_STOP_TOO_TIGHT: ${LABEL.COIL}: ${cs.reason}`, now, 'COIL'); return tally.skip(symbol, 'Rejected: coil base too shallow for the fee floor'); }
    invalidation = floorPx(cs.invalidation);
    stopBasis = cs.widened ? 'widened to the crypto fee floor' : 'under the 3-hour base low';
  } else {
    const structural = Math.min(...b.slice(-CONFIG.swingBars).map((x) => x.low)) * (1 - CONFIG.stopBufferPct);
    invalidation = floorPx(Math.min(structural, entryMax * (1 - floor)));
    stopBasis = invalidation < structural ? 'the crypto fee floor' : 'under the 30-minute low';
  }
  const risk = entryMax - invalidation;
  const [t1R, t2R] = kind === 'COIL' ? [CONFIG.coilT1R, CONFIG.coilT2R] : [CONFIG.t1R, CONFIG.t2R];
  const conviction = Math.round(clamp01((s.total - CONFIG.qualify) / (100 - CONFIG.qualify)) * 100) / 100;
  lastSignal.set(symbol, now);
  tally.setup();
  const why = [buzz.reddit.titles[0], buzz.trending ? `CoinGecko trending #${buzz.trending.rank}` : null, news.ok && news.score !== null ? `news ${news.score}/100 (${news.label})` : null].filter(Boolean);
  const found = watchRow && watchRow.reasons.length ? ` On the gem watchlist for: ${watchRow.reasons.join(', ')}.` : '';
  return {
    id: `${STRATEGY_ID}:${kind === 'COIL' ? 'COIL' : 'MOON'}:${symbol}:${new Date(now).toISOString().slice(0, 16)}`,
    asset: symbol, market: 'crypto', strategyId: STRATEGY_ID, setupType: `Moonshot · ${LABEL[kind]}`, tag: TAG, speculative: true, gemTrigger: kind,
    ...(kind === 'COIL' ? { entryLiquidity: 'maker' } : {}),
    conviction, convictionScore: s.total, scoreParts: s.parts, direction: 'long', timeframe: kind === 'COIL' ? '15m' : a.ign.m.frame, tradeType: CONFIG.tradeType,
    expectedDuration: CONFIG.expectedDuration, newsSentiment: news.ok && news.score !== null ? { score: news.score, label: news.label, source: news.source } : null,
    entryZone: { min: round(live), max: entryMax },
    invalidation,
    targets: [{ level: 1, price: round(entryMax + t1R * risk), allocation: 0.5 }, { level: 2, price: round(entryMax + t2R * risk), allocation: 0.5 }],
    catalyst: { type: why.length ? 'social' : 'volume', headline: why[0] || `Volume ${(kind === 'COIL' ? a.coil.volRatio : a.ign.m.relVol).toFixed(1)}x`, sentimentScore: s.total },
    thesis: `SPECULATIVE MOONSHOT · ${LABEL[kind].toUpperCase()}. ${move} (vs BTC ${pct(btcMove(btc, kind === 'COIL' ? '1h' : a.ign.m.frame))}).${found} Conviction ${s.total}/100: ${describe(s)}. `
      + `${why.length ? `Buzz: ${why.join('; ')}. ` : 'No forum or news coverage found: the volume is the catalyst. '}`
      + `Stop ${invalidation} (${((risk / entryMax) * 100).toFixed(1)}% under entry: ${stopBasis}), `
      + `T1 ${t1R}R (50%), T2 ${t2R}R. Hype moves reverse fast: sized at ${Math.round((0.1 + 0.15 * conviction) * 100)}% of normal risk.`,
    confirmationCriteria: [
      kind === 'COIL'
        ? `${a.coil.volRatio.toFixed(1)}x volume vs 6h (needs 2.8x), EMA9 > EMA21, close at ${Math.round(a.coil.closePos * 100)}% of the bar, ${pct(a.coil.move)} in 1h (needs +1.5% to +5%) above a ${pct(a.coil.baseRange)} base`
        : `${pct(a.ign.m.surge)} in ${a.ign.m.minutes} min (needs ${pct(CONFIG.surgeMin)} to ${pct(CONFIG.surgeMax)}) on ${a.ign.m.relVol.toFixed(1)}x relative volume (needs ${CONFIG.relVolMin}x)`,
      `Conviction ${s.total}/100 (needs ${CONFIG.qualify}): ${describe(s)}`,
      `Sources: ${buzz.sources}${buzz.errors.length ? ` (unavailable: ${buzz.errors.join('; ')})` : ''}`,
    ],
    timestamp: new Date(now).toISOString(),
  };
}

// The pass's gem watchlist: catalog (<= 5 min old) + social + anomalies; its gems join the stream.
async function gemWatchlist(now) {
  await discovery.refresh(now);
  await social.refresh(now);
  const list = discovery.buildWatchlist(social.snapshot(discovery.gems().map((c) => c.symbol), now), [], now);
  discovery.stream(list.map((w) => w.symbol));
  return list;
}

async function generateCandidates(latestPricesMap, now = Date.now()) {
  blocks = [];
  tally.start();
  const out = [];
  const btcLive = lookup(latestPricesMap, 'BTC-USD');
  const btc = btcLive > 0 ? { live: btcLive, bars: await bars5('BTC-USD', now) } : null;
  const list = await gemWatchlist(now);
  for (const w of list) {
    tally.checked();
    const live = lookup(latestPricesMap, w.symbol);
    if (!(live > 0)) { tally.skip(w.symbol, 'No live price yet (joining the Coinbase stream)'); continue; }
    try {
      const c = await evaluate(w.symbol, live, now, btc, w);
      if (c) out.push(c);
    } catch (err) {
      console.error(`[speculative-crypto] ${w.symbol} failed: ${err.message}`);
    }
  }
  return out;
}

function takeBlocks() { const b = blocks; blocks = []; return b; }
function reset() { candles.clear(); lastSignal.clear(); blocks = []; }
// When a gem was last proposed and until when its cooldown holds (null: not cooling down).
const cooldownOf = (symbol, now = Date.now()) => { const at = lastSignal.get(symbol); return at && now - at < CONFIG.cooldownMs ? { proposedAt: at, until: at + CONFIG.cooldownMs } : null; };

module.exports = { generateCandidates, takeBlocks, takeScan: tally.take, reset, cooldownOf, assess, score, describe, bars5, btcMove, gemWatchlist,
  frames: gem.frames, to15: gem.to15, STRATEGY_ID, TAG, CONFIG, LABEL };
