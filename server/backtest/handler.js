// Backtest over the WebSocket (Phase 77): the Journal's "Run Backtest" panel.
//   GET_BACKTESTS                          -> BACKTEST_CATALOG { rules, unavailable, days, running }
//   RUN_BACKTEST { rule, days, requestId } -> BACKTEST_PROGRESS { requestId, text } while it runs (throttled),
//                                             then BACKTEST_RESULT { requestId, ...report | ok: false, error }
// Only the asker gets the answer. Market data only: nothing here can place an order.
const runner = require('./runner');

const PROGRESS_MS = 700;

function handle(ws, msg, send) {
  if (msg.type === 'GET_BACKTESTS') { send(ws, 'BACKTEST_CATALOG', runner.catalog()); return true; }
  if (msg.type !== 'RUN_BACKTEST') return false;
  const requestId = msg.requestId || null;
  let last = 0;
  const progress = (text) => {
    if (Date.now() - last < PROGRESS_MS) return;
    last = Date.now();
    send(ws, 'BACKTEST_PROGRESS', { requestId, text });
  };
  console.log(`[backtest] ${msg.rule}, ${msg.days || 'default'} days: started`);
  runner.run(String(msg.rule || ''), msg.days, { progress, fresh: msg.fresh === true })
    .then((r) => {
      if (r.ok) console.log(`[backtest] ${r.rule} ${r.days} days: ${r.trades} trades, win ${r.winRate === null ? '-' : Math.round(r.winRate * 100)}%, ${r.totalR.toFixed(1)}R${r.cached ? ' (cached)' : ` in ${(r.runtimeMs / 1000).toFixed(0)} s`}`);
      send(ws, 'BACKTEST_RESULT', { requestId, ...r });
    })
    .catch((err) => send(ws, 'BACKTEST_RESULT', { requestId, ok: false, error: err.message }));
  return true;
}

module.exports = { handle };
