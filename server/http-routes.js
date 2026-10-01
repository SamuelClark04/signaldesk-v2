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
    // Phase 85: a market-data host failing (timeout, open circuit) is 424, never 502 / 503: through the Cloudflare tunnel a 5xx
    // reads as "SignalDesk is down" (and may be swapped for Cloudflare's own error page).
    return res.status(result.status >= 500 || !result.status ? 424 : result.status).json({ error: result.error });
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
      // Phase 85: never a 5xx for an answer we gave (no key, the AI provider failed): through the Cloudflare tunnel a 502 / 503
      // reads as "SignalDesk is down". 424 = the AI provider (a dependency) failed; the JSON says why.
      return res.status(r.ok ? 200 : { BAD_REQUEST: 400, NOT_FOUND: 404, NO_KEY: 424, RATE_LIMIT: 429 }[r.code] || 424).json(r);
    } catch (err) {
      console.error(`[ai] analyze failed: ${err.message}`);
      return res.status(500).json({ ok: false, error: 'AI Analyst failed unexpectedly; see the server log' });
    }
  });
}

module.exports = { install, installAi };
