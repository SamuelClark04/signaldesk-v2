# Phase 95: running the research system on this PC (desktop mode)

The cloud VM is not used (no billing account). Everything runs on this PC:

| Process | Started by | What it does |
|---|---|---|
| Trading server (`node server\server.js`) | `scripts\Start-SignalDesk.bat` (its own window) | the app, unchanged: paper lock, manual approval for real trading, Phase 94 news / event recording (`server\data\events-*.jsonl`) and decision recording (`decisions-*.jsonl`) |
| Research supervisor + collector (`scripts\research-supervisor.js`, `server\research\collector\main.js`) | the same `.bat` (background, no window); restarts the collector if it crashes | RECORD-ONLY option data: every 30 min in session it re-centres the contract selection (Q = nearest 1-7 DTE, D / W = monthlies), samples the Q grid every minute and the pinned D / W contracts every 10 min; files `server\data\research-YYYY-MM-DD.jsonl`, `research-pins.json` |
| Post-session research job (`tools\research\shadow\nightly.js`) | the collector, from 16:40 ET on each session day (and at the next start if the PC was off) | ingests the option data into `research-data\`, fetches stock bars, finds the opportunities, simulates the frozen exit rules with realistic fills, writes `reports\shadow-<day>.html` |

Commands:

```bat
npm run research:status    REM is it running, which report is the latest
npm run research:report    REM run the post-session job now (for the last completed session)
npm run research:stop      REM stop the collector (Stop-SignalDesk.bat stops both)
```

**The PC must be on (and awake) during market hours** for option quotes to be recorded: Alpaca serves NO historical option quotes, so a
missed session cannot be recovered. Stock bars and news are re-fetched / caught up later (news catch-up <= 24 h). If the PC sleeps,
set Windows power options to never sleep while plugged in during market hours.

Research never places orders: the collector's module graph is an exact allowlist (tests/ph95collector.js) and the research job loads
no broker, execution, strategy or vault module (tests/ph95shadow.js).

## What the report means

- **Price label INDICATIVE_ESTIMATE**: Alpaca's free plan gives indicative (approximated) option quotes; per Alpaca they are not for
  strategy validation. Results are estimates; executable-profit validation is **UNAVAILABLE** until OPRA quotes are available.
- **OPRA**: the account returns `403 OPRA agreement is not signed`. Account action: sign the OPRA market-data agreement in the Alpaca
  dashboard. Real-time OPRA on Alpaca is part of the paid Algo Trader Plus plan (a purchase: needs a separate approval). The nightly
  job re-checks it and states the result in the report; once served, set `RESEARCH_OPTIONS_FEED=opra` in `.env`.
- Opportunities (`triggers@1-lite`): opening-range breaks (5 / 15 / 30 min), prior-30-min range breaks, VWAP crosses, 15-min moves of
  1.5 x ATR(14, 1-min), reversal confirmations (1.0 / 0.5 x ATR30), rebounds (50% of a 2 x ATR30 swing), opening gaps (held / filled
  by 10:00), the first news item, every app decision (staged, rejected or blocked) and controls at 10:00 / 11:30 / 14:00.
- Exit rules (`exits@1`, frozen): Q = net target $20 / 40 / 60 / 80 x time stop 30 / 60 min, stop -$40, flat 15:50; H = 2 h,
  stop -50%; D = session +1 / +3 / +5, stop -50%; W = session +10 / +20, stop -50%; all exit at 2 DTE from 10:00.
- Fills: the ASK of the first eligible quote >= 5 s after the decision; exits at the BID of the next quote after the trigger;
  $0.05 / contract / side fees (assumption); stress = 10% of the spread worse each side. Unfilled, no-selection and skipped entries are
  counted, never dropped; wins and losses are listed.
