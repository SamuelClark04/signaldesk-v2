// Decision inputs (Phase 93): what a strategy actually used to propose or block a setup, kept BESIDE the candidate (never on
// it: staged orders are saved in the ledger and broadcast to the browser), in a bounded in-memory store keyed by setup id.
// The decision recorder attaches the entry to the setup's records; the analyzer reads them as RECORDED evidence.
//   capture(id, { strategyId, symbol, values, series: [{ name, symbol, tf, bars }] })
//       SYNCHRONOUS, never throws: each bars array is slice()d (the newest MAX_BARS; longer ones flagged truncated), values are
//       shallow-copied numbers / strings. No serialization here (the recorder's flush does it, time-sliced).
//   block(id, reason, candidate, inputs)   a strategy-internal skip AFTER a signal fired (e.g. an ORB breakout filtered out):
//       capture + decision-recorder STRATEGY_BLOCK in one call.
// Observational: nothing here feeds a trading decision, and a failure is counted, never raised.
const MAX_IDS = 500;
const MAX_BARS = 3000;
const store = new Map(); // id -> { at, strategyId, values, series }
let errors = 0;

function copyValues(v) {
  if (!v || typeof v !== 'object') return null;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (x === null || ['number', 'string', 'boolean'].includes(typeof x)) out[k] = x;
    else if (Array.isArray(x)) out[k] = x.slice(0, 50);
    else if (typeof x === 'object') out[k] = { ...x };
  }
  return out;
}

function capture(id, { strategyId = null, symbol = null, values = null, series = [] } = {}) {
  try {
    if (!id) return false;
    const list = [];
    for (const s of series || []) {
      if (!s || !s.name) continue;
      const src = Array.isArray(s.bars) ? s.bars : null;
      list.push({ name: s.name, symbol: s.symbol || symbol, tf: s.tf || null, bars: src ? src.slice(-MAX_BARS) : null, data: src ? undefined : s.data,
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
const clear = () => { store.clear(); errors = 0; };

module.exports = { capture, block, get, stats, clear, MAX_IDS, MAX_BARS };
