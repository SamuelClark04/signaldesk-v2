// Phase 94 Stage 1, Task 13 (required by tests/ph94capture.js): the PC pilot health check (tools/event-research/inspect.js, C4).
// A session is healthy only with real collection coverage, healthy sources and CPU / memory within the measured budget; files full of
// failed polls never qualify; zero headlines alone is not a failure.
const fs = require('fs'); const os = require('os'); const path = require('path');

module.exports = async ({ check }) => {
  const insp = require(path.join(__dirname, '..', 'tools', 'event-research', 'inspect'));
  const T = require(path.join(__dirname, '..', 'tools', 'decision-review', 'time'));
  const budget = { cpuPctP95Max: 60, rssMbMax: 400, loopP99MsMax: 200 };
  const day = (ymd, { pollOk = true, pollsEvery = 2, gapAt = null, news = 3, earnings = true, macro = true, status = true, dropped = 0, cpu = 12, rss = 180, loop = 5, stalled = false } = {}) => {
    const L = [];
    for (let m = T.OPEN_MIN; m < T.CLOSE_MIN; m += pollsEvery) {
      if (gapAt && m >= gapAt[0] && m < gapAt[1]) continue;
      L.push({ v: 1, kind: 'POLL_STATUS', at: T.at(ymd, m), source: 'alpaca-news', ok: pollOk, marketOpen: true, ...(pollOk ? { new: 0 } : { error: 'HTTP 503' }) });
    }
    for (let i = 0; i < news; i += 1) L.push({ v: 1, kind: 'NEWS', at: T.at(ymd, 600 + i), docId: `alpaca:${i}`, seenVia: 'poll' });
    if (earnings) L.push({ v: 1, kind: 'EARNINGS_SNAPSHOT', at: T.at(ymd, 7 * 60 + 5), rows: [], complete: earnings !== 'partial', errors: earnings === 'partial' ? [{ symbol: 'TSLA', error: 'HTTP 502' }] : [] }); else L.push({ v: 1, kind: 'POLL_STATUS', at: T.at(ymd, 7 * 60 + 5), source: 'finnhub-earnings', ok: false, error: 'HTTP 401' });
    if (macro) L.push({ v: 1, kind: 'MACRO_SNAPSHOT', at: T.at(ymd, 6 * 60 + 5), rows: [] });
    if (status) for (let m = T.OPEN_MIN; m < T.CLOSE_MIN; m += 10) L.push({ v: 1, kind: 'STATUS', at: T.at(ymd, m), dropped, writeErrors: 0, serializeErrors: 0, recordErrors: 0, stalled, health: { cpuPct: cpu, rssMb: rss, loopP99Ms: loop } });
    return L;
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ph94p-'));
  const put = (ymd, lines) => fs.writeFileSync(path.join(dir, `events-${ymd}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const days = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'];
  for (const d of days) put(d, day(d, { news: d === '2026-09-23' ? 0 : 3 }));
  let s = insp.summarize(dir, { budget });
  check('C4 pilot: 10 healthy sessions qualify (a session with ZERO headlines is still healthy)', s.pilotCriteria.ok === true && s.pilotCriteria.healthy === 10
    && s.days.find((x) => x.day === '2026-09-23').healthy === true, JSON.stringify(s.pilotCriteria));
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ph94p2-'));
  for (const d of days) fs.writeFileSync(path.join(bad, `events-${d}.jsonl`), day(d, { pollOk: false }).map((l) => JSON.stringify(l)).join('\n') + '\n');
  s = insp.summarize(bad, { budget });
  check('C4 pilot: ten files full of FAILED polls are not ten healthy sessions', s.pilotCriteria.ok === false && s.pilotCriteria.healthy === 0
    && s.days.every((x) => x.reasons.some((r) => /polls ok/.test(r))), JSON.stringify(s.days[0].reasons));
  const cases = { partial: { earnings: 'partial' }, gap: { gapAt: [12 * 60, 12 * 60 + 30] }, sparse: { pollsEvery: 5 }, earnings: { earnings: false }, macro: { macro: false }, status: { status: false },
    dropped: { dropped: 3 }, cpu: { cpu: 95 }, rss: { rss: 900 }, loop: { loop: 900 }, stalled: { stalled: true } };
  const expect = { partial: /incomplete/, gap: /gap/, sparse: /polls present/, earnings: /earnings/, macro: /macro/, status: /STATUS/, dropped: /drop|error/, cpu: /CPU/, rss: /memory|RSS/, loop: /event-loop/, stalled: /stall/ };
  const one = (opts) => { const d1 = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ph94p3-')); fs.writeFileSync(path.join(d1, 'events-2026-10-05.jsonl'), day('2026-10-05', opts).map((l) => JSON.stringify(l)).join('\n') + '\n'); return insp.summarize(d1, { budget }).days[0]; };
  const results = Object.entries(cases).map(([k, o]) => { const r = one(o); return [k, r.healthy === false && r.reasons.some((x) => expect[k].test(x)), r.reasons.join('; ')]; });
  check('C4 pilot: each failure makes a session unhealthy with its reason (a 30-min poll gap, < 90% polls, earnings / macro source down, no STATUS coverage, drops, CPU, RSS, event loop, stall)',
    results.every((r) => r[1]), JSON.stringify(results.filter((r) => !r[1])));
  const nob = insp.summarize(dir, {});
  check('C4 pilot: without a measured CPU / memory budget no session qualifies (reason stated)', nob.pilotCriteria.ok === false && nob.days[0].reasons.some((r) => /budget/.test(r)));
  check('inspect: an archive with no events files says so (no crash)', insp.summarize(path.join(dir, 'nothing'), { budget }).files === 0);
  const wk = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ph94p4-'));
  fs.writeFileSync(path.join(wk, 'events-2026-10-04.jsonl'), JSON.stringify({ v: 1, kind: 'STATUS', at: T.at('2026-10-04', 700) }) + '\n'); // a Sunday
  check('inspect: a day with no market-hours polls (weekend / holiday) is not a session, neither healthy nor unhealthy', insp.summarize(wk, { budget }).pilotCriteria.sessions === 0);
};
