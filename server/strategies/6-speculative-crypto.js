// Strategy 6: Speculative Crypto Moonshots, the Gem Hunter (ADDITIVE: Systems 1-5
// are untouched). PROPOSER ONLY: returns Canonical Candidates tagged "Speculative
// Moonshot"; the risk engine sizes them at a small fraction of normal risk.
//
// Universe (Phase 56): the Active Gem Watchlist (coinbase-discovery.js) from the whole Coinbase spot catalog:
// trending / Reddit coins, volume + momentum anomalies; never mega-caps or stable / wrapped / staked tokens.
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
// Moonshot tier (Phase 65B): fee drag <= 0.35R and T1 alone >= 1.35 : 1 net of the real
// Coinbase fees, stop floors at a 0.34R budget (6.7% taker / 4.6% maker). IGNITION T1 2.2R
// (50%), T2 3R: 2.2R nets 1.38 : 1 at the 6.7% floor (2.1R would net 1.31); COIL T1 2.25R,
// T2 3.5R: 1.41 : 1 at 4.6%.
// Liquidity (65B): >= $350k of 24h Coinbase volume, or >= $200k with a confirmed catalyst
// (CoinGecko trending, a Reddit mention, or >= 2.5x relative volume with 24h volume up >= 50%);
// the volume-only catalyst credit (12/30) needs a real catalyst, or >= $500k of 24h volume
// (>= $250k when 24h volume is up >= 75%). Bid/ask <= 0.80% (pipeline.js spread gate).
// conviction = (score - 60) / 40: the Smart Investment Amount, 10-25% of normal risk.
// Phase 79 (replayed on 90 days of 5m candles): a trigger is never bought on its breakout bar; > 18% up over 24h or a
// 15m RSI > 70 is skipped, the rest wait up to 1 hour for a retest (moonshot-entry.js, evaluate / fillArmed).
const { getHistory } = require('../connectors/history-bars');
const { minStopPct } = require('../risk/cost-authority');
const { chartStop } = require('../risk/reality-gate');
const sentiment = require('../connectors/news-sentiment');
const social = require('../connectors/crypto-social');
const coinbase = require('../connectors/coinbase-socket');
const discovery = require('../connectors/coinbase-discovery');
const gem = require('./gem-triggers');
const entry = require('./moonshot-entry'); // Phase 79: no chasing, no overbought, buy the pullback
const { candidate: buildCandidate } = require('./moonshot-candidate'); // Phase 83: the setup builder, split out
const { createTally } = require('./scan-tally');
const { pace } = require('../execution/loop-pace'); // Phase 72: yield the event loop between symbols

const STRATEGY_ID = 'speculative-crypto';
const TAG = 'Speculative Moonshot';
const CONFIG = {
  volumeCatalyst: 3.5, qualify: 60, swingBars: 6, stopBufferPct: 0.003, entryBufferPct: 0.003, t1R: 2.2, t2R: 3, coilT1R: 2.25, coilT2R: 3.5, feeBudget: 0.34,
  minVolumeUsd: 350000, catalystVolumeUsd: 200000, catalystRelVol: 2.5, catalystVolChange: 0.5,
  volumeCreditUsd: 500000, volumeCreditSurgeUsd: 250000, volumeCreditSurge: 0.75, cooldownMs: 4 * 60 * 60 * 1000,
  tradeType: TAG, expectedDuration: 'Minutes to hours (momentum; exits at stop or targets)', ...gem.CONFIG.ignition,
};
const LABEL = { IGNITION: 'Momentum Ignition', COIL: 'Accumulation Coil' };
// Phase 79: the hold window each trigger is built for (shown on the setup card and the open position).
const HOLD = { IGNITION: '30m – 3h (momentum burst — do not hold if volume dies)', COIL: '1h – 6h (accumulation breakout — do not hold if volume dies)' };
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
// volumeUsd / volChange: the gem's 24h USD volume and its change vs the prior 24h (the volume-only
// credit needs a real catalyst, >= volumeCreditUsd, or >= volumeCreditSurgeUsd on a volumeCreditSurge surge).
function score({ m, btcSurge, buzz, news, spreadPct, volumeUsd, volChange }) {
  const velocity = 25 * clamp01((m.surge - 0.02) / 0.06);
  const volume = 25 * clamp01((m.relVol - 1.5) / 3);
  const r = buzz && buzz.reddit;
  const reddit = r ? Math.min(15, 5 * r.recent + (r.mentions > r.recent ? 2 : 0) + (r.bullish > r.bearish ? 3 : 0)) : 0;
  const trend = buzz && buzz.trending ? (buzz.trending.rank <= 7 ? 15 : 10) : 0;
  const fresh = news && news.ok && news.score !== null ? (news.score >= 70 ? 15 : news.score >= 60 ? 8 : 0) : 0;
  const found = Math.min(30, reddit + trend + fresh);
  const external = !!(buzz && (buzz.trending || (buzz.reddit && buzz.reddit.mentions > 0)));
  const deep = Number.isFinite(volumeUsd) && (volumeUsd >= CONFIG.volumeCreditUsd || (volumeUsd >= CONFIG.volumeCreditSurgeUsd && volChange >= CONFIG.volumeCreditSurge));
  const catalyst = m.relVol >= CONFIG.volumeCatalyst && found < 12 && (external || deep) ? 12 : 0;
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
  const vol = ctx.volumeUsd;
  const volChange = ctx.volChange;
  for (const f of ign.frames) scored.push({ kind: 'IGNITION', m: f, ok: ign.ok && ign.m === f, ...score({ m: f, btcSurge: btcMove(ctx.btc, f.frame), buzz: ctx.buzz, news: ctx.news, spreadPct, volumeUsd: vol, volChange }) });
  if (Number.isFinite(coil.volRatio)) {
    const m = { surge: coil.move, relVol: coil.volRatio, frame: '15m', minutes: 60 };
    const s = score({ m, btcSurge: btcMove(ctx.btc, '1h'), buzz: ctx.buzz, news: ctx.news, spreadPct, volumeUsd: vol, volChange });
    const parts = { ...s.parts, velocity: gem.coilPattern(coil) };
    scored.push({ kind: 'COIL', m, ok: coil.ok, pattern: true, parts, detail: s.detail, total: Math.round(Object.values(parts).reduce((x, y) => x + y, 0)) });
  }
  const pick = (list) => (list.length ? list.reduce((a, x) => (x.total > a.total ? x : a)) : null);
  const triggered = pick(scored.filter((x) => x.ok));
  return { ign, coil, spreadPct, trigger: triggered ? triggered.kind : null, best: triggered || pick(scored) };
}

// Phase 65B liquidity floor: $350k, or $200k with a confirmed catalyst. -> { ok, floor, catalyst, reason }
function liquidity({ volumeUsd, volChange, relVol, buzz }) {
  const catalyst = !!(buzz && (buzz.trending || (buzz.reddit && buzz.reddit.mentions > 0))) || (relVol >= CONFIG.catalystRelVol && volChange >= CONFIG.catalystVolChange);
  const floor = catalyst ? CONFIG.catalystVolumeUsd : CONFIG.minVolumeUsd;
  const ok = Number.isFinite(volumeUsd) && volumeUsd >= floor;
  return { ok, floor, catalyst, reason: ok ? null : `THIN_VOLUME: 24h volume $${Math.round(volumeUsd || 0).toLocaleString('en-US')} under the $${Math.round(floor / 1000)}k Moonshot floor${catalyst ? ' (catalyst floor)' : ' (no confirmed catalyst: $200k with one)'}` };
}

function block(symbol, reason, now, kind = 'MOON') {
  blocks.push({ id: `${STRATEGY_ID}:${kind}:${symbol}:${new Date(now).toISOString().slice(0, 13)}`, reason,
    candidate: { asset: symbol, market: 'crypto', strategyId: STRATEGY_ID, setupType: TAG, direction: 'long', timeframe: '5m', speculative: true } });
}

// Phase 79: the stop floor on EVERY venue is Coinbase's (coil 4.6%, ignition 6.7%), the one the replay validated. OKX /
// Kraken fees would allow tighter floors (70D), but those admit trades the replay found losing (tight coil breakouts).
const stopFloor = (kind) => minStopPct('crypto', kind === 'COIL' ? 'maker' : 'taker', CONFIG.feeBudget);

// Stop for a trigger bought at `ref` (shared with backtest/rules-moonshots.js). -> { price, basis } | { reject }
function stopFor(kind, ref, structural, floor) {
  if (kind === 'COIL') {
    const cs = chartStop(ref, structural, floor);
    return cs.ok ? { price: floorPx(cs.invalidation), basis: cs.widened ? 'widened to the crypto fee floor' : 'under the 3-hour base low' } : { reject: cs.reason };
  }
  const price = floorPx(Math.min(structural, ref * (1 - floor)));
  return { price, basis: price < structural ? 'the crypto fee floor' : 'under the 30-minute low' };
}

// Phase 79: a qualifying trigger is never bought on its breakout bar. Chasing (> 18% up over 24h) and overbought
// (15m RSI > 70) triggers are skipped; the rest are ARMED (moonshot-entry.js) and staged only when the price comes
// back to the retest within 1 hour (fillArmed), as a resting maker buy. The 4-hour cooldown runs from the trigger.
async function evaluate(symbol, live, now, btc, watchRow) {
  const armed = entry.armedFor(symbol);
  if (armed) return fillArmed(symbol, armed, live, now);
  if (now - (lastSignal.get(symbol) || 0) < CONFIG.cooldownMs) return tally.skip(symbol, 'Proposed in the last 4 hours');
  const volumeUsd = watchRow ? watchRow.volumeUsd : null;
  const volChange = watchRow ? watchRow.volChange : null;
  if (!(volumeUsd >= CONFIG.catalystVolumeUsd)) return tally.skip(symbol, 'Thin book: 24h volume under $200k (never traded)');
  const b = await bars5(symbol, now);
  const probe = assess(b, live, symbol, { btc, volumeUsd, volChange }); // triggers first: social / news only for a triggered gem
  if (!probe.trigger) {
    // Grouped in the Scanner log by cause (the radar shows each gem's numbers).
    return tally.skip(symbol, probe.ign.frames.length ? `Ignition: ${probe.ign.short} · Coil: ${probe.coil.short}` : 'Not enough 5-minute history');
  }
  const [buzz, news] = await Promise.all([social.getSocial(symbol, now), sentiment.getSentiment(symbol, now)]);
  const a = assess(b, live, symbol, { btc, buzz, news, volumeUsd, volChange });
  const s = { ...a.best };
  const liq = liquidity({ volumeUsd, volChange, relVol: s.m && s.m.relVol, buzz });
  if (!liq.ok) { block(symbol, liq.reason, now, a.trigger === 'COIL' ? 'COIL' : 'MOON'); return tally.skip(symbol, 'Thin book: under the $350k floor without a confirmed catalyst'); }
  const kind = a.trigger || probe.trigger;
  const move = kind === 'COIL'
    ? `${symbol} ${pct(a.coil.move)} in 1h breaking a ${pct(a.coil.baseRange)} 3-hour base on ${a.coil.volRatio.toFixed(1)}x its 6-hour volume`
    : `${symbol} ${pct(a.ign.m.surge)} in ${a.ign.m.minutes}m on ${a.ign.m.relVol.toFixed(1)}x volume`;
  if (!a.trigger || s.total < CONFIG.qualify) {
    block(symbol, `SPECULATIVE_SCORE_LOW: ${LABEL[kind]}: ${move}, conviction ${s.total}/100 (needs ${CONFIG.qualify}): ${describe(s)}`, now, kind === 'COIL' ? 'COIL' : 'MOON');
    return tally.skip(symbol, `Rejected: ${LABEL[kind]} conviction ${s.total}/100`);
  }
  const change24h = watchRow && Number.isFinite(watchRow.change24h) ? watchRow.change24h : null;
  const chase = entry.chase(b, change24h);
  if (chase) { block(symbol, `${chase.code}: ${LABEL[kind]}: ${move}: ${chase.text}`, now, kind === 'COIL' ? 'COIL' : 'MOON'); return tally.skip(symbol, chase.short); }
  const floor = stopFloor(kind);
  const structural = kind === 'COIL' ? a.coil.structural : Math.min(...b.slice(-CONFIG.swingBars).map((x) => x.low)) * (1 - CONFIG.stopBufferPct);
  lastSignal.set(symbol, now);
  entry.arm(symbol, { kind, limit: floorPx(entry.pullbackLimit(kind, a, live, b)), until: now + entry.FILTERS.armMs, at: now, triggerLive: live, structural, floor,
    s, a, buzz, news, watchRow, move, change24h, rsi: entry.rsi15(b), btcVs: btcMove(btc, kind === 'COIL' ? '1h' : a.ign.m.frame) });
  return tally.skip(symbol, 'Armed: waiting for its pullback (buys only a retest within 1 hour)');
}

function fillArmed(symbol, w, live, now) {
  if (now > w.until) { entry.disarm(symbol); return tally.skip(symbol, 'No pullback within 1 hour of its trigger: no trade (never chases)'); }
  if (!(live <= w.limit)) return tally.skip(symbol, 'Armed: waiting for its pullback (buys only a retest within 1 hour)');
  entry.disarm(symbol);
  const entryMax = Math.min(w.limit, round(live * (1 + CONFIG.entryBufferPct)));
  const stop = stopFor(w.kind, entryMax, w.structural, w.floor);
  if (stop.reject) { block(symbol, `CHART_STOP_TOO_TIGHT: ${LABEL.COIL}: ${stop.reject}`, now, 'COIL'); return tally.skip(symbol, 'Rejected: coil base too shallow for the fee floor'); }
  if (!(stop.price < live) || live <= w.structural) return tally.skip(symbol, 'Fell through its stop before the pullback was bought: no trade');
  tally.setup();
  return buildCandidate({ CONFIG, LABEL, HOLD, TAG, STRATEGY_ID, round, pct, clamp01, describe }, symbol, w, live, entryMax, stop, now);
}

// The pass's gem watchlist: catalog (<= 5 min old) + social + anomalies; its gems join the stream.
async function gemWatchlist(now) {
  await discovery.refresh(now);
  await social.refresh(now);
  const list = discovery.buildWatchlist(social.snapshot(discovery.gems().map((c) => c.symbol), now), entry.armedSymbols(), now);
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
    await pace();
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
function reset() { candles.clear(); lastSignal.clear(); blocks = []; entry.reset(); }
// When a gem was last proposed and until when its cooldown holds (null: not cooling down).
const cooldownOf = (symbol, now = Date.now()) => { const at = lastSignal.get(symbol); return at && now - at < CONFIG.cooldownMs ? { proposedAt: at, until: at + CONFIG.cooldownMs } : null; };

module.exports = { generateCandidates, takeBlocks, takeScan: tally.take, reset, cooldownOf, liquidity, assess, score, describe, stopFor, stopFloor, armed: entry.armedList, bars5, btcMove, gemWatchlist,
  frames: gem.frames, to15: gem.to15, STRATEGY_ID, TAG, CONFIG, LABEL };
