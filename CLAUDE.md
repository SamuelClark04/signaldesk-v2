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
  AI keys (Phase 84): every test / harness sets `OPENAI_API_KEY` / `GEMINI_API_KEY` blank and `OPENAI_BASE_URL` /
  `GEMINI_BASE_URL` dead (a provider call costs money); tests inject a fake fetch into ai-analyst.
- **Secrets:** never print or commit `.env` values; API keys travel in headers only.
- **Credentials vault (Phase 73)**: `security/vault.js` (server/data/credentials.enc.json, AES-256-GCM keyed from
  LAN_ACCESS_TOKEN) is applied OVER .env at server boot (`server/boot.js`). A vault on this PC could override a
  harness's mock keys with real ones: every harness / spawned server sets `CREDENTIALS_PATH` to a scratch file
  (ph55real.js does); unit tests never call vault.load(). Never read or write the real credentials.enc.json.
  The browser only gets vault.status() (masked previews), never a secret.
- **Alpaca paper keys (PK...)**: for the LIVE client data-only (market data / news / clock: never
  live holdings, cash, sizing or orders; alpaca-api.dataOnly). They ARE the PAPER broker
  (alpaca-api.paper -> execution/alpaca-paper.js, Settings paperStockBroker 'alpaca'): paper stock
  brackets and options spreads execute in the Alpaca Paper account; its cash / holdings live in the
  `alpacaPaper` snapshot, Paper side only. Until Alpaca reports a fill (fillEstimated) such a record is a WORKING
  order (client netPnl.working: no P&L, "Working"); [Close] cancels it (alpaca-paper.cancelEntry), never a closing trade.
  Paper fills only MARKETABLE orders (NBBO): a spread entry is sent at the natural price from fresh quotes, capped at
  spread-entry.maxDebit (T1 still nets MIN_T1_NET_RR after fees, <= 53% of width, <= +20% risk); re-priced every 3 min
  while working, canceled + voided (ENTRY_UNFILLED) after 15 min (execution/spread-entry.js, Phase 74). Tests / harness point ALPACA_PAPER_BASE_URL at the
  scratchpad `alpacamock.js` (never the user's real paper account).
- **Event loop (Phase 72)**: a loop over symbols awaits `loop-pace.pace()` once per symbol (an `await` on cached data
  never yields); no synchronous per-symbol pass over bars without it. The VM is an e2-micro (0.25 vCPU).
- **Deploy (Compute Engine VM, pm2):** `bash scripts/deploy-vm.sh [pm2-app]` on the VM. New family VMs:
  `scripts/install-free-vm.sh` (swap, Node 20, pm2, cloudflared, .env with LAN_ACCESS_TOKEN / LAN_ACCESS / TUNNEL,
  prints the tunnel sign-in link); idempotent.
- **Network (Phase 73)**: market data / news fetches go through `connectors/net-guard.js` (per-host circuit breaker:
  3 network failures -> fail fast 30 s); broker order / exit calls never do. boot.js sets IPv4-first DNS. A pass runs
  under `loop-pace.watchdog` (PASS_WATCHDOG_MS 45 s): past it the lock is released and the stalled pass is abandoned
  at its next pace() (PASS_ABANDONED). Paper exits run right after broker reconcile, and every 5 s (exit-pass.startFast).
- **Strategies (Phase 75)**: `execution/strategy-runner.js` runs crypto first (swing, intraday, Moonshots), then stocks /
  options, each with a STRATEGY_BUDGET_MS (15 s) budget: a late strategy finishes in the background, its setups carried
  into the next pass. Only watchdog-released passes are abandoned. CPU-heavy per-contract math: no Intl / toLocaleString
  per call (memoize, like options-data.expiryMs / 1-equity-day toEastern); spread-builder build() is async and paced.
  The Moonshot leaderboard persists next to the ledger file (moonshot-radar.json), restored for 6 h.
- **Audit (Phase 76)**: ONE automated trade per symbol per market (order-guard.stackingConflict: open positions, and staged
  setups at the pipeline; Pilot and manual exempt, the LIVE rule unchanged). Time exits (execution/time-exits.js, every exit
  pass): ONLY option spreads, closed at 2 DTE (Phase 82 AUTO_CLOSE_2_DTE; was EXPIRY_EXIT at 3 days); PAPER only (LIVE is reported, never sold).
  Phase 76B (the user's rule): NOTHING else is ever closed on time alone: day trades carry overnight (every Alpaca stock
  bracket is GTC, day trades included), stale Moonshots only get a UI tag (portfolio-table staleBadge, 24 h+); stop,
  target and manual exits decide. Equity swing scans all STOCKS. ORB: breakout above the session VWAP, none while SPY is under its VWAP.
  Tests that call moonshot-radar.compute set RADAR_CACHE_PATH (it otherwise writes next to the REAL ledger).
- **Portfolio risk + attribution + backtest (Phase 77)**: risk/portfolio-risk.js caps the BOOK (a pool of one account): open risk
  (dollarRisk x the stop distance still at risk; option spreads in full) + the new setup <= settings.maxOpenRiskPct (6%) of the
  bankroll it is sized from, and <= settings.maxEquityPerDirection (2) bullish / 2 bearish equity trades open or staged; at staging
  (pipeline) and at approval (order-router: refused but KEPT pending). Pilot / adopted / external holdings and manual orders are
  outside both rules. PORTFOLIO_RISK each pass + on connect. Journal: Strategy Scorecard (client/lib/scorecard.js, UMD: a T1
  partial + runner = one trade) and Backtest (server/backtest: history.js paged bars, engine.js replay with the live exits / cost
  gates, rules-stocks.js / rules-crypto.js ports of the live rules, runner.js reports, handler.js RUN_BACKTEST / GET_BACKTESTS).
  Moonshots / options / Pilot are not replayable (no archived buzz / option chains). The backtest follows the live Strictness dial.
- **Strategy switches (Phase 78)**: settings.strategiesEnabled (strategies/strategy-toggles.js; Settings > Strategies): a strategy
  that is off is never run (strategy-runner), hidden from heating-up / Watching triggers, and "off" in the Scanner log; its open
  trades and staged setups are untouched. Crypto Swing is OFF by default: every replayed variant lost money over 2 x 90 days (base
  PF 0.82-0.96; + BTC daily / 4h regime filter worse; + confirmed reversal candle 0-6 trades). Research script: scratchpad
  ph78exp.js. Re-enable only after a backtest shows an edge; never tune on the window you judge it on.
- **Moonshots entry + live holdings (Phase 79)**: replayed (backtest/rules-moonshots.js, offline: scratchpad ph79exp.js, 62 gems x
  90 days of 5m) the old entry lost (PF 0.86, -24R). strategies/moonshot-entry.js (shared by the live strategy and the replay):
  skip > 18% up over 24h or 15m RSI > 70; a trigger is ARMED, never bought on its breakout bar, and staged only when the price
  retests (Ignition: half the surge back; Coil: the base top) within 1 hour, as a maker buy (no pullback = no trade). Stop floor =
  Coinbase's on every venue (stopFloor: the validated one). Replay: 65 trades PF 1.40 (Kraken 1.21, OKX 1.34), both halves > 1.
  Setups carry expectedDuration (hold window), entrySnapshot (score / parts / volume / spread / 24h / RSI / pullback) and
  entryReason; client/components/trade-context.js shows hold + entry vs live score (the radar always scores held Moonshots) + why,
  on Approvals, setup detail, the position panel and Portfolio. Holdings: execution/live-sync.js re-syncs broker balances
  (read-only) when a LIVE trade opens / closes / resizes; portfolio-metrics lists a LIVE ledger trade its venue's snapshot lacks
  (or with no snapshot) and counts it in Managed / account value. Tests reaching the radar need a scratch LEDGER_STATE_PATH.
- **Taxes & Accounting (Phase 80)**: Journal panel, client-only (no server change). client/lib/tax-report.js (UMD, tested in Node):
  one Form 8949 line per closed journal record (partials = separate sales); basis = paid + buy fee (venue's entryFeeActual, else
  pro rata; options half each), proceeds = basis + netPnl so the gain is the ledger's to the cent; options at debit x 100; shorts:
  (b) = the cover date; long-term only if held MORE than 1 year; New York trade dates / tax year. LIVE only by default (paper rows
  say "do not report"). TTS readiness on LIVE trades (trades / week vs 20, active weekdays vs 75%, average hold vs 31 days, volume;
  period from the first trade to now / year end). 475(f) deadlines (April 15, weekend-rolled). views/journal-taxes.js (hub, CSV
  download via Blob) + views/journal-tax-guide.js (roadmap, built once; expense ticks in localStorage). Education, not tax advice.
- **Entry shields (Phase 81)**: risk/entry-shields.js, on NEW entries only: pipeline staging (after portfolio-risk) and order-router
  approval (a shielded setup STAYS pending); never exits (stops / targets / closes: exit paths must not require it). Manual, Pilot and
  adopted / external are exempt. (1) DAILY_LOSS_LIMIT_REACHED: risk/daily-loss.js, today (New York day) realized + unrealized
  moves, ONE SWITCH PER BOOK since Phase 83: paper (settings.dailyLossLimitPaper, $150) pauses paper entries only, live
  (dailyLossLimitLive, $25) live only (Phase 81's dailyLossLimit migrates to the paper one); latched for the day (only raising
  that limit releases it); in memory. (2) MACRO_SHIELD_ACTIVE: services/macro-calendar.js, 30 min before -> 15 min after a high-impact USD
  release (CPI / PCE / payrolls / unemployment / FOMC / Fed rate): feed MACRO_CALENDAR_URL (Forex Factory weekly JSON; boot + 06:00
  ET, 5 s abort) merged with the built-in official schedule (macro-events FOMC / CPI + BLS / BEA dates: extend yearly); fail-open;
  stocks / options when settings.macroShield, crypto only with macroShieldCrypto. (3) SECTOR_CAP_REACHED: risk/sectors.js groups (mega-cap
  tech + internet = Technology), <= settings.maxTradesPerSector (1) open + staged per book. services/et-time.js: ET <-> epoch (DST-safe).
  ENTRY_SHIELDS each pass + on connect -> components/shield-banner.js ([data-shield] on Today / Opportunities). Test: tests/ph81unit.js
  (in the repo; scratch fixtures in the OS temp dir; a real pipeline pass + approval).
- **Options liquidity (Phase 82)**: execution/options-exit-window.js gates EVERY automated option exit (exit-monitor.premiumExit:
  internal paper + Alpaca Paper) to 9:35 AM - 3:45 PM ET on trading days; a stop / target hit while the market is open outside it
  is saved on the position (p.deferredExit, persisted) and sold at the next 9:35 AM; signals while closed are ignored; manual
  [Close] is never gated. Entry shield OPTIONS_SPREAD_TOO_WIDE: net natural bid / ask from the legs (buy at ask / bid, sell at bid /
  ask) > 25% of its mid. time-exits AUTO_CLOSE_2_DTE: every option position from 10:00 AM ET (before 3:45 PM) once within 2 calendar
  OR 2 trading days of expiry (a Monday expiry closes Thursday), profit or loss. Test: tests/ph82unit.js (controlled clock + marks).
- **Options sizing + limit exits (Phase 83)**: risk-engine sizeOptions: 1R per contract at the EXPECTED EXIT FILL (risk/option-spread-width
  expectedExitRisk: debit - (stop value - half the net bid / ask)); ONE contract over the budget only within OPTIONS_CAP (1.25x the
  risk budget; whole debit <= 6% of the bankroll), else OPTIONS_RISK_EXCEEDS_CAP (the 5.5% / 12% small-account override is gone; the
  spread builder's caps match and take settings.riskPct). resizeOrder: an amount ABOVE the engine's size never passes OVERRIDE_CEILING
  (3% risk / 8% capital; options 1.25x / 6%), confirmed or not (AMOUNT_ABOVE_HARD_CAP). portfolio-risk counts an option position's
  WHOLE debit. Alpaca Paper option exits: NEVER a market order (connectors/alpaca-options.closeSpread needs a limit; an mleg credit is a
  NEGATIVE limit_price); execution/spread-exit.js: stop / 2 DTE / manual exits start at the NBBO mid and step 25% of the bid / ask width
  lower every 15 s (4 steps = 60 s), floor 10% under the natural bid, then rest; take-profits REST at the target value (placed in the
  9:35-3:45 window, canceled + confirmed before any other exit; a target that filled first is booked). exit-pass fast loop (5 s)
  runs Alpaca option exits too (alpaca-paper.exits) and re-quotes held legs every 12 s in market hours. Test: tests/ph83unit.js
  (fake Alpaca). Ad-hoc load checks: node -r <scratchpad>/safe-env.js (never the real ledger).
- **AI Trade Analyst (Phase 84)**: on demand only. POST /api/ai/analyze { mode PRE_TRADE | IN_TRADE, payload: { id } } (http-routes.installAi,
  checkHttp guard) -> services/ai-analyst.js: the facts are REBUILT ON THE SERVER from the ledger by id (services/ai-payload.js: setup /
  position, risk vs budget, option net bid / ask + DTE, crypto spread, unrealized + R now, events, cached headlines, the equity / crypto
  tape; no keys / account ids); fixed risk-manager system prompt (facts only, no price / timing predictions, never widen a stop, 4 fixed
  headings + a "Recommendation:" / "Action:" verdict line); OpenAI (OPENAI_MODEL, gpt-4o-mini) or Gemini (GEMINI_MODEL,
  default gemini-flash-latest since Phase 85b) per settings.aiProvider (auto | openai | gemini); keys = encrypted vault providers `openai` / `gemini` (Settings >
  Accounts & Connections, masked, Test & Save = a free model list) or .env, in request headers only; 15 s abort; clean errors (NO_KEY,
  PROVIDER, RATE_LIMIT, NOT_FOUND); 60 s cache per mode + id, 30 calls / hour; a timing claim in the reply is flagged. Client:
  components/ai-analyst.js modal ([AI Breakdown] on Approvals cards, [AI Briefing] under Close Now on the position panel),
  lib/mini-markdown.js renders text nodes only (never HTML). Test: tests/ph84unit.js.
- **No serial network waits in a pass (Phase 85)**: intelligence/watch-triggers.js requests every watched symbol's daily (+ crypto 1h)
  history AT ONCE (Promise.allSettled), waits at most FETCH_BUDGET_MS (8 s), then computes from the cache (peekDailyBars); a slow host
  fills it for the next pass (one warning per 5 min). The watchdog warning lists the stalled pass's stage times (loop-pace timeline:
  "stage times: exit-pass 1.2 s, ..., watch-triggers 31.0 s (still running)"). alpaca-paper.exits is single-flight (the 5 s loop, the
  pipeline and the reconciler share one run: no duplicate resting targets) and handles positions side by side; the pipeline waits for it
  at most exit-pass EXITS_WAIT_MS (20 s). options-data.refreshQuotes(symbols, now, spotOf, maxAgeMs): the fast loop re-quotes at 12 s,
  an exit step at 10 s. Upstream failures answer 424, never a 5xx (through the Cloudflare tunnel a 502 / 503 reads as "server down"):
  /api/history and /api/ai/analyze. Phase 85b (Gemini "HTTP 400: Request contains an invalid argument"): the
  generateContent body is systemInstruction { parts: [{ text }] } + contents [{ role: 'user', parts: [{ text }] }] + generationConfig
  { maxOutputTokens 2048 } only (no temperature; thinkingConfig { thinkingBudget: 0 } only for gemini-2.5-flash / -lite, the old code sent
  it to every "flash" model); a 400 to a body with thinkingConfig is retried once bare; errors carry Google's fieldViolations; default
  model = Google's alias gemini-flash-latest (2.5 Flash is closed to new keys); Test & Save also reads that model (404 = warning). Scratch runall.sh marks a suite that exits non-zero without FAIL lines as CRASH. Test: tests/ph85unit.js.
- **AI Analyst model fallback (Phase 86)**: Google sheds load per MODEL ("HTTP 503: This model is currently experiencing high demand",
  free tier first). ai-analyst.answer(): the chosen model, then on 404 / 429 / 5xx / timeout / network (never 400 / 401 / 403) the key's
  other stable Flash models from its OWN model list (services/gemini-models.js: GET /models, free, cached 6 h; full Flash newest first,
  then Flash-Lite; no previews / TTS / aliases; fixed list if unreadable; <= 5), then the other provider when its key is set; all within
  TOTAL_MS (30 s; 15 s per call). The reply names the model that answered (+ a note on the busy ones); all busy -> code BUSY (HTTP 424),
  a clear "try again in a few minutes / add an OpenAI key" message and a [Try again] button. Test: tests/ph86unit.js.
- **Shell:** Windows + Git Bash. Write temporary `.js` / `.py` scripts (scratchpad) for
  anything longer than a one-liner instead of complex inline quoting: nested quotes in
  heredocs and `sed` have broken edits before.
- Git: commit only when the phase says so; end commit messages with the Co-Authored-By line.

## Module map

Server (`server/`)
- `server.js` wiring · `boot.js` (.env, IPv4-first DNS, vault) · `client-assets.js` cache-busted client files
- `execution/` `pipeline.js` (60 s loop: reconcile -> strategies -> gates -> risk engine ->
  stage), `exit-pass.js` (broker reconcile first in every pass + at boot; paper exits),
  `paper-ledger.js` + `ledger-live.js` (split / broker fill / bracketStatus / adopted) +
  `ledger-store.js` (state), `message-handler.js` (WS actions), `order-router.js` (APPROVE /
  REJECT, live routing, in-flight lock), `exit-quote.js` (net-first quotes, POSITION_MARKS),
  `coinbase-exit.js` ([Close at Coinbase]: uncertain sells, truthful re-arm), `bracket-ops.js`
  (shared cancel / verify / re-arm / replaceStop), `ratchet.js` (+1R / +1.5R stop locks,
  STOP_GAP_UNFILLED), `order-recovery.js` (orders Coinbase took that the ledger never recorded),
  `chart-ticks.js` (1 s TICKS for charted symbols), `loop-pace.js` (Phase 72: every scan loop awaits pace() per
  symbol so a low-vCPU VM never starves live ticks / HTTP; `[loop] event loop blocked` warning; SCAN_SLICE_MS / SCAN_PAUSE_MS), `paper-pools.js` (Phase 70: separate stocks / options and
  crypto PAPER bankrolls + cash), `crypto-waterfall.js` (Settings venue status strip), `crypto-router.js` + `crypto-venues.js`
  (Phases 69A / 69B: OKX US -> Kraken Pro -> Coinbase waterfall; one connector surface per venue),
  `reconciler.js` (broker truth, UNARMORED, ended partial exits), `external-close.js` (Phase 71: coins sold in
  the venue's app -> CLOSED_EXTERNALLY, auto when the balance is gone twice, or [Mark closed externally]), `expiry-sweeper.js` + `setup-ttl.js`
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
  `crypto-social.js` (Reddit RSS + CoinGecko trending) `news-sentiment.js` `alpaca-*.js` (alpaca-api.dataKeys(): live keys,
  else the Alpaca Paper keys, for market data / news / streams) `history-bars.js` (stock bars BATCHED: one multi-symbol
  request per timeframe; chart reads `{ chart: true }` = cached at once + background refresh + priority slot) `net-guard.js`
- `security/` access-policy, auth-gate, tunnel, `vault.js` + `accounts.js` (Settings > Accounts & Connections: Test & Save
  against the venue, encrypted save, hot reload; WS GET_ACCOUNTS / SAVE_ACCOUNT / REMOVE_ACCOUNT)
- `data/news-feed.js` Catalyst & News Feed (Phase 73: stale-while-revalidate: the first reply from cache < 50 ms, a second when fresh) (Alpaca + crypto RSS + Reddit + trending, 48 h,
  subject-filtered; also the symbol's news sentiment). The rest of `server/data/` is
  ledger state and is git-ignored.

Client (`client/`)
- `app.js` state + WS dispatch · `lib/` (ui, mobile tab bar, venue)
- `views/` `opportunities*.js` (Setups / Approvals / Scanner / Moonshots), `live-chart.js`
  (pane factory), `trade-hud.js` (per-chart HUD factory), `position-detail.js`,
  `opportunity-detail.js`, `moonshots-panel.js`, `setup-analysis.js`, `journal.js`, `settings-accounts.js` (Accounts & Connections, welcome banner, bankroll / mode notes), ...
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
  0.08/0.10%, 'crypto:kraken' 0.25/0.40%, Coinbase = its account tier). OKX rests an OCO (T1 + stop,
  market on trigger; p.brokerOco; oco-upgrade.js converts stop-only ones); Kraken only the stop
  (SignalDesk sells at T1). Market stops: no STOP_GAP. OKX charges a BUY's fee in the coin:
  the position size is what was received. Cash checks use one currency (`spendable`).
  Kraken may take a buy fee in the coin too: closes / stops use the free balance within 1%
  (bracket-ops.sellable); a sell under the venue minimum (orders.sellMinimum) is refused BEFORE
  anything is canceled.
- Crypto stop floors use the routed venue's fees (strategies/venue-floor.js); Trade Ticket crypto
  defaults: 2 x 1h ATR in a 3-5% band (Moonshots 4.5-6.5%), never under that floor
  (ticket-levels.js). [✎ Edit stop / T1] (level-edit.js) tightens a live stop at its venue.
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
