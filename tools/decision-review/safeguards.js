// Did a rejection follow its own rule? (Phase 93 spec 6.4) From the RECORDED inputs only: CONSISTENT / INCONSISTENT (a bug to fix) /
// NOT_VERIFIABLE (the inputs the rule used were not recorded) / NOT_A_SAFEGUARD (a data gap, e.g. no live price). The blocked trade's
// hypothetical outcome is reported NEXT TO the verdict elsewhere: it never decides whether the rule was right.
const num = (re, s) => { const m = re.exec(String(s || '')); return m ? Number(m[1]) : null; };

const RULES = [
  { test: /^DAILY_LOSS_LIMIT_REACHED/, name: 'Daily loss limit', check: (r, d, g) => {
    if (!g || !g.kill) return null;
    const live = d.setup && d.setup.execution === 'LIVE';
    const book = g.kill[live ? 'live' : 'paper'];
    return book ? { ok: !!book.active, evidence: `kill switch ${book.active ? 'ON' : 'OFF'} for the ${live ? 'live' : 'paper'} book (today ${book.dayPnl ?? '?'} vs limit ${book.limit ?? '?'})` } : null; } },
  { test: /^MACRO_SHIELD_ACTIVE/, name: 'Macro shield', check: (r, d, g) => (g && g.macroActive !== undefined ? { ok: !!g.macroActive, evidence: `macro blackout ${g.macroActive ? 'active' : 'NOT active'} in the pass${g.macroEvent ? ` (${g.macroEvent})` : ''}` } : null) },
  { test: /^SECTOR_CAP_REACHED/, name: 'Sector cap', check: (r) => { const a = num(/(\d+)\s*\/\s*\d+/, r); const b = num(/\d+\s*\/\s*(\d+)/, r); return a !== null && b !== null ? { ok: a >= b, evidence: `${a} open + staged of ${b} allowed` } : null; } },
  { test: /open risk|PORTFOLIO_RISK|OPEN_RISK/i, name: 'Open-risk cap', check: (r) => { const a = num(/([\d.]+)%\s*>/, r); const b = num(/>\s*([\d.]+)%/, r); return a !== null && b !== null ? { ok: a > b, evidence: `${a}% > ${b}%` } : null; } },
  { test: /^EARNINGS_SOON/, name: 'Earnings shield', check: (r) => { const n = num(/(\d+) trading day/, r); return n !== null ? { ok: n < 3, evidence: `${n} trading day(s) to earnings (rule: < 3)` } : null; } },
  { test: /^EARNINGS_UNKNOWN/, name: 'Earnings shield (date unknown: fails closed)', check: () => ({ ok: true, evidence: 'the earnings date was unavailable: the shield blocks by design' }) },
  { test: /^EXPIRED/, name: 'Approval window', check: (r, d) => { const st = d.events.find((e) => e.path === 'STAGED'); const ex = d.events.find((e) => e.path === 'EXPIRED');
    const ttl = num(/after (\d+)m/, r); return st && ex && ttl ? { ok: (ex.at - st.at) >= ttl * 60000 - 35000, evidence: `staged ${(((ex.at - st.at) / 60000)).toFixed(1)} min before expiry (window ${ttl} min)` } : null; } },
  { test: /^REJECTED_BY_USER/, name: 'Your rejection', check: () => ({ ok: true, evidence: 'your click is recorded' }) },
  { test: /^ORB_FILTER: Breakout volume too low/, name: 'ORB volume filter', check: (r, d) => { const v = d.context && d.context.values; return v && v.volumeRatio != null ? { ok: v.volumeRatio < 1.5, evidence: `breakout volume ${v.volumeRatio.toFixed(2)}x the opening-range bar (rule: >= 1.5x)` } : null; } },
  { test: /^ORB_FILTER: Breakout under the session VWAP/, name: 'ORB VWAP filter', check: (r, d) => { const v = d.context && d.context.values; return v && v.vwap ? { ok: v.breakoutClose <= v.vwap, evidence: `close ${v.breakoutClose} vs VWAP ${Number(v.vwap).toFixed(2)}` } : null; } },
  { test: /^ORB_FILTER: Weak market/, name: 'ORB SPY-tape filter', check: (r, d) => { const v = d.context && d.context.values; return v && v.spyWeak !== undefined ? { ok: !!v.spyWeak, evidence: v.spyText } : null; } },
  { test: /^ORB_FILTER: Breakout too extended/, name: 'ORB no-chase filter', check: (r, d) => { const v = d.context && d.context.values; return v && v.orHigh ? { ok: v.breakoutClose > v.orHigh * 1.005, evidence: `close ${v.breakoutClose} vs OR high ${v.orHigh} (+0.5% max)` } : null; } },
  { test: /^(NO_LIVE_PRICE|MARKET_CLOSED|OPTIONS_CHAIN_UNAVAILABLE|QUICKFLIPS_STALE_QUOTE)/, name: 'Data availability', na: true },
];

function check(d) {
  if (d.outcome.group !== 'REJECTED') return null;
  const reason = d.outcome.reason || '';
  // Phase 94 S0-3: the REJECTING event (the last one with this path + reason) and ITS OWN guard snapshot.
  const ev = [...d.events].reverse().find((e) => e.reason === d.outcome.reason && e.path === d.outcome.path)
    || [...d.events].reverse().find((e) => e.reason === d.outcome.reason) || {};
  const rule = RULES.find((x) => x.test.test(reason));
  if (!rule) return { verdict: 'NOT_VERIFIABLE', rule: reason ? (d.outcome.reasonBucket || reason.split(':')[0]) : 'reason not stored', evidence: reason ? 'no rule check defined for this reason yet' : 'the rejection reason was not stored (discarded before the recorder)' };
  if (rule.na) return { verdict: 'NOT_A_SAFEGUARD', rule: rule.name, evidence: 'a data gap, not a judgement on the setup' };
  const r = rule.check(reason, { ...d, setup: ev.setup }, ev.guard || null);
  if (!r) return { verdict: 'NOT_VERIFIABLE', rule: rule.name, evidence: d.source === 'RECORDED' ? 'the inputs this rule used are not in the rejecting event\'s record (events recorded before Phase 94 carry no approval-time guard)' : 'decided before the recorder: inputs not recorded' };
  return { verdict: r.ok ? 'CONSISTENT' : 'INCONSISTENT', rule: rule.name, evidence: r.evidence };
}

module.exports = { check, RULES };
