// Strategy 5: Options, CALL and PUT debit spreads (Phase 57).
// PROPOSER ONLY: reads real daily + 1h bars, today's session, the live (or last-close)
// price and the real Alpaca options chain; returns Canonical Candidates. Never sizes,
// stages or executes.
//   Universe   25 liquid optionables: SPY QQQ IWM NVDA AAPL MSFT META AMZN GOOGL TSLA AMD
//              NFLX COIN PLTR INTC + (Phase 58B, $15-$185: cheap spreads with real net
//              delta on a small account) MU UBER ORCL SOFI BAC JPM WMT XOM DIS PYPL
//   Signals    options-signals.js: TREND (call), BREAKDOWN (put), SQUEEZE (call / put),
//              RELATIVE strength / weakness vs SPY (call / put), on 1D and 1h
//   Structure  options-spread-builder.js: bull call / bear put debit spreads at 10-24
//              DTE (intraday / momentum signals) or 21-45 DTE (daily swings), short
//              strike at the 30- / 100-day high / low when it sits 0.5-2.5 ATR away;
//              singles only with ATM IV <= 20-day realized vol and a $10,000+ bankroll
//   Exits      the position's own value (exitRule): stop -45..-50% of the debit, T1
//              +65..+85% (nets >= 1.25 : 1), T2 +100..+130% (a stretch level)
// Direction: a put setup is 'short' the underlying (its stop sits ABOVE the price),
// so the order guard, the entry zone and the stop all read the right way round.
// After hours (the US session is closed: market-session.js, never "no live price"):
// the plan is built on the last close and the chain's last quotes; the pipeline runs
// it through the risk engine and shows it as a reviewable plan (after-hours-plans.js);
// it only stages on live quotes. In the session a symbol with no fresh price yet is
// skipped until it has one (Phase 59B), never planned as "market closed".
// Shields: earnings unknown = blocked (fail closed). One idea per symbol per day.
const { getDailyBars } = require('../connectors/daily-bars');
const { getHistory } = require('../connectors/history-bars');
const alpacaStocks = require('../connectors/alpaca-stock-socket');
const { getEarningsStatus } = require('../connectors/corporate-calendar');
const macro = require('../connectors/macro-events');
const options = require('../connectors/options-data');
const { ivPercentile, realizedVols } = require('../risk/expected-move');
const signals = require('./options-signals');
const builder = require('./options-spread-builder');
const spreadStats = require('../risk/spread-stats');
const sentiment = require('../connectors/news-sentiment');
const { createTally } = require('./scan-tally');
const session = require('../market/market-session');

const STRATEGY_ID = 'options-system';
const ETFS = new Set(['SPY', 'QQQ', 'IWM', 'DIA']);
const CONFIG = {
  tradeType: 'Options Swing', multiplier: 100, entryBufferPct: 0.002, hourTtlMs: 5 * 60 * 1000, maxTries: 2,
  symbols: [...require('../market/universe').OPTIONABLE_STOCKS], // the first 25 WebSocket slots (Phase 59B)
  strikes: { call: [0.95, 1.18], put: [0.82, 1.05], atm: [0.97, 1.03] },
  holdDays: { swing: 15, intraday: 5 },
  duration: { swing: '5-15 trading days (exits on the spread value, well before expiry)', intraday: '1-5 trading days (exits on the spread value)' },
};
const ARCH = { TREND: ['Trend pullback / reclaim', 'Trend'], BREAKDOWN: ['Trend rejection', 'Breakdown'], SQUEEZE: ['Squeeze breakout', 'Squeeze breakdown'],
  RELATIVE: ['Relative-strength leader', 'Relative-weakness laggard'] };

const cents = (x) => Math.round(x * 100) / 100;
const lookup = (src, key) => (src instanceof Map ? src.get(key) : src && src[key]);
const etDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
const fmtExp = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const usd = (x) => `$${Math.round(x * CONFIG.multiplier)}`;

const coils = new Map(); // symbol -> daily squeeze (proximity)
const hourly = new Map(); // symbol -> { at, bars }
let blocks = [];
const tally = createTally();

async function hourBars(symbol, now) {
  const hit = hourly.get(symbol);
  if (hit && now - hit.at < CONFIG.hourTtlMs) return hit.bars;
  const r = await getHistory(symbol, '1h');
  const bars = r.ok ? r.bars.filter((b) => (b.time + 3600) * 1000 <= now) : (hit ? hit.bars : []);
  if (r.ok) hourly.set(symbol, { at: now, bars });
  return bars;
}

// The session's change vs the prior close. After hours the price IS the last bar's close: compare one bar back.
const changeOf = (bars, px) => { const n = bars.length; const prev = n > 1 && Math.abs(px - bars[n - 1].close) < 1e-9 ? bars[n - 2].close : bars[n - 1].close; return px / prev - 1; };

function block(symbol, id, reason, cand = {}) {
  blocks.push({ id, reason, candidate: { asset: symbol, market: 'options', strategyId: STRATEGY_ID, setupType: 'Options spread', direction: 'long', timeframe: '1D', ...cand } });
  return tally.skip(symbol, `Rejected: ${reason.split(':')[0].replace(/_/g, ' ').toLowerCase()}`);
}

async function catalysts(symbol, horizon, now) {
  const list = macro.catalystsFor({ asset: symbol, strategyId: STRATEGY_ID, market: 'options' }, now).map((c) => `${c.type} ${c.date}`);
  if (ETFS.has(symbol)) return { ok: true, list, earnings: null, text: 'Index ETF: no earnings.' };
  const e = await getEarningsStatus(symbol, now);
  if (!e.ok) return { ok: false, reason: `EARNINGS_UNKNOWN: ${e.error}` };
  if (e.date && e.tradingDaysAway < CONFIG.holdDays[horizon]) list.unshift(`earnings ${e.date}`);
  return { ok: true, list, earnings: e.date || null, text: e.date ? `Next earnings ${e.date} (${e.tradingDaysAway} trading days away).` : 'No earnings in the next 60 days.' };
}

// Signal -> { candidate } or { reason }.
async function propose(symbol, px, sig, ctx, bars, env) {
  const { now, afterHours, bankroll } = env;
  const type = sig.direction;
  const w = builder.CONFIG.windows[sig.horizon];
  const id = `${STRATEGY_ID}:${sig.archetype}:${type.toUpperCase()}:${symbol}:${etDate.format(now)}`;
  const cat = await catalysts(symbol, sig.horizon, now);
  if (!cat.ok) return { id, reason: cat.reason };
  const window = { minDte: builder.CONFIG.windows.short.minDte, maxDte: w.maxDte, spot: px }; // 6 DTE up: the short-weekly fallback
  const [lo, hi] = CONFIG.strikes[type];
  const main = await options.getChain(symbol, { ...window, type, strikeMin: px * lo, strikeMax: px * hi }, now);
  if (!main.ok) return { id, reason: `OPTIONS_CHAIN_UNAVAILABLE: ${main.error}` };
  const other = await options.getChain(symbol, { ...window, type: type === 'call' ? 'put' : 'call', strikeMin: px * CONFIG.strikes.atm[0], strikeMax: px * CONFIG.strikes.atm[1] }, now);
  const calls = type === 'call' ? main.contracts : (other.ok ? other.contracts : []);
  const puts = type === 'put' ? main.contracts : (other.ok ? other.contracts : []);
  const hv = realizedVols(bars).slice(-1)[0] || null;
  const atm = main.contracts.filter((c) => c.iv > 0).sort((a, b) => Math.abs(a.strike - px) - Math.abs(b.strike - px) || Math.abs(a.dte - w.prefer) - Math.abs(b.dte - w.prefer))[0];
  const single = !!(atm && hv && atm.iv <= hv && bankroll >= builder.CONFIG.single.minBankroll);
  const ivText = atm && hv ? `${(atm.iv * 100).toFixed(0)}% ${atm.iv <= hv ? '<=' : '>'} 20-day HV ${(hv * 100).toFixed(0)}%` : 'vs HV unavailable';
  const b = builder.build({ chain: main.contracts, calls, puts, type, horizon: sig.horizon, spot: px, ctx, structuralStop: sig.stop, bankroll, single, now, afterHours, earnings: cat.earnings });
  if (!b.ok) return { id, reason: `OPTIONS_NO_STRUCTURE: ${b.error}` };
  const p = b.plan;
  const k = p.long;
  const vertical = p.structure === 'vertical';
  const name = vertical ? (type === 'call' ? 'Bull call spread' : 'Bear put spread') : (type === 'call' ? 'Long call' : 'Long put');
  const label = vertical ? `${symbol} ${fmtExp(k.expiration)} ${k.strike}/${p.short.strike} ${type} spread` : `${symbol} ${fmtExp(k.expiration)} ${k.strike} ${type}`;
  const hist = await getHistory(symbol, '1d-long', now);
  const ivp = ivPercentile(atm ? atm.iv : null, hist.ok ? hist.bars : []);
  const sign = type === 'call' ? 1 : -1;
  const levelText = b.level ? `${sign > 0 ? 'Resistance' : 'Support'} ${cents(b.level)} (${(Math.abs(b.level - px) / ctx.atr).toFixed(1)} ATR away)${b.anchored ? ': the short strike sits at it' : ''}.` : `No 30- / 100-day ${sign > 0 ? 'high above' : 'low below'} the price.`;
  const em = b.em ? `Expected Move to ${fmtExp(k.expiration)}: ±${cents(b.em.em)} (${(b.em.pct * 100).toFixed(1)}%).` : 'Expected Move unavailable at this expiration.';
  const od = {
    underlying: symbol, type, structure: p.structure, fill: p.od.fill, label, contract: k.symbol, ...(vertical ? { shortContract: p.short.symbol, shortStrike: p.short.strike, width: p.width, maxProfit: p.maxProfit } : {}),
    strike: k.strike, expiration: k.expiration, dte: k.dte, feed: main.feed, multiplier: CONFIG.multiplier, iv: k.iv, delta: vertical ? k.delta - p.short.delta : k.delta,
    bid: p.exitNow, ask: p.debit, debit: p.debit, netMid: p.netMid, spread: p.od.spread, combinedLegSpread: p.combined, refSpot: px, refMid: p.od.refMid, refAt: now, legs: p.legs,
    riskPerShare: p.riskPerShare, valueAtStop: p.stopValue, valueAtTarget: p.t1Value, exitRule: { stopValue: p.stopValue, targetValue: p.t1Value, ...(p.t2Value ? { t2Value: p.t2Value } : {}) },
    stopSharePct: Math.round(p.stopShare * 100), t1SharePct: Math.round(p.t1Share * 100), netRR: p.netRR, breakeven: p.breakeven, afterHours,
    quoteTime: Math.min(...[k, p.short].filter(Boolean).map((x) => x.quoteTime)), greeksSource: k.greeksSource, horizon: sig.horizon,
    expectedMove: b.em ? { value: cents(b.em.em), pct: b.em.pct, atmStrike: b.em.strike, t1Share: Math.abs(p.t1 - px) / b.em.em } : null, level: b.level ? cents(b.level) : null, levelAnchored: b.anchored,
    ivPercentile: ivp.ok ? { pct: Math.round(ivp.pct), proxy: 'ATM IV vs 1y of 20-day realized vol', atmIv: atm.iv, hv20: hv } : null,
    spreadReason: `${vertical ? (bankroll < builder.CONFIG.single.minBankroll ? `$${bankroll} bankroll (under $${builder.CONFIG.single.minBankroll})` : `ATM IV ${ivText}`) : `ATM IV ${ivText}`}: `
      + `${vertical ? 'defined-risk debit spread' : `single ${type}`}`,
  };
  // Net Black-Scholes Greeks, expiry breakeven, POP, max value / profit, IV vs HV (Phase 58).
  od.hv20 = hv;
  od.stats = spreadStats.stats(od, px, now, hv);
  od.theta = od.stats.thetaDay === null ? null : od.stats.thetaDay / CONFIG.multiplier; // per share, like a contract's theta
  od.netDelta = od.stats.netDelta;
  od.midHoldAt = p.midHoldAt;
  const st = od.stats;
  const statText = `Net delta ${st.netDelta.toFixed(2)} (${st.deltaUsd >= 0 ? '+' : '−'}$${Math.abs(st.deltaUsd).toFixed(0)} per $1), theta ${st.thetaDay >= 0 ? '+' : '−'}$${Math.abs(st.thetaDay).toFixed(2)}/day, `
    + `POP ${Math.round(st.pop * 100)}% (expiry breakeven ${st.breakeven}).`;
  const news = await sentiment.getSentiment(symbol, now);
  const legsText = vertical ? `buy ${k.symbol} (delta ${k.delta.toFixed(2)}), sell ${p.short.symbol} (delta ${p.short.delta.toFixed(2)}), ${p.width} wide` : `buy ${k.symbol} (delta ${k.delta.toFixed(2)})`;
  return { id, candidate: {
    id, asset: symbol, market: 'options', strategyId: STRATEGY_ID, setupType: `${name} · ${ARCH[sig.archetype][type === 'call' ? 0 : 1]}`, direction: type === 'call' ? 'long' : 'short',
    timeframe: sig.timeframe, tradeType: sig.horizon === 'intraday' ? 'Options Momentum' : CONFIG.tradeType, expectedDuration: CONFIG.duration[sig.horizon],
    newsSentiment: news.ok ? { score: news.score, label: news.label, source: news.source } : null,
    entryZone: { min: cents(px * (1 - CONFIG.entryBufferPct)), max: cents(px * (1 + CONFIG.entryBufferPct)) },
    invalidation: p.invalidation,
    targets: [{ level: 1, price: p.t1, allocation: 1 }, ...(p.t2 ? [{ level: 2, price: p.t2, allocation: 0, stretch: true }] : [])],
    catalyst: { type: 'technical', headline: sig.text, sentimentScore: 0 },
    thesis: `${sig.text} (${sig.timeframe}). ${name} for a ${sig.horizon === 'intraday' ? '1-5 day move' : 'multi-week swing'}: ${legsText}, ${k.dte} DTE. `
      + `One package limit near the net mid ${p.netMid}: debit ${p.debit} (${usd(p.debit)}${vertical ? `, ${Math.round((p.debit / p.width) * 100)}% of the width, max value ${usd(p.width)}` : ''}). `
      + `Stop: worth ${p.stopValue} (-${od.stopSharePct}%, ${symbol} near ${p.invalidation}); T1: worth ${p.t1Value} (+${od.t1SharePct}%, ${symbol} ${p.t1}), ${p.netRR.toFixed(2)} : 1 net`
      + `${p.t2Value ? `; T2 stretch: worth ${p.t2Value} (${symbol} ${p.t2})` : ''}; the ${symbol} levels are where the spread is worth that by mid-hold. ${statText} ${levelText} ${em} `
      + `${ivp.ok ? `IV percentile ${ivp.pct.toFixed(0)} (proxy). ` : ''}${afterHours ? 'MARKET CLOSED: priced on the last close and the chain\'s last quotes; re-priced live at the open. ' : ''}`
      + `${cat.text}${cat.list.length ? ` Inside the hold: ${cat.list.join(', ')}.` : ''} ${sentiment.describe(news)}`,
    confirmationCriteria: [sig.text, `${name}: ${label}, debit ${p.debit}${vertical ? ` of ${p.width} (30-53% band)` : ''}, slippage + fees ${p.costR.toFixed(2)}R`,
      `Exits on its value: stop ${p.stopValue} / T1 ${p.t1Value}${p.t2Value ? ` / T2 ${p.t2Value}` : ''}; T1 nets ${p.netRR.toFixed(2)} : 1 after $0.65 / leg / fill`, levelText],
    timestamp: new Date(now).toISOString(),
    optionsData: od,
  } };
}

async function evaluate(symbol, px, env, bench) {
  const bars = await getDailyBars(symbol, env.now);
  const sq = signals.dailySqueeze(bars);
  if (sq) coils.set(symbol, sq); else coils.delete(symbol);
  if (bars.length < 60) return tally.skip(symbol, 'Not enough daily history');
  const hb = await hourBars(symbol, env.now);
  const session1m = env.afterHours ? [] : lookup(alpacaStocks.getLatestBars(), symbol);
  const d = signals.detect({ bars, live: px, hourlyBars: hb, session1m, change: changeOf(bars, px), benchChange: symbol === 'SPY' ? NaN : bench, now: env.now });
  if (!d.ctx) return tally.skip(symbol, d.why);
  const r = signals.rank(d.signals);
  if (r.conflict) return tally.skip(symbol, 'Call and put signals conflict: no trade');
  if (!r.list.length) return tally.skip(symbol, 'No call or put archetype fired');
  let last = null;
  for (const sig of r.list.slice(0, CONFIG.maxTries)) {
    const out = await propose(symbol, px, sig, d.ctx, bars, env);
    if (out.candidate) return out.candidate;
    last = out;
  }
  const top = r.list[0];
  return block(symbol, last.id, last.reason, { setupType: `${top.direction === 'call' ? 'Call' : 'Put'} spread · ${ARCH[top.archetype][top.direction === 'call' ? 0 : 1]}`, direction: top.direction === 'call' ? 'long' : 'short', timeframe: top.timeframe });
}

// marks: live price, else the last session close (getMarkPrices); live: fresh prices only.
async function generateCandidates(marks, { live = marks, bankroll = null } = {}, now = Date.now()) {
  blocks = [];
  tally.start();
  const out = [];
  const spyPx = lookup(marks, 'SPY');
  const spyBars = spyPx > 0 ? await getDailyBars('SPY', now) : [];
  const bench = spyBars.length > 1 ? changeOf(spyBars, spyPx) : NaN;
  const bank = bankroll || (() => { try { return require('../execution/ledger-store').getSettings().bankroll; } catch { return 0; } })();
  const afterHours = !session.isEquityMarketOpen(now);
  for (const symbol of CONFIG.symbols) {
    tally.checked();
    const px = afterHours ? lookup(marks, symbol) : lookup(live, symbol);
    if (!(px > 0)) { tally.skip(symbol, afterHours ? 'No price (live or last close)' : 'Market open: no fresh price yet (next pass)'); continue; }
    try {
      const cand = await evaluate(symbol, px, { now, afterHours, bankroll: bank }, bench);
      if (cand) { out.push(cand); tally.setup(); }
    } catch (err) {
      console.error(`[options-system] ${symbol} failed: ${err.message}`);
    }
  }
  return out;
}

// "Heating up": daily squeezes still inside their range (cached analyses only).
function proximity(latestPricesMap) {
  const out = [];
  for (const [symbol, s] of coils) {
    const live = lookup(latestPricesMap, symbol);
    if (!(live > 0) || live > s.rangeHigh || live < s.rangeLow) continue;
    const up = s.rangeHigh - live <= live - s.rangeLow;
    out.push({ symbol, strategyId: STRATEGY_ID, trigger: up ? s.rangeHigh : s.rangeLow, distancePct: Math.abs((up ? s.rangeHigh : s.rangeLow) - live) / live, // unsigned: a put trigger sits below
      label: `Daily squeeze; ${up ? `call breakout above ${cents(s.rangeHigh)}` : `put breakdown below ${cents(s.rangeLow)}`}` });
  }
  return out;
}

function takeBlocks() { const b = blocks; blocks = []; return b; }
function reset() { coils.clear(); hourly.clear(); blocks = []; }

module.exports = { generateCandidates, proximity, takeBlocks, takeScan: tally.take, reset, propose, evaluate, changeOf, STRATEGY_ID, CONFIG,
  analyse: signals.dailySqueeze, squeezeAt: signals.squeezeAt };
