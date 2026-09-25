// Live prices for the stocks the WebSocket does not carry (Phase 59B).
// Alpaca's free IEX WebSocket takes 30 symbols (universe.js streams the first 30:
// all 25 optionables first). Its REST market data has no symbol cap, so during the
// regular US session (market-session.js) this polls, every POLL_MS and in ONE
// request each, every universe stock + manual external stock holding without a
// WebSocket bar in the last STREAM_QUIET_MS:
//   /v2/stocks/snapshots      latest-prices.setPolled(symbol, price, time): the newer
//                             of the last IEX trade and the tight two-sided IEX quote
//                             mid (history-bars getLivePrices), for approvals, exits,
//                             marks and scans
//   /v2/stocks/bars 1Min      today's session bars into the stream's bar store
//                             (alpaca-stock-socket.ingest), so System 1's intraday
//                             setups, System 5's session read, trigger proximity
//                             and VWAP see these stocks exactly like streamed ones
// Freshness is unchanged (latest-prices MAX_PRICE_AGE_MS on the trade's own time).
// Outside the session it idles; reference-prices.js serves the last close.
const { STOCKS } = require('./universe');
const prices = require('./latest-prices');
const session = require('./market-session');
const alpacaStocks = require('../connectors/alpaca-stock-socket');
const hb = require('../connectors/history-bars');

const POLL_MS = 60 * 1000;
const STREAM_QUIET_MS = 3 * 60 * 1000;
const BAR_OVERLAP_MS = 2 * 60 * 1000; // re-read the last 2 bars (the newest may have been forming)

const lastBar = new Map(); // symbol -> ms of the newest bar ingested
let timer = null;
let lastError = null;
let last = { at: null, open: null, symbols: [], priced: [], bars: 0, error: null };

function externalStocks() {
  try { return require('../execution/external-holdings').symbols().filter((s) => !s.includes('-')); } catch { return []; }
}

// Universe + held stocks with no WebSocket bar lately (past the cap, or a quiet stream).
function targets(now = Date.now()) {
  const streamed = alpacaStocks.streamTimes();
  return [...new Set([...STOCKS, ...externalStocks()])].filter((s) => !(now - (streamed[s] || 0) <= STREAM_QUIET_MS));
}

async function poll(now = Date.now()) {
  const open = session.isEquityMarketOpen(now);
  if (!open) { last = { ...last, at: now, open, symbols: [], priced: [], bars: 0, error: null }; return last; }
  const symbols = targets(now);
  if (!symbols.length) { last = { at: now, open, symbols, priced: [], bars: 0, error: null }; return last; }
  const errors = [];
  const priced = [];
  const t = await hb.getLivePrices(symbols);
  if (t.ok) {
    for (const [s, x] of Object.entries(t.prices)) { prices.setPolled(s, x.price, x.time); priced.push(s); }
  } else errors.push(`prices: ${t.error}`);
  const since = Math.min(...symbols.map((s) => (lastBar.has(s) ? lastBar.get(s) - BAR_OVERLAP_MS : session.sessionOpenMs(now))));
  const b = await hb.getMinuteBarsSince(symbols, since);
  let n = 0;
  if (b.ok) {
    for (const [s, bars] of Object.entries(b.bars)) {
      if (!bars.length) continue;
      alpacaStocks.ingest(bars);
      lastBar.set(s, Math.max(lastBar.get(s) || 0, Date.parse(bars[bars.length - 1].time)));
      n += bars.length;
    }
  } else errors.push(`bars: ${b.error}`);
  const error = errors.join('; ') || null;
  if (error && error !== lastError) console.warn(`[stock-poller] ${error}`);
  if (!error && lastError) console.log('[stock-poller] recovered');
  lastError = error;
  last = { at: now, open, symbols, priced, bars: n, error };
  return last;
}

function start() {
  if (timer) return;
  session.start();
  const run = () => poll().catch((err) => console.error('[stock-poller] poll failed:', err.message));
  setTimeout(run, 4000).unref(); // after the clock's first reading
  timer = setInterval(run, POLL_MS);
  timer.unref();
  console.log(`[stock-poller] REST prices every ${POLL_MS / 1000}s in the US session for stocks without WebSocket bars`);
}
function stop() { clearInterval(timer); timer = null; }

const status = () => ({ ...last, symbols: [...last.symbols], priced: [...last.priced] });

module.exports = { start, stop, poll, targets, status, POLL_MS, STREAM_QUIET_MS };
