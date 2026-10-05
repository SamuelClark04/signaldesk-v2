// Decision Review trade results (Phase 93 spec 6.2 / 6.3): the MONEY side, kept apart from the direction class [C2].
//   trade()        a stock / crypto (or option-underlying proxy) trade with the strategy's fills, exits and costs
//   optionPrints() an option contract from Alpaca TRADE prints: an ESTIMATE [C3] (entry at the recorded ask, exits at the print less
//                  the recorded half-spread); UNAVAILABLE when the prints are too sparse
//   oppositeOf()   the opposite side on the same path: market entry at the same time, stop at the same unit, T1 at the same R multiple
// rows: [tMs, o, h, l, c, v].
const MIN = 60 * 1000;
const STOCK_SLIP = 0.0005; // per leg (cost-authority stocks)
const CRYPTO_TAKER = 0.009; // the verified Coinbase account taker per side (2026-10-04); crypto setups are history only
const OPTION_FEE = 0.65; // per contract per fill

// Approval window per setup (setup-ttl): Quick Flips 3 min, Momentum Ignition 8, Coil / Crypto Intraday 15, the rest 30.
function windowMs(d) {
  if (d.strategyId === 'options-quickflips') return 3 * MIN;
  if (/ignition/i.test(d.setupType || '')) return 8 * MIN;
  if (/coil/i.test(d.setupType || '') || d.strategyId === 'crypto-intraday') return 15 * MIN;
  return 30 * MIN;
}

// spec: { d, entry: { type: 'zone', min, max } | { type: 'market' }, stop, t1, t1Share, t2, t0, endAt, windowMs, slip, feePct }
function trade(rows, s) {
  const start = s.t0 + MIN;
  const i0 = rows.findIndex((r) => r[0] >= start);
  if (i0 < 0) return { filled: false, why: 'no bars after the decision' };
  let fi = -1; let fill = null;
  for (let i = i0; i < rows.length && rows[i][0] <= start + s.windowMs; i += 1) {
    const r = rows[i];
    if (s.entry.type === 'market') { fi = i; fill = r[1]; break; }
    const edge = s.d > 0 ? s.entry.max : s.entry.min;
    if (i === i0 && (s.d > 0 ? r[1] <= edge : r[1] >= edge)) { fi = i; fill = r[1]; break; }
    if (s.d > 0 ? r[3] <= edge : r[2] >= edge) { fi = i; fill = edge; break; }
  }
  if (fi < 0) return { filled: false, why: 'ENTRY_NOT_FILLED: never traded through the entry within the approval window' };
  // The app's approval guard refuses a setup whose price already reached its stop (order-guard): not an entry.
  if (s.d > 0 ? fill <= s.stop : fill >= s.stop) return { filled: false, why: 'INVALIDATED: the price was at / through the stop before the entry filled' };
  const px = fill * (1 + s.d * s.slip);
  // 1R = the PLANNED risk (|entry - stop|), as the app's dollarRisk: a fill near the stop never inflates R.
  const risk = s.riskUnit > 0 ? s.riskUnit : Math.abs(px - s.stop);
  let left = 1; const exits = []; let t1Done = false;
  const out = (at, raw, share, reason) => { exits.push({ at, raw, price: raw * (1 - s.d * s.slip), share, reason }); left -= share; };
  for (let i = fi; i < rows.length && left > 1e-9; i += 1) {
    const r = rows[i];
    if (r[0] >= s.endAt) { out(r[0], rows[Math.max(fi, i - 1)][4], left, 'PLANNED_END'); break; }
    const hitStop = s.d > 0 ? r[3] <= s.stop : r[2] >= s.stop;
    if (hitStop) { const gap = s.d > 0 ? r[1] < s.stop : r[1] > s.stop; out(r[0], gap && i > fi ? r[1] : s.stop, left, 'STOP'); break; }
    if (!t1Done && (s.d > 0 ? r[2] >= s.t1 : r[3] <= s.t1)) {
      const share = s.t2 && s.t1Share < 1 ? s.t1Share : left;
      out(r[0], s.t1, share, 'T1'); t1Done = true;
      if (left <= 1e-9) break;
    }
    if (t1Done && s.t2 && (s.d > 0 ? r[2] >= s.t2 : r[3] <= s.t2)) { out(r[0], s.t2, left, 'T2'); break; }
  }
  if (left > 1e-9) { const last = rows.filter((r) => r[0] < s.endAt).pop(); out(last ? last[0] : rows[rows.length - 1][0], (last || rows[rows.length - 1])[4], left, 'OPEN_AT_DATA_END'); }
  const gross = exits.reduce((a, e) => a + e.share * s.d * (e.price - px), 0);
  const fees = s.feePct ? exits.reduce((a, e) => a + e.share * e.price * s.feePct, 0) + px * s.feePct : 0;
  const rawRisk = s.riskUnit > 0 ? s.riskUnit : Math.abs(fill - s.stop);
  const grossRaw = exits.reduce((a, e) => a + e.share * s.d * (e.raw - fill), 0); // before slippage and fees
  return { filled: true, fillAt: rows[fi][0], fill: px, rawFill: fill, exits, rGross: rawRisk > 0 ? grossRaw / rawRisk : null, rNet: (gross - fees) / risk, risk };
}

const costsOf = (d) => (d.market === 'crypto' ? { slip: 0.0005, feePct: CRYPTO_TAKER } : { slip: STOCK_SLIP, feePct: 0 });

// The setup's own trade (stocks / crypto; options: an UNDERLYING PROXY only, labelled).
function realistic(d, rows, m) {
  if (!d.levels || !m || m.error) return null;
  const L = d.levels;
  const zone = L.entryZone && L.entryZone.max > 0 ? { type: 'zone', min: L.entryZone.min || L.entry, max: L.entryZone.max } : { type: 'zone', min: L.entry, max: L.entry };
  const r = trade(rows, { d: d.d, entry: zone, stop: L.stop, t1: L.t1, t1Share: L.t1Share ?? 1, t2: L.t2, t0: d.t0, endAt: m.H.endAt || Date.now(), windowMs: windowMs(d), riskUnit: Math.abs(L.entry - L.stop), ...costsOf(d) });
  return { ...r, tier: d.market === 'options' ? 'UNDERLYING_PROXY' : 'FETCHED', label: d.market === 'options' ? 'underlying proxy, not an option result' : 'simulated on fetched bars' };
}

function oppositeOf(d, rows, m) {
  if (!d.levels || !m || m.error || d.market === 'crypto') return d.market === 'crypto' ? { unavailable: 'spot crypto cannot be shorted' } : null;
  const L = d.levels; const u = m.u; const k = Math.abs(L.t1 - L.entry) / u;
  const i0 = rows.findIndex((r) => r[0] >= d.t0 + MIN);
  if (i0 < 0) return null;
  const e = rows[i0][1]; const od = -d.d;
  const r = trade(rows, { d: od, entry: { type: 'market' }, stop: e - od * u, t1: e + od * k * u, t1Share: 1, t2: null, t0: d.t0, endAt: m.H.endAt || Date.now(), windowMs: windowMs(d), riskUnit: u, ...costsOf(d) });
  return { ...r, tier: d.market === 'options' ? 'UNDERLYING_PROXY' : 'FETCHED', contract: d.market === 'options' ? 'unavailable (the opposite contract was never quoted)' : null };
}

// An option contract from trade prints (ESTIMATE). legs: [{ contract, side: 'buy' | 'sell', rows }]; rule: { debit, halfSpread,
// stopValue, targetValue, endAt, confirmations }. -> { tier, rNet, exitReason, ... } or { tier: 'UNAVAILABLE', why }.
function optionPrints(legs, rule, t0) {
  const start = t0 + MIN;
  const maps = legs.map((l) => new Map(l.rows.filter((r) => r[0] >= start && r[0] < rule.endAt).map((r) => [Math.floor(r[0] / MIN), r])));
  const minutes = [...maps[0].keys()].filter((k) => maps.every((m) => m.has(k))).sort((a, b) => a - b);
  if (minutes.length < 5) return { tier: 'UNAVAILABLE', why: `only ${minutes.length} minute(s) with prints on every leg` };
  for (let i = 1; i < minutes.length; i += 1) if ((minutes[i] - minutes[i - 1]) > 15) return { tier: 'UNAVAILABLE', why: 'a 15-minute stretch without prints' };
  const value = (k, f) => legs.reduce((s, l, j) => s + (l.side === 'sell' ? -1 : 1) * maps[j].get(k)[f], 0);
  let below = 0; let exit = null;
  for (const k of minutes) {
    const v = value(k, 4) - rule.halfSpread; const hi = value(k, 2) - rule.halfSpread;
    if (rule.targetValue && hi >= rule.targetValue) { exit = { at: k * MIN, price: rule.targetValue, reason: 'TARGET' }; break; }
    below = v <= rule.stopValue ? below + 1 : 0;
    if (below >= (rule.confirmations || 1)) { exit = { at: k * MIN, price: v, reason: 'STOP' }; break; }
  }
  if (!exit) { const k = minutes[minutes.length - 1]; exit = { at: k * MIN, price: value(k, 4) - rule.halfSpread, reason: 'PLANNED_END' }; }
  const fees = OPTION_FEE * legs.length * 2;
  const pnl = (exit.price - rule.debit) * 100 - fees;
  const risk = (rule.debit - rule.stopValue) * 100 + fees;
  return { tier: 'ESTIMATE', label: 'estimate: trade prints, not quotes', entry: rule.debit, exit, pnl, rNet: risk > 0 ? pnl / risk : null, prints: minutes.length };
}

module.exports = { trade, realistic, oppositeOf, optionPrints, windowMs, costsOf, STOCK_SLIP, CRYPTO_TAKER, OPTION_FEE };
