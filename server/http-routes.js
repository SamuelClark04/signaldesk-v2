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

// Phase 84: POST /api/ai/analyze { mode: 'PRE_TRADE' | 'IN_TRADE', payload: { id } } -> the AI Trade Analyst's reply
// (services/ai-analyst.js). Same guard as the chart history (signed-in session + allowed origin). Never throws.
function installAi(app, PORT) {
  app.post('/api/ai/analyze', async (req, res) => {
    const verdict = checkHttp(req, PORT);
    if (!verdict.ok) return res.status(403).json({ ok: false, error: 'forbidden' });
    res.set('Cache-Control', 'no-store');
    try {
      const r = await require('./services/ai-analyst').analyze(req.body || {});
      return res.status(r.ok ? 200 : { BAD_REQUEST: 400, NOT_FOUND: 404, NO_KEY: 503, RATE_LIMIT: 429 }[r.code] || 502).json(r);
    } catch (err) {
      console.error(`[ai] analyze failed: ${err.message}`);
      return res.status(500).json({ ok: false, error: 'AI Analyst failed unexpectedly; see the server log' });
    }
  });
}

module.exports = { install, installAi };
