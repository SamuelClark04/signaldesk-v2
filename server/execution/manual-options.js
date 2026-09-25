// Options for the Manual Trade Ticket (Phase 60), on one of the 25 optionables:
//   chain     the live Alpaca chain 6-45 DTE (calls + puts near the money) for the
//             custom strike picker
//   autoFind  [⚡ Auto-Find Best Bull Call / Bear Put Spread]: System 5's own spread
//             builder (options-spread-builder.build, every gate incl. the exit-spread
//             cap) with a 1.5 ATR structural stop: the best spread + 2 alternatives
//   custom    the user's expiration / long / short strike (short null = a single
//             call / put) and optional stop / T1 values, priced the same way (package
//             net mid + 0.15 x the combined bid/ask) but without the strategy's
//             structure gates; the risk engine still gates it (manual-trade.js)
// Every result carries `spec` ({ type, expiration, long, short, stopValue, t1Value,
// t2Value }); opening re-reads the LIVE chain and re-prices it: client numbers are
// never trusted. candidate() turns a priced plan into a canonical candidate with the
// same optionsData as System 5 (chart lines ENTRY / SL / T1 / T2 / BE, marks, exits).
const options = require('../connectors/options-data');
const builder = require('../strategies/options-spread-builder');
const { getDailyBars } = require('../connectors/daily-bars');
const { getEarningsStatus } = require('../connectors/corporate-calendar');
const signals = require('../strategies/options-signals');
const spreadStats = require('../risk/spread-stats');
const { packageQuote } = require('../risk/cost-authority');
const { OPTIONABLE_STOCKS } = require('../market/universe');
const { exitSpreadCap } = require('../strategies/5-options-system');

const WINDOW = { minDte: 6, maxDte: 45 };
const ETFS = new Set(['SPY', 'QQQ', 'IWM']);
const STOP_ATR = 1.5;
const MULT = 100;
const cents = (x) => Math.round(x * 100) / 100;
const fmtExp = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { day: 'numeric', month: 'short', timeZone: 'UTC' });

function assertOptionable(symbol) {
  if (!OPTIONABLE_STOCKS.includes(symbol)) throw new Error(`OPTIONS_UNAVAILABLE: ${symbol} is not one of the 25 optionable stocks`);
}

// Daily context (ATR, 30 / 100-day highs and lows) + 20-day realized vol.
async function context(symbol, spot, now) {
  const bars = await getDailyBars(symbol, now);
  const d = signals.daily(bars, spot);
  if (!d.ctx) throw new Error(`NO_HISTORY: ${d.why}`);
  const closes = bars.map((b) => b.close);
  const rets = closes.slice(-21).map((c, i, a) => (i ? Math.log(c / a[i - 1]) : null)).filter((x) => x !== null);
  const m = rets.reduce((s, x) => s + x, 0) / rets.length;
  const hv = Math.sqrt((rets.reduce((s, x) => s + (x - m) ** 2, 0) / (rets.length - 1)) * 252);
  return { ctx: d.ctx, hv: Number.isFinite(hv) ? hv : null };
}

const fetchSide = (symbol, type, spot, now, extra = {}) => options.getChain(symbol, { ...WINDOW, type, spot, strikeMin: spot * 0.85, strikeMax: spot * 1.15, ...extra }, now);

// Live chain for the strike picker: { ok, spot, feed, expirations: [{ expiration, dte, calls, puts }] }.
async function chain(symbol, spot, now = Date.now()) {
  assertOptionable(symbol);
  const [c, p] = await Promise.all([fetchSide(symbol, 'call', spot, now), fetchSide(symbol, 'put', spot, now)]);
  if (!c.ok && !p.ok) throw new Error(`OPTIONS_CHAIN_UNAVAILABLE: ${c.error}`);
  const row = (x) => ({ symbol: x.symbol, strike: x.strike, bid: x.bid, ask: x.ask, delta: Number.isFinite(x.delta) ? cents(x.delta * 100) / 100 : null, iv: x.iv });
  const all = [...(c.ok ? c.contracts : []), ...(p.ok ? p.contracts : [])];
  const exps = [...new Map(all.map((x) => [x.expiration, x.dte])).entries()].sort((a, b) => a[1] - b[1]);
  return { ok: true, spot, feed: c.feed || p.feed, expirations: exps.map(([expiration, dte]) => ({ expiration, dte,
    calls: all.filter((x) => x.expiration === expiration && x.type === 'call' && x.bid > 0).sort((a, b) => a.strike - b.strike).map(row),
    puts: all.filter((x) => x.expiration === expiration && x.type === 'put' && x.bid > 0).sort((a, b) => a.strike - b.strike).map(row) })) };
}

// What the ticket shows for one priced plan.
function summarize(symbol, p, spot, cap, now) {
  const od = { ...p.od, debit: p.debit, width: p.width, shortStrike: p.short ? p.short.strike : undefined, strike: p.long.strike, multiplier: MULT, type: p.type };
  const st = spreadStats.stats(od, spot, now);
  const label = p.short ? `${symbol} ${fmtExp(p.long.expiration)} ${p.long.strike}/${p.short.strike} ${p.type} spread` : `${symbol} ${fmtExp(p.long.expiration)} ${p.long.strike} ${p.type}`;
  return {
    label, structure: p.short ? 'vertical' : 'single', type: p.type, expiration: p.long.expiration, dte: p.long.dte, longStrike: p.long.strike, shortStrike: p.short ? p.short.strike : null,
    debit: p.debit, netMid: p.netMid, exitSpread: cents(p.exitSpread), overCap: !!(cap && p.exitSpread > cap), cap, netDelta: st.netDelta, thetaDay: st.thetaDay,
    maxProfit: st.maxProfit, breakeven: st.breakeven, pop: st.pop, stopValue: p.stopValue, t1Value: p.t1Value, t2Value: p.t2Value, invalidation: p.invalidation,
    t1: p.t1, t2: p.t2, midHoldAt: p.midHoldAt, netRR: p.netRR, width: p.width,
    spec: { type: p.type, expiration: p.long.expiration, long: p.long.symbol, short: p.short ? p.short.symbol : null, stopValue: p.stopValue, t1Value: p.t1Value, t2Value: p.t2Value },
  };
}

// [⚡ Auto-Find]: the builder's best spread for `type` + 2 alternatives.
async function autoFind(symbol, type, spot, { bankroll, settings, afterHours = false }, now = Date.now()) {
  assertOptionable(symbol);
  const { ctx } = await context(symbol, spot, now);
  const [lo, hi] = type === 'call' ? [0.95, 1.18] : [0.82, 1.05];
  const [main, other] = await Promise.all([fetchSide(symbol, type, spot, now, { strikeMin: spot * lo, strikeMax: spot * hi }),
    fetchSide(symbol, type === 'call' ? 'put' : 'call', spot, now, { strikeMin: spot * 0.97, strikeMax: spot * 1.03 })]);
  if (!main.ok) throw new Error(`OPTIONS_CHAIN_UNAVAILABLE: ${main.error}`);
  const e = ETFS.has(symbol) ? { ok: true, date: null } : await getEarningsStatus(symbol, now);
  const cap = exitSpreadCap(settings);
  const run = (maxExitSpread) => builder.build({ chain: main.contracts, calls: type === 'call' ? main.contracts : other.contracts || [], puts: type === 'put' ? main.contracts : other.contracts || [],
    type, horizon: 'swing', spot, ctx, structuralStop: spot - (type === 'call' ? 1 : -1) * STOP_ATR * ctx.atr, bankroll, single: false, now, afterHours, earnings: e.ok ? e.date : null, maxExitSpread, alternatives: true });
  let b = run(cap);
  // Only the cap stood in the way: show them anyway, flagged (System 5 would skip them; a manual ticket may take one).
  const capOnly = !b.ok && b.wide;
  if (capOnly) b = run(null);
  if (!b.ok) throw new Error(`OPTIONS_NO_STRUCTURE: ${b.error}`);
  return { ok: true, spot, capNote: capOnly ? `Every valid ${type === 'call' ? 'bull call' : 'bear put'} spread is over your $${cap.toFixed(2)} exit-spread cap right now: shown flagged.` : null,
    plans: [b.plan, ...(b.alternatives || [])].map((p) => summarize(symbol, p, spot, cap, now)) };
}

// A lenient price-out of the user's own strikes (stop -50%, T1 +80%, T2 +115% of the debit by default).
function customPlan({ long, short, type, spot, atr, stopValue, t1Value, t2Value }, now) {
  const sign = type === 'call' ? 1 : -1;
  const legs = [{ side: 'buy', type, strike: long.strike, ratio: 1, contract: long.symbol, iv: long.iv, bid: long.bid, ask: long.ask, delta: long.delta },
    ...(short ? [{ side: 'sell', type, strike: short.strike, ratio: 1, contract: short.symbol, iv: short.iv, bid: short.bid, ask: short.ask, delta: short.delta }] : [])];
  if (legs.some((l) => !(l.bid > 0) || !(l.ask >= l.bid))) throw new Error('OPTIONS_NO_QUOTE: a leg has no two-sided quote');
  if (short && sign * (short.strike - long.strike) <= 0) throw new Error(`OPTIONS_BAD_STRIKES: a ${type === 'call' ? 'bull call' : 'bear put'} spread sells the ${type === 'call' ? 'higher' : 'lower'} strike`);
  const q = short ? packageQuote(legs) : { mid: long.mid, combined: long.ask - long.bid, debit: long.ask, exit: long.bid, slippage: long.ask - long.bid };
  const debit = Math.ceil(q.debit * 100 - 1e-9) / 100;
  const width = short ? Math.abs(short.strike - long.strike) : null;
  if (short && debit >= width) throw new Error(`OPTIONS_BAD_PRICE: debit ${debit} is not under the ${width} width`);
  const cap = (v) => (width ? Math.min(v, cents(width * 0.95)) : v);
  const stop = cents(stopValue > 0 && stopValue < debit ? stopValue : debit * 0.5);
  const t1v = cap(cents(t1Value > debit ? t1Value : debit * 1.8));
  const t2v = cap(cents(t2Value > t1v ? t2Value : debit * 2.15));
  const od = { expiration: long.expiration, iv: long.iv, spread: cents(q.slippage), refSpot: spot, refMid: q.mid, refAt: now, legs, fill: short ? 'package' : 'single' };
  const hold = spreadStats.midHoldAt(od, now);
  const inv = builder.levelFor(od, stop, spot, now) || spot - sign * STOP_ATR * atr;
  const t1 = builder.levelFor(od, t1v, spot, hold) || long.strike + sign * t1v;
  const t2 = t2v > t1v ? (builder.levelFor(od, t2v, spot, hold) || long.strike + sign * t2v) : null;
  const fees = (1.3 * legs.length) / MULT;
  return { ok: true, type, long, short, legs, od, width, debit, netMid: cents(q.mid), exitNow: cents(q.exit), combined: cents(q.combined), slippage: cents(q.slippage),
    exitSpread: builder.exitSpreadOf(q), stopValue: stop, riskPerShare: cents(debit - stop), t1Value: t1v, t2Value: t2 ? t2v : null, invalidation: cents(inv), t1: cents(t1), t2: t2 ? cents(t2) : null,
    breakeven: cents(long.strike + sign * debit), midHoldAt: hold, netRR: ((t1v - debit) - fees) / ((debit - stop) + fees) };
}

// The spec's contracts from the LIVE chain -> a priced plan (custom rules).
async function price(symbol, spec, spot, now = Date.now()) {
  assertOptionable(symbol);
  const type = spec.type === 'put' ? 'put' : 'call';
  const r = await fetchSide(symbol, type, spot, now, { strikeMin: spot * 0.7, strikeMax: spot * 1.3 });
  if (!r.ok) throw new Error(`OPTIONS_CHAIN_UNAVAILABLE: ${r.error}`);
  const find = (sym) => r.contracts.find((c) => c.symbol === sym);
  const long = find(spec.long);
  const short = spec.short ? find(spec.short) : null;
  if (!long || (spec.short && !short)) throw new Error('OPTIONS_CONTRACT_GONE: a chosen contract is not in the live chain (6-45 DTE)');
  const { ctx, hv } = await context(symbol, spot, now);
  return { plan: customPlan({ long, short, type, spot, atr: ctx.atr, stopValue: spec.stopValue, t1Value: spec.t1Value, t2Value: spec.t2Value }, now), feed: r.feed, hv };
}

// A priced plan -> a canonical options candidate (same optionsData shape as System 5).
function candidate(symbol, spot, { plan: p, feed, hv }, now = Date.now()) {
  const vertical = !!p.short;
  const sign = p.type === 'call' ? 1 : -1;
  const name = vertical ? (p.type === 'call' ? 'Bull call spread' : 'Bear put spread') : (p.type === 'call' ? 'Long call' : 'Long put');
  const label = vertical ? `${symbol} ${fmtExp(p.long.expiration)} ${p.long.strike}/${p.short.strike} ${p.type} spread` : `${symbol} ${fmtExp(p.long.expiration)} ${p.long.strike} ${p.type}`;
  const od = {
    underlying: symbol, type: p.type, structure: vertical ? 'vertical' : 'single', fill: p.od.fill, label, contract: p.long.symbol,
    ...(vertical ? { shortContract: p.short.symbol, shortStrike: p.short.strike, width: p.width, maxProfit: cents(p.width - p.debit) } : {}),
    strike: p.long.strike, expiration: p.long.expiration, dte: p.long.dte, feed, multiplier: MULT, iv: p.long.iv, delta: p.long.delta - (vertical ? p.short.delta : 0),
    bid: p.exitNow, ask: p.debit, debit: p.debit, netMid: p.netMid, spread: p.od.spread, combinedLegSpread: p.combined, exitSpread: cents(p.exitSpread), refSpot: spot, refMid: p.od.refMid, refAt: now,
    legs: p.legs, riskPerShare: p.riskPerShare, valueAtStop: p.stopValue, valueAtTarget: p.t1Value,
    exitRule: { stopValue: p.stopValue, targetValue: p.t1Value, ...(p.t2Value ? { t2Value: p.t2Value } : {}) }, netRR: p.netRR, breakeven: p.breakeven, midHoldAt: p.midHoldAt,
    quoteTime: Math.min(...[p.long, p.short].filter(Boolean).map((x) => x.quoteTime || now)), hv20: hv, manual: true,
  };
  od.stats = spreadStats.stats(od, spot, now, hv);
  od.netDelta = od.stats.netDelta;
  od.theta = od.stats.thetaDay === null ? null : od.stats.thetaDay / MULT;
  return {
    id: `manual:OPTIONS:${symbol}:${now}`, asset: symbol, market: 'options', strategyId: 'manual', setupType: `Manual · ${name}`, direction: sign > 0 ? 'long' : 'short',
    timeframe: 'manual', tradeType: 'Manual Options', expectedDuration: 'Your call (exits on the spread value)', manual: true, forcePaper: true,
    entryZone: { min: cents(spot * 0.998), max: cents(spot * 1.002) }, invalidation: p.invalidation,
    targets: [{ level: 1, price: p.t1, allocation: 1 }, ...(p.t2 ? [{ level: 2, price: p.t2, allocation: 0, stretch: true }] : [])],
    catalyst: { type: 'manual', headline: 'Manual trade ticket', sentimentScore: 0 },
    thesis: `Manual ${name.toLowerCase()} from the trade ticket: ${label}, debit ${p.debit} (net mid ${p.netMid}), exit spread $${cents(p.exitSpread)} per contract. `
      + `Stop: worth ${p.stopValue} (${symbol} near ${p.invalidation}); T1: worth ${p.t1Value} (${symbol} ${p.t1} by mid-hold)${p.t2Value ? `; T2: worth ${p.t2Value}` : ''}. Expiry breakeven ${p.breakeven}.`,
    confirmationCriteria: [`Manual ${name}: ${label}`, `Exits on its value: stop ${p.stopValue} / T1 ${p.t1Value}${p.t2Value ? ` / T2 ${p.t2Value}` : ''}`],
    timestamp: new Date(now).toISOString(), optionsData: od,
  };
}

module.exports = { chain, autoFind, price, candidate, customPlan, summarize, WINDOW };
