// Phase 94 Stage 1, Task 15: the universe-v1 freeze tool (explicit, dated list; sources hashed; limitations written into the file).
// No network: the parser and the builder are tested on fixtures. Run: node tests/ph94universe.js
const path = require('path');
global.fetch = async () => { throw new Error('test: no network'); };
let fails = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${x ? ` - ${x}` : ''}`); if (!ok) fails += 1; };

const fu = require(path.join(__dirname, '..', 'scripts', 'research', 'freeze-universe'));
const wt = '== Components ==\n{| class="wikitable sortable"\n|-\n! Symbol\n! Name\n! Sector\n|-\n| AAPL\n| [[Apple Inc.]]\n| Information Technology\n|-\n| BRK.B <!-- DO NOT CHANGE THIS TICKER TO BRK-B -->\n| [[Berkshire Hathaway]]\n| Financials\n|-\n| GOOGL\n| [[Alphabet Inc.|Alphabet]] (Class A)\n| Communication Services\n|}\n';
const comps = fu.parseComponents(wt);
check('freeze: parses the components table (symbol, name, sector; piped links keep the display name)', comps.length === 3 && comps[1].symbol === 'BRK.B' && comps[0].sector === 'Information Technology'
  && comps[2].name === 'Alphabet (Class A)', JSON.stringify(comps));
const u = fu.build({ components: comps, revid: 1, rawSha: 'abc', appStocks: ['SPY', 'AAPL', 'PLTR'], appCommit: 'c0ffee', watchlist: ['HOOD', 'BTC-USD'], watchlistSha: 'def', frozenOn: '2026-10-07' });
check('freeze: every symbol lists its sources; benchmarks and the pilot are explicit; dated', u.frozenOn === '2026-10-07' && u.symbols.find((s) => s.symbol === 'AAPL').sources.join() === 'sp100,app-stocks'
  && u.symbols.some((s) => s.symbol === 'HOOD') && !u.symbols.some((s) => s.symbol === 'BTC-USD') && u.benchmarks.includes('XLY') && u.pilot.symbols.length === 24 && u.sources.length === 3);
check('freeze: benchmarks are kept apart from the stock list (SPY is a benchmark, not a stock entry)', !u.symbols.some((s) => s.symbol === 'SPY'));
check('freeze: the file states its limits (a pinned CURRENT list, not historical membership; survivorship; secondary source)',
  u.limitations.length >= 3 && /not historical index membership/i.test(u.limitations.join(' ')) && /survivorship/i.test(u.limitations.join(' ')) && /secondary source/i.test(u.limitations.join(' ')));
check('freeze: the Wikipedia source records the pinned revision and the raw-page hash', u.sources[0].revid === 1 && u.sources[0].sha256 === 'abc');
const wl = fu.watchlistSymbols({ items: [{ symbol: 'NVDA' }, { symbol: 'ETH-USD' }] });
check('freeze: watchlist.json shapes ({ items: [...] } or an array of strings / objects) are read', wl.join() === 'NVDA,ETH-USD' && fu.watchlistSymbols(['AAPL', { symbol: 'MU' }]).join() === 'AAPL,MU');

console.log(`\nph94universe: ${fails ? `${fails} FAIL` : 'all passed'}`);
process.exit(fails ? 1 : 0);
