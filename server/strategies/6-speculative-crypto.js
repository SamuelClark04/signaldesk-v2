// Strategy 6: Speculative Crypto Moonshots (ADDITIVE: Systems 1-5 are untouched).
// PROPOSER ONLY: returns Canonical Candidates tagged "Speculative Moonshot"; the
// risk engine sizes them at a small fraction of normal risk (risk-engine.js).
//
// A setup needs ALL of, on the monitored Coinbase coins:
//   velocity   live price up >= VELOCITY_PCT over the last ~15 minutes (sampled
//              from the live stream each pass; a cheap prefilter, no REST)
//   volume     on real 1-minute Coinbase candles (fetched only for coins that
//              passed velocity): the last 5 minutes traded >= VOLUME_MULT x the
//              average 5 minutes of the hour before, and the last completed
//              close is the highest of the last BREAKOUT_BARS minutes
//   sentiment  news that explains the spike (connectors/news-sentiment.js, scored
//              by intelligence/sentiment-nlp.js): score >= MIN_SENTIMENT
//              (Bullish), at least MIN_HEADLINES focused headlines in 48h, and a
//              bullish headline in the last FRESH_HOURS. Sources are Alpaca /
//              Benzinga news; there is no social-forum feed, so a spike with no
//              news behind it is rejected, never guessed at.
// Levels: stop under the 10-minute low, but never tighter than the crypto fee
// gate allows (round trip / 0.34, as for every crypto trade); target 2R.
// conviction (0-1, from sentiment strength and volume surge) sets how small the
// position is: 10% to 25% of the normal risk budget (see risk-engine.js).
const { CRYPTO } = require('../market/universe');
const { getHistory } = require('../connectors/history-bars');
const { getRoundTripRate } = require('../risk/cost-authority');
const sentiment = require('../connectors/news-sentiment');
const { scoreHeadline } = require('../intelligence/sentiment-nlp');
const { createTally } = require('./scan-tally');

const STRATEGY_ID = 'speculative-crypto';
const TAG = 'Speculative Moonshot';
const CONFIG = {
  symbols: [...CRYPTO], velocityWindowMs: 15 * 60 * 1000, minWindowMs: 5 * 60 * 1000, velocityPct: 0.03,
  volumeMult: 3, breakoutBars: 30, baselineBars: 60, swingBars: 10, stopBufferPct: 0.003, entryBufferPct: 0.003, targetR: 2,
  minSentiment: 70, minHeadlines: 3, freshHours: 12, cooldownMs: 4 * 60 * 60 * 1000,
  tradeType: TAG, expectedDuration: 'Minutes to hours (momentum; exits at stop or target)',
};
const FEE_DRAG_BUDGET = 0.34;
const minStopPct = () => Math.ceil((getRoundTripRate('crypto') / FEE_DRAG_BUDGET) * 200) / 200;

const decimals = (x) => (x >= 100 ? 2 : x >= 1 ? 4 : Math.min(12, 3 - Math.floor(Math.log10(x))));
const round = (x) => { const f = 10 ** decimals(x); return Math.round(x * f) / f; };
const floorPx = (x) => { const f = 10 ** decimals(x); return Math.floor(x * f) / f; };
const lookup = (src, key) => (src instanceof Map ? src.get(key) : src && src[key]);
const clamp01 = (x) => Math.max(0, Math.min(1, x));

const samples = new Map(); // symbol -> [{ t, p }] live prices seen by the pipeline
const lastSignal = new Map(); // symbol -> time of its last proposal (cooldown)
const tally = createTally();
let blocks = [];

function velocity(symbol, live, now) {
  const list = (samples.get(symbol) || []).filter((s) => now - s.t <= CONFIG.velocityWindowMs + 60000);
  list.push({ t: now, p: live });
  samples.set(symbol, list);
  const oldest = list[0];
  if (now - oldest.t < CONFIG.minWindowMs) return null; // warming up after a start
  return { pct: live / oldest.p - 1, minutes: Math.round((now - oldest.t) / 60000) };
}

// 1-minute volume surge + fresh high, on completed candles. null = no surge.
function surge(bars, now) {
  const done = bars.filter((b) => (b.time + 60) * 1000 <= now);
  if (done.length < CONFIG.baselineBars + 5) return null;
  const last5 = done.slice(-5);
  const base = done.slice(-5 - CONFIG.baselineBars, -5);
  const vol5 = last5.reduce((s, b) => s + (b.volume || 0), 0);
  const baseAvg5 = (base.reduce((s, b) => s + (b.volume || 0), 0) / base.length) * 5;
  const mult = baseAvg5 > 0 ? vol5 / baseAvg5 : 0;
  const lastClose = done[done.length - 1].close;
  const priorHigh = Math.max(...done.slice(-1 - CONFIG.breakoutBars, -1).map((b) => b.close));
  if (mult < CONFIG.volumeMult || !(lastClose >= priorHigh)) return { ok: false, mult, fresh: lastClose >= priorHigh };
  return { ok: true, mult, swingLow: Math.min(...done.slice(-CONFIG.swingBars).map((b) => b.low)) };
}

// The news gate: overall score, enough coverage, and a fresh bullish headline.
function newsGate(s, now) {
  if (!s || !s.ok) return { ok: false, why: `news unavailable (${(s && s.error) || 'no reply'})` };
  const fresh = (s.headlines || []).filter((h) => h.at && now - Date.parse(h.at) <= CONFIG.freshHours * 3600000 && scoreHeadline(h.title).score > 0);
  if (!(s.score >= CONFIG.minSentiment)) return { ok: false, why: `sentiment ${s.score === null ? 'none' : `${s.score}/100`} is below ${CONFIG.minSentiment} (${s.label})` };
  if (!(s.total >= CONFIG.minHeadlines)) return { ok: false, why: `only ${s.total || 0} focused headline(s) in 48h (need ${CONFIG.minHeadlines})` };
  if (!fresh.length) return { ok: false, why: `no bullish headline in the last ${CONFIG.freshHours}h to explain the spike` };
  return { ok: true, fresh };
}

function block(symbol, reason, now) {
  blocks.push({ id: `${STRATEGY_ID}:MOON:${symbol}:${new Date(now).toISOString().slice(0, 13)}`, reason,
    candidate: { asset: symbol, market: 'crypto', strategyId: STRATEGY_ID, setupType: TAG, direction: 'long', timeframe: '1m', speculative: true } });
}

async function evaluate(symbol, live, now) {
  const v = velocity(symbol, live, now);
  if (!v) return tally.skip(symbol, 'Warming up (needs 5+ minutes of live prices)');
  if (v.pct < CONFIG.velocityPct) return tally.skip(symbol, `Under +${CONFIG.velocityPct * 100}% in 15 minutes`);
  if (now - (lastSignal.get(symbol) || 0) < CONFIG.cooldownMs) return tally.skip(symbol, 'Proposed in the last 4 hours');
  const hist = await getHistory(symbol, '1m');
  if (!hist.ok) return tally.skip(symbol, 'No 1-minute candles');
  const vol = surge(hist.bars, now);
  if (!vol) return tally.skip(symbol, 'Not enough 1-minute history');
  if (!vol.ok) return tally.skip(symbol, vol.fresh ? `Volume only ${vol.mult.toFixed(1)}x normal` : 'Momentum faded (no fresh 30-minute high)');
  const news = await sentiment.getSentiment(symbol, now);
  const gate = newsGate(news, now);
  if (!gate.ok) {
    block(symbol, `SPECULATIVE_SENTIMENT_WEAK: ${symbol} +${(v.pct * 100).toFixed(1)}% in ${v.minutes}m on ${vol.mult.toFixed(1)}x volume, but ${gate.why}`, now);
    return tally.skip(symbol, 'Rejected: spike without strong news sentiment');
  }

  const entryMax = round(live * (1 + CONFIG.entryBufferPct));
  const structural = vol.swingLow * (1 - CONFIG.stopBufferPct);
  const invalidation = floorPx(Math.min(structural, entryMax * (1 - minStopPct())));
  const risk = entryMax - invalidation;
  const conviction = Math.round(((clamp01((news.score - CONFIG.minSentiment) / 20) + clamp01((vol.mult - CONFIG.volumeMult) / 5)) / 2) * 100) / 100;
  lastSignal.set(symbol, now);
  tally.setup();
  const h = gate.fresh[0];
  return {
    id: `${STRATEGY_ID}:MOON:${symbol}:${new Date(now).toISOString().slice(0, 16)}`,
    asset: symbol, market: 'crypto', strategyId: STRATEGY_ID, setupType: TAG, tag: TAG, speculative: true, conviction,
    direction: 'long', timeframe: '1m', tradeType: CONFIG.tradeType, expectedDuration: CONFIG.expectedDuration,
    newsSentiment: { score: news.score, label: news.label, source: news.source },
    entryZone: { min: round(live), max: entryMax },
    invalidation,
    targets: [{ level: 1, price: round(entryMax + CONFIG.targetR * risk), allocation: 1 }],
    catalyst: { type: 'news', headline: h.title, sentimentScore: news.score },
    thesis: `SPECULATIVE MOONSHOT. ${symbol} is up ${(v.pct * 100).toFixed(1)}% in ${v.minutes} minutes on ${vol.mult.toFixed(1)}x normal 1-minute volume, `
      + `at a fresh 30-minute high, and the news backs it: sentiment ${news.score}/100 (${news.label}, ${news.total} headlines in 48h); `
      + `latest bullish headline: "${h.title}". Stop ${invalidation} (${((risk / entryMax) * 100).toFixed(1)}% under entry: `
      + `${invalidation < structural ? 'the crypto fee floor' : 'under the 10-minute low'}), target ${CONFIG.targetR}R. `
      + `Hype moves reverse fast: sized at ${Math.round((0.1 + 0.15 * conviction) * 100)}% of normal risk (conviction ${conviction}).`,
    confirmationCriteria: [
      `+${(v.pct * 100).toFixed(1)}% in ${v.minutes} min (needs ≥ ${CONFIG.velocityPct * 100}%)`,
      `5-minute volume ${vol.mult.toFixed(1)}x the prior hour's average (needs ≥ ${CONFIG.volumeMult}x) at a fresh ${CONFIG.breakoutBars}-minute high`,
      `News sentiment ${news.score}/100 with a bullish headline in the last ${CONFIG.freshHours}h`,
    ],
    timestamp: new Date(now).toISOString(),
  };
}

async function generateCandidates(latestPricesMap, now = Date.now()) {
  blocks = [];
  tally.start();
  const out = [];
  for (const symbol of CONFIG.symbols) {
    tally.checked();
    const live = lookup(latestPricesMap, symbol);
    if (!(live > 0)) { tally.skip(symbol, 'No live price'); continue; }
    try {
      const c = await evaluate(symbol, live, now);
      if (c) out.push(c);
    } catch (err) {
      console.error(`[speculative-crypto] ${symbol} failed: ${err.message}`);
    }
  }
  return out;
}

function takeBlocks() { const b = blocks; blocks = []; return b; }
function reset() { samples.clear(); lastSignal.clear(); blocks = []; }

module.exports = { generateCandidates, takeBlocks, takeScan: tally.take, reset, surge, newsGate, STRATEGY_ID, TAG, CONFIG };
