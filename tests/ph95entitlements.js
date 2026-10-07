// Phase 95 Task 0.2: the option-data re-probe's pure helpers (no network). Run: node tests/ph95entitlements.js
const path = require('path');
global.fetch = async () => { throw new Error('test: no network'); };
let fails = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${x ? ` - ${x}` : ''}`); if (!ok) fails += 1; };
const E = require(path.join(__dirname, '..', 'scripts', 'research', 'entitlements-options'));

check('chainSymbols: the contract symbols of a chain answer (empty when none)', E.chainSymbols({ snapshots: { SPY261120C00650000: {}, SPY261120P00650000: {} } }).length === 2
  && E.chainSymbols(null).length === 0);
const f = { expFrom: '2026-10-21', expTo: '2026-12-06', kMin: 640, kMax: 700, type: 'call' };
check('filterRespected: an in-range call passes', E.filterRespected(['SPY261120C00650000'], f));
check('filterRespected: a put, a strike outside, an expiry outside, or an unparseable symbol each fail',
  !E.filterRespected(['SPY261120P00650000'], f) && !E.filterRespected(['SPY261120C00720000'], f) && !E.filterRespected(['SPY270115C00650000'], f)
  && !E.filterRespected(['garbage'], f));
check('filterRespected: dotted underlyings (BRK.B) parse', E.filterRespected(['BRK.B261120C00650000'], f));
const now = Date.parse('2026-10-07T15:30:00Z');
check('quoteAgeMin: minutes from the provider quote time to now (null without a quote)', E.quoteAgeMin({ latestQuote: { t: '2026-10-07T15:14:30Z' } }, now) === 16
  && E.quoteAgeMin({}, now) === null);

console.log(`\nph95entitlements: ${fails ? `${fails} FAIL` : 'all passed'}`);
process.exit(fails ? 1 : 0);
