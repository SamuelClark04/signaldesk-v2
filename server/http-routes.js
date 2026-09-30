// HTTP routes behind the sign-in gate (Phase 83: split from server.js, unchanged). install(app, port).
const { checkHttp } = require('./security/access-policy');
const { getHistory } = require('./connectors/history-bars');

function install(app, PORT) {
  // Chart history: last 100 bars (?tf=1m default; 15m, 1h, 4h, 1d) from Alpaca (stocks) or
  // Coinbase (crypto, symbols with "-"). Read-only, but it spends broker API quota,
  // so it is guarded like the socket (origin + LAN token).
  app.get('/api/history/:symbol', async (req, res) => {
    const verdict = checkHttp(req, PORT);
    if (!verdict.ok) {
      console.warn(`[security] rejected /api/history: ${verdict.reason}`);
      return res.status(403).json({ error: 'forbidden' });
    }
    require('./connectors/coinbase-discovery').stream([String(req.params.symbol).toUpperCase()]); // a charted Coinbase gem joins the live stream
    const result = await getHistory(req.params.symbol, String(req.query.tf || '1m'), Date.now(), { chart: true }); // Phase 73: cached at once, refreshed behind
    res.set('Cache-Control', 'no-store');
    if (result.ok) return res.json(result.bars);
    return res.status(result.status || 502).json({ error: result.error });
  });
}

module.exports = { install };
