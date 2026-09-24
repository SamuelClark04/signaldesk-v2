// SAMPLE data for the Today dashboard sections that have no live source yet.
// Everything here is illustrative: it is always rendered with a SAMPLE tag and
// its buttons never lead to an order. Replace section by section as real
// feeds arrive (watchlist triggers, rejection counters, market breadth).
// Exposes window.SignalDesk.todaySample.
(() => {
  const SD = window.SignalDesk;

  SD.todaySample = Object.freeze({
    // Shown in "Ready for review" only when the real Approvals Queue is empty.
    candidates: [
      { asset: 'BTC/USD', direction: 'long', timeframe: '4H', entryMin: 83900, entryMax: 84300, invalidation: 82100, target: 88100 },
      { asset: 'ETH/USD', direction: 'short', timeframe: '1H', entryMin: 2690, entryMax: 2705, invalidation: 2748, target: 2610 },
    ],
    attention: [
      { asset: 'NVDA', action: 'Review 25% reduction', detail: 'Earnings in 2 days; position above target weight', tone: 'warn' },
      { asset: 'BTC', action: 'Hold', detail: 'Trend intact above the 20-day average', tone: 'ok' },
      { asset: 'SPY', action: 'Add on pullback', detail: 'Below target weight in the model', tone: 'info' },
    ],
    watching: [
      { symbol: 'AAPL', trigger: 'ORB above 231.10', last: 229.84 },
      { symbol: 'SPY', trigger: 'Reclaim 512.40', last: 511.02 },
      { symbol: 'BTC-USD', trigger: 'Hold above 83,500', last: 84120.5 },
      { symbol: 'NVDA', trigger: 'Pullback to SMA20', last: 118.35 },
    ],
    passed: [
      { reason: 'Spread too wide', count: 5 },
      { reason: 'Fee drag over 0.35R', count: 4 },
      { reason: 'Earnings within 3 days', count: 2 },
      { reason: 'Price escaped entry zone', count: 1 },
    ],
    context: [
      { asset: 'US equities', trend: 'up', breadth: '62% above SMA50' },
      { asset: 'Crypto', trend: 'down', breadth: 'BTC dominance rising' },
      { asset: 'Volatility', trend: 'down', breadth: 'VIX 14.8, below average' },
    ],
  });
})();
