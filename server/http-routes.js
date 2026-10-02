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
      return res.status(r.ok ? 200 : { BAD_REQUEST: 400, NOT_FOUND: 404, NO_KEY: 424, RATE_LIMIT: 429, BUSY: 424 }[r.code] || 424).json(r);
    } catch (err) {
      console.error(`[ai] analyze failed: ${err.message}`);
      return res.status(500).json({ ok: false, error: 'AI Analyst failed unexpectedly; see the server log' });
    }
  });
}

// Phase 88: paper trading runs (execution/paper-runs.js), same guard as above.
//   GET  /api/paper/runs            the current run (+ its summary) and the archived runs (without their journals)
//   GET  /api/paper/runs/:runId     one archived run with its whole trade journal
//   POST /api/paper/reset-run { confirm: true, name? }  archive the current paper run and start the next one
function installPaperRuns(app, PORT, { broadcast }) {
  const runs = require('./execution/paper-runs');
  const ledger = require('./execution/paper-ledger');
  const guard = (req, res) => { if (checkHttp(req, PORT).ok) return true; res.status(403).json({ ok: false, error: 'forbidden' }); return false; };
  app.get('/api/paper/runs', (req, res) => { if (!guard(req, res)) return; res.set('Cache-Control', 'no-store').json({ ok: true, ...runs.list(ledger) }); });
  app.get('/api/paper/runs/:runId', (req, res) => {
    if (!guard(req, res)) return;
    const r = runs.get(String(req.params.runId));
    res.set('Cache-Control', 'no-store').status(r ? 200 : 404).json(r ? { ok: true, run: r } : { ok: false, error: 'no archived run with that id' });
  });
  app.post('/api/paper/reset-run', (req, res) => {
    if (!guard(req, res)) return;
    res.set('Cache-Control', 'no-store');
    const body = req.body || {};
    if (body.confirm !== true) return res.status(400).json({ ok: false, error: 'confirm: true is required (this archives and clears the paper book)' });
    let r;
    try { r = runs.resetRun(ledger, { name: typeof body.name === 'string' ? body.name : '' }); } catch (err) {
      console.error(`[runs] reset failed: ${err.message}`);
      return res.status(500).json({ ok: false, error: `Reset failed: ${err.message}` });
    }
    if (!r.ok) return res.status(409).json(r);
    const settings = ledger.getSettings();
    broadcast('QUEUE_UPDATED', ledger.getPendingOrders());
    broadcast('POSITIONS_UPDATED', ledger.getActivePositions());
    broadcast('JOURNAL_UPDATED', ledger.getTradeJournal());
    broadcast('PILOT_ACTIONS', ledger.getPilotActions());
    broadcast('ENTRY_SHIELDS', require('./risk/entry-shields').status(settings)); // the paper kill switch is released
    try { broadcast('PORTFOLIO_RISK', require('./risk/portfolio-risk').summary(ledger.getActivePositions(), settings, { stocks: settings.bankroll, crypto: settings.cryptoBankroll })); } catch { /* next pass */ }
    try { require('./intelligence/dashboard-intel').publishIntelligence(broadcast); } catch (err) { console.error('[intel] publish failed:', err.message); }
    require('./execution/broker-state').publishBrokerState(broadcast, { force: true }).catch(() => {});
    broadcast('PAPER_RUNS', runs.list(ledger));
    return res.json({ ...r, runs: runs.list(ledger) });
  });
}

module.exports = { install, installAi, installPaperRuns };
