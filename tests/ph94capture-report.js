// Phase 94 Stage 1 pre-merge fixes (required by tests/ph94capture.js): the pilot REPORT COMMAND (tools/event-research/inspect.js run as a
// program, not only summarize()) and the news coverage it reports. An outage after the last file must print as missing sessions, never
// crash; successful HTTP polls alone never establish complete news coverage (pending catch-up, unrecovered gaps, unread-page backlogs).
const fs = require('fs'); const os = require('os'); const path = require('path'); const { spawnSync } = require('child_process');

module.exports = async ({ check }) => {
  const ROOT = path.join(__dirname, '..');
  const insp = require(path.join(ROOT, 'tools', 'event-research', 'inspect'));
  const T = require(path.join(ROOT, 'tools', 'decision-review', 'time'));
  const budget = { cpuPctP95Max: 60, rssMbMax: 400, loopP99MsMax: 200 };
  // A healthy session's lines; `extra(ymd)` adds or replaces lines.
  const day = (ymd, { polls = (m) => ({ ok: true, new: 0 }) } = {}) => {
    const L = [];
    for (let m = T.OPEN_MIN; m < T.CLOSE_MIN; m += 2) { const p = polls(m); if (p) L.push({ v: 1, kind: 'POLL_STATUS', at: T.at(ymd, m), source: 'alpaca-news', marketOpen: true, ...p }); }
    L.push({ v: 1, kind: 'EARNINGS_SNAPSHOT', at: T.at(ymd, 7 * 60 + 5), rows: [], complete: true, errors: [] });
    L.push({ v: 1, kind: 'MACRO_SNAPSHOT', at: T.at(ymd, 6 * 60 + 5), rows: [] });
    for (let m = T.OPEN_MIN; m < T.CLOSE_MIN; m += 10) L.push({ v: 1, kind: 'STATUS', at: T.at(ymd, m), bootId: 'boot-A', dropped: 0, writeErrors: 0, serializeErrors: 0, recordErrors: 0, health: { cpuPct: 10, rssMb: 200, loopP99Ms: 5 } });
    return L;
  };
  const folder = (name, files) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `sd-ph94r-${name}-`)); for (const [ymd, L] of Object.entries(files)) fs.writeFileSync(path.join(d, `events-${ymd}.jsonl`), L.map((l) => JSON.stringify(l)).join('\n') + '\n'); return d; };
  const bf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ph94r-b-')), 'budget.json'); fs.writeFileSync(bf, JSON.stringify(budget));
  const cli = (args) => spawnSync(process.execPath, [path.join(ROOT, 'tools', 'event-research', 'inspect.js'), ...args], { encoding: 'utf8', timeout: 30000 });

  // ---------- Fix 2: the report command with missing sessions ----------
  const out = folder('outage', { '2026-10-05': day('2026-10-05'), '2026-10-06': day('2026-10-06') });
  const r = cli([out, '--budget', bf, '--through', '2026-10-09', '--now', '2026-10-09T21:00:00Z']);
  check('report command: an outage AFTER the last file (Oct 7-9) prints missing sessions and exits 0 (no crash)', r.status === 0 && !/TypeError|Cannot read/.test(r.stderr)
    && ['2026-10-07', '2026-10-08', '2026-10-09'].every((d) => new RegExp(`${d}\\s+NOT HEALTHY\\s+no events file`).test(r.stdout)) && /pilot criteria: 2 healthy of 5 session/.test(r.stdout),
    `status ${r.status} ${r.stderr.split('\n').slice(0, 3).join(' | ')} || ${r.stdout.slice(-400)}`);
  const mid = folder('mid', { '2026-10-05': day('2026-10-05'), '2026-10-07': day('2026-10-07') });
  const r2 = cli([mid, '--budget', bf, '--through', '2026-10-07', '--now', '2026-10-07T21:00:00Z']);
  check('report command: a missing session BETWEEN files prints too (Oct 6)', r2.status === 0 && /2026-10-06\s+NOT HEALTHY\s+no events file/.test(r2.stdout), `status ${r2.status} ${r2.stderr.slice(0, 200)}`);
  const r3 = cli([mid, '--budget', path.join(os.tmpdir(), 'no-such-budget.json'), '--through', '2026-10-08', '--now', '2026-10-08T21:00:00Z']);
  check('report command: no budget file + a trailing outage still prints every day (no crash)', r3.status === 0 && /2026-10-08\s+NOT HEALTHY/.test(r3.stdout), `status ${r3.status} ${r3.stderr.slice(0, 200)}`);
  const r4 = cli([mid, '--budget', bf, '--now', '2026-10-08T15:00:00Z']);
  check('report command: --now during a session (11:00 ET) prints it NOT JUDGED, not as an outage', r4.status === 0 && /2026-10-08\s+NOT JUDGED\s+session in progress/.test(r4.stdout), r4.stdout.slice(-300) + r4.stderr.slice(0, 200));
  const r5 = cli([mid, '--budget', bf]);
  check('report command: the defaults (now, today) run without a crash', r5.status === 0 && /pilot criteria/.test(r5.stdout), r5.stderr.slice(0, 200));
  // A session still running at the audit time is not judged (its file is partial; no file yet is not an outage).
  const live = insp.summarize(mid, { budget, through: '2026-10-08', now: T.at('2026-10-08', 11 * 60) });
  const d8 = live.days.find((x) => x.day === '2026-10-08');
  check('report: a session still in progress at the audit time is IN PROGRESS, not an outage, and not counted', d8 && d8.inProgress === true && d8.healthy === null
    && live.pilotCriteria.sessions === 3, JSON.stringify(d8));

  // ---------- Fix 3: news coverage is never established by HTTP-ok polls alone ----------
  const A = (ymd, min) => T.at(ymd, min);
  const gapLine = (ymd, min, gapId, extra = {}) => ({ v: 1, kind: 'NEWS_GAP', at: A(ymd, min), gapId, reason: 'restart: catching up from the saved cursor', from: A(ymd, min) - 7200000, to: A(ymd, min), recovery: 'PENDING', covered: false, ...extra });
  const recLine = (ymd, min, gapIds, status = 'COMPLETE', extra = {}) => ({ v: 1, kind: 'NEWS_RECOVERY', at: A(ymd, min), status, gapIds, ...extra });
  const one = (files, d) => insp.summarize(folder('cov', files), { budget, through: d || Object.keys(files).slice(-1)[0] });
  const dayOf = (s, d) => s.days.find((x) => x.day === d);
  let s = one({ '2026-10-05': [...day('2026-10-05'), gapLine('2026-10-05', 9 * 60, 'g1')] });
  let x = dayOf(s, '2026-10-05');
  check('fix 3: every poll HTTP-ok but a restart gap never recovered -> news coverage INCOMPLETE, NOT HEALTHY (PENDING stated)', x.healthy === false && x.newsCoverage === 'INCOMPLETE'
    && x.polls.ok === x.polls.expected && /still PENDING/.test(x.reasons.join()), JSON.stringify(x.reasons));
  s = one({ '2026-10-05': [...day('2026-10-05'), gapLine('2026-10-05', 9 * 60, 'g1'), recLine('2026-10-05', 9 * 60 + 5, ['g1'])] });
  x = dayOf(s, '2026-10-05');
  check('fix 3: the same gap with its NEWS_RECOVERY COMPLETE that day -> coverage COMPLETE, healthy', x.healthy === true && x.newsCoverage === 'COMPLETE', JSON.stringify(x.reasons));
  s = one({ '2026-10-05': [...day('2026-10-05'), gapLine('2026-10-05', 20 * 60, 'g3')], '2026-10-06': [...day('2026-10-06'), recLine('2026-10-06', 9 * 60 + 40, ['g3'])] });
  check('fix 3: a gap recovered only the next morning -> its own day INCOMPLETE (pending at the end of the day, completed later), the next day healthy',
    /still pending at the end of the day \(completed 2026-10-06/.test(dayOf(s, '2026-10-05').reasons.join()) && dayOf(s, '2026-10-06').healthy === true, JSON.stringify(dayOf(s, '2026-10-05').reasons));
  s = one({ '2026-10-05': [...day('2026-10-05'), gapLine('2026-10-05', 9 * 60, 'g4')], '2026-10-06': [...day('2026-10-06'), recLine('2026-10-06', 9 * 60, ['g4'], 'INCOMPLETE', { reason: 'down past the 24 h limit' })] });
  check('fix 3: a recovery closed INCOMPLETE is reported on the day it was recorded (and the pending day before it)', /incomplete recovery.*24 h limit/.test(dayOf(s, '2026-10-06').reasons.join())
    && dayOf(s, '2026-10-06').healthy === false && /closed INCOMPLETE/.test(dayOf(s, '2026-10-05').reasons.join()), JSON.stringify(dayOf(s, '2026-10-06').reasons));
  s = one({ '2026-10-05': [...day('2026-10-05')], '2026-10-06': [...day('2026-10-06'), gapLine('2026-10-06', 8 * 60, 'g5', { recovery: 'UNRECOVERABLE', reason: 'restart: gap longer than the catch-up limit' })] });
  check('fix 3: an UNRECOVERABLE gap -> uncovered gap reported, NOT HEALTHY', dayOf(s, '2026-10-06').healthy === false && /uncovered gap.*catch-up limit/.test(dayOf(s, '2026-10-06').reasons.join()));
  const firstStart = (ymd) => [{ v: 1, kind: 'NEWS_GAP', at: A(ymd, 8 * 60), gapId: `s-${ymd}`, reason: 'no saved cursor (first start, or the file was lost)', from: null, to: A(ymd, 7 * 60), recovery: 'UNRECOVERABLE', covered: false },
    gapLine(ymd, 8 * 60, `h-${ymd}`), recLine(ymd, 8 * 60 + 3, [`h-${ymd}`])];
  s = one({ '2026-10-05': [...day('2026-10-05'), ...firstStart('2026-10-05')], '2026-10-06': [...day('2026-10-06'), ...firstStart('2026-10-06')] });
  check('fix 3: no saved cursor on the FIRST file\'s day = the start of collection (healthy); on a later day = a lost cursor (NOT HEALTHY)', dayOf(s, '2026-10-05').healthy === true
    && dayOf(s, '2026-10-06').healthy === false && /uncovered gap the start of collection/.test(dayOf(s, '2026-10-06').reasons.join()), JSON.stringify([dayOf(s, '2026-10-05').reasons, dayOf(s, '2026-10-06').reasons]));
  const bl = (from, to) => day('2026-10-05', { polls: (m) => ({ ok: true, new: 1, unreadPagesLeft: m >= from && m < to }) });
  s = one({ '2026-10-05': bl(11 * 60, 11 * 60 + 22) });
  check('fix 3: unread pages carried 22 min in the session (every poll HTTP-ok) -> a persistent backlog, NOT HEALTHY', dayOf(s, '2026-10-05').healthy === false
    && /unread pages carried for 22 min/.test(dayOf(s, '2026-10-05').reasons.join()), JSON.stringify(dayOf(s, '2026-10-05').reasons));
  s = one({ '2026-10-05': bl(11 * 60, 11 * 60 + 6) });
  check('fix 3: a 6-minute backlog that clears is not a failure', dayOf(s, '2026-10-05').healthy === true, JSON.stringify(dayOf(s, '2026-10-05').reasons));
  s = one({ '2026-10-05': bl(15 * 60 + 30, 24 * 60) });
  check('fix 3: unread pages still carried at the end of the archive -> reported as a backlog that never cleared', /still carried at the end of the archive/.test(dayOf(s, '2026-10-05').reasons.join()));
  s = one({ '2026-10-05': [...day('2026-10-05'), { v: 1, kind: 'NEWS_GAP', at: A('2026-10-05', 8 * 60), reason: 'restart', from: A('2026-10-05', 6 * 60), to: A('2026-10-05', 8 * 60), covered: true }] });
  check('fix 3: a gap written before this fix as covered: true without a recovery record -> recovery not verified', dayOf(s, '2026-10-05').healthy === false && /not verified/.test(dayOf(s, '2026-10-05').reasons.join()));
  // Review: the day ends at midnight ET (also in daylight time); an evening restart archived before its catch-up is not yet a failure.
  s = one({ '2026-10-05': [...day('2026-10-05'), gapLine('2026-10-05', 23 * 60 + 50, 'g6')], '2026-10-06': [...day('2026-10-06'), recLine('2026-10-06', 30, ['g6']), gapLine('2026-10-06', 20, 'g7')] });
  check('review: a gap at 23:50 ET recovered at 00:30 fails ITS day; a gap at 00:20 ET the next day never fails the day before', /g6|23:50/.test(dayOf(s, '2026-10-05').reasons.join())
    && !/00:20/.test(dayOf(s, '2026-10-05').reasons.join()) && /still PENDING/.test(dayOf(s, '2026-10-06').reasons.join()), JSON.stringify([dayOf(s, '2026-10-05').reasons, dayOf(s, '2026-10-06').reasons]));
  const eve = folder('eve', { '2026-10-05': [...day('2026-10-05'), gapLine('2026-10-05', 17 * 60, 'g8')] });
  const e1 = insp.summarize(eve, { budget, through: '2026-10-05', now: A('2026-10-05', 17 * 60 + 2) }).days[0];
  const e2 = insp.summarize(eve, { budget, through: '2026-10-05', now: A('2026-10-06', 9 * 60) }).days[0];
  check('review: a 17:00 restart archived at 17:02 (catch-up not run yet) leaves the closed session healthy; still pending the next morning = INCOMPLETE',
    e1.healthy === true && e2.healthy === false && /still PENDING/.test(e2.reasons.join()), JSON.stringify([e1.reasons, e2.reasons]));
  const badT = cli([mid, '--budget', bf, '--through', 'oct-9']); const badN = cli([mid, '--budget', bf, '--now', '2026-10-06']);
  check('review: an invalid --through or a date-only --now is refused with a message (exit 2), never an empty report', badT.status === 2 && /YYYY-MM-DD/.test(badT.stdout)
    && badN.status === 2 && /time of day/.test(badN.stdout), `${badT.status} ${badN.status}`);
  const badZ = cli([mid, '--budget', bf, '--now', '2026-10-09T21:00']);
  check('review: --now without a zone is refused (it would read in the PC\'s own time zone)', badZ.status === 2 && /zone/.test(badZ.stdout), `${badZ.status}`);
  s = one({ '2026-10-05': [...day('2026-10-05'), { v: 1, kind: 'POLL_STATUS', at: A('2026-10-05', 12 * 60), source: 'news-cursor', ok: false, error: 'news lines recorded since 11:45 never reached the disk' }] });
  check('review: a frozen news cursor (POLL_STATUS news-cursor) is reported on its session', dayOf(s, '2026-10-05').healthy === false && /cursor saving stopped/.test(dayOf(s, '2026-10-05').reasons.join()));
  const early = cli([mid, '--budget', bf, '--through', '2026-10-06', '--now', '2026-10-09T21:00:00Z']);
  check('review: --through before the last file is the last date reported (Oct 7 not listed)', early.status === 0 && /2026-10-06/.test(early.stdout) && !/2026-10-07/.test(early.stdout), early.stdout.slice(-300));
  const rc = cli([folder('covcli', { '2026-10-05': [...day('2026-10-05'), gapLine('2026-10-05', 9 * 60, 'g1')] }), '--budget', bf, '--now', '2026-10-05T21:00:00Z']);
  check('fix 3: the report command prints the news coverage and the pending recovery', rc.status === 0 && /coverage INCOMPLETE/.test(rc.stdout) && /still PENDING/.test(rc.stdout), rc.stdout.slice(-400));
};
