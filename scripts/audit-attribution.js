// Reconciliation + loss attribution for scripts/trade-audit.js (Phase 89b / 89c), READ-ONLY and pure. Two separate questions:
// A. ACCOUNTING RECONCILIATION (is the recorded P/L what the trades really earned?), from the ledger's own fields:
//      recorded net (netPnl, untouched)
//      - paper package overstatement: internal paper option SPREADS were booked at net mid +/- 0.15 x the legs' combined bid/ask on each
//        side; natural prices pay half the combined width on each side. The model therefore charged 0.30 x C of the round-trip bid/ask
//        cost C (= combined x 100 x size, entry width assumed for the exit) and the reconciliation adds the missing 0.70 x C.
//      - LIVE fee difference: the ledger's fees vs the broker-reported actualFees, when both exist.
//      = reconciled net (an ESTIMATE). C and the overstatement OVERLAP: the overstatement is 70% of C, the other 30% was already booked.
// B. HYPOTHESES (why the reconciled result happened), reconstructed per trade and summing to the RECONCILED net:
//      signal      what the plan made / lost at its own stop / target level
//      execution   slippage past that level, minus fees, minus the overstatement on system exits
//      discretion  manual / external closes (gross, minus the overstatement for those)
//      (held-too-long: the reconciled net of trades held past their window; a view, overlaps the rest)
const exitBy = (r) => (/^MANUAL_CLOSE/.test(String(r || '')) ? 'manual' : /^CLOSED_EXTERNALLY/.test(String(r || '')) ? 'external' : 'system');
const sign = (t) => (t.direction === 'short' ? -1 : 1);
const MODEL_SHARE = 0.15; // cost-authority PACKAGE_SLIPPAGE / 2 per side as booked by the old model

// A: the reconciliation of one record. -> { recorded, overstatement, feeDiff, reconciled, spreadCost, spreadBooked }
function reconcile(t, row) {
  const od = t.optionsData;
  const C = od && od.fill === 'package' ? (Number(od.combinedLegSpread) || 0) * (od.multiplier || 100) * (t.positionSize || 1) : 0;
  const over = row && row.netAtNatural !== null && row.netAtNatural !== undefined ? t.netPnl - row.netAtNatural : 0;
  const feeDiff = t.execution === 'LIVE' && Number.isFinite(t.actualFees) && Number.isFinite(t.fees) ? t.fees - t.actualFees : 0; // + = the ledger charged more
  return { recorded: t.netPnl, overstatement: over, feeDiff, reconciled: t.netPnl - over + feeDiff, spreadCost: C, spreadBooked: C * 2 * MODEL_SHARE };
}

// B: hypotheses for one record, summing to its reconciled net.
function attribute(t, row) {
  const rc = reconcile(t, row);
  const out = { signal: 0, execution: -(Number(t.fees) || 0) + rc.feeDiff, discretion: 0, holding: 0, basis: 'recorded' };
  if (row && row.flags.some((f) => /^EXIT:held/.test(f))) out.holding = rc.reconciled;
  const by = exitBy(t.exitReason);
  if (by !== 'system') { out.discretion = (Number(t.grossPnl) || 0) - rc.overstatement; out.basis = 'manual / external close'; return out; }
  out.execution -= rc.overstatement;
  const od = t.optionsData;
  if (od && od.exitRule) {
    const v = Number(t.optionsExitValue); const k = (od.multiplier || 100) * (t.positionSize || 1);
    if (/^QF_|^AUTO_CLOSE|^EXPIRY|^RUN_RESET/.test(String(t.exitReason))) { out.signal = (v - od.debit) * k; out.basis = 'time exit (no planned level)'; return out; }
    const plan = v <= od.debit ? od.exitRule.stopValue : od.exitRule.targetValue;
    out.signal = (plan - od.debit) * k; out.execution += (v - plan) * k; out.basis = 'planned option value'; return out;
  }
  const fill = Number(t.fillPrice); const ex = Number(t.exitPrice); const size = Number(t.positionSize) || 0;
  const stopLike = sign(t) * (ex - fill) <= 0;
  const t1 = t.targets && t.targets[0] && t.targets[0].price;
  const plan = stopLike ? Number(t.invalidation) : Number(t1) || ex;
  out.signal = sign(t) * (plan - fill) * size; out.execution += sign(t) * (ex - plan) * size; out.basis = `planned ${stopLike ? 'stop' : 'target'}`;
  return out;
}

const m = (x) => (x >= 0 ? '+' : '') + x.toFixed(2);
function group(journal, rows, fn) {
  const g = new Map();
  journal.forEach((t, i) => { const k = `${t.strategyId} ${t.execution}`; const s = g.get(k) || { n: 0 }; s.n += 1; fn(s, t, rows[i]); g.set(k, s); });
  return [...g];
}

function bridge(journal, rows) {
  const add = (s, k, v) => { s[k] = (s[k] || 0) + v; };
  const lines = ['strategy / book                         n      RECORDED  - overstatement  + fee diff  =  RECONCILED (est.) | bid/ask cost C   of which booked   added (=overstatement)'];
  const tot = { n: 0 };
  for (const [k, s] of group(journal, rows, (s, t, r) => { const rc = reconcile(t, r); for (const f of ['recorded', 'overstatement', 'feeDiff', 'reconciled', 'spreadCost', 'spreadBooked']) { add(s, f, rc[f]); add(tot, f, rc[f]); } })) {
    tot.n += s.n;
    lines.push(`${k.padEnd(36)} ${String(s.n).padStart(4)} ${m(s.recorded).padStart(13)} ${m(-s.overstatement).padStart(16)} ${m(s.feeDiff).padStart(11)} ${m(s.reconciled).padStart(20)} | ${s.spreadCost.toFixed(2).padStart(14)} ${s.spreadBooked.toFixed(2).padStart(17)} ${(s.spreadCost - s.spreadBooked).toFixed(2).padStart(23)}`);
  }
  lines.push(`${'TOTAL'.padEnd(36)} ${String(tot.n).padStart(4)} ${m(tot.recorded || 0).padStart(13)} ${m(-(tot.overstatement || 0)).padStart(16)} ${m(tot.feeDiff || 0).padStart(11)} ${m(tot.reconciled || 0).padStart(20)} | ${(tot.spreadCost || 0).toFixed(2).padStart(14)} ${(tot.spreadBooked || 0).toFixed(2).padStart(17)} ${((tot.spreadCost || 0) - (tot.spreadBooked || 0)).toFixed(2).padStart(23)}`);
  lines.push('C overlaps the overstatement: 70% of C was missing from the recorded P/L (= the overstatement), 30% was already booked. Do NOT add C to the reconciliation.');
  return lines;
}

function table(journal, rows) {
  const lines = ['strategy / book                         n  RECONCILED |  signal at plan  execution (fees)  discretion | held-too-long (view)'];
  for (const [k, s] of group(journal, rows, (s, t, r) => {
    const a = attribute(t, r); const rc = reconcile(t, r);
    for (const f of ['signal', 'execution', 'discretion', 'holding']) s[f] = (s[f] || 0) + a[f];
    s.net = (s.net || 0) + rc.reconciled; s.fees = (s.fees || 0) + (Number(t.fees) || 0);
  }).sort((a, b) => a[1].net - b[1].net)) {
    lines.push(`${k.padEnd(36)} ${String(s.n).padStart(4)} ${m(s.net).padStart(11)} | ${m(s.signal).padStart(15)} ${m(s.execution).padStart(10)} (${s.fees.toFixed(2)}) ${m(s.discretion).padStart(10)} | ${m(s.holding).padStart(12)}`);
  }
  lines.push('signal + execution + discretion = the RECONCILED net. These are hypotheses about WHY, not accounting.');
  return lines;
}

module.exports = { reconcile, attribute, bridge, table, MODEL_SHARE };
