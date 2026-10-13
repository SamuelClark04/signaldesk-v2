// Phase 95 Task 7.x: the frozen discovery and forward-test protocol (docs/research/phase95-protocol.md, version 1). Run after each
// shadow recompute; it decides by itself whether a discovery run is due, evaluates open proposals once (one look at n_eff 40), and keeps
// every candidate, proposal and verdict in research-data/discovery/ (write-once files for candidate lists and proposals).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const B = 10000;
const alphaK = (k) => (0.10 * 6) / (Math.PI ** 2 * k * k);
const betaK = (k) => (0.05 * 6) / (Math.PI ** 2 * k * k);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const DAY = 86400000;

function rng(seedHex) { // mulberry32 seeded from the first 8 bytes (two 32-bit words xor-ed)
  let a = (parseInt(seedHex.slice(0, 8), 16) ^ parseInt(seedHex.slice(8, 16), 16)) >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// byDay: [[net, ...], ...] (one array per trading day) -> { mean, p, lo95 }
function bootstrap(byDay, id) {
  const all = byDay.flat(); const mHat = all.reduce((a, b) => a + b, 0) / all.length; const r = rng(sha(id)); const ms = new Float64Array(B); let hits = 0;
  for (let b = 0; b < B; b += 1) {
    let s = 0; let n = 0;
    for (let d = 0; d < byDay.length; d += 1) { const day = byDay[Math.floor(r() * byDay.length)]; for (const x of day) s += x; n += day.length; }
    ms[b] = s / n; if (ms[b] - mHat >= mHat) hits += 1;
  }
  ms.sort();
  return { mean: mHat, p: (1 + hits) / (B + 1), lo95: ms[Math.floor(0.025 * B)] };
}
// Benjamini-Hochberg (and -Yekutieli with c(m)) rejections at level q
function stepUp(ps, q, by = false) {
  const m = ps.length; const c = by ? Array.from({ length: m }, (_, i) => 1 / (i + 1)).reduce((a, b) => a + b, 0) : 1;
  const order = ps.map((p, i) => [p, i]).sort((x, y) => x[0] - y[0]); let kMax = -1;
  order.forEach(([p], j) => { if (p <= ((j + 1) / m) * (q / c)) kMax = j; });
  const out = new Array(m).fill(false); for (let j = 0; j <= kMax; j += 1) out[order[j][1]] = true; return out;
}

// The closed trades of a book (from run.js books), optionally limited to days by `keep(day)` -> [{ day, net, stress, symbol }]
const tradesOf = (book, keep = () => true) => book.entries.filter((e) => e.status === 'ENTERED' && e.outcome.exit.status === 'CLOSED' && keep(e.outcome.opp.day))
  .map((e) => ({ day: e.outcome.opp.day, net: e.outcome.exit.net, stress: e.outcome.stressNet ?? e.outcome.exit.net, symbol: e.outcome.opp.symbol }));
function describe(trades, id) {
  const days = [...new Set(trades.map((t) => t.day))].sort(); const syms = new Set(trades.map((t) => t.symbol));
  const byDay = days.map((d) => trades.filter((t) => t.day === d).map((t) => t.net));
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const half = Math.floor(days.length / 2); const h1 = trades.filter((t) => t.day < days[half]); const h2 = trades.filter((t) => t.day >= days[half]);
  const enough = days.length >= 30 && (syms.size >= 8 || (syms.size === 1 && days.length >= 40));
  const bs = enough ? bootstrap(byDay, id) : { mean: mean(trades.map((t) => t.net)), p: 1, lo95: null };
  return { trades: trades.length, nEff: days.length, symbols: syms.size, tested: enough, mean: bs.mean, p: bs.p, lo95: bs.lo95,
    stressMean: mean(trades.map((t) => t.stress)), half1: mean(h1.map((t) => t.net)), half2: mean(h2.map((t) => t.net)) };
}
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeOnce = (f, obj) => { const text = JSON.stringify(obj, null, 1); fs.writeFileSync(f, text, { flag: 'wx' }); return sha(text); };

// result: run.js output; protocolFile: the frozen protocol; dir: research-data/discovery; today: YYYY-MM-DD (the last session)
function step({ result, protocolFile, dir, today, nowMs = Date.now() }) {
  fs.mkdirSync(path.join(dir, 'proposals'), { recursive: true }); fs.mkdirSync(path.join(dir, 'status'), { recursive: true });
  const stateFile = path.join(dir, 'state.json'); const state = readJson(stateFile, { runs: [] });
  const protocolSha = sha(fs.readFileSync(protocolFile));
  const books = new Map(result.books.map((b) => [b.id, b]));
  // 1. proposals: forward windows and the one look
  const proposals = fs.readdirSync(path.join(dir, 'proposals')).filter((n) => n.endsWith('.json')).map((n) => readJson(path.join(dir, 'proposals', n)));
  const status = (p) => readJson(path.join(dir, 'status', `${p.key}.json`), { verdict: null });
  const forward = [];
  for (const p of proposals) {
    const s = status(p); const b = books.get(p.book);
    const tr = b ? tradesOf(b, (d) => d > p.frozenOn) : []; const st = describe(tr, `${p.key}|fwd`);
    if (!s.verdict) {
      if (st.nEff >= 40) {
        const firstForty = [...new Set(tr.map((t) => t.day))].sort().slice(0, 40); const look = describe(tr.filter((t) => firstForty.includes(t.day)), `${p.key}|fwd`);
        const pass = look.p <= betaK(p.k) / p.familySize && look.stressMean > 0 && look.half1 > 0 && look.half2 > 0;
        Object.assign(s, { verdict: pass ? (p.label === 'MARKET_QUOTE' ? 'VALIDATED' : 'PASSED-INDICATIVE') : 'FAILED', on: today, look, threshold: betaK(p.k) / p.familySize });
      } else if (Date.parse(`${today}T12:00:00Z`) - Date.parse(`${p.frozenOn}T12:00:00Z`) > 365 * DAY) Object.assign(s, { verdict: 'INCONCLUSIVE', on: today });
      if (s.verdict) fs.writeFileSync(path.join(dir, 'status', `${p.key}.json`), JSON.stringify(s, null, 1));
    }
    forward.push({ ...p, verdict: s.verdict, verdictOn: s.on || null, interim: s.verdict ? null : st });
  }
  // 2. the pool: sessions outside every open forward window
  const reserved = (d) => forward.some((p) => d > p.frozenOn && (!p.verdictOn || d <= p.verdictOn));
  const poolDays = result.days.filter((d) => d <= today && !reserved(d));
  const poolSymbolDays = new Set(result.opportunities.filter((o) => poolDays.includes(o.day)).map((o) => `${o.symbol}|${o.day}`)).size;
  // 3. is run k due?
  const last = state.runs[state.runs.length - 1]; const k = state.runs.length + 1;
  const since = last ? last.on : result.days[0];
  const due = !!since && ((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${since}T12:00:00Z`)) >= 28 * DAY || poolSymbolDays - (last ? last.poolSymbolDays : 0) >= 200);
  let run = null;
  if (due && !fs.existsSync(path.join(dir, `run-${k}.json`))) {
    const ids = [...books.values()].filter((b) => b.family !== 'CONTROL').map((b) => b.id).sort();
    const listSha = writeOnce(path.join(dir, `run-${k}-candidates.json`), { k, on: today, protocolSha, poolDays, candidates: ids }); // hashed BEFORE any outcome is read
    const keep = (d) => poolDays.includes(d);
    const cands = ids.map((id) => ({ id, ...describe(tradesOf(books.get(id), keep), id) }));
    const rej = stepUp(cands.map((c) => c.p), alphaK(k)); const rejBY = stepUp(cands.map((c) => c.p), alphaK(k), true);
    for (const [i, c] of cands.entries()) {
      const b = books.get(c.id); const ctrl = books.get(`CONTROL|${b.rule}|${b.label}`); const cm = ctrl ? describe(tradesOf(ctrl, keep), `${ctrl.id}|ctrl`).mean : null;
      Object.assign(c, { bh: rej[i], by: rejBY[i], controlMean: cm, pairedPE: /^(NEWS_FIRST|EVENT_)/.test(b.family) ? 'n/a (v1: no feature bins)' : null });
      c.promising = c.bh && c.lo95 !== null && c.lo95 > 0 && c.stressMean > 0 && c.half1 > 0 && c.half2 > 0 && cm !== null && c.mean > cm;
    }
    const promising = cands.filter((c) => c.promising);
    for (const c of promising) {
      const b = books.get(c.id); const key = sha(`${c.id}|run${k}`).slice(0, 16);
      try { writeOnce(path.join(dir, 'proposals', `${key}.json`), { key, book: c.id, family: b.family, rule: b.rule, label: b.label, k, familySize: promising.length, frozenOn: today, protocolSha, discovery: c }); } catch { /* already frozen */ }
    }
    run = { k, on: today, alpha: alphaK(k), protocolSha, listSha, poolDays: poolDays.length, poolSymbolDays, candidates: cands.length, tested: cands.filter((c) => c.tested).length, promising: promising.length };
    fs.writeFileSync(path.join(dir, `run-${k}.json`), JSON.stringify({ ...run, results: cands }, null, 1));
    state.runs.push(run); fs.writeFileSync(stateFile, JSON.stringify(state, null, 1));
  }
  const lastRun = state.runs.length ? readJson(path.join(dir, `run-${state.runs.length}.json`), null) : null;
  return { runs: state.runs, lastRun, ranNow: run, forward, poolDays: poolDays.length, poolSymbolDays, nextK: state.runs.length + 1, nextAlpha: alphaK(state.runs.length + 1), nowMs };
}

module.exports = { step, bootstrap, stepUp, alphaK, betaK, describe };
