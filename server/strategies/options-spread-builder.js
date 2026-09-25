// System 5 spread builder (Phase 57): a signal's direction + horizon -> the best
// real contract structure, or why none fits. Pure: chains in, plan out.
//   Expirations 10-45 DTE: 'intraday' / 2-5 day signals prefer 10-24 DTE weeklies
//               (where AAPL, NVDA, AMD, TSLA... list $1 / $2 / $2.50 strikes; the
//               30-45 DTE monthlies often list only $5), 'swing' prefers 21-45 DTE.
//   Bull call / bear put DEBIT SPREADS: buy the ~0.52-0.60 |delta| leg, sell a
//               ~0.28-0.38 |delta| leg further out (higher call / lower put).
//               Short strike AT the level (Phase 57): when the 30- / 100-day high
//               (calls) or low (puts) sits 0.5-2.5 daily ATR away, the short strike
//               goes at or just inside it: the spread earns its max right up to the
//               resistance instead of being vetoed by it. Closer than 0.5 ATR, the
//               breakeven (long strike +/- debit) must still be short of the level.
//               Small accounts (under $10,000) also try the next 1-3 strikes (the
//               $1 / $2.50 weekly widths) so one spread fits the 1-contract cap.
//   Singles:    one ~0.55 |delta| call / put when ATM IV <= 20-day realized vol and
//               the bankroll is >= $10,000 (single.minBankroll).
//   Pricing:    a spread is ONE net-limit package: debit = net mid + 0.15 x the
//               combined leg bid/ask (cost-authority packageQuote); a leg is refused
//               only with a zero bid or a bid/ask over 18% of its mid.
//   Geometry:   net debit 30-53% of the width (max value 1.9-3.3x the debit).
//   Exits (on the position's own value, exitRule): stop at -45% to -50% of the debit
//               (the loss at the signal's structural invalidation, clamped), T1 +65%
//               to +85% (the smallest that nets >= 1.30 : 1 after $0.65 / leg / fill
//               and slippage; the risk engine needs 1.25 : 1), T2 +100% to +130%
//               (<= 95% of the width). Underlying levels (Phase 58): where the model
//               value (each leg at its IV, anchored to the real quote) reaches them at
//               MID-HOLD (max(1, round(0.65 x DTE)) days left), never the expiry intrinsic
//               price: a T1 only reachable at expiry is no swing target (rejected).
//   Net delta (Phase 58): |long delta - short delta| >= 0.20 (ideal 0.22-0.42): a
//               0.55-0.68 long and a 0.22-0.35 short, so the spread moves with the stock.
//               Swings that find none at 21-45 DTE try the 10-18 DTE weeklies, where
//               narrow widths separate their deltas more.
//   Phase 58B:  floor 0.16 for stocks at $200+ (a $2.50-$5 width is < 2.5% of spot),
//               0.20 under $200; every signal finally tries the 6-12 DTE weeklies
//               (steeper gamma: about twice the net delta for the same debit), unless
//               earnings falls on or before that expiration.
//   Legs (Phase 58): bid/ask <= 12% of mid, and <= $0.35 when the debit is under $2.50.
//   Exit spread (Phase 60): the projected cost of closing, (net mid - exit fill) x 100
//               per contract (a package: 0.15 x the combined leg bid/ask x 100; a single:
//               mid - bid), is capped at a.maxExitSpread dollars (Settings, default $8;
//               null / 0 = off). A structure over it is WIDE_EXIT_SPREAD: no ticker is
//               dropped, it qualifies again when its chain tightens or the cap is raised.
const { packageQuote, OPTIONS_ROUND_TRIP_PER_CONTRACT } = require('../risk/cost-authority');
const { exitValue } = require('../risk/option-pricing');
const { expectedMove } = require('../risk/expected-move');
const { MIN_T1_NET_RR } = require('../risk/reality-gate');
const { midHoldAt } = require('../risk/spread-stats');

const CONFIG = {
  windows: { intraday: { minDte: 10, maxDte: 24, prefer: 14 }, swing: { minDte: 21, maxDte: 45, prefer: 30 }, weekly: { minDte: 10, maxDte: 18, prefer: 14 }, short: { minDte: 6, maxDte: 12, prefer: 9 } },
  longDelta: [0.55, 0.68, 0.60], shortDelta: [0.22, 0.35, 0.28], levelDelta: [0.12, 0.48], netDelta: { min: 0.20, minPricey: 0.16, priceyAt: 200, ideal: [0.22, 0.42] },
  debitShare: [0.30, 0.53], idealShare: 0.42, stopShare: [0.45, 0.50], t1Share: [0.65, 0.85], t2Share: [1.00, 1.30, 1.15], t1MaxWidth: 0.90, t2MaxWidth: 0.95,
  netRR: 1.30, maxCostR: 0.34, leg: { maxSpreadPct: 0.12, maxAbsSpread: 0.35, absBelowDebit: 2.5, maxAgeMs: 20 * 60 * 1000, afterHoursAgeMs: 20 * 3600 * 1000 },
  level: { minAtr: 0.5, maxAtr: 2.5, minEm: 0.8 }, maxExpirations: 4, narrowSteps: 3, single: { minBankroll: 10000 }, smallCap: { debitPct: 0.12, riskPct: 0.055 },
};
const MULT = 100;
const cents = (x) => Math.round(x * 100) / 100;
const up = (x) => Math.ceil(x * 100 - 1e-9) / 100;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Leg check: null when tradeable, else why not.
function legWhy(x, now, afterHours) {
  if (!(x.bid > 0) || !(x.ask > x.bid)) return 'zero bid / no two-sided quote';
  if (!(x.spreadPct <= CONFIG.leg.maxSpreadPct)) return `bid/ask ${(x.spreadPct * 100).toFixed(0)}% of mid (max ${CONFIG.leg.maxSpreadPct * 100}%)`;
  if (!x.quoteTime || now - x.quoteTime > (afterHours ? CONFIG.leg.afterHoursAgeMs : CONFIG.leg.maxAgeMs)) return 'stale quote';
  if (!Number.isFinite(x.delta)) return 'no delta';
  return null;
}

// The 30- / 100-day high (calls) or low (puts) beyond the price, or null.
function levelTarget(ctx, spot, sign) {
  const list = sign > 0 ? [ctx.high30, ctx.high100].filter((x) => x > spot * 1.005) : [ctx.low30, ctx.low100].filter((x) => x > 0 && x < spot * 0.995);
  if (!list.length) return null;
  return sign > 0 ? Math.min(...list) : Math.max(...list);
}

// Underlying price where the position's model sale value equals `value` today, or
// null (out of reach). Bisection: calls / bull spreads gain as S rises, puts / bear spreads as it falls.
function levelFor(od, value, spot, now) {
  let lo = spot * 0.6;
  let hi = spot * 1.4;
  const vLo = exitValue(od, lo, now);
  const vHi = exitValue(od, hi, now);
  const inc = vHi > vLo;
  if (value < Math.min(vLo, vHi) || value > Math.max(vLo, vHi)) return null;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if ((exitValue(od, mid, now) < value) === inc) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// Exit plan for one structure (short null = single). { ok, ...plan } or { ok:false, error }.
// Projected exit slippage per contract, in dollars: what closing gives up under the net mid.
const exitSpreadOf = (q) => Math.max(0, q.mid - q.exit) * MULT;
const wideWhy = (tag, x, cap) => `WIDE_EXIT_SPREAD: ${tag}: exit spread $${x.toFixed(2)} exceeds $${Number(cap).toFixed(2)} cap`;

function planFrom({ long, short, type, spot, structuralStop, now, minNetDelta = CONFIG.netDelta.min, maxExitSpread = null }) {
  const sign = type === 'call' ? 1 : -1;
  const legs = [{ side: 'buy', type, strike: long.strike, ratio: 1, contract: long.symbol, iv: long.iv, bid: long.bid, ask: long.ask, delta: long.delta },
    ...(short ? [{ side: 'sell', type, strike: short.strike, ratio: 1, contract: short.symbol, iv: short.iv, bid: short.bid, ask: short.ask, delta: short.delta }] : [])];
  const q = short ? packageQuote(legs) : { mid: long.mid, combined: long.ask - long.bid, debit: long.ask, exit: long.bid, slippage: long.ask - long.bid };
  const debit = up(q.debit);
  const width = short ? Math.abs(short.strike - long.strike) : null;
  const tag = short ? `${long.strike}/${short.strike}` : `${long.strike}`;
  const netDelta = Math.abs(long.delta - (short ? short.delta : 0));
  if (short && netDelta < minNetDelta) return { ok: false, error: `${tag}: net delta ${netDelta.toFixed(2)} (needs >= ${minNetDelta}: the legs cancel out)` };
  if (debit < CONFIG.leg.absBelowDebit && legs.some((l) => l.ask - l.bid > CONFIG.leg.maxAbsSpread)) {
    return { ok: false, error: `${tag}: a leg's bid/ask is over $${CONFIG.leg.maxAbsSpread} on a debit under $${CONFIG.leg.absBelowDebit}` };
  }
  if (short && (debit / width < CONFIG.debitShare[0] || debit / width > CONFIG.debitShare[1])) {
    return { ok: false, error: `${tag}: debit ${debit} is ${Math.round((debit / width) * 100)}% of the ${width} width (needs 30-53%)` };
  }
  const od = { expiration: long.expiration, iv: long.iv, spread: cents(q.slippage), refSpot: spot, refMid: q.mid, refAt: now, legs, fill: short ? 'package' : 'single' };
  const atStop = exitValue(od, structuralStop, now);
  const stopShare = clamp(1 - atStop / debit, CONFIG.stopShare[0], CONFIG.stopShare[1]);
  const stopValue = cents(debit * (1 - stopShare));
  const risk = debit - stopValue;
  const fees = (OPTIONS_ROUND_TRIP_PER_CONTRACT * legs.length) / MULT; // per share
  const costR = (q.slippage + fees) / risk;
  if (costR > CONFIG.maxCostR) return { ok: false, error: `${tag}: slippage + fees ${(costR).toFixed(2)}R of its ${cents(risk)} risk (max ${CONFIG.maxCostR}R)` };
  const rrAt = (v) => ((v - debit) - fees) / (risk + fees);
  let t1Value = null;
  for (const need of [CONFIG.netRR, MIN_T1_NET_RR]) {
    for (let s = CONFIG.t1Share[0]; s <= CONFIG.t1Share[1] + 1e-9 && t1Value === null; s += 0.05) {
      const v = cents(debit * (1 + s));
      if ((!short || v <= CONFIG.t1MaxWidth * width) && rrAt(v) >= need) t1Value = v;
    }
    if (t1Value !== null) break;
  }
  if (t1Value === null) return { ok: false, error: `${tag}: no T1 in +65% to +85% of the debit nets ${MIN_T1_NET_RR} : 1 (risk ${cents(risk)}, fees + slippage ${cents(q.slippage + fees)})` };
  const t2Cap = short ? CONFIG.t2MaxWidth * width : Infinity;
  const t2Value = cents(Math.min(debit * (1 + CONFIG.t2Share[2]), t2Cap));
  const invalidation = levelFor(od, stopValue, spot, now);
  if (!invalidation || sign * (invalidation - spot) >= 0) return { ok: false, error: `${tag}: no underlying level matches the ${cents(stopValue)} stop value` };
  // Underlying level for a value at MID-HOLD (the model, each leg at its IV); T2 (a stretch) may fall back to expiry.
  const hold = midHoldAt(od, now);
  const t1 = levelFor(od, t1Value, spot, hold);
  if (!t1 || sign * (t1 - spot) <= 0) return { ok: false, error: `${tag}: T1 ${t1Value} is not reachable by mid-hold (only near expiry)` };
  const t2Level = (v) => levelFor(od, v, spot, hold) || long.strike + sign * v;
  const exitSpread = exitSpreadOf(q);
  if (maxExitSpread > 0 && exitSpread > maxExitSpread + 1e-9) return { ok: false, wide: true, exitSpread, error: wideWhy(tag, exitSpread, maxExitSpread) };
  return {
    exitSpread,
    ok: true, structure: short ? 'vertical' : 'single', type, long, short, legs, od, width, debit, netMid: cents(q.mid), exitNow: cents(q.exit), combined: cents(q.combined),
    slippage: cents(q.slippage), maxProfit: short ? cents(width - debit) : null, stopShare, stopValue, riskPerShare: cents(risk), t1Value, t2Value: t2Value > t1Value ? t2Value : null,
    t1Share: t1Value / debit - 1, netRR: rrAt(t1Value), costR, invalidation: cents(invalidation), t1: cents(t1), t2: t2Value > t1Value ? cents(t2Level(t2Value)) : null,
    breakeven: cents(long.strike + sign * debit), netDelta, midHoldAt: hold,
  };
}

// Expirations of `contracts` in the horizon's window, preferred first.
function expirationsFor(contracts, horizon) {
  const w = CONFIG.windows[horizon] || CONFIG.windows.swing;
  const exps = [...new Map(contracts.filter((c) => c.dte >= w.minDte && c.dte <= w.maxDte).map((c) => [c.expiration, c.dte])).entries()];
  return exps.sort((a, b) => Math.abs(a[1] - w.prefer) - Math.abs(b[1] - w.prefer)).slice(0, CONFIG.maxExpirations).map(([e]) => e);
}

// The best plan for a signal. args: { chain (main type), calls, puts (both, for the
// Expected Move), type, horizon, spot, ctx (daily: atr, highs / lows), structuralStop,
// bankroll, single, now, afterHours }. { ok, plan, em, level, anchored, tried } or { ok:false, error }.
function build(a) {
  const sign = a.type === 'call' ? 1 : -1;
  const level = levelTarget(a.ctx, a.spot, sign);
  const dist = level ? Math.abs(level - a.spot) : null;
  const anchorable = level && dist >= CONFIG.level.minAtr * a.ctx.atr && dist <= CONFIG.level.maxAtr * a.ctx.atr;
  const tooClose = level && dist < CONFIG.level.minAtr * a.ctx.atr;
  const caps = a.bankroll > 0 && a.bankroll < CONFIG.single.minBankroll
    ? { debit: (a.bankroll * CONFIG.smallCap.debitPct) / MULT, risk: (a.bankroll * CONFIG.smallCap.riskPct) / MULT } : null;
  // A swing tries 21-45 DTE first, then the 10-18 DTE weeklies (sharper net delta on narrow widths).
  // ... and finally the 6-12 DTE weeklies, never across an earnings date (a.earnings: 'YYYY-MM-DD' or null).
  const shortOk = (e) => !a.earnings || e < a.earnings;
  const exps = [...new Set([...expirationsFor(a.chain, a.horizon), ...(a.horizon === 'swing' ? expirationsFor(a.chain, 'weekly') : []),
    ...expirationsFor(a.chain, 'short').filter(shortOk)])];
  const minNetDelta = a.spot >= CONFIG.netDelta.priceyAt ? CONFIG.netDelta.minPricey : CONFIG.netDelta.min;
  if (!exps.length) return { ok: false, error: `no ${a.type}s listed ${CONFIG.windows[a.horizon].minDte}-${CONFIG.windows[a.horizon].maxDte} DTE` };
  const whys = [];
  const wide = []; // exit spreads of structures that passed everything but the cap
  let tried = 0;
  let first = null; // the best expiration's result; a.alternatives: keep collecting (up to 3 plans) across the next expirations
  const found = [];
  for (const exp of exps) {
    const em = expectedMove(a.calls, a.puts, a.spot, exp);
    const list = a.chain.filter((c) => c.expiration === exp && c.type === a.type);
    const ok = list.filter((c) => legWhy(c, a.now, a.afterHours) === null);
    const longs = ok.filter((c) => Math.abs(c.delta) >= CONFIG.longDelta[0] && Math.abs(c.delta) <= CONFIG.longDelta[1]);
    if (!longs.length) { whys.push(`${exp}: no tradeable ${CONFIG.longDelta[0]}-${CONFIG.longDelta[1]} delta ${a.type}`); continue; }
    const plans = [];
    for (const long of longs) {
      const beyond = ok.filter((c) => sign * (c.strike - long.strike) > 0);
      const atLevel = anchorable ? beyond.filter((c) => sign * (level - c.strike) >= 0 && Math.abs(c.delta) >= CONFIG.levelDelta[0] && Math.abs(c.delta) <= CONFIG.levelDelta[1]) : [];
      const anchor = atLevel.length ? atLevel.reduce((b, c) => (Math.abs(level - c.strike) < Math.abs(level - b.strike) ? c : b)) : null;
      const inBand = beyond.filter((c) => Math.abs(c.delta) >= CONFIG.shortDelta[0] && Math.abs(c.delta) <= CONFIG.shortDelta[1]);
      const narrow = caps ? [...beyond].sort((x, y) => sign * (x.strike - y.strike)).slice(0, CONFIG.narrowSteps).filter((c) => !inBand.includes(c)) : [];
      const shorts = a.single ? [null] : anchor ? [anchor, ...(caps ? narrow.filter((c) => sign * (anchor.strike - c.strike) > 0) : [])] : [...inBand, ...narrow];
      for (const short of shorts) {
        tried += 1;
        const p = planFrom({ long, short, type: a.type, spot: a.spot, structuralStop: a.structuralStop, now: a.now, minNetDelta });
        if (!p.ok) { whys.push(`${exp} ${p.error}`); continue; }
        if (tooClose && sign * (level - p.breakeven) <= 0) { whys.push(`${exp} ${long.strike}: breakeven ${p.breakeven} is past the ${sign > 0 ? 'resistance' : 'support'} ${cents(level)} (< 0.5 ATR away)`); continue; }
        if (caps && (p.debit > caps.debit || p.riskPerShare > caps.risk)) { whys.push(`${exp} ${long.strike}${short ? `/${short.strike}` : ''}: $${Math.round(p.debit * MULT)} debit over the small-account 1-contract cap`); continue; }
        // The exit-spread cap last: WIDE_EXIT_SPREAD only when it is the sole reason.
        if (a.maxExitSpread > 0 && p.exitSpread > a.maxExitSpread + 1e-9) { wide.push(p.exitSpread); whys.push(`${exp} ${wideWhy(`${long.strike}${short ? `/${short.strike}` : ''}`, p.exitSpread, a.maxExitSpread)}`); continue; }
        plans.push({ ...p, anchored: !!anchor && short === anchor });
      }
    }
    if (!plans.length) continue;
    const [lo, hi] = CONFIG.netDelta.ideal;
    const deltaMiss = (p) => (p.short ? Math.max(0, lo - p.netDelta, p.netDelta - hi) : 0);
    const score = (p) => [p.anchored ? 0 : 1, deltaMiss(p), p.width ? Math.abs(p.debit / p.width - CONFIG.idealShare) : 0, Math.abs(Math.abs(p.long.delta) - CONFIG.longDelta[2]), p.debit];
    plans.sort((x, y) => { const sx = score(x); const sy = score(y); for (let i = 0; i < sx.length; i += 1) if (sx[i] !== sy[i]) return sx[i] - sy[i]; return 0; });
    if (!first) first = { em: em.ok ? em : null, expiration: exp };
    found.push(...plans);
    if (!a.alternatives || found.length >= 3) break;
  }
  if (found.length) return { ok: true, plan: found[0], alternatives: found.slice(1, 3), em: first.em, level, anchored: found[0].anchored, tried, expiration: first.expiration };
  const list = `${tried} structure(s) tried over ${exps.join(', ')}: ${[...new Set(whys)].slice(0, 4).join(' | ') || 'none tradeable'}`;
  if (wide.length) return { ok: false, wide: true, error: `WIDE_EXIT_SPREAD: exit spread $${Math.min(...wide).toFixed(2)} exceeds $${Number(a.maxExitSpread).toFixed(2)} cap (the tightest of ${wide.length} otherwise-valid structure(s)); ${list}` };
  return { ok: false, error: list };
}

module.exports = { build, planFrom, levelFor, levelTarget, legWhy, expirationsFor, exitSpreadOf, CONFIG };
