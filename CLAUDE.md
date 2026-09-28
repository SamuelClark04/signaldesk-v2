# SignalDesk-V2

Personal multi-market trading terminal (Node + Express + WebSocket server, vanilla JS
client). Strategies propose; the risk engine decides; only the ledger holds state. Work
arrives as numbered phases; each ends with a commit + push to `origin main` and a report.

## Hard rules

- **<= 300 lines per `.js` / `.css` file** (`server/server.js` stays under 200). Split into a
  new module before crossing it. Run `npm run check:limits` (syntax + line limits) before
  every commit.
- **Never touch the user's live server.** It runs as `node server\server.js` (the PID changes
  between restarts): never kill it, restart it or send it messages. Stop only processes you
  started (harness / sink), matched by their script name.
- **Never read-modify-write the real ledger** `server/data/ledger-state.json` (or
  `external-holdings.json`). Tests and harnesses set `LEDGER_STATE_PATH`, `WATCHLIST_PATH`
  and `EXTERNAL_HOLDINGS_PATH` to scratch copies *before* requiring any server module.
- **No real orders, no real email.** The user's `.env` has REAL Kraken and OKX keys: every test /
  harness sets `KRAKEN_*` and `OKX_*` (keys + `KRAKEN_API_BASE_URL` / `OKX_BASE_URL`) to local
  signature-verifying mocks (scratchpad `krakenmock.js`, `okxmock.js`) BEFORE requiring any module
  (dotenv never overrides a set variable). Coinbase at a local mock
  (`COINBASE_API_BASE_URL=http://127.0.0.1:<mock port>`, a throwaway EC key; public market
  data is proxied) and SMTP at a local sink (`SMTP_HOST=127.0.0.1`, `SMTP_PORT=2525`). The
  user's `.env` has real keys and `cryptoMode: live`: never APPROVE / close LIVE positions
  against real Coinbase. Unit tests stub `connectors/coinbase-api` and `coinbase-orders`.
- **Secrets:** never print or commit `.env` values; API keys travel in headers only.
- **Shell:** Windows + Git Bash. Write temporary `.js` / `.py` scripts (scratchpad) for
  anything longer than a one-liner instead of complex inline quoting: nested quotes in
  heredocs and `sed` have broken edits before.
- Git: commit only when the phase says so; end commit messages with the Co-Authored-By line.

## Module map

Server (`server/`)
- `server.js` wiring · `client-assets.js` cache-busted client files
- `execution/` `pipeline.js` (60 s loop: reconcile -> strategies -> gates -> risk engine ->
  stage), `exit-pass.js` (broker reconcile first in every pass + at boot; paper exits),
  `paper-ledger.js` + `ledger-live.js` (split / broker fill / bracketStatus / adopted) +
  `ledger-store.js` (state), `message-handler.js` (WS actions), `order-router.js` (APPROVE /
  REJECT, live routing, in-flight lock), `exit-quote.js` (net-first quotes, POSITION_MARKS),
  `coinbase-exit.js` ([Close at Coinbase]: uncertain sells, truthful re-arm), `bracket-ops.js`
  (shared cancel / verify / re-arm / replaceStop), `ratchet.js` (+1R / +1.5R stop locks,
  STOP_GAP_UNFILLED), `order-recovery.js` (orders Coinbase took that the ledger never recorded),
  `chart-ticks.js` (1 s TICKS for charted symbols), `paper-pools.js` (Phase 70: separate stocks / options and
  crypto PAPER bankrolls + cash), `crypto-waterfall.js` (Settings venue status strip), `crypto-router.js` + `crypto-venues.js`
  (Phases 69A / 69B: OKX US -> Kraken Pro -> Coinbase waterfall; one connector surface per venue),
  `reconciler.js` (broker truth, UNARMORED, ended partial exits), `expiry-sweeper.js` + `setup-ttl.js`
  (8 / 15 / 30 min approval windows), `order-guard.js`, `manual-trade.js`,
  `rejection-stats.js` (reason buckets), `scan-log.js`
- `risk/` `risk-engine.js` (sizing, $20 crypto minimum, gates), `cost-authority.js`
  (fees, fee drag caps, stop floors, live Coinbase tier), `break-even.js` (break-even,
  fee hurdle, spread / volume / depth gates, cashout audit), `reality-gate.js` (T1 net R:R),
  `scenarios.js`, `strictness.js`
- `strategies/` `1-equity-day` `2-crypto-swing` `2-crypto-intraday` `3-equity-swing`
  `5-options-system` `6-speculative-crypto` (Moonshots) + helpers (`gem-triggers.js`, ...)
- `intelligence/` `moonshot-radar.js` (100-pt score), `catalyst-summary.js` (why + verdict)
- `config.js` venue credentials read from the environment on each call (OKX keys, `OKX_BASE_URL`,
  default `https://us.okx.com`)
- `connectors/` `okx-api.js` `okx-orders.js` `okx-pairs.js` (OKX US v5: HMAC-SHA256 + passphrase
  auth, SPOT instruments, attached / algo stop-losses, ids `ETH-USD:<ordId>` / `ETH-USD:algo:<id>`)
  `kraken-api.js` `kraken-orders.js` `kraken-pairs.js` (Kraken Pro: HMAC-SHA512
  auth, AssetPairs, conditional-close stops; KRAKEN_API_KEY / SECRET / BASE_URL)
  `coinbase-api.js` `coinbase-socket.js` (ticker: bid/ask/qty)
  `coinbase-fees.js` (account fee tier) `coinbase-discovery.js` (gem catalog)
  `crypto-social.js` (Reddit RSS + CoinGecko trending) `news-sentiment.js` `alpaca-*.js`
- `data/news-feed.js` Catalyst & News Feed (Alpaca + crypto RSS + Reddit + trending, 48 h,
  subject-filtered; also the symbol's news sentiment). The rest of `server/data/` is
  ledger state and is git-ignored.

Client (`client/`)
- `app.js` state + WS dispatch · `lib/` (ui, mobile tab bar, venue)
- `views/` `opportunities*.js` (Setups / Approvals / Scanner / Moonshots), `live-chart.js`
  (pane factory), `trade-hud.js` (per-chart HUD factory), `position-detail.js`,
  `opportunity-detail.js`, `moonshots-panel.js`, `setup-analysis.js`, `journal.js`, ...
- `components/` `net-pnl.js` (net-first P&L, one-tick re-mark), `catalyst-feed.js`,
  `dual-chart-container.js` (Chart 2 + right-column switcher), `live-close.js`,
  `manual-trade-ticket.js`, `chart-data.js`
- `styles/` one stylesheet per area (dark theme tokens in `main.css`)

## Trading rules in code (keep them consistent)

- Crypto tiers: standard (swing / intraday) >= $1.5M 24h volume, spread <= 0.45%, fee drag
  <= 0.30R, T1 >= 1.5 : 1 net; Moonshots >= $350k (>= $200k with a catalyst), spread
  <= 0.80%, fee drag <= 0.35R, T1 >= 1.35 : 1. Crypto positions >= $20 notional.
- Break-even is the fixed sell price after the entry fee and the exit taker fee; P&L gross is
  measured at the best bid so gross + fees = net.
- Paper: two accounts (Phase 70). `settings.bankroll` = stocks / options, `settings.cryptoBankroll`
  = crypto; paper setups size from their pool's bankroll, capped at its paper cash.
- Crypto routing: the cheapest configured venue that lists the pair (and, at approval, has the
  cash in ONE currency its books settle in; live staging also skips venues that cannot fund $20);
  live crypto risk % is of ALL live crypto equity, the cash cap is the routed venue's and
  fee-inclusive (cash / (1 + taker) - $0.02; a cash-bound order may go down to $19.80); staged
  crypto setups re-route each pass (route-refresh.js); costs / break-even / R use that venue's fees (cost-authority.feeKey: 'crypto:okx'
  0.08/0.10%, 'crypto:kraken' 0.25/0.40%, Coinbase = its account tier). OKX and Kraken rest only the
  stop (a market stop: no STOP_GAP); SignalDesk sells at T1. OKX charges a BUY's fee in the coin:
  the position size is what was received. Cash checks use one currency (`spendable`).
- Stops only move UP (ratchet.js): +1.0R -> break-even + 0.05R, +1.5R -> entry + 0.5R; 1R
  (dollarRisk) stays the original risk. No automated setup on a symbol with an open LIVE /
  adopted record (order-guard.stackingConflict); Manual Trade Ticket orders are exempt.

## Testing

- Unit tests are standalone `node phNNunit.js` scripts kept in the session scratchpad (not in
  the repo); each uses a scratch ledger and stubs.
- Browser harness: a scratch copy of the ledger, fake Alpaca stream, mock Coinbase and the
  SMTP sink on port 3999, signed in with the harness token. Verify UI changes there, never
  on the user's server.
- `npm run check:limits` must pass before committing.
