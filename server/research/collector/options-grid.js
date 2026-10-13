// Phase 95 Tasks 1.2 / 1.3 (plan 5.2): the research collector's option contract set, RECORD-ONLY.
// - Re-centre every 30 min in session (and at once after a start): the spot of each underlying (IEX latest trade), then its chain for
//   the Q bucket (nearest 1-7 DTE, +/-5% strikes) and the D / W monthlies (+/-8%). Every quoted chain row is recorded (OPTION_QUOTES)
//   and one OPTION_CANDIDATES line per underlying names, per bucket and side, the contract closest to 0.50 delta (nearest the money
//   without greeks). The replay may ONLY use these selections.
// - Every candidate is PINNED and sampled until it expires (Q pins: until that session's close, Q / H never hold overnight); pins are
//   saved in research-pins.json, so a restart keeps sampling what an open research trade holds.
// - Sampling: the Q grid (3 strikes each side, both sides) + Q pins every 60 s; D / W pins every 10 min; <= 100 contracts a request.
// Every quote row keeps the PROVIDER quote time and our receipt time; the feed label is INDICATIVE (free plan) unless
// RESEARCH_OPTIONS_FEED=opra: indicative prices are estimates and never validate executable profits (plan 5.3).
const fs = require('fs');
const path = require('path');
const cal = require('../nyse-calendar');
const et = require('../../services/et-time');
const oc = require('./option-chain');

const RECENTRE_MS = 30 * 60 * 1000; const Q_MS = 60 * 1000; const DW_MS = 10 * 60 * 1000; const TICK_MS = 15 * 1000;
const BATCH = 100; const MAX_PAGES = 3;

function create({ fetchImpl, keys, base = 'https://data.alpaca.markets', symbols, record, now = () => Date.now(), dir, feed = 'indicative' }) {
  const label = feed === 'opra' ? 'MARKET_QUOTE' : 'INDICATIVE_ESTIMATE';
  const pinsFile = path.join(dir, 'research-pins.json');
  let pins = {}; try { pins = JSON.parse(fs.readFileSync(pinsFile, 'utf8')).pins || {}; } catch { pins = {}; }
  const grid = new Map(); // underlying -> Q grid contracts of the last re-centre
  const st = { recentres: 0, requests: 0, errors: 0, lastError: null, quotesRows: 0, lastRecentre: 0, lastQ: 0, lastDW: 0, day: null };
  let timer = null; let busy = false;

  const savePins = () => { try { fs.writeFileSync(`${pinsFile}.tmp`, JSON.stringify({ v: 1, pins })); fs.renameSync(`${pinsFile}.tmp`, pinsFile); } catch (e) { st.lastError = `pins: ${e.message}`; } };
  async function get(url) {
    const k = keys(); if (!k) throw new Error('no Alpaca data keys');
    // A timeout / network failure is retried ONCE with a longer timeout (large ETF chains took > 15 s live); an HTTP error is not.
    for (let attempt = 0; ; attempt += 1) {
      st.requests += 1;
      let res;
      try { res = await fetchImpl(url, { headers: { 'APCA-API-KEY-ID': k.key, 'APCA-API-SECRET-KEY': k.secret }, signal: AbortSignal.timeout(attempt ? 30000 : 15000) }); }
      catch (e) { if (attempt) throw e; st.retries = (st.retries || 0) + 1; continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url.split('?')[0].replace(base, '')}`);
      return res.json();
    }
  }
  const fail = (where, err) => { st.errors += 1; st.lastError = `${where}: ${String(err && err.message || err).slice(0, 160)}`; record('POLL_STATUS', { source: 'options-grid', ok: false, where, error: st.lastError }); };
  const writeQuotes = (rows, tRecv, src) => {
    const q = rows.filter((r) => r.tQuote !== null && (r.bid !== null || r.ask !== null));
    for (let i = 0; i < q.length; i += 500) record('OPTION_QUOTES', { feed, label, src, tRecv, rows: q.slice(i, i + 500).map(oc.compact) });
    st.quotesRows += q.length;
  };
  async function chain(sym, params) {
    const rows = []; let token = null;
    for (let p = 0; p < MAX_PAGES; p += 1) {
      const body = await get(`${base}/v1beta1/options/snapshots/${encodeURIComponent(sym)}?feed=${feed}&limit=1000&${params}${token ? `&page_token=${encodeURIComponent(token)}` : ''}`);
      for (const [s, snap] of Object.entries(body.snapshots || {})) { const r = oc.toRow(s, snap); if (r) rows.push(r); }
      token = body.next_page_token; if (!token) break;
    }
    return rows;
  }

  async function recentre() {
    const t0 = now(); const today = et.ymd(t0); let spots = {};
    try { const b = await get(`${base}/v2/stocks/trades/latest?feed=iex&symbols=${symbols().map(encodeURIComponent).join(',')}`); spots = b.trades || {}; }
    catch (e) { fail('spots', e); return; }
    const { D, W } = oc.monthlyBuckets(today);
    for (const sym of symbols()) {
      const spot = spots[sym] && spots[sym].p; if (!Number.isFinite(spot)) { fail(`spot ${sym}`, 'no latest trade'); continue; }
      const cands = [];
      try {
        const qRows = await chain(sym, `expiration_date_gte=${oc.addDays(today, 1)}&expiration_date_lte=${oc.addDays(today, 7)}&strike_price_gte=${(spot * 0.95).toFixed(2)}&strike_price_lte=${(spot * 1.05).toFixed(2)}`);
        writeQuotes(qRows, now(), 'chain-Q');
        const qe = oc.qExpiry(qRows, today); const qr = qRows.filter((r) => r.expiry === qe);
        grid.set(sym, qe ? oc.qGrid(qr, spot) : []);
        for (const side of ['call', 'put']) { const c = qe && oc.pick(qr, side, spot); if (c) cands.push({ bucket: 'Q', c }); }
        for (const [bucket, exp] of [['D', D], ['W', W]]) {
          if (!exp) continue;
          const rows = await chain(sym, `expiration_date=${exp}&strike_price_gte=${(spot * 0.92).toFixed(2)}&strike_price_lte=${(spot * 1.08).toFixed(2)}`);
          writeQuotes(rows, now(), `chain-${bucket}`);
          for (const side of ['call', 'put']) { const c = oc.pick(rows, side, spot); if (c) cands.push({ bucket, c }); }
        }
      } catch (e) { fail(`chain ${sym}`, e); }
      if (!cands.length) continue;
      record('OPTION_CANDIDATES', { underlying: sym, spot, spotAt: Date.parse(spots[sym].t) || null, feed, rows: cands.map(({ bucket, c }) => ({
        bucket, side: c.side, contract: c.contract, expiry: c.expiry, strike: c.strike, delta: c.delta, dte: oc.daysBetween(today, c.expiry), rule: c.delta !== null ? 'delta50' : 'atm' })) });
      for (const { bucket, c } of cands) if (!pins[c.contract]) pins[c.contract] = { underlying: sym, bucket, expiry: c.expiry, day: today, pinnedAt: t0 };
    }
    st.recentres += 1; st.lastRecentre = t0; savePins();
  }

  async function sample(contracts, src) {
    for (let i = 0; i < contracts.length; i += BATCH) {
      const part = contracts.slice(i, i + BATCH);
      try {
        const b = await get(`${base}/v1beta1/options/snapshots?feed=${feed}&symbols=${part.map(encodeURIComponent).join(',')}`);
        const rows = Object.entries(b.snapshots || {}).map(([s, snap]) => oc.toRow(s, snap)).filter(Boolean);
        writeQuotes(rows, now(), src);
      } catch (e) { fail(`sample ${src}`, e); }
    }
  }

  // Q pins end with their session; D / W pins after their expiry date.
  function prunePins(today) {
    let n = 0;
    for (const [c, p] of Object.entries(pins)) if ((p.bucket === 'Q' && p.day !== today) || p.expiry < today) { delete pins[c]; n += 1; }
    if (n) savePins();
  }

  async function tick() {
    if (busy) return; busy = true;
    try {
      const t = now(); const today = et.ymd(t);
      if (st.day !== today) { st.day = today; grid.clear(); prunePins(today); }
      if (!cal.isOpen(t)) return;
      if (t - st.lastRecentre >= RECENTRE_MS) await recentre();
      if (t - st.lastQ >= Q_MS) {
        st.lastQ = t;
        const q = new Set([...[...grid.values()].flat(), ...Object.entries(pins).filter(([, p]) => p.bucket === 'Q').map(([c]) => c)]);
        await sample([...q], 'Q');
      }
      if (t - st.lastDW >= DW_MS) { st.lastDW = t; await sample(Object.entries(pins).filter(([, p]) => p.bucket !== 'Q').map(([c]) => c), 'DW'); }
    } catch (e) { fail('tick', e); } finally { busy = false; }
  }

  return {
    tick, recentre, sample, prunePins,
    start() { if (timer) return; timer = setInterval(() => { tick(); }, TICK_MS); if (timer.unref) timer.unref(); tick(); },
    stop() { if (timer) clearInterval(timer); timer = null; },
    stats: () => ({ label, feed, recentres: st.recentres, requests: st.requests, errors: st.errors, lastError: st.lastError, quoteRows: st.quotesRows,
      gridContracts: [...grid.values()].reduce((a, g) => a + g.length, 0), pinned: Object.keys(pins).length, lastRecentre: st.lastRecentre || null }),
    _pins: () => pins,
  };
}

module.exports = { create, RECENTRE_MS, Q_MS, DW_MS };
