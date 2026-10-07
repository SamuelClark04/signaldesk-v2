// The symbols Stage 1 captures news for (Phase 94 spec 3.1). Pilot P1 = the CORE_WATCHLIST stocks + IWM, DIA, the 11 SPDR sector ETFs
// and SMH (24): a rule fixed before any data. The full universe-v1 list (research/universe/universe-v1.json) replaces it only after
// at least 10 pilot sessions meet the spec 3.1 / C4 health criteria AND the user approves the expansion.
const { CORE_WATCHLIST } = require('../market/universe');

const PILOT_P1 = Object.freeze([...CORE_WATCHLIST.filter((s) => !s.includes('-')), 'IWM', 'DIA',
  'XLB', 'XLC', 'XLE', 'XLF', 'XLI', 'XLK', 'XLP', 'XLRE', 'XLU', 'XLV', 'XLY', 'SMH']);
const symbols = () => PILOT_P1;

module.exports = { PILOT_P1, symbols, VERSION: 'pilot-p1' };
