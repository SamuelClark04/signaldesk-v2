// Strategy 1: Equity Day, Opening Range Breakout (long only).
// PROPOSER ONLY: reads market data and news, returns Canonical Candidates.
// Never sizes, stages or executes; that belongs to the risk engine and ledger.
//
// Inputs:
//   marketDataMap: Map or object, symbol -> array of 1-minute bars
//                  ({ open, high, low, close, volume, time: ISO }), or { bars: [...] }
//   newsContext:   Map or object, symbol -> array of headlines (string or { headline })
const { scoreHeadline } = require('../intelligence/sentiment-nlp');

const STRATEGY_ID = 'equity-day';
const SESSION_OPEN = 9 * 60 + 30; // minutes after midnight, US/Eastern
const SESSION_CLOSE = 16 * 60;

const CONFIG = {
  openingRangeMinutes: 15,
  barMinutes: 5,
  minOpeningRangeBars: 10, // of 15 one-minute bars; IEX can skip quiet minutes
  lastEntryMinute: 11 * 60 + 30, // ORB edge fades after late morning
  volumeMultiple: 1.5, // breakout bar volume vs. average opening-range 5m bar
  entryBufferPct: 0.002, // entry zone runs from OR high up to +0.2% (or breakout close)
  maxChasePct: 0.005, // skip if the breakout bar already closed > 0.5% above OR high
  minStopPct: 0.0035, // risk engine rejects stock stops under ~0.29%; keep a margin
  targets: [
    { level: 1, r: 1, allocation: 0.5 },
    { level: 2, r: 2, allocation: 0.5 },
  ],
};

const etFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function toEastern(iso) {
  const p = Object.fromEntries(etFormat.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
}

const lookup = (src, key) => (src instanceof Map ? src.get(key) : src && src[key]);
const entries = (src) => (src instanceof Map ? [...src.entries()] : Object.entries(src || {}));
const cents = (x) => Math.round(x * 100) / 100;

// Regular-session bars for the most recent trading date, oldest first.
function sessionBars(rawBars) {
  const bars = (Array.isArray(rawBars) ? rawBars : rawBars?.bars) || [];
  const tagged = bars.filter((b) => b && b.time).map((b) => ({ ...b, ...toEastern(b.time) }));
  if (!tagged.length) return { date: null, bars: [] };
  const date = tagged.reduce((d, b) => (b.date > d ? b.date : d), tagged[0].date);
  const today = tagged
    .filter((b) => b.date === date && b.minute >= SESSION_OPEN && b.minute < SESSION_CLOSE)
    .sort((a, b) => a.minute - b.minute);
  return { date, bars: today };
}

// Roll 1m bars into completed N-minute bars aligned to the open.
function aggregate(bars, size) {
  const lastMinute = bars.length ? bars[bars.length - 1].minute : -1;
  const buckets = new Map();
  for (const b of bars) {
    const start = SESSION_OPEN + Math.floor((b.minute - SESSION_OPEN) / size) * size;
    const k = buckets.get(start);
    if (!k) buckets.set(start, { start, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });
    else Object.assign(k, { high: Math.max(k.high, b.high), low: Math.min(k.low, b.low), close: b.close, volume: k.volume + b.volume });
  }
  return [...buckets.values()].filter((k) => lastMinute >= k.start + size - 1);
}

function pickCatalyst(headlines) {
  const scored = (headlines || [])
    .map((h) => (typeof h === 'string' ? h : h && h.headline))
    .filter(Boolean)
    .map((headline) => ({ headline, ...scoreHeadline(headline) }));
  if (!scored.length) return null;
  // Strongest signal wins; ties go to the later (more recent) headline.
  return scored.reduce((best, h) => (Math.abs(h.score) >= Math.abs(best.score) ? h : best));
}

function detectOrb(symbol, rawBars, headlines) {
  const c = CONFIG;
  const { date, bars } = sessionBars(rawBars);
  const orEnd = SESSION_OPEN + c.openingRangeMinutes;
  if (!bars.length || bars[bars.length - 1].minute < orEnd - 1) return null; // OR not finished

  const orBars = bars.filter((b) => b.minute < orEnd);
  if (orBars.length < c.minOpeningRangeBars) return null;
  const orHigh = Math.max(...orBars.map((b) => b.high));
  const orLow = Math.min(...orBars.map((b) => b.low));
  const orAvgVolume = orBars.reduce((s, b) => s + b.volume, 0) / (c.openingRangeMinutes / c.barMinutes);

  // Fresh breakout only: the FIRST 5m close above OR high must be the latest completed bar.
  const post = aggregate(bars, c.barMinutes).filter((k) => k.start >= orEnd);
  const breakout = post.find((k) => k.close > orHigh);
  if (!breakout || breakout !== post[post.length - 1]) return null;
  if (breakout.start > c.lastEntryMinute) return null;
  if (breakout.close > orHigh * (1 + c.maxChasePct)) return null;
  if (breakout.volume < orAvgVolume * c.volumeMultiple) return null;

  const catalyst = pickCatalyst(headlines);
  if (catalyst && catalyst.classification === 'NEGATIVE') return null; // no longs into bad news

  const entryMax = cents(Math.max(breakout.close, orHigh * (1 + c.entryBufferPct)));
  const minStop = Math.floor(entryMax * (1 - c.minStopPct) * 100) / 100;
  const invalidation = Math.min(cents(orLow), minStop);
  const risk = entryMax - invalidation;

  return {
    id: `${STRATEGY_ID}:ORB:${symbol}:${date}`,
    asset: symbol,
    market: 'stocks',
    strategyId: STRATEGY_ID,
    setupType: 'ORB',
    direction: 'long',
    timeframe: `${c.barMinutes}m`,
    entryZone: { min: cents(orHigh), max: entryMax },
    invalidation,
    targets: c.targets.map((t) => ({ level: t.level, price: cents(entryMax + t.r * risk), allocation: t.allocation })),
    catalyst: catalyst
      ? { type: 'news', headline: catalyst.headline, sentimentScore: catalyst.score }
      : { type: 'technical', headline: null, sentimentScore: 0 },
    thesis: `${symbol} closed a ${c.barMinutes}m bar at ${breakout.close} above its ${c.openingRangeMinutes}-minute `
      + `opening range high ${cents(orHigh)} on ${(breakout.volume / orAvgVolume).toFixed(1)}x volume. `
      + `Long while price holds above the range; invalid below ${invalidation}.`,
    confirmationCriteria: [
      `${c.barMinutes}m close above OR high ${cents(orHigh)}`,
      `Breakout volume >= ${c.volumeMultiple}x opening-range average`,
      `Entry at or below ${entryMax} (no chasing)`,
      `Stop ${((risk / entryMax) * 100).toFixed(2)}% from worst-case entry (min ${(c.minStopPct * 100).toFixed(2)}%)`,
    ],
    timestamp: new Date().toISOString(),
  };
}

function generateCandidates(marketDataMap, newsContext) {
  const candidates = [];
  for (const [symbol, bars] of entries(marketDataMap)) {
    const candidate = detectOrb(symbol, bars, lookup(newsContext, symbol));
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

module.exports = { generateCandidates, STRATEGY_ID, CONFIG };
