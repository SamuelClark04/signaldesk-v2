// External holdings over HTTP + the live feed that keeps them marked.
//   GET    /api/portfolio/external      { holdings, positions }
//   POST   /api/portfolio/external      add a manual holding (Robinhood / other)
//   PUT    /api/portfolio/external/:id  edit quantity / avg cost / label /
//                                       custom stop or T1 (resetLevels: new auto plan)
//   DELETE /api/portfolio/external/:id  remove it (nothing is sold anywhere)
//   PUT    /api/portfolio/external-broker/:venue/:asset  custom stop / T1 for a
//                                       broker-synced holding (coinbase|alpaca)
// Installed after the sign-in gate (server.js): every call needs a session and a
// request from another site is refused by its Origin. Each change is pushed to
// every client as EXTERNAL_HOLDINGS (the unified positions with their levels).
// Prices: symbols with no fresh stream price (a stock outside the 30 streamed,
// a coin outside the universe) are polled every POLL_MS from 1-minute bars
// (history-bars.js) into latest-prices, stamped with the bar's own time, so a
// closed market still reads "no live price" rather than a stale one.
const external = require('./external-holdings');
const prices = require('../market/latest-prices');
const { getHistory } = require('../connectors/history-bars');

const POLL_MS = 60 * 1000;
const BAR_MS = 60 * 1000;
let broadcastRef = () => {};

const snapshot = () => ({ holdings: external.list(), positions: external.positions(), at: Date.now() });
const publish = () => broadcastRef('EXTERNAL_HOLDINGS', snapshot());

async function pollPrices() {
  const fresh = prices.getLatestPrices();
  for (const symbol of external.symbols().filter((s) => !(fresh.get(s) > 0))) {
    const r = await getHistory(symbol, '1m').catch(() => ({ ok: false }));
    const last = r.ok && r.bars && r.bars[r.bars.length - 1];
    if (last && last.close > 0) prices.setPolled(symbol, last.close, last.time * 1000 + BAR_MS);
  }
}

function install(app, { broadcast }) {
  broadcastRef = broadcast;
  const route = (fn) => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const out = await fn(req);
      publish();
      pollPrices().then(publish).catch(() => {}); // a new symbol gets a price right away
      res.json({ ok: true, ...out, ...snapshot() });
    } catch (err) {
      if (!err.status) console.error(`[external] ${req.method} ${req.path} failed:`, err.message);
      res.status(err.status || 500).json({ ok: false, error: err.message });
    }
  };
  app.get('/api/portfolio/external', (req, res) => res.set('Cache-Control', 'no-store').json(snapshot()));
  app.post('/api/portfolio/external', route(async (req) => {
    const h = await external.add(req.body);
    console.log(`[external] added ${h.quantity} ${h.symbol} (${h.brokerLabel}) at ${h.avgCost}`);
    return { holding: h };
  }));
  app.put('/api/portfolio/external/:id', route(async (req) => ({ holding: await external.update(req.params.id, req.body) })));
  app.delete('/api/portfolio/external/:id', route(async (req) => {
    const h = external.remove(req.params.id);
    console.log(`[external] removed ${h.symbol} (${h.brokerLabel})`);
    return { removed: h.id };
  }));
  app.put('/api/portfolio/external-broker/:venue/:asset', route(async (req) => {
    const key = `${req.params.venue}:${req.params.asset}`;
    if (!external.brokerFree().some((b) => b.key === key)) { const e = new Error(`no synced ${key} holding outside SignalDesk`); e.status = 404; throw e; }
    const b = req.body || {};
    return { levels: external.setBrokerLevels(key, { customStop: b.customStop, customT1: b.customT1 }) };
  }));
  setInterval(() => pollPrices().catch((err) => console.error('[external] price poll failed:', err.message)), POLL_MS).unref();
}

// After a Sync Broker: the new free balances now, their protective levels once computed.
async function brokerSynced() {
  publish();
  if (await external.refreshLevels()) publish();
}

module.exports = { install, snapshot, publish, pollPrices, brokerSynced };
