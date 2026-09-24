// Watchlist: symbols the desk is waiting on, each with a human-readable trigger.
// Persisted to server/data/watchlist.json (same atomic write pattern as the
// ledger) so edits survive restarts; the defaults below apply only when no file
// exists yet. The 60s pipeline refreshes `lastPrice` from the live streams.
//
// Item: { symbol, triggerCondition, lastPrice, lastPriceAt, market }
//   triggerCondition is descriptive text: nothing evaluates it yet.
//   lastPrice keeps the last known value when a feed goes quiet (e.g. overnight),
//   with lastPriceAt showing how old it is. Prices exist only for symbols the
//   connectors stream (server/market/universe.js); after a restart with the market
//   closed, reference-prices.js seeds the last close.
const fs = require('fs');
const path = require('path');
const { CORE_WATCHLIST } = require('../market/universe');

const FILE = process.env.WATCHLIST_PATH || path.join(__dirname, '..', 'data', 'watchlist.json');
const SYMBOL_RE = /^[A-Z0-9.]{1,10}(-[A-Z]{2,5})?$/; // AAPL, BRK.B, BTC-USD
const MAX_TRIGGER_LENGTH = 80;

// First-run defaults: the core list (not all 80 monitored symbols). Descriptive triggers where one exists.
const DEFAULT_TRIGGERS = {
  AAPL: 'Breakout above 231.10',
  NVDA: 'Pullback to SMA20 after earnings',
  SPY: 'Reclaim of 512.40',
  'BTC-USD': 'Reclaim of rolling mean after a 0.4% flush',
};
const DEFAULTS = CORE_WATCHLIST.map((symbol) => ({ symbol, triggerCondition: DEFAULT_TRIGGERS[symbol] || 'Price watch: no trigger set' }));

const marketOf = (symbol) => (symbol.includes('-') ? 'crypto' : 'stocks');
const makeItem = ({ symbol, triggerCondition }) => ({
  symbol, triggerCondition, lastPrice: null, lastPriceAt: null, market: marketOf(symbol),
});

let items = [];
let listener = null;

// ---------- Persistence ----------
function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, items }, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.error(`[watchlist] FAILED to save ${FILE}: ${err.message}`);
  }
}

function load() {
  if (!fs.existsSync(FILE)) {
    items = DEFAULTS.map(makeItem);
    return;
  }
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!Array.isArray(data.items)) throw new Error('"items" is missing or not an array');
    items = data.items.filter((i) => i && SYMBOL_RE.test(i.symbol)).map((i) => ({ ...makeItem(i), ...i, market: marketOf(i.symbol) }));
  } catch (err) {
    const aside = `${FILE}.corrupt-${Date.now()}`;
    try { fs.renameSync(FILE, aside); } catch { /* leave it */ }
    console.error(`[watchlist] could not load ${FILE} (${err.message}); moved to ${aside}, using defaults`);
    items = DEFAULTS.map(makeItem);
  }
}

function changed() {
  if (!listener) return;
  try { listener(getWatchlist()); } catch (err) { console.error('[watchlist] listener failed:', err.message); }
}

// ---------- API ----------
const getWatchlist = () => items.map((i) => ({ ...i }));

// Adds a symbol, or updates the trigger of one already watched. Throws on bad input.
function addWatchlist(item) {
  const symbol = String((item && item.symbol) || '').trim().toUpperCase();
  const triggerCondition = String((item && item.triggerCondition) || '').trim();
  if (!SYMBOL_RE.test(symbol)) throw new Error(`invalid symbol "${symbol}"`);
  if (!triggerCondition || triggerCondition.length > MAX_TRIGGER_LENGTH) {
    throw new Error(`triggerCondition must be 1-${MAX_TRIGGER_LENGTH} characters`);
  }
  const existing = items.find((i) => i.symbol === symbol);
  if (existing) existing.triggerCondition = triggerCondition;
  else items.push(makeItem({ symbol, triggerCondition }));
  save();
  changed();
  return getWatchlist();
}

// Returns true if the symbol was being watched.
function removeWatchlist(symbol) {
  const s = String(symbol || '').trim().toUpperCase();
  const before = items.length;
  items = items.filter((i) => i.symbol !== s);
  if (items.length === before) return false;
  save();
  changed();
  return true;
}

// Called by the pipeline each pass with the FRESH prices map (asset -> price).
// Returns true (and notifies) only if some price actually changed.
function syncPrices(latestPricesMap, now = Date.now()) {
  let dirty = false;
  for (const item of items) {
    const p = latestPricesMap instanceof Map ? latestPricesMap.get(item.symbol) : latestPricesMap && latestPricesMap[item.symbol];
    if (p > 0 && p !== item.lastPrice) {
      item.lastPrice = p;
      item.lastPriceAt = now;
      dirty = true;
    }
  }
  if (dirty) changed(); // prices are refreshed live; not written to disk every minute
  return dirty;
}

// Last closes from reference-prices.js ({ SYM: { price, time } }): fills only
// items with no price at all, with the close's real timestamp. Live prices win.
function seedPrices(closes) {
  let dirty = false;
  for (const item of items) {
    const c = closes && closes[item.symbol];
    if (item.lastPrice == null && c && c.price > 0) {
      item.lastPrice = c.price;
      item.lastPriceAt = c.time;
      dirty = true;
    }
  }
  if (dirty) changed();
  return dirty;
}

// server.js registers a broadcaster here, so producers never touch sockets.
function onChange(fn) {
  listener = fn;
}

load();

module.exports = { getWatchlist, addWatchlist, removeWatchlist, syncPrices, seedPrices, onChange };
