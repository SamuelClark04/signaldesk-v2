// Strategy 5: Options Swing, calls or call debit spreads on a daily
// volatility-squeeze breakout.
// PROPOSER ONLY: reads real daily bars, live prices and the real options chain;
// returns Canonical Candidates. Never sizes, stages or executes.
//
// Trigger (real daily bars, connectors/daily-bars.js, + the live price):
//   squeeze   within the last SQUEEZE_LOOKBACK completed days, the 20-day
//             Bollinger Bands (2 sd) sat inside the Keltner Channel (1.5 ATR20)
//   breakout  the live price clears the highest high of the last RANGE_DAYS
//             completed days and trades above the 20-day average
//   structure the underlying is invalid STOP_ATR x ATR20 under the broken range high
// Expected Move (risk/expected-move.js): (ATM call + ATM put mid) x 0.85 at the
// contract's expiration, from the real chain. Every T1 sits INSIDE it.
// Structure (strategies/options-plan.js):
//   single call        the 30-45 DTE call nearest 0.35 delta; option stop from
//                      the structural level by Delta-Gamma, clamped to a 30-38%
//                      premium loss; T1 at 0.75-0.85 x EM where the call reaches
//                      2.0-2.5R
//   vertical spread    when the IV percentile (proxy, see expected-move.js) is
//                      above 80 or an earnings / macro catalyst falls inside the
//                      hold: long ~0.55 delta + short ~0.30 delta near the EM
//                      edge; stop 50% of the debit, T1 80% of the max profit
// Positions exit on their own value (optionsData.exitRule; the ledger marks every
// leg at its real bid/ask, else the model). Greeks the indicative feed omits are
// modelled from the quote (options-data.js). Resistance (risk/target-plan.js):
// a squeeze breakout is not blocked by the base it breaks out of; higher daily
// resistance under T1 snaps T1 below it if the reward survives, else no trade.
// Shields: earnings unknown = blocked (fail closed). One idea per symbol per day.
const { STREAMED_STOCKS } = require('../market/universe');
const { getDailyBars } = require('../connectors/daily-bars');
const { getHistory } = require('../connectors/history-bars');
const { getEarningsStatus } = require('../connectors/corporate-calendar');
const macro = require('../connectors/macro-events');
const options = require('../connectors/options-data');
const { expectedMove, ivPercentile } = require('../risk/expected-move');
const { planTargets } = require('../risk/target-plan');
const { deltaGamma } = require('../risk/option-greeks');
const { planSingle, planVertical, SINGLE, VERTICAL } = require('./options-plan');
const sentiment = require('../connectors/news-sentiment');
const { createTally } = require('./scan-tally');

const STRATEGY_ID = 'options-system';
const ETFS = new Set(['SPY', 'QQQ', 'IWM', 'DIA']);

const CONFIG = {
  tradeType: 'Options Swing',
  expectedDuration: '5-15 trading days (exit well before expiry)',
  symbols: [...STREAMED_STOCKS], // live-streamed stocks/ETFs (a live price is required)
  period: 20, bbSd: 2, kcAtr: 1.5, squeezeLookback: 5, rangeDays: 10, stopAtr: 0.75, entryBufferPct: 0.002,
  holdTradingDays: 15, // earnings inside this many trading days = a catalyst in the hold
  ivpSpread: 80, // IV percentile above this = vertical spread
  contract: { type: 'call', minDte: 30, maxDte: 45, minDelta: 0.30, maxDelta: 0.40, targetDelta: 0.35, minBid: 0.10, maxQuoteAgeMs: 15 * 60 * 1000 },
  strikeWindow: [0.90, 1.25], // chain request: deep enough for the 0.55 delta spread leg and the ATM straddle
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

// Catalysts inside the hold: { ok, list, text } (earnings unknown = { ok:false }).
async function catalysts(symbol, now) {
  const list = macro.catalystsFor({ asset: symbol, strategyId: STRATEGY_ID, market: 'options' }, now).map((c) => `${c.type} ${c.date}`);
  if (ETFS.has(symbol)) return { ok: true, list, text: 'Index ETF: no earnings.' };
  const e = await getEarningsStatus(symbol, now);
  if (!e.ok) return { ok: false, reason: `EARNINGS_UNKNOWN: ${e.error}` };
  if (e.date && e.tradingDaysAway < CONFIG.holdTradingDays) list.unshift(`earnings ${e.date}`);
  return { ok: true, list, text: e.date ? `Next earnings ${e.date} (${e.tradingDaysAway} trading days away).` : 'No earnings in the next 60 days.' };
}

// ATM implied vol for the structure decision: the straddle nearest mid-window.
function atmContext(calls, puts, live) {
  const mid = (CONFIG.contract.minDte + CONFIG.contract.maxDte) / 2;
  const exps = [...new Set(calls.map((c) => c.expiration))].sort((a, b) => Math.abs(calls.find((c) => c.expiration === a).dte - mid) - Math.abs(calls.find((c) => c.expiration === b).dte - mid));
  for (const exp of exps) { const m = expectedMove(calls, puts, live, exp); if (m.ok) return m; }
  return null;
}

// The single call nearest 0.35 delta, its Expected Move and plan.
function singlePlan(calls, puts, live, structuralStop, now) {
  const pick = options.selectContract(calls, CONFIG.contract, now, live);
  if (!pick.ok) return { ok: false, reason: `OPTIONS_NO_CONTRACT: ${pick.error}` };
  const em = expectedMove(calls, puts, live, pick.contract.expiration);
  if (!em.ok) return { ok: false, reason: `OPTIONS_NO_EXPECTED_MOVE: ${em.error}` };
  const plan = planSingle({ k: pick.contract, spot: live, structuralStop, em: em.em });
  return plan.ok ? { ok: true, k: pick.contract, em, plan } : { ok: false, reason: `OPTIONS_REWARD_TOO_LOW: ${plan.error}` };
}

// Vertical: each expiration in the window (nearest mid-window first) until one
// has a ~0.55 delta long, a short leg near the EM edge and a valid plan.
function verticalPlan(calls, puts, live, now) {
  const c = CONFIG.contract;
  const mid = (c.minDte + c.maxDte) / 2;
  const exps = [...new Map(calls.map((x) => [x.expiration, x.dte])).entries()].sort((a, b) => Math.abs(a[1] - mid) - Math.abs(b[1] - mid)).map(([e]) => e);
  let why = `no calls expiring in ${c.minDte}-${c.maxDte} days`;
  for (const expiration of exps) {
    const pick = options.selectContract(calls, { ...c, expiration, minDelta: VERTICAL.longDelta[0], maxDelta: VERTICAL.longDelta[1], targetDelta: VERTICAL.longDelta[2] }, now, live);
    if (!pick.ok) { why = `OPTIONS_NO_CONTRACT: ${expiration}: ${pick.error}`; continue; }
    const em = expectedMove(calls, puts, live, expiration);
    if (!em.ok) { why = `OPTIONS_NO_EXPECTED_MOVE: ${em.error}`; continue; }
    const plan = planVertical({ long: pick.contract, chain: calls, spot: live, em: em.em, c, now });
    if (plan.ok) return { ok: true, k: pick.contract, em, plan };
    why = `OPTIONS_REWARD_TOO_LOW: ${plan.error}`;
  }
  return { ok: false, reason: why };
}

const fmtExp = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const etTime = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' });
const perContract = (x) => `$${(x * CONFIG.multiplier).toFixed(0)}`;

async function evaluate(symbol, live, now) {
  const bars = await getDailyBars(symbol, now);
  const s = analyse(bars);
  if (s) coils.set(symbol, s); else coils.delete(symbol);
  if (!s) return tally.skip(symbol, bars.length < CONFIG.period + CONFIG.squeezeLookback + 1 ? 'Not enough daily history' : 'No volatility squeeze');
  if (!(live > s.rangeHigh)) return tally.skip(symbol, `In a squeeze, below the ${CONFIG.rangeDays}-day breakout level`);
  if (!(live > s.mean)) return tally.skip(symbol, 'Below the 20-day average');
  return propose(symbol, live, now, bars, s);
}

// The trade for a triggered breakout (s = analyse(bars)): contract(s), plan, candidate.
async function propose(symbol, live, now, bars, s) {
  const date = etDate.format(now);
  const entryMax = cents(live * (1 + CONFIG.entryBufferPct));
  const structuralStop = s.rangeHigh - CONFIG.stopAtr * s.atr;
  const cat = await catalysts(symbol, now);
  if (!cat.ok) return block(symbol, date, cat.reason);

  const c = CONFIG.contract;
  const window = { minDte: c.minDte, maxDte: c.maxDte, spot: live };
  const chain = await options.getChain(symbol, { ...window, type: 'call', strikeMin: live * CONFIG.strikeWindow[0], strikeMax: live * CONFIG.strikeWindow[1] }, now);
  if (!chain.ok) return block(symbol, date, `OPTIONS_CHAIN_UNAVAILABLE: ${chain.error}`);
  const puts = await options.getChain(symbol, { ...window, type: 'put', strikeMin: live * 0.97, strikeMax: live * 1.03 }, now);
  if (!puts.ok) return block(symbol, date, `OPTIONS_CHAIN_UNAVAILABLE: ${puts.error}`);
  const atm = atmContext(chain.contracts, puts.contracts, live);
  if (!atm) return block(symbol, date, 'OPTIONS_NO_EXPECTED_MOVE: no ATM call + put pair quoted in the window');
  const hist = await getHistory(symbol, '1d-long', now);
  const ivp = ivPercentile(atm.iv, hist.ok ? hist.bars : []);
  const spreadWhy = [...(ivp.ok && ivp.pct > CONFIG.ivpSpread ? [`IV percentile ${ivp.pct.toFixed(1)} > ${CONFIG.ivpSpread}`] : []), ...cat.list.map((x) => `${x} inside the hold`)];
  const vertical = spreadWhy.length > 0;

  const found = vertical ? verticalPlan(chain.contracts, puts.contracts, live, now) : singlePlan(chain.contracts, puts.contracts, live, structuralStop, now);
  if (!found.ok) return block(symbol, date, found.reason);
  const { k, em, plan } = found;
  const t1Raw = plan.t1;

  // Resistance under T1: the breakout's own base is exempt; higher tops snap T1 below them.
  const tgt = planTargets({ bars, entry: entryMax, stop: plan.invalidation, market: 'options', fmt: cents, checkNetR: false,
    breakout: { atr: s.atr }, targets: [{ level: 1, price: t1Raw, allocation: 1 }] });
  if (!tgt.ok) return block(symbol, date, tgt.reason);
  let { targetValue, optionR } = plan;
  const t1 = tgt.snapped ? tgt.targets[0].price : t1Raw;
  if (tgt.snapped) {
    targetValue = cents(vertical ? Math.min(plan.width, t1 - k.strike) : k.mid + deltaGamma(k.delta, k.gamma, t1 - live) - (k.ask - k.bid) / 2);
    optionR = (targetValue - (vertical ? plan.debit : k.ask)) / plan.riskPerShare;
    const minR = vertical ? VERTICAL.minR : SINGLE.minR;
    if (optionR < minR) return block(symbol, date, `RESISTANCE_BLOCKS_TARGET: ${tgt.text} The option then reaches only ${optionR.toFixed(2)}R (needs ${minR}R).`);
  }

  const common = { underlying: symbol, type: 'call', expiration: k.expiration, dte: k.dte, feed: chain.feed, multiplier: CONFIG.multiplier, refSpot: live, refAt: now,
    riskPerShare: plan.riskPerShare, valueAtStop: plan.stopValue, valueAtTarget: targetValue, exitRule: { stopValue: plan.stopValue, targetValue },
    expectedMove: { value: cents(em.em), pct: em.pct, atmStrike: em.strike, t1Share: (t1 - live) / em.em },
    ivPercentile: ivp.ok ? { pct: Math.round(ivp.pct), proxy: 'ATM IV vs 1y of 20-day realized vol', atmIv: atm.iv } : null, greeksSource: k.greeksSource };
  const label = vertical ? `${symbol} ${fmtExp(k.expiration)} ${k.strike}/${plan.short.strike} call spread` : `${symbol} ${fmtExp(k.expiration)} ${k.strike} call`;
  const optionsData = vertical
    ? { ...common, ...plan.od, structure: 'vertical', label, contract: k.symbol, shortContract: plan.short.symbol, strike: k.strike, shortStrike: plan.short.strike,
      bid: plan.netBid, ask: plan.debit, debit: plan.debit, width: plan.width, maxProfit: plan.maxProfit, delta: k.delta - plan.short.delta,
      quoteTime: Math.min(k.quoteTime, plan.short.quoteTime), spreadReason: spreadWhy.join('; ') }
    : { ...common, structure: 'single', label, contract: k.symbol, strike: k.strike, bid: k.bid, ask: k.ask, spread: cents(k.ask - k.bid), iv: k.iv, delta: k.delta,
      gamma: k.gamma, theta: k.theta, quoteTime: k.quoteTime, refMid: k.mid, debit: k.ask, legs: [{ side: 'buy', type: 'call', strike: k.strike, ratio: 1 }],
      stopLossPct: plan.lossPct, structuralLossPct: plan.structuralLossPct };
  const news = await sentiment.getSentiment(symbol, now);
  const emText = `Expected Move to ${fmtExp(k.expiration)}: ±${cents(em.em)} (${(em.pct * 100).toFixed(1)}%, ATM ${em.strike} straddle x 0.85); T1 ${t1} is ${(common.expectedMove.t1Share).toFixed(2)} x EM.`;
  const ivText = ivp.ok ? `IV percentile ${ivp.pct.toFixed(0)} (proxy: ATM IV ${(atm.iv * 100).toFixed(1)}% vs a year of realized vol).` : `IV percentile unavailable (${ivp.error}).`;
  const planText = vertical
    ? `Vertical debit spread because ${optionsData.spreadReason}: buy ${k.symbol} (delta ${k.delta.toFixed(2)}) at ${k.ask}, sell ${plan.short.symbol} (delta ${plan.short.delta.toFixed(2)}, near the EM edge) at ${plan.short.bid}. `
      + `Net debit ${plan.debit} (${perContract(plan.debit)}), max profit ${plan.maxProfit} of the ${plan.width} width. Stop: spread worth ${plan.stopValue} (-50%, ${symbol} near ${plan.invalidation}); `
      + `T1: worth ${targetValue} (80% of max profit${tgt.snapped ? ', trimmed under resistance' : ''}; ${symbol} ${t1} at expiry), ${optionR.toFixed(2)}R. It exits on the spread's value, not a date.`
    : `Contract ${k.symbol} (${label}, ${k.dte} DTE): ask ${k.ask} / bid ${k.bid}, delta ${k.delta.toFixed(2)}, gamma ${k.gamma.toFixed(4)}, IV ${(k.iv * 100).toFixed(1)}%`
      + `${k.greeksSource === 'model' ? ' (greeks modelled from the quote)' : ''}. Stop: the structural level ${cents(structuralStop)} would cost ${(plan.structuralLossPct * 100).toFixed(0)}% of the premium; `
      + `clamped to ${(plan.lossPct * 100).toFixed(0)}%: exit when the call is worth ${plan.stopValue} (${symbol} near ${plan.invalidation}), ${perContract(plan.riskPerShare)} at risk per contract. `
      + `T1: ${symbol} ${t1}, the call worth ~${targetValue} (Delta-Gamma), ${optionR.toFixed(2)}R.`;

  return {
    id: `${STRATEGY_ID}:BREAKOUT:${symbol}:${date}`,
    asset: symbol, market: 'options', strategyId: STRATEGY_ID, setupType: vertical ? 'Squeeze breakout call spread' : 'Squeeze breakout call', direction: 'long', timeframe: '1D',
    tradeType: CONFIG.tradeType, expectedDuration: CONFIG.expectedDuration, resistance: tgt.resistance,
    newsSentiment: news.ok ? { score: news.score, label: news.label, source: news.source } : null,
    entryZone: { min: cents(live), max: entryMax },
    invalidation: plan.invalidation,
    targets: [{ level: 1, price: t1, allocation: 1 }],
    catalyst: { type: 'volatility', headline: null, sentimentScore: 0 },
    thesis: `${symbol} coiled in a daily squeeze (${s.squeezeDays} of the last ${CONFIG.squeezeLookback} days) and is breaking out at ${cents(live)}, above its `
      + `${CONFIG.rangeDays}-day high ${cents(s.rangeHigh)} and 20-day average ${cents(s.mean)}. ${emText} ${ivText} ${planText} `
      + `Quotes: ${chain.feed} feed, ${etTime(optionsData.quoteTime)} ET. A gap through the stop can lose more; the whole debit is the worst case. `
      + `${tgt.text} ${cat.text} ${sentiment.describe(news)} Expected hold: ${CONFIG.expectedDuration}.`,
    confirmationCriteria: [
      `Squeeze on ${s.squeezeDays}/${CONFIG.squeezeLookback} recent days: 2 sd Bollinger width inside 1.5 ATR20 Keltner (ATR ${cents(s.atr)})`,
      `Live price above the ${CONFIG.rangeDays}-day high ${cents(s.rangeHigh)} and the 20-day average`,
      `T1 ${t1} inside the Expected Move ±${cents(em.em)} (${common.expectedMove.t1Share.toFixed(2)} x EM)`,
      vertical ? `Spread: ${k.strike}/${plan.short.strike}, debit ${plan.debit}, exits on the spread's value (stop ${plan.stopValue}, T1 ${targetValue})`
        : `${k.symbol}: spread ${(k.spreadPct * 100).toFixed(1)}% of mid (cap ${(options.maxSpreadFor(symbol) * 100).toFixed(1)}%), exits on the call's value (stop ${plan.stopValue}, T1 ${targetValue})`,
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
      const cand = await evaluate(symbol, live, now);
      if (cand) { out.push(cand); tally.setup(); }
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

module.exports = { generateCandidates, proximity, takeBlocks, takeScan: tally.take, reset, analyse, squeezeAt, propose, STRATEGY_ID, CONFIG };
