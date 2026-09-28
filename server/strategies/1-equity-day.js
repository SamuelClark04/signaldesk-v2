// Strategy 1: Equity Day, Opening Range Breakout (long only).
// PROPOSER ONLY: reads market data and news, returns Canonical Candidates.
// Never sizes, stages or executes; that belongs to the risk engine and ledger.
//
// Inputs:
//   marketDataMap: Map or object, symbol -> array of 1-minute bars
//                  ({ open, high, low, close, volume, time: ISO }), or { bars: [...] }
//   newsContext:   Map or object, symbol -> array of headlines (string or { headline })
// Reality gate (Phase 54): T1 at 2R / T2 at 3R (the risk engine demands >= 1.25 : 1
// net at T1 alone), and T1 within 1.0x the DAILY ATR (cached daily bars): a 1-4h
// hold never plans a multi-day move.
const { scoreHeadline } = require('../intelligence/sentiment-nlp');
const { peekDailyBars } = require('../connectors/daily-bars');
const gate = require('../risk/reality-gate');
const { createTally } = require('./scan-tally');
const { pace } = require('../execution/loop-pace'); // Phase 72: yield the event loop between symbols

const STRATEGY_ID = 'equity-day';
const SESSION_OPEN = 9 * 60 + 30; // minutes after midnight, US/Eastern
const SESSION_CLOSE = 16 * 60;

const CONFIG = {
  tradeType: 'Day Trade',
  expectedDuration: '1-4 hours (closed by the end of the session)',
  openingRangeMinutes: 15,
  barMinutes: 5,
  minOpeningRangeBars: 10, // of 15 one-minute bars; IEX can skip quiet minutes
  lastEntryMinute: 11 * 60 + 30, // ORB edge fades after late morning
  volumeMultiple: 1.5, // breakout bar volume vs. average opening-range 5m bar
  entryBufferPct: 0.002, // entry zone runs from OR high up to +0.2% (or breakout close)
  maxChasePct: 0.005, // skip if the breakout bar already closed > 0.5% above OR high
  minStopPct: 0.0035, // risk engine rejects stock stops under ~0.29%; keep a margin
  targets: [
    { level: 1, r: 2, allocation: 0.5 },
    { level: 2, r: 3, allocation: 0.5 },
  ],
};

const etFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

// Phase 72: memoized. formatToParts is slow and every pass re-tags the same session bars three times
// (the strategy, trigger proximity, watch triggers): a real cost on a 0.25 vCPU VM. A bar's time never changes.
const eastern = new Map();
function toEastern(iso) {
  const hit = eastern.get(iso);
  if (hit) return hit;
  const p = Object.fromEntries(etFormat.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  const v = { date: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
  if (eastern.size >= 50000) eastern.clear(); // ~ a few sessions of 1m bars for the whole universe
  eastern.set(iso, v);
  return v;
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

const tally = createTally(); // why each symbol produced no setup (scanner log)

// Phase 76 (audit): session VWAP of the 1m bars (typical price x volume). A long ORB must break out ABOVE its
// own VWAP, and none is taken while SPY trades under ITS session VWAP (breakouts fail most in a weak tape).
function vwap(bars) {
  let pv = 0; let v = 0;
  for (const b of bars) { pv += ((b.high + b.low + b.close) / 3) * (b.volume || 0); v += b.volume || 0; }
  return v > 0 ? pv / v : null;
}
function marketTape(marketDataMap) {
  const { bars } = sessionBars(lookup(marketDataMap, 'SPY'));
  const w = bars.length >= CONFIG.minOpeningRangeBars ? vwap(bars) : null;
  const last = bars.length ? bars[bars.length - 1].close : null;
  return w && last ? { weak: last < w, text: `SPY ${last} ${last < w ? 'under' : 'over'} its session VWAP ${cents(w)}` } : { weak: false, text: 'SPY tape unknown' };
}

function detectOrb(symbol, rawBars, headlines, tape = { weak: false }) {
  const c = CONFIG;
  const { date, bars } = sessionBars(rawBars);
  const orEnd = SESSION_OPEN + c.openingRangeMinutes;
  if (!bars.length) return tally.skip(symbol, 'No bars this session (market closed)');
  if (bars[bars.length - 1].minute < orEnd - 1) return tally.skip(symbol, 'Opening range still forming'); // OR not finished

  const orBars = bars.filter((b) => b.minute < orEnd);
  if (orBars.length < c.minOpeningRangeBars) return tally.skip(symbol, 'Too few opening-range bars');
  const orHigh = Math.max(...orBars.map((b) => b.high));
  const orLow = Math.min(...orBars.map((b) => b.low));
  const orAvgVolume = orBars.reduce((s, b) => s + b.volume, 0) / (c.openingRangeMinutes / c.barMinutes);

  // Fresh breakout only: the FIRST 5m close above OR high must be the latest completed bar.
  const post = aggregate(bars, c.barMinutes).filter((k) => k.start >= orEnd);
  const breakout = post.find((k) => k.close > orHigh);
  if (!breakout) return tally.skip(symbol, 'No 5m close above the opening-range high');
  if (breakout !== post[post.length - 1]) return tally.skip(symbol, 'Breakout happened earlier (not fresh)');
  if (breakout.start > c.lastEntryMinute) return tally.skip(symbol, 'Past the entry cutoff');
  if (breakout.close > orHigh * (1 + c.maxChasePct)) return tally.skip(symbol, 'Breakout too extended (no chasing)');
  if (breakout.volume < orAvgVolume * c.volumeMultiple) return tally.skip(symbol, 'Breakout volume too low');
  const vw = vwap(bars);
  if (vw && breakout.close <= vw) return tally.skip(symbol, 'Breakout under the session VWAP');
  if (tape.weak) return tally.skip(symbol, `Weak market: ${tape.text}`);

  const catalyst = pickCatalyst(headlines);
  if (catalyst && catalyst.classification === 'NEGATIVE') return tally.skip(symbol, 'Negative news catalyst'); // no longs into bad news

  const entryMax = cents(Math.max(breakout.close, orHigh * (1 + c.entryBufferPct)));
  const minStop = Math.floor(entryMax * (1 - c.minStopPct) * 100) / 100;
  const invalidation = Math.min(cents(orLow), minStop);
  const risk = entryMax - invalidation;
  const cap = gate.atrCap(entryMax, entryMax + c.targets[0].r * risk, gate.dailyAtr(peekDailyBars(symbol)), 'intraday');
  if (!cap.ok) return tally.skip(symbol, `Rejected: ${cap.reason}`);

  return {
    id: `${STRATEGY_ID}:ORB:${symbol}:${date}`,
    asset: symbol,
    market: 'stocks',
    strategyId: STRATEGY_ID,
    setupType: 'ORB',
    tradeType: c.tradeType,
    expectedDuration: c.expectedDuration,
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
      `Above the session VWAP${vw ? ` ${cents(vw)}` : ''}; ${tape.text || 'SPY tape unknown'}`,
      `Entry at or below ${entryMax} (no chasing)`,
      `Stop ${((risk / entryMax) * 100).toFixed(2)}% from worst-case entry (min ${(c.minStopPct * 100).toFixed(2)}%)`,
    ],
    timestamp: new Date().toISOString(),
  };
}

async function generateCandidates(marketDataMap, newsContext) {
  const candidates = [];
  tally.start();
  const tape = marketTape(marketDataMap);
  for (const [symbol, bars] of entries(marketDataMap)) {
    await pace();
    tally.checked();
    const candidate = detectOrb(symbol, bars, lookup(newsContext, symbol), symbol === 'SPY' ? { weak: false, text: tape.text } : tape);
    if (candidate) { candidates.push(candidate); tally.setup(); }
  }
  return candidates;
}

// "Heating up": after the opening range is set and before the entry cutoff,
// symbols still below the OR high (the breakout level) with no breakout yet.
function proximity(marketDataMap) {
  const c = CONFIG;
  const out = [];
  for (const [symbol, raw] of entries(marketDataMap)) {
    const { bars } = sessionBars(raw);
    const orEnd = SESSION_OPEN + c.openingRangeMinutes;
    if (!bars.length || bars[bars.length - 1].minute < orEnd - 1 || bars[bars.length - 1].minute > c.lastEntryMinute) continue;
    const orBars = bars.filter((b) => b.minute < orEnd);
    if (orBars.length < c.minOpeningRangeBars) continue;
    const orHigh = Math.max(...orBars.map((b) => b.high));
    if (aggregate(bars, c.barMinutes).some((k) => k.start >= orEnd && k.close > orHigh)) continue; // already broke out
    const last = bars[bars.length - 1].close;
    if (!(last > 0) || last >= orHigh) continue;
    out.push({ symbol, strategyId: STRATEGY_ID, trigger: cents(orHigh), distancePct: (orHigh - last) / last,
      label: `ORB: ${c.barMinutes}m close above the opening-range high ${cents(orHigh)}` });
  }
  return out;
}

module.exports = { generateCandidates, proximity, vwap, marketTape, takeScan: tally.take, STRATEGY_ID, CONFIG };
