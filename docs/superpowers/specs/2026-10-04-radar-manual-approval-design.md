# Radar mode: paper-only lock, manual-approval guarantee, evidence labels, Quick Flips radar card (Phase 91)

Status: DRAFT for review (2026-10-04). Parts 1 and 2 of the "Scanner-Only / Manual Approval" pivot. Part 3 (an N1 radar scanner) and
a new crypto approach are separate later projects.

## 1. Intent (agreed 2026-10-04)

SignalDesk becomes a scanner and manual execution terminal. Phase 90 showed no automated strategy survives real costs on unseen data.

- **Nothing opens a trade on its own.** Scanners surface setups; an entry happens only when the user clicks Approve (or submits the
  Manual Trade Ticket).
- **Paper only, every market, every mode** (option A): no new live entry of any kind until a strategy passes a pre-registered test.
- **Automatic exits stay**: once an entry is approved, its stop / target / ratchet / time exits run without the user.
- **Every alert states its strategy's test record** (e.g. "PF 0.86 · Failed"), so a failed strategy never looks like a recommendation.
- **Crypto is manual-only**: charts + the Manual Trade Ticket; no crypto scanner runs. Crypto research is a separate future project.
- **Quick Flips is a radar for day options**: shows the contract, the entry rationale and the full cost, then waits for approval.

Success = (a) no code path can open a position without a user action, proven by tests; (b) no code path can send a LIVE entry order
while the lock is on, proven by tests; (c) existing LIVE positions keep being monitored, exited and closable; (d) the stock / options
scanners stage setups into Approvals again, each with its evidence label; (e) a Quick Flips alert can be judged from its card alone.

## 2. What exists today (the starting point)

- Scanners stage setups into Approvals (pendingOrders) after the risk engine and every gate; nothing executes until APPROVE, with ONE
  exception: `execution/auto-paper.js` approves Quick Flips paper setups at once (`settings.quickFlipsAutoPaper`, default true).
- Approvals expire (setup-ttl: 8 / 15 / 30 min; Quick Flips 3 min, entry deadline = signal bar end + 60 s + 3 min).
- An email alert goes out on staging when SMTP is configured (`notifier.sendApprovalAlert`).
- Every scanner is OFF (research pauses 89 / 90). The VM runs stocks PAPER, crypto PAPER, paperStockBroker internal, with 2 LIVE ETH
  positions (Pilot rotation + adopted hold) still monitored: the reconciler, external-close and the close paths query the venue
  whatever the mode setting.
- Entry paths that read the mode: pipeline sizing (`risk/venue-capital`), `order-router` routing, `manual-trade` (crypto `venue: 'live'`
  needs cryptoMode live), Pilot buys (through the router). `external-actions` (Pilot SELL / TRIM of EXTERNAL holdings) refuses in
  paper mode (BROKER_PAPER_MODE).

## 3. Design

### 3.1 Paper-only lock (new `server/risk/paper-lock.js`)

Approaches considered: (a) a code constant; (b) a Settings switch with a typed confirmation; (c) an `.env` flag. **Chosen: (a)**:
`PAPER_ONLY = true`. Unlocking later is a deliberate code change + deploy (a future phase, after a strategy passes); no UI, browser
session or settings file can flip it.

Enforced at three choke points (defense in depth):
1. **Settings** (`ledger-store`): while locked, `stockMode` / `cryptoMode` are forced to `'paper'` at load (logged once:
   `[paper-lock] stockMode live -> paper`) and a save setting either to `'live'` is refused with `PAPER_ONLY_LOCK`. Every entry path
   reads these, so sizing, routing and staging are paper.
2. **Order router**: before any broker submit of an ENTRY, `paperLock.assertPaperEntry(order, route)` throws `PAPER_ONLY_LOCK` if the
   execution would be LIVE (a second wall should a mode ever read live). The setup stays pending, as with other approval refusals.
3. **Manual Trade Ticket**: `venue: 'live'` is refused with `PAPER_ONLY_LOCK` before any routing or cash lookup; the ticket UI hides
   the live option and says why.

Not affected (exits and monitoring): reconcile, stops / targets / ratchet / time exits, [Close] / [Close at Coinbase] /
[Mark closed externally] on the 2 existing LIVE positions, live-sync reads. `external-actions` keeps refusing SELL / TRIM of external
holdings in paper mode (unchanged; sell those in the broker's own app). Settings shows a banner: "Paper-only lock: every new entry is
paper. Existing live positions are still monitored and can be closed."

### 3.2 Manual-approval guarantee

- **Delete `execution/auto-paper.js`** and its call in `pipeline.js`; remove the `quickFlipsAutoPaper` setting (an old saved value is
  ignored on load) and its UI.
- **`order-router.approveWithGuard(id, { actor })`** requires `actor: 'user'` and throws `APPROVAL_REQUIRES_USER` otherwise. Only
  `message-handler` sets it, on an APPROVE from the signed-in WebSocket (a click) and on the Manual Trade Ticket's submit (it injects the
  approve function into `manual-trade`); an `actor` field in the client's message is ignored (overwritten).
- Static test: outside `order-router` itself, only `message-handler` references `approveWithGuard` / `routeApproved` /
  `QUEUE_ACTIONS`.

### 3.3 Radar: scanners on, crypto off

- `strategies/strategy-toggles.js` gains `RADAR_IDS` (equity-day, equity-swing, options-system, options-quickflips) and
  `CRYPTO_MANUAL_ONLY` (crypto-swing, crypto-intraday, speculative-crypto).
- **One-time radar migration** (`settings.radarVersion` 1, like the pause versions): switches the four radar ids ON and the crypto ids
  OFF once; the user may switch radar ids off afterwards (it sticks).
- Crypto ids are never run while manual-only (`strategy-runner` skips them whatever the saved switch) and Settings > Strategies shows
  them disabled: "Manual-only: crypto research is a separate project". The Moonshot radar leaderboard stays an information panel (it
  stages nothing).

### 3.4 Evidence labels (new `server/strategies/strategy-evidence.js`)

One record per strategy id, the single source for the server, the email and the UI:

| id | verdict | label | detail |
|---|---|---|---|
| equity-swing | FAILED | PF 0.86 · Failed | unseen 2022-10..2024-10, 93 trades, -0.13R a trade (Phase 90) |
| equity-day | FAILED | PF 1.11 · Failed | unseen 2022-10..2024-10, 298 trades; PF 0.94 at stress costs; 2nd half below its random control (Phase 90) |
| options-system | FAILED | PF 0.75 · Failed | 2-year replay, both halves lose, no directional information (Phase 87) |
| options-quickflips | FAILED | PF 1.41 dev · Failed | Phase 89 protocol 1: not significant (bootstrap lower bound < 0); IEX version PF 1.10 |
| crypto-swing / crypto-intraday / speculative-crypto | FAILED | PF 0.82-0.96 / 0.81 / 0.58 · Failed | Phases 78 / 89 / 89b (manual-only now) |
| portfolio-pilot | NOT_A_STRATEGY | Pilot · not backtested | rebalancing proposals from your holdings |
| manual | none | (no label) | |

- At staging, the pipeline copies the record onto the setup (`setup.evidence = { verdict, label, detail, source }`), so a card, the
  journal and the email show the record as it was when the alert fired.
- `getSettings()` exposes `strategyEvidence` for Settings > Strategies (shown under each switch with the existing note).
- The approval email puts the label in its first line: `[PF 0.86 · Failed] Equity Swing: AAPL ...`.
- UI: a new `client/components/evidence-badge.js` (amber for FAILED, grey for NOT_A_STRATEGY) on Approvals cards, the opportunity /
  setup detail, the Scanner log rows and the position panel ("opened from a failed strategy" stays visible after approval).

### 3.5 Quick Flips radar card (new `client/components/quickflip-card.js`)

An Approvals card for `strategyId === 'options-quickflips'` replaces the generic options block. Server adds to `optionsData.quickFlip`
the structured fields it already computes: `relVol`, `orHigh`, `orLow` (S1) / `ema20` (S2), `spotAtDecision`, `signalAt`.

- **Contract**: `BUY 1 SPY Oct 9 595 call`, OCC symbol, strike, expiry, DTE, delta, IV.
- **Why**: setup (S1 ORB + VWAP / S2 VWAP pullback); "5-min close 594.62 above the opening range 592.10-594.20 and VWAP 593.40, RelVol
  1.6x; still above at the decision minute"; signal time.
- **Cost** (per contract, x100): ask (the entry limit) $X; bid $Y; spread $ (ask - bid) and % of mid; commission $0.65 x 2 = $1.30;
  "cost if sold at the bid right away" = spread + $1.30; max loss at the -30% stop; target +45% value; quote age at the signal, and
  "Quotes: Alpaca indicative (not OPRA)".
- **Exits that run automatically after approval**: -30% / +45% / 5-min close back through VWAP / 60-min max hold / 3:40 PM deadline.
- **Approve window**: a countdown to `entryDeadlineAt` (the fill must come by then); the button disables at 0 and the card expires.
- **Evidence label** (3.4) at the top; the button reads "Approve (paper)".

`opportunities-approvals.js` (201 lines) only delegates to the component; every file stays <= 300 lines.

## 4. Error handling

- `PAPER_ONLY_LOCK` / `APPROVAL_REQUIRES_USER`: the order stays pending (or the ticket is rejected); the UI shows the reason; logged.
- A setting save with a live mode: refused, the other fields of that save are not applied (existing validation behaviour).
- Missing evidence record (a future strategy id): label "Untested" (grey); never blank.
- Quick Flips card fields missing (an older staged setup): the card falls back to the generic options block.

## 5. Testing

`tests/ph91unit.js` (repo; scratchpad wrapper), with scratch ledgers and stubs per the hard rules:
1. Static: auto-paper.js is gone; outside order-router only message-handler references approveWithGuard / routeApproved / QUEUE_ACTIONS;
   a client APPROVE carrying `actor: 'system'` is still recorded as the user's (overwritten).
2. A real pipeline pass stages a Quick Flips setup; it stays pending (no position) after the pass and after 10 s.
3. `approveWithGuard` without `actor: 'user'` -> APPROVAL_REQUIRES_USER; with it -> a paper position.
4. Lock: load with stockMode / cryptoMode live -> paper; saving live -> PAPER_ONLY_LOCK; the router refuses a forced LIVE entry route;
   the Manual Trade Ticket refuses venue live; no broker stub receives an entry call.
5. Exits under the lock: an existing LIVE position's stop / [Close] still reach the (stubbed) venue.
6. Radar migration runs once; crypto ids never run even if a saved map says on; Settings data marks them manual-only.
7. Evidence: staged setups carry it; the email subject / first line has the label; unknown id -> "Untested".
8. Quick Flips card: rendered in Node with a stub window (as ph89c's banner): cost math (spread %, $1.30, sell-at-bid cost, max loss),
   countdown disabled at the deadline, fallback for an old setup.
Then every suite (runall.sh), `npm run check:limits`, and the browser harness (port 3999): an Approvals Quick Flip card, an evidence
badge, Settings banner + disabled live modes and crypto switches.

## 6. Out of scope

N1 radar scanner (part 3); any crypto scanner or crypto research; unlocking live trading; browser push notifications; changes to the
strategies' rules, the risk engine or the exits.

## 7. Deploy notes

On the VM's first boot: modes already paper (no change), the radar migration switches the four stock / options scanners on, crypto
stays off. Expect setups in Approvals again during market hours, each labelled. Rollback: rollback-vm.sh writes every scanner OFF for
the old code (unchanged).
