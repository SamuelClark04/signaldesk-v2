// The Kraken and OKX US ACCOUNTS' real spot fee rates (Phase 92), read the way coinbase-fees.js reads Coinbase's.
//   kraken  POST /0/private/TradeVolume for the BTC / ETH books the router can pick (XBT/USD, ETH/USD, XBT/USDC, ETH/USDC)
//           -> fees_maker / fees, in percent, per pair. Every requested pair must come back with a valid maker AND taker
//           rate; an incomplete answer is a failed read and never replaces the rates in force. The verified rate is
//           claimed for those four books only (the source says so); other Kraken pairs are costed at the same rate.
//   okx     OKX US fees are per FEE GROUP: each instrument has a groupId (public instruments, okx-pairs), and
//           GET /api/v5/account/trade-fee { instType SPOT } lists the account's maker / taker per group in feeGroup[]
//           (fractions, NEGATIVE = a charge). The top-level maker / taker fields belong to one group only, so they are
//           NOT used. Every routable book (each live USD / USDC / USDT instrument okx-pairs keeps, USDC and USDT books
//           included) must map to a group present in the answer; a book without a groupId or a missing group fails
//           the read. The venue rate is the highest over those groups (conservative), with per-book detail for BTC / ETH.
// A good read -> cost-authority.setVenueFees (source + coverage + time). Read-only, only for a venue whose keys are set;
// at boot then every REFRESH_MS. A failed read is EXPLICIT (status error + time, a log warning) and changes nothing;
// verified rates expire for new entries VERIFIED_MAX_AGE_MS after the last good read (cost-authority, at use time).
const cost = require('../risk/cost-authority');

const REFRESH_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
// Requested Kraken pair (altname) -> the key Kraken answers with.
const KRAKEN_PAIRS = { XBTUSD: 'XXBTZUSD', ETHUSD: 'XETHZUSD', XBTUSDC: 'XBTUSDC', ETHUSDC: 'ETHUSDC' };
const OKX_DETAIL = ['BTC-USDC', 'ETH-USDC', 'BTC-USDT', 'ETH-USDT']; // the BTC / ETH books the router picks from
const fin = (x) => x !== '' && x !== null && x !== undefined && Number.isFinite(Number(x));

const READERS = {
  kraken: {
    label: 'Kraken',
    configured: () => require('./kraken-api').configured(),
    async read() {
      const r = await require('./kraken-api').privateCall('TradeVolume', { pair: Object.keys(KRAKEN_PAIRS).join(',') });
      const rows = []; const missing = [];
      for (const [asked, key] of Object.entries(KRAKEN_PAIRS)) {
        const t = r && r.fees && r.fees[key]; const m = r && r.fees_maker && r.fees_maker[key];
        if (!t || !m || !fin(t.fee) || !fin(m.fee)) { missing.push(asked); continue; }
        rows.push({ pair: key, maker: Number(m.fee) / 100, taker: Number(t.fee) / 100 });
      }
      if (missing.length) throw new Error(`incomplete TradeVolume answer: no valid maker / taker fee for ${missing.join(', ')}`);
      return { rows, tier: null, coverage: `verified for ${rows.map((x) => x.pair).join(', ')}; other Kraken pairs assumed the same (unverified)` };
    },
  },
  okx: {
    label: 'OKX US',
    configured: () => require('./okx-api').configured(),
    async read() {
      const pairs = require('./okx-pairs');
      const inst = await pairs.refresh();
      const books = pairs.entries();
      if (!books.length) throw new Error(`no OKX instrument list (${(inst && inst.error) || 'empty'}): fee groups cannot be mapped`);
      const noGroup = books.filter((e) => !e.groupId).map((e) => e.instId);
      if (noGroup.length) throw new Error(`${noGroup.length} routable book(s) without a fee group (${noGroup.slice(0, 5).join(', ')})`);
      const d = (await require('./okx-api').request('GET', '/api/v5/account/trade-fee', { query: { instType: 'SPOT' } }))[0];
      const groups = new Map(((d && d.feeGroup) || []).filter((g) => g && fin(g.maker) && fin(g.taker)).map((g) => [String(g.groupId), g]));
      const needed = [...new Set(books.map((e) => e.groupId))];
      const absent = needed.filter((g) => !groups.has(g));
      if (absent.length) throw new Error(`fee group(s) ${absent.join(', ')} missing from the trade-fee answer (${books.filter((e) => absent.includes(e.groupId)).length} books)`);
      const rate = (g) => ({ maker: Math.max(0, -Number(groups.get(g).maker)), taker: Math.max(0, -Number(groups.get(g).taker)) }); // a rebate counts as 0
      const rows = needed.map((g) => ({ pair: `group ${g}`, ...rate(g) }));
      const detail = OKX_DETAIL.map((id) => pairs.get(id)).filter(Boolean).map((e) => ({ book: e.instId, group: e.groupId, ...rate(e.groupId) }));
      const dtxt = detail.map((x) => `${x.book} g${x.group} ${(x.maker * 100).toFixed(2)}/${(x.taker * 100).toFixed(2)}%`).join(', ');
      return { rows, tier: (d && d.level) || null, detail,
        coverage: `all ${books.length} routable USD/USDC/USDT books, fee groups ${needed.sort((a, b) => a - b).join(', ')}; highest used${dtxt ? `; ${dtxt}` : ''}` };
    },
  },
};

const last = Object.fromEntries(Object.keys(READERS).map((v) => [v, { ok: false, at: null, error: 'not read yet', tier: null, pairs: [] }]));
const timers = {};
const pct = (x) => `${(x * 100).toFixed(2)}%`;

async function refresh(venue, now = Date.now()) {
  const R = READERS[venue];
  if (!R) throw new Error(`venue-fees: unknown venue ${venue}`);
  if (!R.configured()) { // keys removed: no read possible (a cached verified rate still ages out at use time)
    last[venue] = { ok: false, at: now, error: 'no API keys configured', tier: null, pairs: [] };
    cost.expireStaleFees(venue, now);
    return last[venue];
  }
  try {
    const { rows, tier, coverage, detail } = await R.read();
    const maker = Math.max(...rows.map((x) => x.maker));
    const taker = Math.max(...rows.map((x) => x.taker));
    const source = `${R.label} account${tier ? ` ${tier}` : ''}: ${coverage}`;
    if (!cost.setVenueFees(venue, { maker, taker, source, at: now, coverage })) throw new Error(`implausible rates maker ${maker} / taker ${taker}`);
    last[venue] = { ok: true, at: now, error: null, tier, pairs: rows.map((x) => x.pair), detail: detail || null, maker, taker };
    console.log(`[venue-fees] ${R.label} account fees${tier ? ` (${tier})` : ''}: maker ${pct(maker)} / taker ${pct(taker)} (${coverage})`);
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
// Per venue: the latest lookup ({ ok, at, error, tier, pairs, detail }) + the rates in force with their provenance (cost.feeInfo).
const status = (venue) => ({ ...last[venue], inForce: cost.feeInfo(venue) });

module.exports = { refresh, start, stop, status, READERS, KRAKEN_PAIRS, OKX_DETAIL, REFRESH_MS, RETRY_MS };
