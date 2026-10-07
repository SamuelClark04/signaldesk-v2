// Phase 95: the Alpaca MARKET-DATA keys for the research code, without loading the broker connector (connectors/alpaca-api exports
// order functions; the research collector must never reach them: tests/ph95collector.js import guard). Same answer as
// alpaca-api.dataKeys() (tested): the live keys when both are set, else the Alpaca Paper keys (both serve the free data feeds).
function dataKeys() {
  const e = process.env;
  if (e.ALPACA_API_KEY && e.ALPACA_API_SECRET) return { key: e.ALPACA_API_KEY, secret: e.ALPACA_API_SECRET };
  if (e.ALPACA_PAPER_API_KEY && e.ALPACA_PAPER_API_SECRET) return { key: e.ALPACA_PAPER_API_KEY, secret: e.ALPACA_PAPER_API_SECRET };
  return null;
}

module.exports = { dataKeys };
