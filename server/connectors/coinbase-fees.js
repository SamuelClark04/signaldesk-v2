// The Coinbase account's REAL fee tier (Phase 65). Advanced Trade reports it on
// GET /api/v3/brokerage/transaction_summary: fee_tier.maker_fee_rate / taker_fee_rate
// (fractions, e.g. "0.006" / "0.012", set by the 30-day volume). Read at startup and
// every REFRESH_MS; the rates go to cost-authority.setCoinbaseFees, so the cost gate,
// the stop floors, the exit quotes, break-even and the fee hurdle all use what Coinbase
// really charges this account. Read-only (no orders). Fails soft: until a read succeeds
// (no key, network, API change) the .env / default Intro-tier rates (0.60% maker /
// 1.20% taker) stay in force, and the reason is kept in status().
const api = require('./coinbase-api');
const cost = require('../risk/cost-authority');

const PATH = '/api/v3/brokerage/transaction_summary';
const REFRESH_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
let last = { ok: false, at: null, error: 'not read yet', tier: null };
let timer = null;

// { maker, taker, tier } from a transaction_summary body, or null.
function parse(body) {
  const t = body && body.fee_tier;
  const maker = Number(t && t.maker_fee_rate);
  const taker = Number(t && t.taker_fee_rate);
  return Number.isFinite(maker) && Number.isFinite(taker) && taker > 0 ? { maker, taker, tier: (t.pricing_tier || '').trim() || null } : null;
}

async function refresh(now = Date.now()) {
  const auth = api.loadAuth();
  if (auth.error) { last = { ok: false, at: now, error: auth.error, tier: null }; cost.expireStaleFees('coinbase', now); return last; } // Phase 92: ages out too
  try {
    const r = parse(await api.cbFetch(auth, 'GET', PATH, { query: '?product_type=SPOT' }));
    if (!r) throw new Error('no fee_tier in the transaction summary');
    const set = cost.setCoinbaseFees({ maker: r.maker, taker: r.taker, source: `Coinbase account tier${r.tier ? ` ${r.tier}` : ''}`, at: now });
    if (!set) throw new Error(`implausible rates maker ${r.maker} / taker ${r.taker}`);
    last = { ok: true, at: now, error: null, tier: r.tier, maker: r.maker, taker: r.taker };
    console.log(`[coinbase-fees] account fee tier${r.tier ? ` ${r.tier}` : ''}: maker ${(r.maker * 100).toFixed(2)}% / taker ${(r.taker * 100).toFixed(2)}%`);
  } catch (err) {
    last = { ok: false, at: now, error: err.message, tier: null };
    if (cost.expireStaleFees("coinbase", now)) console.warn(`[coinbase-fees] last verified tier older than ${cost.VERIFIED_MAX_AGE_MS / 3600000} h; new entries now costed at the higher fallback`); // Phase 92
    const f = cost.coinbaseFees();
    console.warn(`[coinbase-fees] fee tier unavailable (${err.message}); using ${(f.maker * 100).toFixed(2)}% / ${(f.taker * 100).toFixed(2)}% (${f.source})`);
  }
  return last;
}

function start() {
  if (timer) return;
  const loop = () => refresh().catch(() => null).then((r) => { timer = setTimeout(loop, r && r.ok ? REFRESH_MS : RETRY_MS); if (timer.unref) timer.unref(); });
  loop();
}
function stop() { clearTimeout(timer); timer = null; }
const status = () => ({ ...last, inForce: cost.coinbaseFees() });

module.exports = { refresh, start, stop, status, parse, PATH };
