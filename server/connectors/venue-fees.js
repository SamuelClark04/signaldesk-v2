// The Kraken and OKX US ACCOUNTS' real spot fee rates (Phase 92), read the way coinbase-fees.js reads Coinbase's:
//   kraken  POST /0/private/TradeVolume { pair: XBTUSD,ETHUSD } -> fees_maker / fees (percent, per pair)
//   okx     GET /api/v5/account/trade-fee { instType SPOT, instId BTC-USDC / ETH-USDC } -> maker / taker (fractions,
//           NEGATIVE = a charge; OKX US lists no BTC-USD / ETH-USD book, its BTC / ETH books are USDC / USDT)
// The highest rate over the pairs read is used (conservative), set in cost-authority.setVenueFees with its source and
// time, so cost gates, stop floors, break-even, paper fills and the waterfall use what the venue really charges.
// Read-only (no orders), only for a venue whose keys are configured; at boot then every REFRESH_MS. A failed read is
// EXPLICIT: status() keeps the error and time, the log warns once per failure, and the rates in force stay (the last
// verified ones, else the .env / default entry tier, labelled unverified) for at most cost-authority.VERIFIED_MAX_AGE_MS
// (24 h) after the last good read; then expireStaleFees raises them to the higher of those and the fallback. Tests stub the two connectors.
const cost = require('../risk/cost-authority');

const REFRESH_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
const OKX_BOOKS = ['BTC-USDC', 'ETH-USDC'];
const KRAKEN_PAIRS = 'XBTUSD,ETHUSD';

const READERS = {
  kraken: {
    label: 'Kraken',
    configured: () => require('./kraken-api').configured(),
    async read() {
      const r = await require('./kraken-api').privateCall('TradeVolume', { pair: KRAKEN_PAIRS });
      const pairs = Object.keys((r && r.fees) || {});
      if (!pairs.length) throw new Error('no fees in the TradeVolume answer');
      const rows = pairs.map((p) => ({ pair: p, maker: Number(r.fees_maker && r.fees_maker[p] && r.fees_maker[p].fee) / 100, taker: Number(r.fees[p].fee) / 100 }));
      return { rows, tier: null };
    },
  },
  okx: {
    label: 'OKX US',
    configured: () => require('./okx-api').configured(),
    async read() {
      const api = require('./okx-api');
      const rows = [];
      let tier = null;
      for (const instId of OKX_BOOKS) {
        const d = (await api.request('GET', '/api/v5/account/trade-fee', { query: { instType: 'SPOT', instId } }))[0];
        if (!d) throw new Error(`no fee row for ${instId}`);
        tier = tier || d.level || null;
        rows.push({ pair: instId, maker: Math.max(0, -Number(d.maker)), taker: -Number(d.taker) }); // a maker rebate counts as 0
      }
      return { rows, tier };
    },
  },
};

const last = Object.fromEntries(Object.keys(READERS).map((v) => [v, { ok: false, at: null, error: 'not read yet', tier: null, pairs: [] }]));
const timers = {};
const pct = (x) => `${(x * 100).toFixed(2)}%`;

async function refresh(venue, now = Date.now()) {
  const R = READERS[venue];
  if (!R) throw new Error(`venue-fees: unknown venue ${venue}`);
  if (!R.configured()) { // keys removed: no read possible, so a cached verified rate also ages out (fee-failure policy)
    last[venue] = { ok: false, at: now, error: 'no API keys configured', tier: null, pairs: [] };
    cost.expireStaleFees(venue, now);
    return last[venue];
  }
  try {
    const { rows, tier } = await R.read();
    const maker = Math.max(...rows.map((x) => x.maker));
    const taker = Math.max(...rows.map((x) => x.taker));
    const source = `${R.label} account${tier ? ` ${tier}` : ''} (${rows.map((x) => x.pair).join(', ')})`;
    if (!cost.setVenueFees(venue, { maker, taker, source, at: now })) throw new Error(`implausible rates maker ${maker} / taker ${taker}`);
    last[venue] = { ok: true, at: now, error: null, tier, pairs: rows.map((x) => x.pair), maker, taker };
    console.log(`[venue-fees] ${R.label} account fees${tier ? ` (${tier})` : ''}: maker ${pct(maker)} / taker ${pct(taker)}`);
  } catch (err) {
    last[venue] = { ok: false, at: now, error: String(err.message || err).slice(0, 200), tier: null, pairs: [] };
    if (cost.expireStaleFees(venue, now)) console.warn(`[venue-fees] ${R.label}: last verified rates older than ${cost.VERIFIED_MAX_AGE_MS / 3600000} h; new entries now costed at the higher fallback`);
    const f = cost.feeInfo(venue);
    console.warn(`[venue-fees] ${R.label} fee lookup failed (${last[venue].error}); using ${pct(f.maker)} / ${pct(f.taker)} (${f.source})`);
  }
  return last[venue];
}

function start() {
  for (const venue of Object.keys(READERS)) {
    if (timers[venue]) continue;
    const loop = () => refresh(venue).catch(() => null).then((r) => {
      timers[venue] = setTimeout(loop, r && r.ok ? REFRESH_MS : RETRY_MS);
      if (timers[venue].unref) timers[venue].unref();
    });
    timers[venue] = true;
    loop();
  }
}
function stop() { for (const v of Object.keys(timers)) { clearTimeout(timers[v]); delete timers[v]; } }
// Per venue: the latest lookup ({ ok, at, error, tier, pairs }) + the rates in force with their provenance (cost.feeInfo).
const status = (venue) => ({ ...last[venue], inForce: cost.feeInfo(venue) });

module.exports = { refresh, start, stop, status, READERS, OKX_BOOKS, KRAKEN_PAIRS, REFRESH_MS, RETRY_MS };
