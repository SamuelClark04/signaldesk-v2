// Strategy runner for the pipeline pass (Phase 75, out of pipeline.js). Each strategy runs isolated (one failing
// never blocks the others) and:
//   - CRYPTO FIRST (crypto swing, intraday, Moonshots), then stocks / options: a slow stock-options scan can
//     never hold up crypto (the VM log: options-system blocked 36.8 s and every pass was abandoned before
//     the Moonshot Radar)
//   - a time BUDGET per strategy (STRATEGY_BUDGET_MS, 15 s): past it the pass moves on; the strategy finishes
//     in the background and its setups are CARRIED into the next pass (never lost: some strategies signal a
//     symbol once per day), and it is not started again while it is still running
const alpacaStocks = require('../connectors/alpaca-stock-socket');
const alpacaNews = require('../connectors/alpaca-news-socket');
const prices = require('../market/latest-prices');
const loop = require('./loop-pace');

const S = {
  equityDay: require('../strategies/1-equity-day'),
  cryptoSwing: require('../strategies/2-crypto-swing'),
  cryptoIntraday: require('../strategies/2-crypto-intraday'),
  equitySwing: require('../strategies/3-equity-swing'),
  optionsSystem: require('../strategies/5-options-system'),
  speculativeCrypto: require('../strategies/6-speculative-crypto'),
};
const num = (v, d) => (Number(v) > 0 ? Number(v) : d);
const BUDGET_MS = num(process.env.STRATEGY_BUDGET_MS, 15000);
const CARRY_MAX_MS = 5 * 60 * 1000; // a carried setup older than this is dropped (its prices moved on)

const STRATEGIES = [
  ['crypto-swing', () => S.cryptoSwing.generateCandidates(prices.getLatestPrices())],
  ['crypto-intraday', () => S.cryptoIntraday.generateCandidates(prices.getLatestPrices())],
  ['speculative-crypto', () => S.speculativeCrypto.generateCandidates(prices.getLatestPrices())],
  ['equity-day', () => S.equityDay.generateCandidates(alpacaStocks.getLatestBars(), alpacaNews.getNewsContext())],
  // Marks: live, else the last session close (after hours / weekends the scan still runs; see the staging loop).
  ['equity-swing', () => S.equitySwing.generateCandidates(prices.getMarkPrices())],
  // Options plan on marks too (after hours: last close + the chain's last quotes); they stage only on live prices.
  ['options-system', () => S.optionsSystem.generateCandidates(prices.getMarkPrices(), { live: prices.getLatestPrices() })],
];

const running = new Map(); // name -> the job still running past its budget
const carried = new Map(); // name -> { at, list } a late job's setups, for the next pass
const LATE = Symbol('late');

async function collect() {
  const all = [];
  for (const [name, generate] of STRATEGIES) {
    const c = carried.get(name);
    if (c) { carried.delete(name); if (Date.now() - c.at <= CARRY_MAX_MS) all.push(...c.list); }
    if (running.has(name)) { console.warn(`[pipeline] ${name}: still finishing the previous pass's scan; not started again`); continue; }
    const job = loop.during(name, generate);
    let timer;
    const late = new Promise((r) => { timer = setTimeout(() => r(LATE), BUDGET_MS); });
    try {
      const r = await Promise.race([job, late]);
      if (r !== LATE) { all.push(...r); continue; }
      console.warn(`[pipeline] ${name} over its ${BUDGET_MS / 1000} s budget: the pass moves on; its setups join the next pass`);
      running.set(name, job);
      job.then((list) => carried.set(name, { at: Date.now(), list }), (err) => { if (err.code !== 'PASS_ABANDONED') console.error(`[pipeline] strategy ${name} failed:`, err.message); })
        .finally(() => running.delete(name));
    } catch (err) {
      if (err.code === 'PASS_ABANDONED') throw err; // the watchdog released this pass (Phase 73)
      console.error(`[pipeline] strategy ${name} failed:`, err.message);
    } finally { clearTimeout(timer); }
  }
  return all;
}

// Rejection blocks and scan tallies of every strategy (read and cleared after each pass).
const takeBlocks = () => [S.equitySwing, S.cryptoSwing, S.cryptoIntraday, S.optionsSystem, S.speculativeCrypto].flatMap((m) => m.takeBlocks());
const scans = () => [['equity-day', S.equityDay], ['crypto-swing', S.cryptoSwing], ['crypto-intraday', S.cryptoIntraday], ['equity-swing', S.equitySwing],
  ['options-system', S.optionsSystem], ['speculative-crypto', S.speculativeCrypto]].map(([id, m]) => [id, m.takeScan()]);

module.exports = { collect, takeBlocks, scans, STRATEGIES, BUDGET_MS, _state: { running, carried } };
