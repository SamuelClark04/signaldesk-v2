// Sector groups for the concentration cap (Phase 81): names that tend to move TOGETHER share a group, so the cap stops
// several bets on one move (the day AMZN / GOOGL / NVDA all stopped out together). Mega-cap tech and internet names are one
// group on purpose (they trade as one factor), whatever their official GICS sector. A ticker not listed is its own group.
const GROUPS = {
  Technology: ['NVDA', 'AAPL', 'MSFT', 'META', 'AMZN', 'GOOGL', 'GOOG', 'AMD', 'NFLX', 'INTC', 'MU', 'ORCL', 'AVGO', 'CRM', 'ADBE', 'PLTR', 'UBER', 'QCOM', 'TSM', 'SMCI'],
  Financials: ['JPM', 'BAC', 'SOFI', 'PYPL', 'V', 'MA', 'COIN', 'GS', 'MS', 'WFC', 'C', 'HOOD'],
  Energy: ['XOM', 'CVX', 'OXY', 'COP'],
  Healthcare: ['LLY', 'UNH', 'PFE', 'JNJ', 'MRK', 'ABBV'],
  'Consumer Staples': ['WMT', 'COST', 'KO', 'PEP', 'PG'],
  'Media & Telecom': ['DIS', 'T', 'VZ', 'CMCSA'],
  'Autos & EV': ['TSLA', 'F', 'GM', 'RIVN', 'NIO'],
  'China ADRs': ['BABA', 'PDD', 'JD'],
  'Index ETFs': ['SPY', 'QQQ', 'IWM', 'DIA'],
};
const BY_TICKER = new Map(Object.entries(GROUPS).flatMap(([g, list]) => list.map((t) => [t, g])));

// 'AMZN' -> 'Technology'; an option spread uses its underlying (the asset field); unknown -> the ticker itself.
const sectorOf = (asset) => { const t = String(asset || '').toUpperCase(); return BY_TICKER.get(t) || t; };

module.exports = { sectorOf, GROUPS };
