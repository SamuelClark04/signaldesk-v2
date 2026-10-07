// Decision inputs (Phase 93): what a strategy actually used to propose or block a setup, kept BESIDE the candidate (never on
// it: staged orders are saved in the ledger and broadcast to the browser), in a bounded in-memory store keyed by setup id.
// The decision recorder attaches the entry to the setup's records; the analyzer reads them as RECORDED evidence.
//   capture(id, { strategyId, symbol, values, series: [{ name, symbol, tf, bars }] })
//       SYNCHRONOUS, never throws: each series (the newest MAX_BARS; longer ones flagged truncated) is copied into FROZEN bars /
//       values (Phase 94 S0-1: a bar the stream later updates in place never changes the evidence); values are bounded copies.
//       No serialization here (the recorder's flush does it, time-sliced).
//   block(id, reason, candidate, inputs)   a strategy-internal skip AFTER a signal fired (e.g. an ORB breakout filtered out):
//       capture + decision-recorder STRATEGY_BLOCK in one call. No guard snapshot: such a filter is checked against its own recorded
//       signal values (Decision Review rule checks), never against the book limits / shields (Phase 94 S0-3: guard-exempt).
// Observational: nothing here feeds a trading decision, and a failure is counted, never raised.
const MAX_IDS = 500;
const MAX_BARS = 3000;
const store = new Map(); // id -> { at, strategyId, values, series }
let errors = 0;

// Bounded copy of signal values: scalars as-is; arrays <= 50 items, objects <= 40 keys, 3 levels deep (signal contexts can hold
// whole indicator arrays: the bar series are kept separately, in full). Functions and deeper levels are dropped.
function copyValues(v, depth = 0) {
  if (v === null || ['number', 'string', 'boolean'].includes(typeof v)) return v;
  if (typeof v !== 'object' || depth >= 3) return undefined;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => copyValues(x, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v).slice(0, 40)) { const c = copyValues(x, depth + 1); if (c !== undefined) out[k] = c; }
  return out;
}

const iso = (x) => (x instanceof Date ? x.toISOString() : x);
const timeOf = (b) => iso(b.time ?? b.t ?? b.start ?? b.min ?? b.minute ?? b.date ?? null);
const num = (x) => (x === undefined || x === null || x === '' ? null : Number(x));
const isBar = (b) => b && typeof b === 'object' && ('close' in b || 'c' in b) && ('high' in b || 'h' in b);
// Phase 94 S0-1: DETACHED, frozen bars: a bar the stream later updates in place (the live last bar) never changes the evidence.
// Memory (review): a series re-captured every pass REUSES the previous capture's frozen bar when all six fields are unchanged, so
// 500 ids sharing SPY / daily bars hold one frozen copy each, not 500 (one Map lookup + compare per bar; a changed bar is re-copied).
const frozenBySeries = new Map(); // `symbol|tf|name` -> Map(time -> frozen bar) of the latest capture
const MAX_SERIES_KEYS = 400;
const same = (f, b) => f.open === num(b.open ?? b.o) && f.high === num(b.high ?? b.h) && f.low === num(b.low ?? b.l) && f.close === num(b.close ?? b.c) && f.volume === num(b.volume ?? b.v);
const barCopy = (b) => (b && typeof b === 'object' ? Object.freeze({ time: timeOf(b), open: num(b.open ?? b.o), high: num(b.high ?? b.h), low: num(b.low ?? b.l),
  close: num(b.close ?? b.c), volume: num(b.volume ?? b.v) }) : null);
function rawCopy(v, depth = 0) { // non-bar series data (e.g. Quick Flips' prior sessions): plain arrays / objects of scalars, 4 levels
  if (v instanceof Date) return v.toISOString();
  if (v === null || typeof v !== 'object') return v;
  if (depth >= 4) return null;
  return Object.freeze(Array.isArray(v) ? v.map((x) => rawCopy(x, depth + 1)) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rawCopy(x, depth + 1)])));
}
function seriesCopy(src, key) {
  const first = src.find((b) => b != null);
  if (!isBar(first)) return Object.freeze(src.map((x) => rawCopy(x)));
  const prev = frozenBySeries.get(key); const next = new Map();
  const out = src.map((b) => {
    if (!b || typeof b !== 'object') return null;
    const t = timeOf(b); const f = prev && prev.get(t);
    const c = f && same(f, b) ? f : barCopy(b);
    next.set(t, c); return c;
  });
  frozenBySeries.delete(key); frozenBySeries.set(key, next);
  if (frozenBySeries.size > MAX_SERIES_KEYS) frozenBySeries.delete(frozenBySeries.keys().next().value);
  return Object.freeze(out);
}

function capture(id, { strategyId = null, symbol = null, values = null, series = [] } = {}) {
  try {
    if (!id) return false;
    const list = [];
    for (const s of series || []) {
      if (!s || !s.name) continue;
      const src = Array.isArray(s.bars) ? s.bars : null;
      list.push({ name: s.name, symbol: s.symbol || symbol, tf: s.tf || null, bars: src ? seriesCopy(src.slice(-MAX_BARS), `${s.symbol || symbol}|${s.tf || ''}|${s.name}`) : null, data: src ? undefined : rawCopy(s.data),
        truncated: !!(src && src.length > MAX_BARS) });
    }
    if (store.has(id)) store.delete(id);
    store.set(id, { at: Date.now(), strategyId, symbol, values: copyValues(values), series: list });
    if (store.size > MAX_IDS) store.delete(store.keys().next().value);
    return true;
  } catch { errors += 1; return false; }
}

function block(id, reason, candidate, inputs) {
  try {
    capture(id, inputs);
    return require('./decision-recorder').record('STRATEGY_BLOCK', id, { reason, candidate });
  } catch { errors += 1; return false; }
}

const get = (id) => store.get(id) || null;
const stats = () => ({ ids: store.size, errors });
const clear = () => { store.clear(); frozenBySeries.clear(); errors = 0; };

module.exports = { capture, block, get, stats, clear, MAX_IDS, MAX_BARS };
