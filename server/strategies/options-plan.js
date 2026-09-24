// System 5 trade plans (read-only helpers for 5-options-system.js): turn a real
// contract (or two) plus the underlying's structure into option stop / target
// values and the underlying levels they correspond to. Pure: no I/O.
//
// Single call (Delta-Gamma, dV = Delta x dS + 0.5 x Gamma x dS^2, from the
// contract's real mid; a sale fills at the bid side, half the spread under it):
//   stop    the option's value if the underlying falls to its STRUCTURAL
//           invalidation, as a loss on the premium paid (the ask), clamped to
//           30%-38%: a stop that would lose more is tightened to 38% (the
//           underlying stop moves up to match), one that would lose less than
//           30% is given room to 30%
//   T1      the underlying T1 sits INSIDE the Expected Move, at 0.75-0.85 x EM:
//           the nearest point in that band where the call's reward reaches
//           2.0R (so 2.0-2.5R when the band allows it); none = no trade
// Vertical debit spread (IV percentile > 80, or a catalyst inside the hold):
//   long ~0.55 delta call + short ~0.30 delta call nearest the Expected Move
//   boundary (spot + EM), same expiration.
//   net debit = long ask - short bid;  max profit = width - debit
//   stop = the spread worth 50% of the debit;  T1 = debit + 80% of max profit
// Narrow spread (bankroll under $10,000): the same exits on a $1-$2.50 wide
//   spread costing $0.40-$1.10 (planNarrow), so one spread risks $20-$55.
//   underlying levels: the stop where the spread's model value (both legs at
//   their own IV, anchored to the real net mid) falls to 50% today; T1 where the
//   spread is worth the T1 value AT EXPIRY (long strike + T1 value), inside the
//   short strike. Before expiry the exit follows the spread's own value
//   (exitRule): a debit spread only nears its max value as time passes.
const { deltaGamma, moveFor } = require('../risk/option-greeks');
const { exitValue } = require('../risk/option-pricing');
const { liquidity } = require('../connectors/options-data');

const SINGLE = { stopMin: 0.30, stopMax: 0.38, emLo: 0.75, emHi: 0.85, minR: 2.0, maxR: 2.5 };
const VERTICAL = { longDelta: [0.45, 0.65, 0.55], shortDelta: [0.20, 0.40], stopShare: 0.5, targetShare: 0.8, minR: 1.5 };
const NARROW = { maxBankroll: 10000, widths: [1, 2, 2.5], maxSteps: 2, debit: [0.40, 1.10], longDelta: [0.35, 0.65], fallbackWidth: 5, maxFrictionR: 0.34 };

const cents = (x) => Math.round(x * 100) / 100;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// { ok, lossPct, structuralLossPct, stopValue, riskPerShare, invalidation, t1, targetValue, emShare, optionR } or { ok:false, error }.
function planSingle({ k, spot, structuralStop, em }) {
  if (!(k.gamma >= 0) || !(k.delta > 0)) return { ok: false, error: 'contract has no usable delta / gamma' };
  const half = (k.ask - k.bid) / 2;
  const valueAt = (dS) => k.mid + deltaGamma(k.delta, k.gamma, dS) - half; // bid side
  const structuralLossPct = (k.ask - valueAt(structuralStop - spot)) / k.ask;
  const lossPct = clamp(structuralLossPct, SINGLE.stopMin, SINGLE.stopMax);
  const stopValue = k.ask * (1 - lossPct);
  const dStop = moveFor(stopValue - k.mid + half, k.delta, k.gamma);
  if (!(dStop < 0)) return { ok: false, error: 'no underlying stop matches the option stop' };
  const riskPerShare = k.ask - stopValue;
  let best = null;
  for (let share = SINGLE.emLo; share <= SINGLE.emHi + 1e-9; share += 0.01) {
    const dS = share * em;
    const value = valueAt(dS);
    best = { share, dS, value, r: (value - k.ask) / riskPerShare };
    if (best.r >= SINGLE.minR) break;
  }
  if (best.r < SINGLE.minR) {
    return { ok: false, error: `${k.symbol} reaches only ${best.r.toFixed(2)}R at ${SINGLE.emHi} x the Expected Move (needs ${SINGLE.minR}R inside the EM)` };
  }
  return { ok: true, structure: 'single', lossPct, structuralLossPct, stopValue: cents(stopValue), riskPerShare: cents(riskPerShare),
    invalidation: Math.floor((spot + dStop) * 100) / 100, t1: cents(spot + best.dS), targetValue: cents(best.value), emShare: best.share, optionR: best.r };
}

// Underlying price where the position's model sale value equals `value` today
// (bisection; the value of a long call or call debit spread rises with S), or null.
function levelFor(od, value, spot, now) {
  let lo = spot * 0.5;
  let hi = spot * 1.6;
  if (exitValue(od, lo, now) > value || exitValue(od, hi, now) < value) return null;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (exitValue(od, mid, now) < value) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// Short leg: same expiration, delta 0.20-0.40, tradeable, strike nearest spot + EM.
function pickShort(chain, long, spot, em, c, now) {
  const [lo, hi] = VERTICAL.shortDelta;
  const list = chain.filter((x) => x.type === 'call' && x.expiration === long.expiration && x.strike > long.strike
    && Number.isFinite(x.delta) && x.delta >= lo && x.delta <= hi && liquidity(x, chain, spot, c, now) === null);
  if (!list.length) return null;
  const edge = spot + em;
  return list.reduce((best, x) => (Math.abs(x.strike - edge) < Math.abs(best.strike - edge) ? x : best), list[0]);
}

// The spread's numbers from two real legs: { ok, long, short, debit, netBid, width,
// maxProfit, stopValue, targetValue, riskPerShare, optionR, od, invalidation, t1 } or { ok:false, error }.
function spreadPlan(long, short, spot, now) {
  const debit = cents(long.ask - short.bid);
  const netBid = Math.max(0, long.bid - short.ask);
  const width = short.strike - long.strike;
  const maxProfit = cents(width - debit);
  if (!(debit > 0) || !(maxProfit > 0)) return { ok: false, error: `spread ${long.strike}/${short.strike} costs ${debit}, no profit left in a ${width} width` };
  const stopValue = cents(debit * (1 - VERTICAL.stopShare));
  const targetValue = cents(debit + VERTICAL.targetShare * maxProfit);
  const riskPerShare = cents(debit - stopValue);
  const optionR = (targetValue - debit) / riskPerShare;
  if (optionR < VERTICAL.minR) return { ok: false, error: `spread reward ${optionR.toFixed(2)}R under ${VERTICAL.minR}R (debit ${debit} of a ${width} width)` };
  const od = { expiration: long.expiration, iv: long.iv, spread: cents(debit - netBid), refSpot: spot, refMid: long.mid - short.mid, refAt: now,
    legs: [
      { side: 'buy', type: 'call', strike: long.strike, ratio: 1, contract: long.symbol, iv: long.iv, bid: long.bid, ask: long.ask, delta: long.delta },
      { side: 'sell', type: 'call', strike: short.strike, ratio: 1, contract: short.symbol, iv: short.iv, bid: short.bid, ask: short.ask, delta: short.delta },
    ] };
  const stopLevel = levelFor(od, stopValue, spot, now);
  if (!(stopLevel < spot)) return { ok: false, error: 'the spread is already worth less than its stop value' };
  return { ok: true, structure: 'vertical', long, short, debit, netBid: cents(netBid), width, maxProfit, stopValue, targetValue, riskPerShare, optionR, od,
    invalidation: Math.floor(stopLevel * 100) / 100, t1: cents(long.strike + targetValue) };
}

function planVertical({ long, chain, spot, em, c, now }) {
  const short = pickShort(chain, long, spot, em, c, now);
  if (!short) return { ok: false, error: `no tradeable ${VERTICAL.shortDelta.join('-')} delta call above ${long.strike} for the short leg (${long.expiration})` };
  return spreadPlan(long, short, spot, now);
}

// Small accounts (bankroll under NARROW.maxBankroll): a NARROW call debit spread
// at one expiration: long call at 0.35-0.65 delta, short call 1 or 2 strikes
// above it, $1 / $2 / $2.50 wide, net debit $0.40-$1.10 ($40-$110 per spread,
// so the 50% stop risks $20-$55). Only when a chain lists no strikes that close
// (NVDA / AAPL list $5 strikes at 30-45 DTE) the narrowest listed width up to $5
// is used, if one spread fits the risk engine's 1-contract small-account cap
// (risk <= 5.5%, debit <= 12% of the bankroll). Every candidate must pass the
// cost gate on its own (net bid/ask + fees <= 0.34R): narrow spreads are cheap
// but their bid/ask is large next to their risk. Best reward wins, then the
// long delta nearest 0.55. T1 must be above the current price.
function planNarrow({ chain, expiration, spot, c, now, bankroll }) {
  const calls = chain.filter((x) => x.type === 'call' && x.expiration === expiration);
  const strikes = [...new Set(calls.map((x) => x.strike))].sort((a, b) => a - b);
  const byStrike = new Map(calls.map((x) => [x.strike, x]));
  const ok = (x) => x && liquidity(x, chain, spot, c, now) === null;
  const friction = (p) => (p.debit - p.netBid + 0.004) / p.riskPerShare; // 0.004 = $0.40 fees per spread, per share
  const capDebit = (bankroll * 0.12) / 100;
  const capRisk = (bankroll * 0.055) / 100;
  const found = { preferred: [], fallback: [] };
  let why = `no $1 / $2 / $2.50 (or listed up to $${NARROW.fallbackWidth}) pair with both legs tradeable`;
  for (const long of calls) {
    if (!(long.delta >= NARROW.longDelta[0] && long.delta <= NARROW.longDelta[1]) || !ok(long)) continue;
    const i = strikes.indexOf(long.strike);
    for (let step = 1; step <= NARROW.maxSteps; step += 1) {
      const short = byStrike.get(strikes[i + step]);
      const width = short ? cents(short.strike - long.strike) : null;
      const preferred = NARROW.widths.includes(width);
      if (!short || !(preferred || (step === 1 && width <= NARROW.fallbackWidth)) || !ok(short)) continue;
      const debit = cents(long.ask - short.bid);
      if (preferred ? debit < NARROW.debit[0] || debit > NARROW.debit[1] : debit > capDebit || debit / 2 > capRisk) {
        why = `${long.strike}/${short.strike} costs ${debit} (${preferred ? `outside $${NARROW.debit[0]}-${NARROW.debit[1]}` : 'over the 1-contract cap'})`;
        continue;
      }
      const plan = spreadPlan(long, short, spot, now);
      if (!plan.ok) { why = plan.error; continue; }
      if (!(plan.t1 > spot)) { why = `${long.strike}/${short.strike}: T1 ${plan.t1} is not above the price`; continue; }
      if (friction(plan) > NARROW.maxFrictionR) { why = `${long.strike}/${short.strike}: bid/ask ${cents(plan.debit - plan.netBid)} is ${friction(plan).toFixed(2)}R of its ${plan.riskPerShare} risk (cost gate ${NARROW.maxFrictionR}R)`; continue; }
      found[preferred ? 'preferred' : 'fallback'].push(plan);
    }
  }
  const plans = found.preferred.length ? found.preferred : found.fallback;
  if (!plans.length) return { ok: false, error: `small account, ${expiration}: ${why}` };
  plans.sort((a, b) => b.optionR - a.optionR || Math.abs(a.long.delta - 0.55) - Math.abs(b.long.delta - 0.55));
  return { ...plans[0], narrow: true, fallbackWidth: !found.preferred.length, candidates: plans.length };
}

module.exports = { planSingle, planVertical, planNarrow, levelFor, SINGLE, VERTICAL, NARROW };
