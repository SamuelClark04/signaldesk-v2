// Phase 94 Stage 1 pilot health check (PC, read-only; correction C4): summarize the events-*.jsonl files of a vm-audit archive.
// Run: node tools/event-research/inspect.js <folder with events-*.jsonl> [--budget tools/event-research/budget.json]
// A SESSION is a day with market-hours news polls (weekends / holidays are not sessions). It is HEALTHY only if every check passes:
//   collection   >= 90% of the expected market-hours polls present (one every 2 min), >= 95% of them ok, no market-hours gap > 10 min
//   sources      the day's earnings snapshot (complete: every capture symbol answered) and macro snapshot both recorded
//   recorder     STATUS lines in >= 6 of the 7 market hours; no drop / write / serialize / record error added that day; no stall
//   process      CPU % p95, RSS max and event-loop p99 max within the measured budget (budget.json; none = not healthy)
// NEWS counts are reported, never required: a quiet day with zero headlines is not a failure.
// The pilot criteria (spec 3.1): >= 10 sessions and the LAST 10 all healthy. Expansion still needs the user's approval.
const fs = require('fs');
const path = require('path');
const T = require('../decision-review/time');

const POLL_EVERY_MIN = 2;
const MIN_PRESENT = 0.9; const MIN_OK = 0.95; const MAX_GAP_MIN = 10; const MIN_STATUS_HOURS = 6;
const read = (f) => fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return { kind: 'UNREADABLE' }; } });
const pct = (xs, p) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : null; };

// Counters are cumulative per process: count only what was ADDED (a lower value = a restart, counted from 0).
function added(statuses, field, base) {
  let prev = base; let sum = 0;
  for (const s of statuses) { const v = Number(s[field]) || 0; sum += v >= prev ? v - prev : v; prev = v; }
  return { sum, last: prev };
}

function summarize(dir, { budget = null } = {}) {
  if (!fs.existsSync(dir)) return { files: 0, days: [], pilotCriteria: { sessions: 0, healthy: 0, ok: false } };
  const files = fs.readdirSync(dir).filter((f) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  const base = { dropped: 0, errors: 0 };
  const days = files.map((f) => {
    const day = f.slice(7, 17); const L = read(path.join(dir, f));
    const open = T.at(day, T.OPEN_MIN); const close = T.at(day, T.CLOSE_MIN);
    const inMkt = (x) => x.at >= open && x.at < close;
    const byKind = {}; for (const x of L) byKind[x.kind] = (byKind[x.kind] || 0) + 1;
    const polls = L.filter((x) => x.kind === 'POLL_STATUS' && x.source === 'alpaca-news' && inMkt(x)).sort((a, b) => a.at - b.at);
    const session = polls.some((x) => x.marketOpen);
    const out = { day, session, byKind, news: byKind.NEWS || 0, reasons: [] };
    const statuses = L.filter((x) => x.kind === 'STATUS').sort((a, b) => a.at - b.at);
    const errs = statuses.map((s) => ({ errors: (Number(s.writeErrors) || 0) + (Number(s.serializeErrors) || 0) + (Number(s.recordErrors) || 0) }));
    const dr = added(statuses, 'dropped', base.dropped); const er = added(errs, 'errors', base.errors);
    base.dropped = dr.last; base.errors = er.last;
    if (!session) { out.healthy = null; return out; }
    const expected = Math.floor((T.CLOSE_MIN - T.OPEN_MIN) / POLL_EVERY_MIN);
    const ok = polls.filter((x) => x.ok).length;
    const times = [open, ...polls.map((x) => x.at), close];
    const maxGapMin = Math.max(...times.slice(1).map((t, i) => (t - times[i]) / 60000));
    out.polls = { expected, present: polls.length, ok, maxGapMin: Math.round(maxGapMin) };
    if (polls.length / expected < MIN_PRESENT) out.reasons.push(`collection: ${polls.length} of ${expected} expected polls present (< 90%)`);
    if (polls.length && ok / polls.length < MIN_OK) out.reasons.push(`collection: ${ok} of ${polls.length} polls ok (< 95%)`);
    if (maxGapMin > MAX_GAP_MIN) out.reasons.push(`collection: a ${Math.round(maxGapMin)}-minute gap between market-hours polls (> 10)`);
    const fail = (src) => L.filter((x) => x.kind === 'POLL_STATUS' && x.source === src && !x.ok).map((x) => x.error).slice(-1)[0];
    if (!byKind.EARNINGS_SNAPSHOT) out.reasons.push(`sources: no earnings snapshot${fail('finnhub-earnings') ? ` (finnhub-earnings: ${fail('finnhub-earnings')})` : ''}`);
    else if (!L.some((x) => x.kind === 'EARNINGS_SNAPSHOT' && x.complete !== false)) {
      const e = L.filter((x) => x.kind === 'EARNINGS_SNAPSHOT').slice(-1)[0];
      out.reasons.push(`sources: earnings snapshot incomplete (${(e.errors || []).map((x) => `${x.symbol}: ${x.error}`).join(', ')})`);
    }
    if (!byKind.MACRO_SNAPSHOT) out.reasons.push(`sources: no macro snapshot${fail('macro-feed') ? ` (macro-feed: ${fail('macro-feed')})` : ''}`);
    const hours = new Set(statuses.filter(inMkt).map((s) => Math.floor((T.minuteOf(s.at) - 30) / 60)));
    if (hours.size < MIN_STATUS_HOURS) out.reasons.push(`recorder: STATUS lines in ${hours.size} of 7 market hours (< ${MIN_STATUS_HOURS})`);
    if (dr.sum > 0) out.reasons.push(`recorder: ${dr.sum} record(s) dropped that day`);
    if (er.sum > 0) out.reasons.push(`recorder: ${er.sum} write / serialize / record error(s) that day`);
    if (statuses.some((s) => s.stalled)) out.reasons.push('recorder: a write stall was reported');
    const mk = statuses.filter(inMkt).map((s) => s.health || {});
    out.process = { cpuP95: pct(mk.map((h) => h.cpuPct), 0.95), rssMax: pct(mk.map((h) => h.rssMb), 1), loopP99Max: pct(mk.map((h) => h.loopP99Ms), 1) };
    if (!budget) out.reasons.push('process: no CPU / memory budget measured yet (tools/event-research/budget.json, Task 16)');
    else {
      if (out.process.cpuP95 === null || out.process.cpuP95 > budget.cpuPctP95Max) out.reasons.push(`process: CPU p95 ${out.process.cpuP95}% (budget ${budget.cpuPctP95Max}%)`);
      if (out.process.rssMax === null || out.process.rssMax > budget.rssMbMax) out.reasons.push(`process: memory (RSS) max ${out.process.rssMax} MB (budget ${budget.rssMbMax} MB)`);
      if (out.process.loopP99Max === null || out.process.loopP99Max > budget.loopP99MsMax) out.reasons.push(`process: event-loop p99 max ${out.process.loopP99Max} ms (budget ${budget.loopP99MsMax} ms)`);
    }
    out.healthy = out.reasons.length === 0;
    return out;
  });
  const sessions = days.filter((d) => d.session);
  const last10 = sessions.slice(-10);
  return { files: files.length, days, pilotCriteria: { sessions: sessions.length, healthy: sessions.filter((d) => d.healthy).length,
    ok: last10.length === 10 && last10.every((d) => d.healthy) } };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const bf = args.includes('--budget') ? args[args.indexOf('--budget') + 1] : path.join(__dirname, 'budget.json');
  const budget = fs.existsSync(bf) ? JSON.parse(fs.readFileSync(bf, 'utf8')) : null;
  const s = summarize(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--budget') || '.', { budget });
  if (!s.files) { console.log('no events-*.jsonl files in this folder (an older vm-audit, or the capture is not deployed)'); process.exit(0); }
  for (const d of s.days) {
    if (!d.session) { console.log(`${d.day}  not a market session (no market-hours polls)`); continue; }
    console.log(`${d.day}  ${d.healthy ? 'HEALTHY' : 'NOT HEALTHY'}  polls ${d.polls.present}/${d.polls.expected} (ok ${d.polls.ok}, max gap ${d.polls.maxGapMin} min)  news ${d.news}  CPU p95 ${d.process.cpuP95}%  RSS ${d.process.rssMax} MB  loop p99 ${d.process.loopP99Max} ms`);
    for (const r of d.reasons) console.log(`    - ${r}`);
  }
  console.log(`pilot criteria: ${s.pilotCriteria.healthy} healthy of ${s.pilotCriteria.sessions} session(s); the last 10 all healthy: ${s.pilotCriteria.ok ? 'YES (expansion still needs the user\'s approval)' : 'not yet'}`);
}

module.exports = { summarize };
