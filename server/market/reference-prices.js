// Last closes for stocks whose live stream is quiet (market closed, weekend,
// fresh restart), so the UI can show "Last close 225.62" instead of "—".
// Phase 54: each quiet stock (the universe + manual external holdings) is also
// seeded from its latest regular-session DAILY bar: close, previous close and
// the day's % change, into latest-prices' MARK prices (setReference), so
// Robinhood NVDA, the Pilot matrix, the after-hours equity-swing scan and the
// Today market context (SPY) have a real price 24/7.
// NEVER feeds approvals or exits: those read getLatestPrice(s), which only
// trusts fresh stream prices. Refreshed every REFRESH_MS, only for quiet symbols.
const { getLatestStockCloses, getHistory } = require('../connectors/history-bars');
const prices = require('./latest-prices');
const watchlist = require('../execution/watchlist');

const REFRESH_MS = 10 * 60 * 1000;

let closes = {}; // symbol -> { price, time }
let timer = null;
let lastError = null;

const snapshot = () => Object.fromEntries(Object.entries(closes).map(([s, c]) => [s, { ...c }]));

// Manual external stock holdings (Robinhood NVDA...) are seeded too.
function externalStocks() {
  try { return require('../execution/external-holdings').symbols().filter((s) => !s.includes('-')); } catch { return []; }
}

// Latest session close + change from daily bars, into latest-prices' marks.
async function seedDaily(quiet) {
  let changed = false;
  for (const symbol of quiet) {
    const r = await getHistory(symbol, '1d').catch(() => ({ ok: false }));
    const b = r.ok ? r.bars : [];
    if (b.length < 2) continue;
    const last = b[b.length - 1];
    const ref = { price: last.close, time: (last.time + 86400) * 1000, prevClose: b[b.length - 2].close, changePct: last.close / b[b.length - 2].close - 1, source: 'daily close' };
    const prev = prices.getReference(symbol);
    prices.setReference(symbol, ref);
    if (!prev || prev.price !== ref.price || !closes[symbol]) changed = true;
    closes[symbol] = { price: ref.price, time: ref.time, prevClose: ref.prevClose, changePct: ref.changePct, source: ref.source };
  }
  return changed;
}

async function refresh(baseSymbols, onChange) {
  const fresh = prices.getLatestPrices();
  const symbols = [...new Set([...baseSymbols, ...externalStocks()])];
  const quiet = symbols.filter((s) => !fresh.has(s));
  if (!quiet.length) return;
  const seeded = await seedDaily(quiet);
  if (seeded && onChange) onChange(snapshot());
  const rest = quiet.filter((s) => !prices.getReference(s)); // no daily bars: last 1-minute bar instead
  if (!rest.length) return;
  const result = await getLatestStockCloses(rest);
  if (!result.ok) {
    if (result.error !== lastError) console.warn(`[reference] last closes unavailable: ${result.error}`);
    lastError = result.error;
    return;
  }
  lastError = null;
  let changed = false;
  for (const [symbol, c] of Object.entries(result.closes)) {
    const prev = closes[symbol];
    if (!prev || prev.price !== c.price || prev.time !== c.time) { closes[symbol] = { ...prev, ...c }; changed = true; }
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

// Re-seed now (a manual stock holding was just added).
const refreshNow = (symbols, onChange) => refresh(symbols, onChange).catch(() => {});

module.exports = { start, stop, snapshot, refreshNow, REFRESH_MS };
