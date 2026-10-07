# Phase 94: data entitlements check (2026-10-06)

Read-only probes with the EXISTING keys (no purchase; spec 4.1). Keys in headers only; User-Agent = the application identifier.

| Probe | HTTP | Result |
|---|---|---|
| Stock SIP 1-min bars, last 10 min | 403 | recent SIP blocked (free plan): history only after 15 min |
| Stock SIP 1-min bars, 3 h .. 1 h ago | 200 | ok (118 bars) |
| Option snapshot, indicative feed | 200 | ok: indicative quotes + Greeks |
| Option snapshot, OPRA feed | 403 | OPRA NOT available (OPRA agreement is not signed) |
| Option historical QUOTES | 404 | no historical option quotes endpoint |
| Option trade bars, January 2024 | 200 | status 200, 10 bars |
| Option trade bars, Feb-Mar 2024 | 200 | status 200, 30 bars |
| News, earliest available | 200 | earliest 2015-01-01T19:14:12Z |
| News `start` filters on | 200 | updated_at (3 of 3 revised articles returned for a start between their created_at and updated_at) |
| Finnhub earnings calendar (all US, 30 days) | 200 | ok (1500 rows) |
| Finnhub upgrades / downgrades | 403 | premium only (not in the free plan) |

ThetaData / Massive / Databento: not probed (no account; creating one is the user's action). Their published tiers are in the spec, section 4.

## What this means for each stage (spec 4.1)

| Stage | Needs | Available now? |
|---|---|---|
| 1 (capture) | live news versions, the macro feed, the earnings calendar, indicative option quotes for open positions | yes |
| 2-5 (observation, events, reports) | stock IEX / SIP bars (history after 15 min), news since 2015, SEC EDGAR (needs a user-designated contact address, spec 4.0) | yes, except EDGAR (waits for the contact decision) |
| 6 (call / put simulation) | historical option NBBO quotes | NO: no historical quotes; OPRA not signed. Option results stay `UNAVAILABLE (no quote source)` until a purchase is separately approved. Trade bars (prints) exist and stay Phase 93 "ESTIMATE" only. |

## Findings recorded on 2026-10-06

1. **News `start` filters on `updated_at`.** The news poll's cursor (sort asc by updated date, start = cursor - 5 min) is consistent: a
   revised older article is returned by the poll after its revision.
2. **Option trade bars exist BEFORE Feb 2024** for at least this contract (10 daily bars in January 2024). Phase 89b's note "trade bars from
   Feb 2024" is too narrow. Coverage varies by contract and is checked per contract when used.
3. **Finnhub's earnings calendar answered exactly 1,500 rows for 30 days of all-US earnings**, which looks like a response cap. A single
   all-US call can therefore miss pilot symbols, so the earnings snapshot queries each capture symbol separately (24 small calls a day,
   far under the free 60 / min).

## Phase 95 option-data re-probe (2026-10-07 15:08Z; Task 0.2, `scripts/research/entitlements-options.js`)

Read-only, data keys in headers, application User-Agent. Contract used: `SPY261130C00808000`.

| Probe | HTTP | Result |
|---|---|---|
| (d) Chain endpoint with expiry / strike / type filters (SPY calls, 14-60 days, +/-5%) | 200 | 479 contracts on one page; the filters are RESPECTED |
| (c) `snapshots?symbols=` with 50 / 100 symbols | 200 | all returned, no paging |
| (c) `snapshots?symbols=` with 200 / 250 symbols | 400 | "symbol limit is 100" |
| (a) OPRA snapshot and latest quote (`feed=opra`) | 403 | "OPRA agreement is not signed": no real quotes, even delayed |
| (a) indicative snapshot, same contract | 200 | served, quote 0 min old (real time, approximated) |
| (b) recent option trade bars / trades (3 h .. 20 min ago) | 200 | 13 bars / 24 trades: real prints are served after the delay |

**What this means for the plan:**
- **Batch size:** the collector sends 100 contracts per snapshot request, the confirmed limit.
- **Re-centring:** it uses the filtered chain query.
- **Quote source:** every recorded quote is INDICATIVE. No result can be VALIDATED (plan 5.3) unless real quotes become available. The
  403 names an unsigned OPRA agreement. Whether signing it in the Alpaca dashboard unlocks delayed OPRA quotes on the free plan, and on
  what terms, is the user's to check: accepting an agreement is the user's own action. After that the probe is re-run.
- **Calibration:** indicative quotes can be calibrated against real (delayed) trade prints, as planned.
