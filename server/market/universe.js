// The symbols SignalDesk monitors: 40 stocks + 40 crypto, with display names.
//   Stocks: liquid US stocks/ETFs. Alpaca's free (Basic) data plan allows 30
//           WebSocket symbol subscriptions, so the first ALPACA_WS_SYMBOL_LIMIT
//           (default 30) stream live 1m bars; the rest get display-only last
//           closes (reference-prices.js). Raise the limit on a paid plan.
//   Crypto: the 40 highest 24h-volume Coinbase USD pairs (stablecoins and
//           wrapped coins excluded), snapshot of 2026-09-24. Coinbase ticker stream.
// CORE_WATCHLIST is the smaller first-run default for the Today "Watching" list.
const STOCK_LIST = [
  ['SPY', 'SPDR S&P 500 ETF'], ['QQQ', 'Invesco QQQ Trust'], ['IWM', 'iShares Russell 2000 ETF'], ['AAPL', 'Apple'],
  ['MSFT', 'Microsoft'], ['NVDA', 'NVIDIA'], ['AMZN', 'Amazon'], ['GOOGL', 'Alphabet'], ['META', 'Meta Platforms'],
  ['TSLA', 'Tesla'], ['AMD', 'Advanced Micro Devices'], ['AVGO', 'Broadcom'], ['NFLX', 'Netflix'], ['PLTR', 'Palantir'],
  ['JPM', 'JPMorgan Chase'], ['BAC', 'Bank of America'], ['XOM', 'Exxon Mobil'], ['WMT', 'Walmart'], ['COST', 'Costco'],
  ['UNH', 'UnitedHealth'], ['V', 'Visa'], ['MA', 'Mastercard'], ['INTC', 'Intel'], ['MU', 'Micron'], ['ORCL', 'Oracle'],
  ['CRM', 'Salesforce'], ['UBER', 'Uber'], ['COIN', 'Coinbase Global'], ['SOFI', 'SoFi'], ['DIA', 'SPDR Dow Jones ETF'],
  // Beyond the free 30-symbol stream: last closes only unless the limit is raised.
  ['CVX', 'Chevron'], ['ADBE', 'Adobe'], ['PYPL', 'PayPal'], ['F', 'Ford'], ['DIS', 'Disney'], ['KO', 'Coca-Cola'],
  ['PFE', 'Pfizer'], ['T', 'AT&T'], ['BABA', 'Alibaba'], ['NIO', 'NIO'],
];

const CRYPTO_LIST = [
  ['BTC-USD', 'Bitcoin'], ['ETH-USD', 'Ethereum'], ['ZEC-USD', 'Zcash'], ['XRP-USD', 'XRP'], ['SOL-USD', 'Solana'],
  ['NEAR-USD', 'NEAR Protocol'], ['HYPE-USD', 'Hyperliquid'], ['LTC-USD', 'Litecoin'], ['UNI-USD', 'Uniswap'], ['SUI-USD', 'Sui'],
  ['BCH-USD', 'Bitcoin Cash'], ['DOGE-USD', 'Dogecoin'], ['ADA-USD', 'Cardano'], ['ONDO-USD', 'Ondo'], ['LINK-USD', 'Chainlink'],
  ['XLM-USD', 'Stellar Lumens'], ['AVAX-USD', 'Avalanche'], ['TAO-USD', 'Bittensor'], ['VVV-USD', 'Venice Token'], ['HBAR-USD', 'Hedera'],
  ['USELESS-USD', 'Useless Coin'], ['NEON-USD', 'Neon EVM'], ['LIGHTER-USD', 'Lighter'], ['ENA-USD', 'Ethena'], ['PENGU-USD', 'Pudgy Penguins'],
  ['AERO-USD', 'Aerodrome Finance'], ['AAVE-USD', 'Aave'], ['ARB-USD', 'Arbitrum'], ['PUMP-USD', 'Pump.fun'], ['INJ-USD', 'Injective'],
  ['XCN-USD', 'Onyxcoin'], ['BONK-USD', 'Bonk'], ['PEPE-USD', 'Pepe'], ['ALEO-USD', 'Aleo'], ['ICP-USD', 'Internet Computer'],
  ['DASH-USD', 'Dash'], ['DRV-USD', 'Derive'], ['ZRO-USD', 'LayerZero'], ['RAY-USD', 'Raydium'], ['FET-USD', 'Artificial Superintelligence Alliance'],
];

const STOCKS = Object.freeze(STOCK_LIST.map(([s]) => s));
const CRYPTO = Object.freeze(CRYPTO_LIST.map(([s]) => s));
const NAMES = Object.freeze(Object.fromEntries([...STOCK_LIST, ...CRYPTO_LIST]));
const STOCK_STREAM_LIMIT = Math.max(1, Number(process.env.ALPACA_WS_SYMBOL_LIMIT) || 30);
const STREAMED_STOCKS = Object.freeze(STOCKS.slice(0, STOCK_STREAM_LIMIT));
const CORE_WATCHLIST = Object.freeze(['SPY', 'QQQ', 'AAPL', 'NVDA', 'MSFT', 'META', 'AMZN', 'GOOGL', 'TSLA', 'AMD',
  'BTC-USD', 'ETH-USD', 'SOL-USD', 'AVAX-USD', 'LINK-USD', 'DOGE-USD', 'XRP-USD']);

// Sent to clients on connect (UNIVERSE): lists, names and which stocks stream.
const snapshot = () => ({ stocks: [...STOCKS], crypto: [...CRYPTO], streamedStocks: [...STREAMED_STOCKS], names: { ...NAMES } });

module.exports = { STOCKS, CRYPTO, NAMES, STREAMED_STOCKS, STOCK_STREAM_LIMIT, CORE_WATCHLIST, snapshot };
