// Phase 94 (spec 3.1): freeze universe-v1 as an EXPLICIT, DATED list. Sources, each recorded with its id / hash:
//   S&P 100 components  Wikipedia "S&P 100" at a pinned revision (revid + sha256 of the raw wikitext; a SECONDARY source, labelled)
//   app stocks          server/market/universe.js STOCKS at the current commit
//   watchlist           the VM's watchlist.json from a vm-audit archive (Phase 94 vm-audit copies it)
// Run: node scripts/research/freeze-universe.js --watchlist <archive>/watchlist.json [--out research/universe/universe-v1.json]
// Network: one GET to en.wikipedia.org with the APPLICATION identifier as User-Agent (spec 4.0: never a personal email). If Wikipedia
// refuses it, the freeze stops and says so: a contact address is added only if the user designates one, never automatically.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BENCHMARKS = ['SPY', 'QQQ', 'IWM', 'DIA', 'XLB', 'XLC', 'XLE', 'XLF', 'XLI', 'XLK', 'XLP', 'XLRE', 'XLU', 'XLV', 'XLY', 'SMH', 'KRE', 'XBI', 'XRT', 'IYT', 'VIXY'];
const PILOT_RULE = 'CORE_WATCHLIST stocks + IWM, DIA, the 11 SPDR sector ETFs and SMH (server/research/capture-universe.js)';
// Spec 3.1: written INTO the file, so no report can present this list as something it is not.
const LIMITATIONS = [
  'A pinned CURRENT list: the S&P 100 as listed on the freeze date. It is not historical index membership.',
  'Applied to dates before the freeze it is survivorship-biased: it includes later joiners and omits companies that left before the freeze. Label such results "membership as of <frozenOn>, applied retroactively".',
  'Wikipedia is a secondary source: it can lag an index change or contain an error. The revision id and sha256 make the exact list reproducible; a correction is a new universe version.',
  'Real historical membership needs a separate dated source (S&P announcements or a point-in-time constituents dataset): not in scope, not purchased.',
];

function parseComponents(wikitext) {
  const i = wikitext.indexOf('Components'); if (i < 0) return [];
  const tbl = wikitext.slice(wikitext.indexOf('{|', i)); const body = tbl.slice(0, tbl.indexOf('|}'));
  return body.split('|-').slice(1).map((r) => r.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('|') && !l.startsWith('|-'))
    .map((l) => l.replace(/^\|\s*/, '').replace(/<!--[\s\S]*?-->/g, '').trim())) // cells may carry editor comments (the BRK.B row does)
    .filter((cells) => cells.length >= 3 && /^[A-Z][A-Z.]{0,6}$/.test(cells[0]))
    .map((cells) => ({ symbol: cells[0], name: cells[1].replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1'), sector: cells[2] }));
}

const watchlistSymbols = (j) => (Array.isArray(j) ? j : (j && j.items) || []).map((x) => (typeof x === 'string' ? x : x && x.symbol)).filter(Boolean);

function build({ components, revid, rawSha, appStocks, appCommit, watchlist, watchlistSha, frozenOn }) {
  const map = new Map();
  const add = (sym, src, extra = {}) => { if (BENCHMARKS.includes(sym)) return; const e = map.get(sym) || { symbol: sym, sources: [] }; if (!e.sources.includes(src)) e.sources.push(src); map.set(sym, { ...e, ...extra }); };
  for (const c of components) add(c.symbol, 'sp100', { name: c.name, sector: c.sector });
  for (const s of appStocks) add(s, 'app-stocks');
  for (const s of watchlist.filter((x) => !x.includes('-'))) add(s, 'vm-watchlist'); // crypto pairs are not part of the stock universe
  const { PILOT_P1 } = require(path.join(__dirname, '..', '..', 'server', 'research', 'capture-universe'));
  return { version: 'universe-v1', frozenOn, limitations: LIMITATIONS,
    sources: [{ id: 'sp100', what: 'S&P 100 components (Wikipedia; a secondary source)', url: 'https://en.wikipedia.org/wiki/S%26P_100', revid, sha256: rawSha },
      { id: 'app-stocks', what: 'server/market/universe.js STOCKS', commit: appCommit }, { id: 'vm-watchlist', what: 'the VM watchlist.json from a vm-audit archive', sha256: watchlistSha }],
    benchmarks: BENCHMARKS, vix: 'Cboe VIX daily; VIXY = the intraday proxy (labelled)',
    symbols: [...map.values()].sort((a, b) => a.symbol.localeCompare(b.symbol)), pilot: { id: 'P1', rule: PILOT_RULE, symbols: [...PILOT_P1] } };
}

async function main() {
  const args = process.argv.slice(2);
  const wl = args.includes('--watchlist') ? args[args.indexOf('--watchlist') + 1] : null;
  if (!wl || !fs.existsSync(wl)) { console.log('usage: --watchlist <archive>/watchlist.json (copied by vm-audit from Phase 94)'); process.exit(2); }
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : path.join(__dirname, '..', '..', 'research', 'universe', 'universe-v1.json');
  if (fs.existsSync(out)) { console.log(`${out} already exists: a frozen universe is never rewritten (a change is a new version file)`); process.exit(2); }
  const res = await fetch('https://en.wikipedia.org/w/api.php?action=parse&page=S%26P_100&prop=wikitext|revid&format=json&formatversion=2', { headers: { 'User-Agent': 'SignalDesk-research/1.0' } });
  if (!res.ok) { console.log(`Wikipedia answered HTTP ${res.status}: not frozen. If it requires a contact address in the User-Agent, ask the user to designate one (never add it automatically).`); process.exit(1); }
  const j = await res.json(); const text = j.parse.wikitext;
  const components = parseComponents(text);
  if (components.length < 95) { console.log(`only ${components.length} components parsed: check the page format before freezing`); process.exit(1); }
  const wlRaw = fs.readFileSync(wl, 'utf8');
  const appCommit = require('child_process').execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  const dirtyTree = require('child_process').execSync('git status --porcelain --untracked-files=no', { encoding: 'utf8' }).trim() !== ''; // recorded: STOCKS may differ from the commit
  const u = build({ components, revid: j.parse.revid, rawSha: crypto.createHash('sha256').update(text).digest('hex'), appStocks: [...require('../../server/market/universe').STOCKS], appCommit,
    watchlist: watchlistSymbols(JSON.parse(wlRaw)), watchlistSha: crypto.createHash('sha256').update(wlRaw).digest('hex'), frozenOn: require('../../server/services/et-time').ymd(Date.now()) });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  u.sources[1].dirtyTree = dirtyTree;
  fs.writeFileSync(out, `${JSON.stringify(u, null, 1)}\n`, { flag: 'wx' }); // 'wx': never overwrites, even if created meanwhile
  console.log(`universe-v1: ${u.symbols.length} symbols + ${u.benchmarks.length} benchmarks, frozen ${u.frozenOn} -> ${out}`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { parseComponents, build, watchlistSymbols, BENCHMARKS, LIMITATIONS };
