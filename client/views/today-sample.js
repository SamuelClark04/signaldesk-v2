// SAMPLE data for the Today dashboard sections that have no live source yet.
// Everything here is illustrative: it is always rendered with a SAMPLE tag and
// its buttons never lead to an order. Replace section by section as real
// feeds arrive (portfolio attention, market breadth). Real since: "Why we
// passed" (Phase 18, REJECTION_STATS), "Watching" (Phase 19, WATCHLIST_UPDATED).
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
    context: [
      { asset: 'US equities', trend: 'up', breadth: '62% above SMA50' },
      { asset: 'Crypto', trend: 'down', breadth: 'BTC dominance rising' },
      { asset: 'Volatility', trend: 'down', breadth: 'VIX 14.8, below average' },
    ],
  });
})();
