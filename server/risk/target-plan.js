// Target plan vs overhead resistance (long setups). Replaces the old hard veto
// "resistance under the target = rejected":
//   no resistance under the target   the strategy's own targets stand
//   resistance >= snapMinR above entry (strict 1.75R, moderate 1.35R;
//   risk/strictness.js)              T1 (50%) snaps to just under it
//                                    (resistance x 0.995), T2 (the 50% runner)
//                                    keeps the full target; the blended NET
//                                    reward (after the leg-by-leg fees of
//                                    cost-authority.js) must reach minNetR
//   resistance closer than that      rejected (RESISTANCE_BLOCKS_TARGET)
// Breakout archetypes are not blocked by the base they are breaking out of:
//   - Opening Range Breakout (1-equity-day) and Speculative Moonshots
//     (6-speculative-crypto) have no resistance gate at all;
//   - base breakouts (5-options-system's squeeze breakout) pass `breakout`:
//     tops of the last BASE_DAYS days within half an ATR above entry are the
//     base being broken, not overhead supply, and are skipped.
// Pure: bars in, plan out.
const { resistanceLevels } = require('./structure');
const { legRate } = require('./cost-authority');
const { getStrictness } = require('./strictness');

const SNAP_BELOW = 0.995; // T1 just under resistance (limit orders fill before the level)
const T1_SHARE = 0.5;
const BASE_DAYS = 30;
const BAND_ATR = 0.5;

const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);

// Blended result per unit of a long T1/T2 plan, in R: { grossR, netR }.
// Entry at `entry` (entryLiquidity), both targets as resting limits (maker).
function blendedR({ market, entry, stop, t1, t2, share = T1_SHARE, entryLiquidity }) {
  const risk = entry - stop;
  const gross = share * (t1 - entry) + (1 - share) * (t2 - entry);
  const fees = market === 'options' ? 0
    : legRate(market, entryLiquidity) * entry + legRate(market, 'maker') * (share * t1 + (1 - share) * t2);
  return { grossR: gross / risk, netR: (gross - fees) / risk };
}

// input: { bars (daily, oldest first), entry, stop, targets: [{ level, price,
//   allocation }] (the strategy's plan; the last one is the full target), market,
//   entryLiquidity, fmt, breakout?: { atr }, lookbackDays?, checkNetR? (default true) }
// -> { ok, targets, resistance, snapped, blended, text } or { ok:false, reason, text }.
function planTargets(input) {
  const s = getStrictness();
  const { entry, stop, market, entryLiquidity, fmt = (x) => x } = input;
  const lookback = input.lookbackDays === undefined ? s.resistanceLookbackDays : input.lookbackDays;
  const bars = lookback > 0 ? input.bars.slice(-lookback) : input.bars;
  const risk = entry - stop;
  const full = input.targets[input.targets.length - 1].price;
  if (!(risk > 0) || !(full > entry)) return { ok: false, reason: 'levels out of order', text: 'Target plan: levels out of order.' };

  let levels = resistanceLevels(bars, entry);
  let skipped = null;
  if (input.breakout && input.breakout.atr > 0 && bars.length) {
    const since = bars[bars.length - 1].time - BASE_DAYS * 86400;
    const inBase = (l) => l.time >= since && l.price <= entry + BAND_ATR * input.breakout.atr;
    skipped = levels.filter(inBase)[0] || null;
    levels = levels.filter((l) => !inBase(l));
  }
  const r = levels[0] || null;
  const span = `last ${bars.length} days`;
  const exempt = skipped ? ` Breakout: the base top ${fmt(skipped.price)} (${skipped.kind} ${day(skipped.time)}) is the level being broken, not a block.` : '';
  if (!r) return { ok: true, targets: input.targets, resistance: null, snapped: false, text: `No major daily resistance between entry and the target ${fmt(full)} (${span}).${exempt}` };
  const where = `${fmt(r.price)} (${r.kind} ${day(r.time)}, ${span})`;
  if (full <= r.price) return { ok: true, targets: input.targets, resistance: r, snapped: false, text: `The target ${fmt(full)} sits below the major daily resistance ${where}.${exempt}` };

  const distR = (r.price - entry) / risk;
  if (distR < s.snapMinR) {
    const text = `Major daily resistance ${where} is only ${distR.toFixed(2)}R above entry, under the target ${fmt(full)}; `
      + `${s.level} needs at least ${s.snapMinR}R of room to snap T1 below it.`;
    return { ok: false, reason: `RESISTANCE_BLOCKS_TARGET: ${text}`, resistance: r, text };
  }
  const t1 = fmt(r.price * SNAP_BELOW);
  const blended = blendedR({ market, entry, stop, t1, t2: full, entryLiquidity });
  const text = `Major daily resistance ${where} sits ${distR.toFixed(2)}R above entry, under the ${fmt(full)} target: `
    + `T1 (${T1_SHARE * 100}%) snaps to ${t1} just below it and T2 (${(1 - T1_SHARE) * 100}% runner) stays at ${fmt(full)}; `
    + `blended ${blended.netR.toFixed(2)}R net of fees (${s.level} needs ${s.minNetR}R).${exempt}`;
  if (input.checkNetR !== false && blended.netR < s.minNetR) {
    return { ok: false, reason: `RESISTANCE_BLOCKS_TARGET: ${text}`, resistance: r, text };
  }
  return {
    ok: true, resistance: r, snapped: true, blended, text,
    targets: [{ level: 1, price: t1, allocation: T1_SHARE, snappedTo: r.price }, { level: 2, price: full, allocation: 1 - T1_SHARE }],
  };
}

module.exports = { planTargets, blendedR, SNAP_BELOW, T1_SHARE, BASE_DAYS };
