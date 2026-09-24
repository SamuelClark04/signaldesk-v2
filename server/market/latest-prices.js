// One place to ask "what is the current price of X?" across all connectors.
// Prices older than MAX_PRICE_AGE_MS are treated as missing, so a dead stream
// or a closed market can never feed an approval or an exit.
const alpacaStocks = require('../connectors/alpaca-stock-socket');
const coinbase = require('../connectors/coinbase-socket');

const MAX_PRICE_AGE_MS = 5 * 60 * 1000;
const BAR_MS = 60 * 1000; // an Alpaca bar is stamped at its start; its close is a minute later

function collect() {
  const prices = new Map(); // asset -> { price, time }
  for (const [symbol, bars] of alpacaStocks.getLatestBars()) {
    const last = bars[bars.length - 1];
    if (last) prices.set(symbol, { price: last.close, time: Date.parse(last.time) + BAR_MS });
  }
  for (const [symbol, tick] of Object.entries(coinbase.getLatest())) {
    prices.set(symbol, { price: tick.price, time: Date.parse(tick.time) });
  }
  return prices;
}

// Map of asset -> price, fresh prices only.
function getLatestPrices(now = Date.now()) {
  const fresh = new Map();
  for (const [asset, { price, time }] of collect()) {
    if (price > 0 && now - time <= MAX_PRICE_AGE_MS) fresh.set(asset, price);
  }
  return fresh;
}

// Map of asset -> time (ms) of its fresh price, for "data age" displays.
function getPriceTimes(now = Date.now()) {
  const times = {};
  for (const [asset, { price, time }] of collect()) {
    if (price > 0 && now - time <= MAX_PRICE_AGE_MS) times[asset] = time;
  }
  return times;
}

function getLatestPrice(asset, now = Date.now()) {
  return getLatestPrices(now).get(asset);
}

module.exports = { getLatestPrices, getLatestPrice, getPriceTimes, MAX_PRICE_AGE_MS };
