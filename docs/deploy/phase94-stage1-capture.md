# Phase 94 Stage 1: record-only event capture (pilot P1): deploy notes

**Status:** implemented on branch `phase94-capture`, NOT deployed. A deploy needs the user's separate approval.
Expanding from pilot P1 to universe-v1 needs the user's approval too.

## What it records

Files: `events-YYYY-MM-DD.jsonl` (New York date), next to the ledger (or `EVENTS_DIR`), kept 60 days. The PC archive is the system of
record. `news-cursor.json` holds the news poll's cursor.

| Kind | What | Source |
|---|---|---|
| NEWS | each news document VERSION (id + updated_at) with OUR receipt time `t_recv`, `seenVia` stream / poll, `versionCoverage: OBSERVED_ONLY`, `receipt: POLL_RECEIPT / STREAM_RECEIPT`, `catchUp` after a restart | a tap on the existing news socket (subscription unchanged) + a REST poll for the 24 pilot symbols, every 2 min in market hours (10 min otherwise) |
| NEWS_GAP | restart gaps, each with a `gapId`. `recovery: PENDING` (the catch-up from the saved cursor, at most 24 h back, has not read every page yet) or `UNRECOVERABLE` (older than 24 h, or no saved cursor). A gap line never claims coverage (`covered: false`); pending gaps persist in `news-cursor.json` across restarts | the news poll at start |
| NEWS_RECOVERY | `COMPLETE`: a query that started at or before the named gaps has read its LAST page. `INCOMPLETE`: a restart past the 24 h limit overtook a pending gap | the news poll |
| NEWS_BACKLOG | `PERSISTENT`: unread pages carried for more than 10 min (news is read late); `CLEARED` with its length once the last page is read | the news poll |
| MACRO_SNAPSHOT | the weekly Forex Factory feed's USD rows with forecast / previous, on each daily refresh | a tap in `macro-calendar.refresh` |
| EARNINGS_SNAPSHOT | Finnhub earnings calendar (30 days ahead) rows for the pilot symbols with their estimates | one call a day after 07:00 ET |
| OPTION_MARK | bid / ask, quote age, IV, Greeks + source, DTE, feed (indicative) of contracts the app already quotes, at most once per contract per minute | a tap in `options-data.refreshQuotes` |
| POLL_STATUS | every news poll (ok / error, cursor, marketOpen, `unreadPagesLeft`, the backlog age, the pending recovery count) and every failed source (finnhub-earnings, macro-feed) | |
| STATUS | every 10 min: counters, stall state, and process health (CPU %, RSS / heap MB, event-loop p99 beyond the 20 ms sampling) | the event recorder |

## What it never does

- It never changes the news subscription. `equity-day` reads that stream, so changing it would be a trading change.
- Nothing in trading reads these files. No strategy input, gate, sizing, exit or approval changes.
- No network request inside a pipeline pass. The poll and the earnings call run on their own unref'd timers, through net-guard
  (a slow host fails fast).
- No key in a URL, and no personal data in any request.
- A failed or hanging disk write never blocks trading. The queue is bounded, a stall shows in the Settings footer
  ("write STALLED"), and a retry never duplicates a written file.

## Switches

- `EVENTS_RECORDER=off` starts nothing and records nothing.
- `EVENTS_DIR` sets another folder.

## After a deploy (when approved)

1. The `[version] running <commit>` line.
2. `/api/version`: `eventRecorder.enabled: true`, `queued` small, `dropped 0`, `stalled false`.
3. Settings > Strategies footer: "Event capture: N today · 0 dropped · 0 write errors · last write HH:MM".
4. After one session: run the pinned vm-audit (Phase 94 copies `events-*.jsonl`, `news-cursor.json` and `watchlist.json`). Then, on the
   PC: `node tools/event-research/inspect.js <archive>/decisions --now <the archive time, ISO>`. Without `--now` the audit time is now;
   a session that had not closed by then is NOT JUDGED (neither healthy nor missing). `--through YYYY-MM-DD` reports later dates too:
   a session with no file is NOT HEALTHY ("no events file"), before, between or after the files.

## Pilot health (correction C4)

A session is HEALTHY only if all of these hold:
- >= 90% of the expected market-hours polls are present and >= 95% of them ok, with no gap over 10 min;
- the earnings and macro snapshots were recorded;
- STATUS lines cover >= 6 of the 7 market hours;
- news coverage is COMPLETE: no restart gap still PENDING at the end of the day, none UNRECOVERABLE or closed INCOMPLETE, and no
  unread-page backlog over 10 min of the session. HTTP-ok polls alone never establish it (`tools/event-research/news-coverage.js`).
  The first start of collection (no saved cursor on the first file's day) is the pilot's start, not a loss;
- no drop, error or stall was added that day;
- CPU p95, RSS max and event-loop p99 are within `tools/event-research/budget.json` (measured in Task 16).

A quiet day with zero headlines is still healthy. The pilot qualifies after >= 10 sessions, with the LAST 10 all healthy. Expansion
then still needs the user's approval.

## Rollback

`EVENTS_RECORDER=off` and a restart, or the previous commit via `scripts/rollback-vm.sh`. Event files are separate from the ledger and
can be left in place.

## Also fixed in vm-audit.sh (found while building this)

The Phase 93 line copying `decisions-*.jsonl` lacked the `\;` that terminates `find -exec`, so `find` failed ("missing argument to
-exec") and NO decision-recorder file was ever copied into an audit archive. Both copy lines now terminate correctly, verified in a
temporary folder.

## Measured budget (Task 16, 2026-10-06)

Browser harness on the PC, 15 minutes in market hours, pilot P1, the same code (7284967), sampled every 30 s:

| Measure | Value |
|---|---|
| Whole-process CPU (one core) | p95 4.1%, mean 2.6% |
| RSS (whole process) | max 333 MB |
| Event-loop p99 beyond the 20 ms sampling | ~14 ms (STATUS lines) |
| Recorders | 0 drops, 0 write errors, 0 stalls; no event-loop warning in the log |
| Written | ~100 KB in 15 min: 152 option marks (12 open paper contracts), 12 news versions, 9 polls, 1 macro snapshot, 1 news gap |

**Projected size:**
- Per market day: marks ~700 B x open contracts x 390 min (12 contracts: ~3.3 MB) + news ~3.5 KB per version (pilot: ~1 MB) = about
  **4-5 MB / day**.
- The full universe roughly multiplies the news part by 5: about **7-9 MB / day**.
- 60-day retention on the VM: under ~0.6 GB.

**Health limits:** `tools/event-research/budget.json`, PROVISIONAL: CPU p95 80% of one core, RSS 600 MB, event-loop p99 200 ms.
- They are sized for the e2-micro, NOT measured on it.
- Re-set them from the first VM pilot sessions; `inspect.js` prints the measured values.
