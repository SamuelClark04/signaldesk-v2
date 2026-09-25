// One place to ask "what is the current price of X?" across all connectors.
// Prices older than MAX_PRICE_AGE_MS are treated as missing, so a dead stream
// or a closed market can never feed an approval or an exit.
const alpacaStocks = require('../connectors/alpaca-stock-socket');
const coinbase = require('../connectors/coinbase-socket');

const MAX_PRICE_AGE_MS = 5 * 60 * 1000;
const BAR_MS = 60 * 1000; // an Alpaca bar is stamped at its start; its close is a minute later
// Polled prices (REST, for symbols no stream carries: e.g. a manual Robinhood
// holding outside the streamed universe; execution/external-api.js). Stamped with
// the time of the bar they came from, so the same freshness rule applies.
const polled = new Map(); // asset -> { price, time }
function setPolled(asset, price, time) { if (price > 0 && Number.isFinite(time)) polled.set(asset, { price, time }); }

function collect() {
  const prices = new Map(polled); // asset -> { price, time }; stream prices win when newer
  for (const [symbol, bars] of alpacaStocks.getLatestBars()) {
    const last = bars[bars.length - 1];
    const time = last ? Date.parse(last.time) + BAR_MS : 0;
    if (last && !(prices.has(symbol) && prices.get(symbol).time > time)) prices.set(symbol, { price: last.close, time });
  }
  for (const [symbol, tick] of Object.entries(coinbase.getLatest())) {
    const time = Date.parse(tick.time);
    if (!(prices.has(symbol) && prices.get(symbol).time > time)) prices.set(symbol, { price: tick.price, time });
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

module.exports = { getLatestPrices, getLatestPrice, getPriceTimes, setPolled, MAX_PRICE_AGE_MS };
