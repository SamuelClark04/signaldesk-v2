// Phase 93 capture points (required by tests/ph93unit.js after the recorder checks): a REAL pipeline pass + approvals on a scratch
// ledger record every decision path, nothing about the decisions changes, and staged orders never carry chart data.
module.exports = async ({ S, check, rec, dc, readLines, wipe, T }) => {
  T.reset(); T.setClock(null); wipe(); dc.clear();
  require(S + 'execution/exit-pass').reconcile = async () => null;
  require(S + 'execution/exit-pass').run = async () => null;
  require(S + 'connectors/macro-events').refresh = async () => false;
  require(S + 'connectors/coinbase-discovery').stream = () => [];
  require(S + 'market/market-session').isEquityMarketOpen = () => true;
  const prices = require(S + 'market/latest-prices');
  const ledger = require(S + 'execution/paper-ledger');
  const runner = require(S + 'execution/strategy-runner');
  const stock = (asset, px, extra = {}) => { prices.setPolled(asset, px, Date.now()); return { id: `equity-swing:PULLBACK:${asset}:t`, asset, market: 'stocks', strategyId: 'equity-swing', setupType: 'Pullback',
    direction: 'long', timeframe: '1D', entryZone: { min: px * 0.998, max: px }, invalidation: +(px * 0.97).toFixed(2),
    targets: [{ level: 1, price: +(px * 1.07).toFixed(2), allocation: 0.5 }, { level: 2, price: +(px * 1.1).toFixed(2), allocation: 0.5 }],
    catalyst: { type: 'technical', headline: 't', sentimentScore: 0 }, thesis: 'test', confirmationCriteria: ['t'], expectedDuration: '3-10 days', tradeType: 'Swing', timestamp: new Date().toISOString(), ...extra }; };
  const day = Array.from({ length: 260 }, (_, i) => ({ time: 1700000000 + i * 86400, open: 50 + i * 0.1, high: 51 + i * 0.1, low: 49 + i * 0.1, close: 50.5 + i * 0.1 }));
  const jpm = stock('JPM', 250);
  const bad = stock('KO', 60, { invalidation: 61 }); // stop above a long entry: the risk engine rejects it
  dc.capture(jpm.id, { strategyId: 'equity-swing', symbol: 'JPM', values: { sma20: 248.1, sma50: 240.2, recentHigh: 256 }, series: [{ name: 'daily', tf: '1D', bars: day }] });
  const blockId = 'equity-swing:PULLBACK:NFLX:t';
  dc.capture(blockId, { strategyId: 'equity-swing', symbol: 'NFLX', values: { earningsDate: '2026-10-08' }, series: [{ name: 'daily', tf: '1D', bars: day }] });
  runner.collect = async () => [jpm, bad];
  runner.takeBlocks = () => [{ id: blockId, reason: 'EARNINGS_SOON: reports 2026-10-08, 2 trading day(s) away', candidate: { asset: 'NFLX', market: 'stocks', strategyId: 'equity-swing', setupType: 'SMA pullback', direction: 'long', timeframe: '1D' } }];
  runner.scans = () => [];
  const pipeline = require(S + 'execution/pipeline');
  await pipeline.runPipeline({ trigger: 'test' });
  await pipeline.runPipeline({ trigger: 'test' }); // the same rejection + block again: deduplicated
  const staged = ledger.getPendingOrders().find((o) => o.asset === 'JPM');
  check('decisions unchanged: JPM staged, KO rejected by the risk engine (stop on the wrong side), as without the recorder', !!staged && !ledger.getPendingOrders().some((o) => o.asset === 'KO'));
  check('staged orders carry NO chart data (the inputs live beside the setup, never in the ledger / browser)', staged && !JSON.stringify(staged).includes('"bars"') && !('context' in staged));
  // Phase 94 S0-3: a setting changed between the pass and the approval must show up in the APPROVAL's snapshot only (fresh, not reused).
  ledger.updateSettings({ dailyProfitTarget: 777 });
  const router = require(S + 'execution/order-router');
  let err = null;
  try { await router.approveWithGuard(staged.id, { actor: 'user', amount: 0.01 }); } catch (e) { err = e.message; }
  check('approval with a Trade Amount too small to size: refused, the setup stays pending', !!err && ledger.getPendingOrders().some((o) => o.id === staged.id), err);
  const pos = await router.approveWithGuard(staged.id, { actor: 'user' });
  check('approved: a paper position opened', pos && pos.execution === 'PAPER');
  ledger.closePosition(staged.id, 245, 'STOP_LOSS');
  runner.collect = async () => [stock('JPM', 251, { id: 'equity-swing:PULLBACK:JPM:t2' }), stock('XOM', 60, { id: 'equity-swing:PULLBACK:XOM:t' })];
  runner.takeBlocks = () => [];
  await pipeline.runPipeline({ trigger: 'test' });
  const pend = ledger.getPendingOrders();
  const j2 = pend.find((o) => o.id === 'equity-swing:PULLBACK:JPM:t2'); const bac = pend.find((o) => o.id === 'equity-swing:PULLBACK:XOM:t');
  if (j2) router.QUEUE_ACTIONS.REJECT(j2.id);
  if (bac) require(S + 'execution/expiry-sweeper').sweep(() => {}, Date.now() + 24 * 3600 * 1000);
  await rec.flush();
  const L = readLines();
  const paths = (id) => L.filter((x) => x.type === 'decision' && x.id === id).map((x) => x.path);
  check('every decision path recorded: STRATEGY_BLOCK, PIPELINE_REJECT, STAGED, APPROVAL_HOLD, APPROVED, OPENED, CLOSED, USER_REJECT, EXPIRED',
    paths(blockId).join() === 'STRATEGY_BLOCK' && paths(bad.id).join() === 'PIPELINE_REJECT' && paths(jpm.id).join() === 'STAGED,APPROVAL_HOLD,APPROVED,OPENED,CLOSED'
    && paths('equity-swing:PULLBACK:JPM:t2').join() === 'STAGED,USER_REJECT' && paths('equity-swing:PULLBACK:XOM:t').join() === 'STAGED,EXPIRED',
    JSON.stringify({ block: paths(blockId), bad: paths(bad.id), jpm: paths(jpm.id), j2: paths('equity-swing:PULLBACK:JPM:t2'), xom: paths('equity-swing:PULLBACK:XOM:t') }));
  const st = L.find((x) => x.type === 'decision' && x.id === jpm.id && x.path === 'STAGED');
  check('the STAGED record: sized levels, the guard limits of the pass, the recorded inputs (daily series by key)', st.setup.positionSize > 0 && st.guard && st.guard.maxOpenRiskPct !== undefined
    && st.context && st.context.values.sma20 === 248.1 && st.context.series[0].key && L.some((x) => x.type === 'series' && x.key === st.context.series[0].key && x.rows.length === 260));
  const blk = L.find((x) => x.type === 'decision' && x.id === blockId);
  check('the STRATEGY_BLOCK keeps its reason and inputs; the repeated block / rejection on pass 2 is a REPEATS count, not new records', /^EARNINGS_SOON/.test(blk.reason) && blk.context
    && L.filter((x) => x.type === 'decision' && x.id === bad.id).length === 1);
  const closed = L.find((x) => x.type === 'decision' && x.id === jpm.id && x.path === 'CLOSED');
  check('CLOSED: exit 245, STOP_LOSS, net P&L', closed.setup.exitPrice === 245 && closed.reason === 'STOP_LOSS' && Number.isFinite(closed.setup.netPnl));
  const ver = require(S + 'version').report(ledger.getSettings());
  check('/api/version carries the recorder status (recorded, dropped, errors, missing inputs, last write)', ver.decisionRecorder && Number.isFinite(ver.decisionRecorder.dropped)
    && ver.decisionRecorder.lastWriteAt > 0 && Number.isFinite(ver.decisionRecorder.missingContext), JSON.stringify(ver.decisionRecorder).slice(0, 200));
  // Phase 94 S0-3: each decision event carries ITS OWN guard snapshot, taken when that event happened (approval-time ones included).
  const decisionEvents = L.filter((x) => x.type === 'decision' && ['STAGED', 'PIPELINE_REJECT', 'STRATEGY_BLOCK', 'APPROVAL_HOLD', 'APPROVAL_REJECT', 'APPROVED', 'ROUTE_FAILED', 'USER_REJECT'].includes(x.path));
  check('S0-3: every staged / rejection / approval-time event has its own guard (limits + kill switch + macro state, stamped)', decisionEvents.length >= 8 && decisionEvents.some((x) => x.path === 'STRATEGY_BLOCK')
    && decisionEvents.every((x) => x.guard && Number.isFinite(x.guard.at) && x.guard.maxOpenRiskPct !== undefined && 'kill' in x.guard && 'macroActive' in x.guard),
    JSON.stringify(decisionEvents.filter((x) => !x.guard || !Number.isFinite(x.guard.at)).map((x) => x.path)));
  const hold = L.find((x) => x.type === 'decision' && x.id === jpm.id && x.path === 'APPROVAL_HOLD');
  const stagedLine = L.find((x) => x.type === 'decision' && x.id === jpm.id && x.path === 'STAGED');
  check('S0-3: the approval-time snapshot is FRESH (a setting changed after the pass appears in it, not in the STAGED snapshot of the pass)', !!(hold && hold.guard && stagedLine && stagedLine.guard)
    && hold.guard.dailyProfitTarget === 777 && stagedLine.guard.dailyProfitTarget !== 777 && hold.guard.at >= stagedLine.guard.at, `${hold && hold.guard && hold.guard.dailyProfitTarget} / ${stagedLine && stagedLine.guard && stagedLine.guard.dailyProfitTarget}`);
  const blkLine = L.find((x) => x.type === 'decision' && x.path === 'STRATEGY_BLOCK');
  check('S0-3: a strategy block recorded in a pass carries the guard of THAT pass (refreshed before blocks are recorded)', !!(blkLine && blkLine.guard && Number.isFinite(blkLine.guard.at)));
};
