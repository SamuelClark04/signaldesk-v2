// Phase 95: the cross-symbol and event triggers of triggers@1 (spec 8.2), on per-minute closes carried forward (a minute without a
// trade keeps the last close; IEX / SIP gaps on thin ETFs never shift the clock). tAvail = the END of the minute that completes it.
//   T4 RS_DIVERGENCE  the 15-min return minus its comparison series' (sector ETF for a stock, SPY for an ETF; NOT ex-self: no weights)
//                     beyond 2 sd of the prior <= 20 sessions' values in the same 30-min time-of-day bucket; re-armed after 15 min
//   T5 PEER_SHOCK     a mapped peer's 5-min return beyond 2 sd (its prior sessions, same bucket) while the stock's own is within 1 sd;
//                     direction = the peer's move; re-armed after 15 min
//   T6 EVENT_SELF / EVENT_PEER  a classified headline (evt-rules@1-lite, not OTHER) naming the stock (SELF) or a mapped peer, at its
//                     receipt time; REACTIVE articles (the stock already moved >= 1.5 x ATR30 in the 30 min before) are skipped (spec 6);
//                     direction = the category rule for SELF, both sides for a peer or a BOTH rule
// Needs >= 5 prior sessions with >= 100 values per bucket for T4 / T5 (else none: never judged on a thin baseline).
const et = require('../../../server/services/et-time');
const X = require('./exposure');

const MIN = 60000;
// The session's closes per minute (index 0 = 9:30), carried forward; null before the first trade.
function dense(bars, open, n) {
  const out = new Array(n).fill(null); let k = 0; let last = null;
  for (let m = 0; m < n; m += 1) { const t = open + m * MIN; while (k < bars.length && bars[k].t <= t) { last = bars[k].c; k += 1; } out[m] = last; }
  return out;
}
const ret = (c, m, k) => (m >= k && c[m] && c[m - k] ? c[m] / c[m - k] - 1 : null);
function stats(values) {
  if (values.length < 100) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length; const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1));
  return sd > 0 ? { mean, sd } : null;
}
// per 30-min bucket stats of fn(m) over the prior sessions' dense series
function baseline(priorSessions, fn, n) {
  if (priorSessions.length < 5) return null;
  const buckets = Array.from({ length: Math.ceil(n / 30) }, () => []);
  for (const s of priorSessions) for (let m = 0; m < n; m += 1) { const v = fn(s, m); if (v !== null && Number.isFinite(v)) buckets[Math.floor(m / 30)].push(v); }
  return buckets.map(stats);
}

// day: YYYY-MM-DD; n: session minutes; series(sym) -> { today: dense closes, prior: [dense closes of prior sessions] } or null
function crossTriggers(symbols, day, n, series) {
  const open = et.toEpoch(day, 9, 30); const out = [];
  const add = (symbol, id, dir, m, extra) => out.push({ source: 'TRIGGER', symbol, day, trigger: id, dir, tAvail: open + (m + 1) * MIN, key: `${symbol}|${id}|${dir}|${open + (m + 1) * MIN}`, ...extra });
  for (const s of symbols) {
    const me = series(s); if (!me) continue;
    const b = X.benchOf(s); const bs = b && series(b);
    if (bs && me.prior.length && bs.prior.length) {
      const pairs = me.prior.map((c, i) => [c, bs.prior[i]]).filter(([, y]) => y);
      const base = baseline(pairs, ([c, y], m) => { const a = ret(c, m, 15); const r = ret(y, m, 15); return a === null || r === null ? null : a - r; }, n);
      const last = { UP: -Infinity, DOWN: -Infinity };
      for (let m = 15; base && m < n; m += 1) {
        const a = ret(me.today, m, 15); const r = ret(bs.today, m, 15); const st = base[Math.floor(m / 30)]; if (a === null || r === null || !st) continue;
        const z = (a - r - st.mean) / st.sd; const dir = z > 0 ? 'UP' : 'DOWN';
        if (Math.abs(z) >= 2 && m - last[dir] >= 15) { last[dir] = m; add(s, 'RS_DIVERGENCE', dir, m, { z: Math.round(z * 100) / 100, vs: b }); }
      }
    }
    const own = baseline(me.prior, (c, m) => ret(c, m, 5), n); if (!own) continue;
    for (const p of X.peersOf(s)) {
      const ps = series(p); if (!ps) continue; const pb = baseline(ps.prior, (c, m) => ret(c, m, 5), n); if (!pb) continue;
      const last = { UP: -Infinity, DOWN: -Infinity };
      for (let m = 5; m < n; m += 1) {
        const k = Math.floor(m / 30); const rp = ret(ps.today, m, 5); const rs = ret(me.today, m, 5); if (rp === null || rs === null || !pb[k] || !own[k]) continue;
        const zp = (rp - pb[k].mean) / pb[k].sd; const zs = (rs - own[k].mean) / own[k].sd; const dir = zp > 0 ? 'UP' : 'DOWN';
        if (Math.abs(zp) >= 2 && Math.abs(zs) < 1 && m - last[dir] >= 15) { last[dir] = m; add(s, 'PEER_SHOCK', dir, m, { peer: p, zPeer: Math.round(zp * 100) / 100 }); }
      }
    }
  }
  return out;
}

// docs: [{ docId, t_recv, headline, symbols }] (earliest receipt per document); closeMin: the session close (minutes); atrOf(sym) -> ATR30
function eventTriggers(symbols, day, docs, closeMin, series, atrOf) {
  const open = et.toEpoch(day, 9, 30); const close = et.toEpoch(day, Math.floor(closeMin / 60), closeMin % 60) - 30 * MIN; const out = [];
  for (const d of docs) {
    if (!(d.t_recv >= open && d.t_recv < close)) continue;
    const c = X.classify(d.headline); if (c.category === 'OTHER') continue;
    for (const s of symbols) {
      const rel = X.relation(s, d.symbols); if (rel === 'NONE') continue;
      const me = series(s); const a = atrOf(s); const m = Math.floor((d.t_recv - open) / MIN) - 1; // the last COMPLETED minute
      if (me && a && m >= 30 && me.today[m] && me.today[m - 30] && Math.abs(me.today[m] - me.today[m - 30]) >= 1.5 * a) continue; // REACTIVE
      const id = rel === 'SELF' ? 'EVENT_SELF' : 'EVENT_PEER';
      const dirs = rel === 'SELF' && c.dir !== 'BOTH' ? [c.dir] : ['UP', 'DOWN'];
      for (const dir of dirs) out.push({ source: 'TRIGGER', symbol: s, day, trigger: id, dir, tAvail: d.t_recv, key: `${s}|${id}|${dir}|${d.docId}`, category: `${c.category}/${c.subtype || '-'}`, headline: String(d.headline || '').slice(0, 140) });
    }
  }
  return out;
}

module.exports = { dense, crossTriggers, eventTriggers, baseline };
