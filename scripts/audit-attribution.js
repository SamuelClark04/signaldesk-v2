// Loss attribution for scripts/trade-audit.js (Phase 89b), READ-ONLY and pure. Every number here is a RECONSTRUCTED ESTIMATE from
// the ledger's own fields, never a substitute for the recorded result (netPnl):
//   signal      what the plan made / lost at its OWN level: (planned exit level - fill) x size for a stop / target / time exit
//               (stop-like broker exits are matched to the stop, the rest to T1); for an option position the move of its
//               value (exitRule) vs the debit at the planned level
//   execution   slippage past the planned level ((exit - planned level) x size) minus the recorded fees (negative = cost)
//   contract    options: the round-trip cost of the chosen contracts' bid / ask (combined leg spread x 100 x size)
//   accounting  internal paper option spreads: booked - natural (the old mid +/- 0.15 x model; POSITIVE = the ledger overstated it)
//   discretion  manual / external closes: the gross P/L of the close (not the strategy's own exit)
//   holding     trades held past their setup's window: their recorded net (overlaps the others; shown apart)
// The categories overlap by construction (holding, contract); the table says which sum to the recorded net.
const exitBy = (r) => (/^MANUAL_CLOSE/.test(String(r || '')) ? 'manual' : /^CLOSED_EXTERNALLY/.test(String(r || '')) ? 'external' : 'system');
const sign = (t) => (t.direction === 'short' ? -1 : 1);

function attribute(t, row) {
  const out = { signal: 0, execution: -(Number(t.fees) || 0), contract: 0, accounting: 0, discretion: 0, holding: 0, basis: 'recorded' };
  const od = t.optionsData;
  if (od) out.contract = (Number(od.combinedLegSpread) || 0) * (od.multiplier || 100) * (t.positionSize || 1);
  if (row && row.netAtNatural !== null && row.netAtNatural !== undefined) out.accounting = t.netPnl - row.netAtNatural;
  if (row && row.flags.some((f) => /^EXIT:held/.test(f))) out.holding = t.netPnl;
  const by = exitBy(t.exitReason);
  if (by !== 'system') { out.discretion = (Number(t.grossPnl) || 0); out.basis = 'recorded (manual / external close)'; return out; }
  if (od && od.exitRule) { // option: value at the planned level vs the debit
    const v = Number(t.optionsExitValue); const stopLike = v <= od.debit;
    const plan = stopLike ? od.exitRule.stopValue : od.exitRule.targetValue;
    const k = (od.multiplier || 100) * (t.positionSize || 1);
    if (/^QF_|^AUTO_CLOSE|^EXPIRY|^RUN_RESET/.test(String(t.exitReason))) { out.signal = (v - od.debit) * k; out.basis = 'reconstructed (time exit: no planned level)'; return out; }
    out.signal = (plan - od.debit) * k; out.execution += (v - plan) * k; out.basis = 'reconstructed (planned option value)'; return out;
  }
  const fill = Number(t.fillPrice); const ex = Number(t.exitPrice); const size = Number(t.positionSize) || 0;
  const stopLike = sign(t) * (ex - fill) <= 0;
  const t1 = t.targets && t.targets[0] && t.targets[0].price;
  const plan = stopLike ? Number(t.invalidation) : Number(t1) || ex;
  out.signal = sign(t) * (plan - fill) * size; out.execution += -sign(t) * (plan - ex) * size; out.basis = `reconstructed (planned ${stopLike ? 'stop' : 'target'})`;
  return out;
}

// rows: trade-audit rows; journal: the matching ledger records (same order). -> printable lines
function table(journal, rows, filter = () => true) {
  const sums = new Map();
  journal.forEach((t, i) => {
    if (!filter(t)) return;
    const a = attribute(t, rows[i]); const k = `${t.strategyId} ${t.execution}`;
    const s = sums.get(k) || { n: 0, net: 0, signal: 0, execution: 0, contract: 0, accounting: 0, discretion: 0, holding: 0, fees: 0 };
    s.n += 1; s.net += t.netPnl; s.fees += Number(t.fees) || 0;
    for (const c of ['signal', 'execution', 'contract', 'accounting', 'discretion', 'holding']) s[c] += a[c];
    sums.set(k, s);
  });
  const m = (x) => (x >= 0 ? '+' : '') + x.toFixed(2);
  const lines = ['strategy / book                         n   RECORDED net |  est. signal  execution (fees)  discretion | contract b/a  booked-natural  held-too-long'];
  for (const [k, s] of [...sums].sort((a, b) => a[1].net - b[1].net)) {
    lines.push(`${k.padEnd(36)} ${String(s.n).padStart(4)} ${m(s.net).padStart(12)} | ${m(s.signal).padStart(11)} ${m(s.execution).padStart(10)} (${s.fees.toFixed(2)}) ${m(s.discretion).padStart(10)} | ${m(-s.contract).padStart(11)} ${m(s.accounting).padStart(14)} ${m(s.holding).padStart(13)}`);
  }
  lines.push('signal + execution + discretion ~= recorded net (fees inside execution); contract / accounting / held-too-long are views, not additive.');
  return lines;
}

module.exports = { attribute, table };
