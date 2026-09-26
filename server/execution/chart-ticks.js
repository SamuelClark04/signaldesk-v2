// 1-second chart ticks (Phase 68). PRICES_UPDATED reaches clients once per pipeline pass (60 s)
// and POSITION_MARKS every 5 s for held symbols only, so a charted symbol that is not held
// formed its candle from one sample a minute. A client sends WATCH_SYMBOLS { symbols } (its
// charted symbols, at most MAX) whenever a chart changes symbol; every TICK_MS it then gets
// TICKS { at, prices } with those symbols' live prices that moved (crypto: the Coinbase
// ticker, subscribed on demand; stocks: the Alpaca stream / poller). Candles only: the
// client feeds its chart data, never the P&L state (net-pnl marks stay on one server tick).
const prices = require('../market/latest-prices');

const TICK_MS = 1000;
const MAX = 4;
const watchers = new Map(); // ws -> { symbols, send, last: Map(symbol -> price) }
let timer = null;

function tick() {
  for (const [ws, w] of watchers) {
    if (ws.readyState !== 1) { if (ws.readyState > 1) watchers.delete(ws); continue; } // 1 = OPEN; 2/3 closing / closed
    const out = {};
    for (const s of w.symbols) {
      const p = prices.getLatestPrice(s);
      if (p > 0 && w.last.get(s) !== p) { out[s] = p; w.last.set(s, p); }
    }
    if (Object.keys(out).length) w.send(ws, 'TICKS', { at: Date.now(), prices: out });
  }
}

// WATCH_SYMBOLS from a client: remember its symbols (replacing the last list). true when handled.
function handle(ws, msg, send) {
  if (msg.type !== 'WATCH_SYMBOLS') return false;
  const symbols = [...new Set((Array.isArray(msg.symbols) ? msg.symbols : []).map((s) => String(s).toUpperCase()))]
    .filter((s) => /^[A-Z0-9.]{1,10}(-USDC?)?$/.test(s)).slice(0, MAX);
  if (!watchers.has(ws) && typeof ws.once === 'function') ws.once('close', () => watchers.delete(ws));
  watchers.set(ws, { symbols, send, last: new Map() });
  const coins = symbols.filter((s) => s.includes('-'));
  if (coins.length) { try { require('../connectors/coinbase-socket').addProducts(coins); } catch { /* not streaming: the pass's prices still arrive */ } }
  if (!timer) { timer = setInterval(tick, TICK_MS); timer.unref(); }
  return true;
}

module.exports = { handle, tick, watching: (ws) => (watchers.get(ws) || { symbols: [] }).symbols, TICK_MS, MAX };
