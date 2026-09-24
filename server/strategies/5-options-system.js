// Strategy 5: Options Swing, long calls on a daily volatility-squeeze breakout.
// PROPOSER ONLY: reads real daily bars, live prices and the real options chain;
// returns Canonical Candidates. Never sizes, stages or executes.
//
// Trigger (real daily bars, connectors/daily-bars.js, + the live price):
//   squeeze   within the last SQUEEZE_LOOKBACK completed days, the 20-day
//             Bollinger Bands (2 sd) sat inside the Keltner Channel (1.5 ATR20):
//             volatility compressed, a coil
//   breakout  the live price clears the highest high of the last RANGE_DAYS
//             completed days and trades above the 20-day average
// Levels (UNDERLYING prices; the exit monitor watches the underlying):
//   stop      STOP_ATR x ATR20 under the broken range high (back inside = failed)
//   target    2R on the underlying, which must sit below major daily resistance
// Contract (connectors/options-data.js, real Alpaca chain): the call expiring
// in 30-45 days whose delta is nearest 0.35 (0.30-0.40), with a fresh two-sided
// quote and a spread under 10% of mid. Entry premium = the real ASK. The stop's
// cost is the real premium paid less what the option is modelled to fetch at
// the stop price (option-pricing.js: its real IV, sold at the BID side), which
// is what the risk engine sizes on (riskPerShare).
// One idea per symbol per day (the id carries the date; the ledger refuses repeats).
// Shields: stocks (not index ETFs) are blocked when earnings fall inside the
// hold (fail closed, like equity-swing); rejected setups go out via takeBlocks().
const { STREAMED_STOCKS } = require('../market/universe');
const { getDailyBars } = require('../connectors/daily-bars');
const { getEarningsStatus } = require('../connectors/corporate-calendar');
const options = require('../connectors/options-data');
const { exitValue } = require('../risk/option-pricing');
const { checkTarget } = require('../risk/structure');
const sentiment = require('../connectors/news-sentiment');
const { createTally } = require('./scan-tally');

const STRATEGY_ID = 'options-system';
const ETFS = new Set(['SPY', 'QQQ', 'IWM', 'DIA']);

const CONFIG = {
  tradeType: 'Options Swing',
  expectedDuration: '5-15 trading days (exit well before expiry)',
  symbols: [...STREAMED_STOCKS], // live-streamed stocks/ETFs (a live price is required)
  period: 20, bbSd: 2, kcAtr: 1.5, squeezeLookback: 5, rangeDays: 10,
  stopAtr: 0.75, targetR: 2, entryBufferPct: 0.002,
  earningsBufferDays: 15, // trading days: no earnings report inside the planned hold
  contract: { type: 'call', minDte: 30, maxDte: 45, minDelta: 0.30, maxDelta: 0.40, targetDelta: 0.35,
    maxSpreadPct: 0.10, minBid: 0.10, maxQuoteAgeMs: 15 * 60 * 1000 },
  strikeWindow: [0.98, 1.25], // chain request: strikes from 2% under to 25% over spot
  minOptionR: 1.5, // the option's own reward at the target / its risk at the stop
  multiplier: 100,
};

const cents = (x) => Math.round(x * 100) / 100;
const lookup = (src, key) => (src instanceof Map ? src.get(key) : src && src[key]);
const etDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });

const coils = new Map(); // symbol -> latest analysis (for proximity; cached bars only)
let blocks = [];
const tally = createTally(); // why each symbol produced no setup (scanner log)

// Squeeze state at bar index i: BB(20, 2sd) inside KC(20, 1.5 ATR20).
function squeezeAt(bars, i, p = CONFIG.period) {
  const w = bars.slice(i - p + 1, i + 1);
  const mean = w.reduce((s, b) => s + b.close, 0) / p;
  const sd = Math.sqrt(w.reduce((s, b) => s + (b.close - mean) ** 2, 0) / p);
  const atr = w.reduce((s, b, k) => {
    const prev = bars[i - p + k].close;
    return s + Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev));
  }, 0) / p;
  return { mean, sd, atr, on: CONFIG.bbSd * sd < CONFIG.kcAtr * atr };
}

// { mean, atr, rangeHigh, squeezeDays } from completed bars, or null (too short / no coil).
function analyse(bars) {
  const n = bars.length;
  if (n < CONFIG.period + CONFIG.squeezeLookback + 1) return null;
  const now = squeezeAt(bars, n - 1);
  let squeezeDays = 0;
  for (let i = n - CONFIG.squeezeLookback; i < n; i += 1) if (squeezeAt(bars, i).on) squeezeDays += 1;
  if (!squeezeDays) return null;
  const rangeHigh = Math.max(...bars.slice(-CONFIG.rangeDays).map((b) => b.high));
  return { mean: now.mean, atr: now.atr, rangeHigh, squeezeDays };
}

function block(symbol, date, reason) {
  blocks.push({ id: `${STRATEGY_ID}:BREAKOUT:${symbol}:${date}`, reason,
    candidate: { asset: symbol, market: 'options', strategyId: STRATEGY_ID, setupType: 'Squeeze breakout call', direction: 'long', timeframe: '1D' } });
  return tally.skip(symbol, `Rejected: ${reason.split(':')[0].replace(/_/g, ' ').toLowerCase()}`);
}

async function earningsGuard(symbol, now) {
  if (ETFS.has(symbol)) return { ok: true, text: 'Index ETF: no earnings.' };
  const e = await getEarningsStatus(symbol, now);
  if (!e.ok) return { ok: false, reason: `EARNINGS_UNKNOWN: ${e.error}` };
  if (e.date && e.tradingDaysAway < CONFIG.earningsBufferDays) {
    return { ok: false, reason: `OPTIONS_EARNINGS_IN_HOLD: reports ${e.date}, ${e.tradingDaysAway} trading day(s) away (IV crush risk)` };
  }
  return { ok: true, text: e.date ? `Next earnings ${e.date} (${e.tradingDaysAway} trading days away, after the planned hold).` : 'No earnings in the next 60 days.' };
}

const fmtExp = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const etTime = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' });

async function evaluate(symbol, live, now) {
  const date = etDate.format(now);
  const bars = await getDailyBars(symbol, now);
  const s = analyse(bars);
  if (s) coils.set(symbol, s); else coils.delete(symbol);
  if (!s) return tally.skip(symbol, bars.length < CONFIG.period + CONFIG.squeezeLookback + 1 ? 'Not enough daily history' : 'No volatility squeeze');
  if (!(live > s.rangeHigh)) return tally.skip(symbol, `In a squeeze, below the ${CONFIG.rangeDays}-day breakout level`);
  if (!(live > s.mean)) return tally.skip(symbol, 'Below the 20-day average');

  const entryMax = cents(live * (1 + CONFIG.entryBufferPct));
  const invalidation = Math.floor((s.rangeHigh - CONFIG.stopAtr * s.atr) * 100) / 100;
  const t1 = cents(entryMax + CONFIG.targetR * (entryMax - invalidation));
  const tgt = checkTarget(bars, entryMax, t1, cents);
  if (!tgt.ok) return block(symbol, date, `RESISTANCE_BLOCKS_TARGET: ${tgt.text}`);
  const guard = await earningsGuard(symbol, now);
  if (!guard.ok) return block(symbol, date, guard.reason);

  const chain = await options.getChain(symbol, { type: 'call', minDte: CONFIG.contract.minDte, maxDte: CONFIG.contract.maxDte,
    strikeMin: live * CONFIG.strikeWindow[0], strikeMax: live * CONFIG.strikeWindow[1] }, now);
  if (!chain.ok) return block(symbol, date, `OPTIONS_CHAIN_UNAVAILABLE: ${chain.error}`);
  const pick = options.selectContract(chain.contracts, CONFIG.contract, now);
  if (!pick.ok) return block(symbol, date, `OPTIONS_NO_CONTRACT: ${pick.error}`);
  const k = pick.contract;

  const optionsData = { contract: k.symbol, underlying: symbol, type: 'call', strike: k.strike, expiration: k.expiration, dte: k.dte,
    bid: k.bid, ask: k.ask, spread: cents(k.ask - k.bid), iv: k.iv, delta: k.delta, theta: k.theta, quoteTime: k.quoteTime, feed: chain.feed,
    refSpot: live, refMid: k.mid, refAt: now, // the model is anchored to this real quote (option-pricing.js)
    debit: k.ask, multiplier: CONFIG.multiplier, legs: [{ side: 'buy', type: 'call', strike: k.strike, ratio: 1 }] };
  const atStop = cents(exitValue(optionsData, invalidation, now));
  const atTarget = cents(exitValue(optionsData, t1, now));
  optionsData.riskPerShare = cents(Math.max(0.01, k.ask - atStop));
  optionsData.valueAtStop = atStop;
  optionsData.valueAtTarget = atTarget;
  const optionR = (atTarget - k.ask) / optionsData.riskPerShare;
  if (!(optionR >= CONFIG.minOptionR)) {
    return block(symbol, date, `OPTIONS_REWARD_TOO_LOW: ${k.symbol} gains ${cents(atTarget - k.ask)} at the target vs ${optionsData.riskPerShare} at risk (${optionR.toFixed(2)}R < ${CONFIG.minOptionR}R)`);
  }
  const news = await sentiment.getSentiment(symbol, now);
  const perContract = (x) => `$${(x * CONFIG.multiplier).toFixed(0)}`;
  const label = `${symbol} ${fmtExp(k.expiration)} ${k.strike} call`;

  return {
    id: `${STRATEGY_ID}:BREAKOUT:${symbol}:${date}`,
    asset: symbol, market: 'options', strategyId: STRATEGY_ID, setupType: 'Squeeze breakout call', direction: 'long', timeframe: '1D',
    tradeType: CONFIG.tradeType, expectedDuration: CONFIG.expectedDuration, resistance: tgt.resistance,
    newsSentiment: news.ok ? { score: news.score, label: news.label, source: news.source } : null,
    entryZone: { min: cents(live), max: entryMax },
    invalidation,
    targets: [{ level: 1, price: t1, allocation: 1 }],
    catalyst: { type: 'volatility', headline: null, sentimentScore: 0 },
    thesis: `${symbol} coiled in a daily squeeze (Bollinger Bands inside the Keltner Channel on ${s.squeezeDays} of the last ${CONFIG.squeezeLookback} days) `
      + `and is breaking out at ${cents(live)}, above its ${CONFIG.rangeDays}-day high ${cents(s.rangeHigh)} and 20-day average ${cents(s.mean)}. `
      + `Contract: ${k.symbol} (${label}, ${k.dte} DTE). Premium: ask ${k.ask} / bid ${k.bid} (${chain.feed} feed, ${etTime(k.quoteTime)} ET), `
      + `delta ${k.delta.toFixed(2)}, IV ${(k.iv * 100).toFixed(1)}%. Why this contract: of ${pick.candidates} liquid calls in the ${CONFIG.contract.minDte}-${CONFIG.contract.maxDte} DTE window, `
      + `its delta is nearest ${CONFIG.contract.targetDelta}, enough time for the move without paying for far-dated premium. `
      + `Bought at the ask (${perContract(k.ask)} per contract). If ${symbol} falls back to ${invalidation} (inside the range) the call is modelled to sell near ${atStop}: `
      + `${perContract(optionsData.riskPerShare)} at risk per contract. At the ${t1} target it is modelled near ${atTarget} (${optionR.toFixed(1)}R). `
      + `A gap through the stop or holding to expiry can lose the whole premium. ${tgt.text} ${guard.text} ${sentiment.describe(news)} Expected hold: ${CONFIG.expectedDuration}.`,
    confirmationCriteria: [
      `Squeeze on ${s.squeezeDays}/${CONFIG.squeezeLookback} recent days: 2 sd Bollinger width inside 1.5 ATR20 Keltner (ATR ${cents(s.atr)})`,
      `Live price above the ${CONFIG.rangeDays}-day high ${cents(s.rangeHigh)} and the 20-day average`,
      `${k.symbol}: ${k.dte} DTE, delta ${k.delta.toFixed(2)}, spread ${(k.spreadPct * 100).toFixed(1)}% of mid, quote ${etTime(k.quoteTime)} ET`,
      `Entry at the ask ${k.ask}; stop and target are ${symbol} prices, the option sells at the bid`,
    ],
    timestamp: new Date(now).toISOString(),
    optionsData,
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
      if (c) { out.push(c); tally.setup(); }
    } catch (err) {
      console.error(`[options-system] ${symbol} failed: ${err.message}`);
    }
  }
  return out;
}

// "Heating up": coiled symbols still under their breakout level (cached analyses only).
function proximity(latestPricesMap) {
  const out = [];
  for (const [symbol, s] of coils) {
    const live = lookup(latestPricesMap, symbol);
    if (!(live > 0) || live > s.rangeHigh) continue;
    out.push({ symbol, strategyId: STRATEGY_ID, trigger: s.rangeHigh, distancePct: (s.rangeHigh - live) / live,
      label: `Daily squeeze; call breakout above ${cents(s.rangeHigh)}` });
  }
  return out;
}

function takeBlocks() { const b = blocks; blocks = []; return b; }
function reset() { coils.clear(); blocks = []; }

module.exports = { generateCandidates, proximity, takeBlocks, takeScan: tally.take, reset, analyse, squeezeAt, STRATEGY_ID, CONFIG };
