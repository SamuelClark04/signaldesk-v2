// Phase 94 Stage 1 pilot health check (PC, read-only; correction C4): summarize the events-*.jsonl files of a vm-audit archive.
// Run: node tools/event-research/inspect.js <folder with events-*.jsonl> [--budget tools/event-research/budget.json] [--through YYYY-MM-DD]
//   [--now <ISO time>]
// (--now = when the archive was taken, default now; --through = the last date to report, default the --now date: sessions after the
// last file count as missing; a session that had not closed by --now is NOT JUDGED, neither healthy nor missing)
// A SESSION is an NYSE trading day (weekdays minus the NYSE holidays below) between the first and last events file: a session with NO file
// (the server was down) is NOT HEALTHY. Session length = 09:30 to 16:00, or 13:00 on NYSE's listed early closes. HEALTHY needs every check:
//   collection   >= 90% of the expected session polls present (one every 2 min), >= 95% of them ok, no gap > 10 min between OK polls
//   sources      the day's earnings snapshot (complete: every capture symbol answered) and macro snapshot both recorded
//   recorder     STATUS lines in all but one of the session's hours; no drop / write / serialize / record error added that day (counters
//                restart from 0 with a new bootId); no stall; no unreadable line
//   news         coverage COMPLETE: no restart gap still pending at the end of the day, none unrecoverable or incompletely recovered,
//                no unread-page backlog > 10 min of the session (news-coverage.js; HTTP-ok polls alone never establish coverage)
//   process      CPU % p95, RSS max and event-loop p99 max within the measured budget (budget.json; none = not healthy)
// NEWS counts are reported, never required: a quiet day with zero headlines is not a failure.
// The pilot criteria (spec 3.1): >= 10 sessions and the LAST 10 all healthy. Expansion still needs the user's approval.
const fs = require('fs');
const path = require('path');
const T = require('../decision-review/time');
const { assess } = require('./news-coverage');

// Phase 95: the NYSE calendar lives in server/research/nyse-calendar.js (shared with the VM collector).
const { NYSE_HOLIDAYS, NYSE_EARLY_CLOSES, CALENDAR_YEARS, isSessionDay, closeMinOf } = require('../../server/research/nyse-calendar');
function daysBetween(a, b) { const out = []; for (let t = Date.parse(`${a}T12:00:00Z`); t <= Date.parse(`${b}T12:00:00Z`); t += 864e5) out.push(new Date(t).toISOString().slice(0, 10)); return out; }
const POLL_EVERY_MIN = 2;
const MIN_PRESENT = 0.9; const MIN_OK = 0.95; const MAX_GAP_MIN = 10;
const read = (f) => fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return { kind: 'UNREADABLE' }; } });
const pct = (xs, p) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : null; };

// Counters are cumulative per process: count only what was ADDED. A new bootId (or a lower value) = a restart, counted from 0.
function added(statuses, field, base) {
  let prev = base.value; let boot = base.bootId; let sum = 0;
  for (const s of statuses) { const v = Number(s[field]) || 0; const restarted = (s.bootId && boot && s.bootId !== boot) || v < prev; sum += restarted ? v : v - prev; prev = v; boot = s.bootId || boot; }
  return { sum, last: { value: prev, bootId: boot } };
}

function summarize(dir, { budget = null, through = null, now = null } = {}) {
  if (!fs.existsSync(dir)) return { files: 0, days: [], pilotCriteria: { sessions: 0, healthy: 0, ok: false } };
  const files = fs.readdirSync(dir).filter((f) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  if (!files.length) return { files: 0, days: [], pilotCriteria: { sessions: 0, healthy: 0, ok: false } };
  const base = { dropped: { value: 0, bootId: null }, errors: { value: 0, bootId: null } };
  const byDay = new Map(files.map((f) => [f.slice(7, 17), f]));
  // review: `through` (the audit date) extends the range, so an outage AFTER the last file is a missing session too.
  // review: `through` is the last date reported, before or after the last file (never before the first file).
  const last = through ? (through < files[0].slice(7, 17) ? files[0].slice(7, 17) : through) : files[files.length - 1].slice(7, 17);
  const range = daysBetween(files[0].slice(7, 17), last);
  const years = [...new Set(range.map((d) => Number(d.slice(0, 4))))].filter((y) => !CALENDAR_YEARS.includes(y));
  const warnings = years.length ? [`the NYSE calendar here covers ${CALENDAR_YEARS.join(' / ')} only: holidays in ${years.join(', ')} count as sessions (extend NYSE_HOLIDAYS)`] : [];
  const linesByDay = new Map([...byDay].map(([d, f]) => [d, read(path.join(dir, f))]));
  // Fix 3: news coverage needs every file (a gap's recovery may be recorded on a later day); HTTP-ok polls alone never establish it.
  const newsGaps = assess(linesByDay, range.filter(isSessionDay), { openAt: (d) => T.at(d, T.OPEN_MIN), closeAt: (d) => T.at(d, closeMinOf(d)), firstDay: files[0].slice(7, 17), now: now === null ? Infinity : now });
  const days = range.map((day) => {
    // A session that had not closed at the audit time (`now`) is not judged: its file is partial, and no file yet is not an outage.
    if (now !== null && isSessionDay(day) && now < T.at(day, closeMinOf(day))) return { day, session: true, inProgress: true, healthy: null, byKind: {}, news: 0,
      reasons: [now < T.at(day, T.OPEN_MIN) ? 'session not yet started at the audit time: not judged' : 'session in progress at the audit time: not judged'] };
    if (!byDay.has(day)) return isSessionDay(day) ? { day, session: true, healthy: false, byKind: {}, news: 0, reasons: ['no events file for this NYSE session (the server was down, or the file was not archived)'] } : { day, session: false, healthy: null, byKind: {}, news: 0, reasons: [] };
    const L = linesByDay.get(day);
    const open = T.at(day, T.OPEN_MIN); const close = T.at(day, closeMinOf(day));
    const inMkt = (x) => x.at >= open && x.at < close;
    const byKind = {}; for (const x of L) byKind[x.kind] = (byKind[x.kind] || 0) + 1;
    const polls = L.filter((x) => x.kind === 'POLL_STATUS' && x.source === 'alpaca-news' && inMkt(x)).sort((a, b) => a.at - b.at);
    const session = isSessionDay(day);
    const out = { day, session, byKind, news: byKind.NEWS || 0, reasons: [] };
    const statuses = L.filter((x) => x.kind === 'STATUS').sort((a, b) => a.at - b.at);
    const errs = statuses.map((s) => ({ bootId: s.bootId, errors: (Number(s.writeErrors) || 0) + (Number(s.serializeErrors) || 0) + (Number(s.recordErrors) || 0) }));
    const dr = added(statuses, 'dropped', base.dropped); const er = added(errs, 'errors', base.errors);
    base.dropped = dr.last; base.errors = er.last;
    if (!session) { out.healthy = null; return out; }
    const expected = Math.floor((closeMinOf(day) - T.OPEN_MIN) / POLL_EVERY_MIN);
    const ok = polls.filter((x) => x.ok).length;
    const times = [open, ...polls.filter((x) => x.ok).map((x) => x.at), close]; // review: failed polls never hide a gap
    const maxGapMin = Math.max(...times.slice(1).map((t, i) => (t - times[i]) / 60000));
    out.polls = { expected, present: polls.length, ok, maxGapMin: Math.round(maxGapMin) };
    if (polls.length / expected < MIN_PRESENT) out.reasons.push(`collection: ${polls.length} of ${expected} expected polls present (< 90%)`);
    if (polls.length && ok / polls.length < MIN_OK) out.reasons.push(`collection: ${ok} of ${polls.length} polls ok (< 95%)`);
    if (maxGapMin > MAX_GAP_MIN) out.reasons.push(`collection: a ${Math.round(maxGapMin)}-minute gap between OK polls (> 10)`);
    const newsReasons = newsGaps.get(day) || [];
    out.newsCoverage = newsReasons.length ? 'INCOMPLETE' : 'COMPLETE'; // fix 3: never from poll success alone
    out.reasons.push(...newsReasons);
    if (byKind.UNREADABLE) out.reasons.push(`file: ${byKind.UNREADABLE} unreadable line(s)`);
    const fail = (src) => L.filter((x) => x.kind === 'POLL_STATUS' && x.source === src && !x.ok).map((x) => x.error).slice(-1)[0];
    if (!byKind.EARNINGS_SNAPSHOT) out.reasons.push(`sources: no earnings snapshot${fail('finnhub-earnings') ? ` (finnhub-earnings: ${fail('finnhub-earnings')})` : ''}`);
    else if (!L.some((x) => x.kind === 'EARNINGS_SNAPSHOT' && x.complete !== false)) {
      const e = L.filter((x) => x.kind === 'EARNINGS_SNAPSHOT').slice(-1)[0];
      out.reasons.push(`sources: earnings snapshot incomplete (${(e.errors || []).map((x) => `${x.symbol}: ${x.error}`).join(', ')})`);
    }
    if (!byKind.MACRO_SNAPSHOT) out.reasons.push(`sources: no macro snapshot${fail('macro-feed') ? ` (macro-feed: ${fail('macro-feed')})` : ''}`);
    const hours = new Set(statuses.filter(inMkt).map((s) => Math.floor((T.minuteOf(s.at) - 30) / 60)));
    const sessionHours = Math.ceil((closeMinOf(day) - T.OPEN_MIN) / 60); const needHours = sessionHours - 1;
    if (hours.size < needHours) out.reasons.push(`recorder: STATUS lines in ${hours.size} of ${sessionHours} session hours (< ${needHours})`);
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
  const sessions = days.filter((d) => d.session && !d.inProgress);
  const last10 = sessions.slice(-10);
  return { files: files.length, days, warnings, pilotCriteria: { sessions: sessions.length, healthy: sessions.filter((d) => d.healthy).length,
    ok: last10.length === 10 && last10.every((d) => d.healthy) } };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const bf = args.includes('--budget') ? args[args.indexOf('--budget') + 1] : path.join(__dirname, 'budget.json');
  const budget = fs.existsSync(bf) ? JSON.parse(fs.readFileSync(bf, 'utf8')) : null;
  // review: validated, never silently ignored. --now needs a time (a bare date would read as UTC midnight, the evening before in New York).
  const nowArg = args.includes('--now') ? args[args.indexOf('--now') + 1] : null;
  const now = nowArg === null ? Date.now() : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(nowArg || '') ? Date.parse(nowArg) : NaN;
  if (!Number.isFinite(now)) { console.log('--now needs an ISO time with a time of day and a zone (Z or +hh:mm), e.g. 2026-10-09T21:00:00Z'); process.exit(2); }
  const through = args.includes('--through') ? args[args.indexOf('--through') + 1] : T.ymd(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(through || '') || !Number.isFinite(Date.parse(`${through}T12:00:00Z`))) { console.log('--through needs a date, YYYY-MM-DD'); process.exit(2); }
  const s = summarize(args.find((a, i) => !a.startsWith('--') && !['--budget', '--through', '--now'].includes(args[i - 1])) || '.', { budget, through, now });
  for (const w of s.warnings || []) console.log(`WARNING: ${w}`);
  if (!s.files) { console.log('no events-*.jsonl files in this folder (an older vm-audit, or the capture is not deployed)'); process.exit(0); }
  for (const d of s.days) {
    if (!d.session) { console.log(`${d.day}  not a market session (no market-hours polls)`); continue; }
    if (d.inProgress) { console.log(`${d.day}  NOT JUDGED  ${d.reasons[0]}`); continue; }
    if (!d.polls) { console.log(`${d.day}  NOT HEALTHY  no events file`); for (const r of d.reasons) console.log(`    - ${r}`); continue; } // a missing session has no counts to print
    console.log(`${d.day}  ${d.healthy ? 'HEALTHY' : 'NOT HEALTHY'}  polls ${d.polls.present}/${d.polls.expected} (ok ${d.polls.ok}, max gap ${d.polls.maxGapMin} min)  news ${d.news} (coverage ${d.newsCoverage})  CPU p95 ${d.process.cpuP95}%  RSS ${d.process.rssMax} MB  loop p99 ${d.process.loopP99Max} ms`);
    for (const r of d.reasons) console.log(`    - ${r}`);
  }
  console.log(`pilot criteria: ${s.pilotCriteria.healthy} healthy of ${s.pilotCriteria.sessions} session(s); the last 10 all healthy: ${s.pilotCriteria.ok ? 'YES (expansion still needs the user\'s approval)' : 'not yet'}`);
}

module.exports = { summarize, isSessionDay, NYSE_HOLIDAYS, NYSE_EARLY_CLOSES };
