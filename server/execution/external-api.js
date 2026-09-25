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
// Prices: every held coin (synced Coinbase balances, manual crypto) is added to
// the live Coinbase ticker stream (coinbase-socket.addProducts). Until a tick
// arrives, and for any symbol still without a fresh price, it is polled every
// POLL_MS: coins from Coinbase's public product price (<BASE>-USD, else the
// <BASE>-USDC book), stamped now; stocks from 1-minute bars stamped with the
// bar's own time (a closed market then reads "last close", via reference-prices).
const coinbaseSocket = require('../connectors/coinbase-socket');
const referencePrices = require('../market/reference-prices');
const external = require('./external-holdings');
const prices = require('../market/latest-prices');
const { getHistory } = require('../connectors/history-bars');

const POLL_MS = 60 * 1000;
const BAR_MS = 60 * 1000;
let broadcastRef = () => {};

const snapshot = () => ({ holdings: external.list(), positions: external.positions(), at: Date.now() });
const publish = () => broadcastRef('EXTERNAL_HOLDINGS', snapshot());

// Coinbase public product price for BASE-USD, falling back to BASE-USDC. null: unlisted.
async function coinPrice(symbol) {
  const base = (process.env.COINBASE_API_BASE_URL || 'https://api.coinbase.com').replace(/\/+$/, '');
  for (const product of [symbol, symbol.replace(/-USD$/, '-USDC')]) {
    try {
      const res = await fetch(`${base}/api/v3/brokerage/market/products/${encodeURIComponent(product)}`, { signal: AbortSignal.timeout(8000) });
      const j = res.ok ? await res.json() : null;
      if (j && Number(j.price) > 0) return Number(j.price);
    } catch { /* try the next book */ }
  }
  return null;
}

async function pollPrices() {
  const held = external.symbols();
  coinbaseSocket.addProducts(held.filter((s) => s.includes('-')));
  const fresh = prices.getLatestPrices();
  for (const symbol of held.filter((s) => !(fresh.get(s) > 0))) {
    if (symbol.includes('-')) {
      const px = await coinPrice(symbol);
      if (px) prices.setPolled(symbol, px, Date.now());
      continue;
    }
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
      referencePrices.refreshNow([], (closes) => broadcastRef('REFERENCE_PRICES', closes)); // and a last close (after hours)
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
  const poll = () => pollPrices().catch((err) => console.error('[external] price poll failed:', err.message));
  setTimeout(poll, 5000).unref(); // held coins join the stream right after startup
  setInterval(poll, POLL_MS).unref();
}

// After a Sync Broker: the new free balances now, their protective levels once computed.
async function brokerSynced() {
  publish();
  await pollPrices().catch(() => {}); // newly synced coins: stream + a price now
  if (await external.refreshLevels()) publish();
}

module.exports = { install, snapshot, publish, pollPrices, brokerSynced };
