// The symbols SignalDesk streams and watches. server.js subscribes the live
// connectors to these lists; watchlist.js uses them as its first-run defaults.
// Stocks: Alpaca IEX bar + news streams. Crypto: Coinbase ticker stream.
const STOCKS = Object.freeze(['SPY', 'QQQ', 'AAPL', 'NVDA', 'MSFT', 'META', 'AMZN', 'GOOGL', 'TSLA', 'AMD']);
const CRYPTO = Object.freeze(['BTC-USD', 'ETH-USD', 'SOL-USD', 'AVAX-USD', 'LINK-USD', 'DOGE-USD', 'XRP-USD']);

module.exports = { STOCKS, CRYPTO };
