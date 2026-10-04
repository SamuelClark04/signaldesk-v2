# Phase 92: venue fee verification and OKX listing (sanitized evidence)

All reads below were **read-only**. They used the API keys in this PC's `.env`, loaded into the reading process only, and never printed. The
credentials vault was not read. No orders were placed and no balances were requested. Fee rates belong to the account behind the keys: if the
VM's server uses other accounts, those accounts need their own read. On the VM, the Settings waterfall now shows the read the server itself made.

## 1. Account fee reads

| Time (UTC) | Tool | Venue / market | Endpoint | Maker / taker | Tier |
|---|---|---|---|---|---|
| 2026-10-04 18:07:27 | scratchpad `ph92/fee-verify.js` (standalone) | Coinbase Advanced, account-wide SPOT | `GET /api/v3/brokerage/transaction_summary?product_type=SPOT` | 0.500% / 0.900% | Intro |
| 2026-10-04 18:07:27 | same | Kraken XXBTZUSD, XETHZUSD | `POST /0/private/TradeVolume` (pair XBTUSD,ETHUSD) | 0.400% / 0.800% (both pairs) | 30-day volume based |
| 2026-10-04 18:07:45 | same, retried with OKX's real instrument ids | OKX US BTC-USDC, ETH-USDC, BTC-USDT, ETH-USDT | `GET /api/v5/account/trade-fee?instType=SPOT&instId=...` | 0.200% / 0.350% (all four; USDC-quoted the same) | Lv1 |
| 2026-10-04 23:50:05 | scratchpad `ph92/live-check.js`, through the app's own modules (coinbase-fees.js, venue-fees.js) | the same three | the same | Coinbase 0.500 / 0.900%; Kraken 0.400 / 0.800%; OKX 0.200 / 0.350% | Intro; -; Lv1 |

The first OKX read with instId BTC-USD / ETH-USD returned `51001 Instrument ID ... doesn't exist`: OKX US has no such books (section 2).

The `.env` sets fee overrides only for Coinbase: COINBASE_MAKER_FEE 0.006 / COINBASE_TAKER_FEE 0.012, its fallback until the account read
succeeds. It sets no KRAKEN_* or OKX_* fee overrides. Before Phase 92 the app therefore costed Kraken at 0.25% / 0.40% and OKX at
0.08% / 0.10%. Those were built-in defaults that had never been verified.

## 2. OKX US listing and settlement (public `GET /api/v5/public/instruments?instType=SPOT`, 2026-10-04)

| Book | State | Quote | Settles in (tradeQuoteCcyList) | minSz | tickSz |
|---|---|---|---|---|---|
| BTC-USD, ETH-USD | **not listed** | - | - | - | - |
| BTC-USDC | live | USDC | USDG, USD, USDC, RLUSD | 0.0001 | 0.1 |
| ETH-USDC | live | USDC | USDG, USD, USDC, RLUSD | 0.001 | 0.01 |
| BTC-USDT | live | USDT | USDT | 0.00001 | 0.1 |
| ETH-USDT | live | USDT | USDT | 0.0001 | 0.01 |

The app's mapping, checked with its own module against this listing (702 USD / USDC / USDT books loaded):
- `BTC-USD` resolves to BTC-USDC, then BTC-USDT. `ETH-USD` resolves to ETH-USDC, then ETH-USDT.
- A buy pays in USD (sending `tradeQuoteCcy: USD`) or USDC on the USDC book, or in USDT on the USDT book.
- Spendable cash is the most held in ONE of USD / USDC / USDT. USDG and RLUSD balances are not counted.

tests/ph92unit.js pins all of this.

## 3. OKX candle history (public `history-candles`, bar counts only; for the research protocol)

- BTC-USDC and ETH-USDC: hourly history starts about **2025-08-21**.
- BTC-USDT and ETH-USDT: hourly history from 2019, and 1-minute bars present on 2020-12-01, 2021-06-01 and 2024-03-01.
