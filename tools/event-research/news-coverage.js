// Phase 94 Stage 1 pre-merge fix 3 (PC, read-only): news COVERAGE per NYSE session, for tools/event-research/inspect.js.
// Successful HTTP polls alone never establish complete news coverage. A session's news is INCOMPLETE when, across ALL the archive's files:
//   - a restart gap (NEWS_GAP recovery PENDING) was still unrecovered at the end of that day: no NEWS_RECOVERY COMPLETE naming it yet
//     (a gap stays pending across days until its catch-up has read every page);
//   - a pending gap was closed as NEWS_RECOVERY INCOMPLETE (the 24 h catch-up limit overtook it), on the day that was recorded;
//   - a gap is UNRECOVERABLE (beyond the catch-up limit, or a lost cursor), on the session it was recorded in or the next one.
//     The first start of collection (no saved cursor, on the first file's day) is the pilot's start, not a loss;
//   - unread pages were carried (POLL_STATUS unreadPagesLeft) for more than MAX_BACKLOG_MIN of that session: a persistent backlog;
//   - a gap written before this fix says covered: true with no recovery record: its recovery is not verified.
const T = require('../decision-review/time');

const MAX_BACKLOG_MIN = 10;
const hhmm = (t) => { const m = T.minuteOf(t); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const when = (t) => (t === null || t === undefined ? 'the start of collection' : `${T.ymd(t)} ${hhmm(t)} ET`);

// linesByDay: Map(ymd -> lines of that day's file); sessions: the NYSE session days of the report range; openAt / closeAt(ymd) -> ms.
// Returns Map(ymd -> reasons[]) for the session days (empty = news coverage COMPLETE).
// now: the audit time (a day that had not ended by then is not failed for a gap recorded after its close: the catch-up may still run).
function assess(linesByDay, sessions, { openAt, closeAt, firstDay, now = Infinity }) {
  const out = new Map(sessions.map((d) => [d, []]));
  const all = [...linesByDay.values()].flat().filter((x) => Number.isFinite(x.at)).sort((a, b) => a.at - b.at);
  const recs = all.filter((x) => x.kind === 'NEWS_RECOVERY');
  const nextDay = (d) => new Date(Date.parse(`${d}T12:00:00Z`) + 864e5).toISOString().slice(0, 10);
  const endOf = (d) => T.at(nextDay(d), 0); // review: midnight ET of the next day (T.at(d, 24 * 60) fell back to EST: 1 h late in summer)
  const sessionOf = (at) => sessions.find((d) => endOf(d) > at); // the session the record belongs to (that day, else the next one)
  const add = (d, r) => { if (d && out.has(d) && !out.get(d).includes(r)) out.get(d).push(r); };
  for (const g of all.filter((x) => x.kind === 'NEWS_GAP')) {
    const span = `${when(g.from)} to ${when(g.to)}`;
    const state = g.recovery || (g.covered === true ? 'LEGACY' : 'UNRECOVERABLE');
    if (state === 'UNRECOVERABLE') {
      if (g.from === null && T.ymd(g.at) === firstDay) continue;
      add(sessionOf(g.at), `news: uncovered gap ${span} (${g.reason || 'no reason recorded'})`);
      continue;
    }
    if (state === 'LEGACY') { add(sessionOf(g.at), `news: gap ${span} recorded as covered with no recovery record (written before this check): recovery not verified`); continue; }
    const done = recs.find((r) => r.at >= g.at && Array.isArray(r.gapIds) && r.gapIds.includes(g.gapId));
    const doneAt = done ? done.at : Infinity;
    for (const d of sessions) {
      if (endOf(d) <= g.at || endOf(d) > doneAt) continue; // only the days that ENDED while this gap was still pending
      if (!done && endOf(d) > now && g.at >= closeAt(d)) continue; // review: a restart after the close, archived that evening: not yet judged
      add(d, done ? `news: catch-up of the gap ${span} still pending at the end of the day (${done.status === 'COMPLETE' ? 'completed' : 'closed INCOMPLETE'} ${when(done.at)})`
        : `news: catch-up of the gap ${span} still PENDING: no recovery recorded by the end of the archive`);
    }
    if (done && done.status !== 'COMPLETE') add(sessionOf(done.at), `news: incomplete recovery of the gap ${span} (${done.reason || done.status})`);
  }
  // Unread-page backlogs: from the first OK poll that left pages unread to the first OK poll that read the last page (failed polls in
  // between continue the backlog).
  const polls = all.filter((x) => x.kind === 'POLL_STATUS' && x.source === 'alpaca-news');
  const runs = []; let run = null;
  for (const p of polls) {
    if (!p.ok) continue;
    if (p.unreadPagesLeft && !run) run = { start: p.at, end: Infinity };
    else if (!p.unreadPagesLeft && run) { run.end = p.at; runs.push(run); run = null; }
  }
  if (run) runs.push(run);
  for (const r of runs) {
    for (const d of sessions) {
      const overlapMin = (Math.min(r.end, closeAt(d)) - Math.max(r.start, openAt(d))) / 60000;
      if (overlapMin <= MAX_BACKLOG_MIN) continue;
      add(d, r.end === Infinity ? `news: unread pages carried since ${when(r.start)} and still carried at the end of the archive (a persistent backlog)`
        : `news: unread pages carried for ${Math.round((r.end - r.start) / 60000)} min from ${when(r.start)} (a persistent backlog, > ${MAX_BACKLOG_MIN} min of the session)`);
    }
  }
  return out;
}

module.exports = { assess, MAX_BACKLOG_MIN };
