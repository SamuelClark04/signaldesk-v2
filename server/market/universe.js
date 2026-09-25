// The symbols SignalDesk monitors: 41 stocks + 42 crypto, with display names.
//   Stocks: liquid US stocks/ETFs. Alpaca's free (Basic) data plan allows 30
//           WebSocket symbol subscriptions: the first ALPACA_WS_SYMBOL_LIMIT
//           (default 30) stream live 1m bars. Phase 59B: the 25 optionables
//           (System 5, OPTIONABLE_STOCKS) take the FIRST 25 slots, and the rest
//           (POLLED_STOCKS) get live prices + session bars from Alpaca's REST data
//           every 60 s during the US session (stock-poller.js); after hours every
//           stock shows its last close (reference-prices.js).
//   Crypto: the 40 highest 24h-volume Coinbase USD pairs (stablecoins and
//           wrapped coins excluded), snapshot of 2026-09-24, plus APT and RENDER
//           (the intraday day-trading list, 2-crypto-intraday.js). Coinbase ticker stream.
// CORE_WATCHLIST is the smaller first-run default for the Today "Watching" list.
const OPTIONABLE_LIST = [
  ['SPY', 'SPDR S&P 500 ETF'], ['QQQ', 'Invesco QQQ Trust'], ['IWM', 'iShares Russell 2000 ETF'], ['NVDA', 'NVIDIA'], ['AAPL', 'Apple'],
  ['MSFT', 'Microsoft'], ['META', 'Meta Platforms'], ['AMZN', 'Amazon'], ['GOOGL', 'Alphabet'], ['TSLA', 'Tesla'],
  ['AMD', 'Advanced Micro Devices'], ['NFLX', 'Netflix'], ['COIN', 'Coinbase Global'], ['PLTR', 'Palantir'], ['INTC', 'Intel'],
  ['MU', 'Micron'], ['UBER', 'Uber'], ['ORCL', 'Oracle'], ['SOFI', 'SoFi'], ['BAC', 'Bank of America'],
  ['JPM', 'JPMorgan Chase'], ['WMT', 'Walmart'], ['XOM', 'Exxon Mobil'], ['DIS', 'Disney'], ['PYPL', 'PayPal'],
];
const STOCK_LIST = [
  ...OPTIONABLE_LIST, // slots 1-25: System 5's underlyings always stream
  ['AVGO', 'Broadcom'], ['LLY', 'Eli Lilly'], ['COST', 'Costco'], ['UNH', 'UnitedHealth'], ['V', 'Visa'], // slots 26-30
  // Past the free 30-symbol stream: live REST prices every 60 s in the session (stock-poller.js).
  ['MA', 'Mastercard'], ['CRM', 'Salesforce'], ['DIA', 'SPDR Dow Jones ETF'], ['CVX', 'Chevron'], ['ADBE', 'Adobe'], ['F', 'Ford'],
  ['KO', 'Coca-Cola'], ['PFE', 'Pfizer'], ['T', 'AT&T'], ['BABA', 'Alibaba'], ['NIO', 'NIO'],
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
  ['APT-USD', 'Aptos'], ['RENDER-USD', 'Render'],
];

const OPTIONABLE_STOCKS = Object.freeze(OPTIONABLE_LIST.map(([s]) => s));
const STOCKS = Object.freeze(STOCK_LIST.map(([s]) => s));
const CRYPTO = Object.freeze(CRYPTO_LIST.map(([s]) => s));
const NAMES = Object.freeze(Object.fromEntries([...STOCK_LIST, ...CRYPTO_LIST]));
const STOCK_STREAM_LIMIT = Math.max(1, Number(process.env.ALPACA_WS_SYMBOL_LIMIT) || 30);
const STREAMED_STOCKS = Object.freeze(STOCKS.slice(0, STOCK_STREAM_LIMIT));
const POLLED_STOCKS = Object.freeze(STOCKS.slice(STOCK_STREAM_LIMIT));
const CORE_WATCHLIST = Object.freeze(['SPY', 'QQQ', 'AAPL', 'NVDA', 'MSFT', 'META', 'AMZN', 'GOOGL', 'TSLA', 'AMD',
  'BTC-USD', 'ETH-USD', 'SOL-USD', 'AVAX-USD', 'LINK-USD', 'DOGE-USD', 'XRP-USD']);

// Sent to clients on connect (UNIVERSE): lists, names, which stocks stream and which are REST-polled.
const snapshot = () => ({ stocks: [...STOCKS], crypto: [...CRYPTO], streamedStocks: [...STREAMED_STOCKS], polledStocks: [...POLLED_STOCKS], pollSeconds: 60, optionableStocks: [...OPTIONABLE_STOCKS], names: { ...NAMES } });

module.exports = { STOCKS, CRYPTO, NAMES, OPTIONABLE_STOCKS, STREAMED_STOCKS, POLLED_STOCKS, STOCK_STREAM_LIMIT, CORE_WATCHLIST, snapshot };
