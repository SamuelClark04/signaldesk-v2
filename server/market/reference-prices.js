// Display-only last closes for stocks whose live stream is quiet (market closed,
// weekend, fresh restart), so the UI can show "Last close 225.62" instead of "—".
// NEVER feeds risk, approvals or exits: those read latest-prices.js, which only
// trusts fresh stream prices. Refreshed every REFRESH_MS, only for quiet symbols,
// in one batched REST call.
const { getLatestStockCloses } = require('../connectors/history-bars');
const prices = require('./latest-prices');
const watchlist = require('../execution/watchlist');

const REFRESH_MS = 10 * 60 * 1000;

let closes = {}; // symbol -> { price, time }
let timer = null;
let lastError = null;

const snapshot = () => Object.fromEntries(Object.entries(closes).map(([s, c]) => [s, { ...c }]));

async function refresh(symbols, onChange) {
  const fresh = prices.getLatestPrices();
  const quiet = symbols.filter((s) => !fresh.has(s));
  if (!quiet.length) return;
  const result = await getLatestStockCloses(quiet);
  if (!result.ok) {
    if (result.error !== lastError) console.warn(`[reference] last closes unavailable: ${result.error}`);
    lastError = result.error;
    return;
  }
  lastError = null;
  let changed = false;
  for (const [symbol, c] of Object.entries(result.closes)) {
    const prev = closes[symbol];
    if (!prev || prev.price !== c.price || prev.time !== c.time) { closes[symbol] = c; changed = true; }
  }
  watchlist.seedPrices(result.closes); // fills only items that have no price yet
  if (changed && onChange) onChange(snapshot());
}

function start({ symbols, onChange }) {
  const run = () => refresh(symbols, onChange).catch((err) => console.error('[reference] refresh failed:', err.message));
  run();
  timer = setInterval(run, REFRESH_MS);
}

function stop() {
  clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, snapshot, REFRESH_MS };
