# Research universes (Phase 94)

- `universe-v1.json` is frozen by `scripts/research/freeze-universe.js` as an explicit, dated list (spec 3.1).
  - It is never edited by hand; a change is a new version file.
  - The tool refuses to overwrite an existing file.
- Collection starts with pilot P1 (24 symbols, `server/research/capture-universe.js`).
  - Expanding the capture to universe-v1 needs 10 healthy pilot sessions (`tools/event-research/inspect.js`) AND the user's approval.
- The freeze waits for a vm-audit archive that contains `watchlist.json` (Phase 94 vm-audit copies it).

## Limits of universe-v1 (also written inside the file as `limitations`)

- **It is a pinned CURRENT list: the S&P 100 as listed on the freeze date. It is NOT historical index membership.**
- **Earlier dates are survivorship-biased.** Applied to dates before the freeze (the 2018-2025 backfill), the list includes companies
  that joined the index later and omits companies that left it before the freeze. Results there are labelled "membership as of
  <frozenOn>, applied retroactively".
- **The source is secondary.** It is the Wikipedia "S&P 100" components table at a pinned revision (id + sha256 recorded). It can lag an
  index change or contain an error; a correction is a new version.
- **Real historical membership needs a separate dated source.** None is in scope or purchased.
- **Forward-collected data has none of these problems.** The list was fixed before that data existed.
- **The request uses the application identifier as its User-Agent, never a personal email (spec 4.0).** If Wikipedia refuses it, the
  freeze stops and reports it.
