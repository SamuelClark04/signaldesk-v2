// Option marks (Phase 94 Stage 1, RECORD-ONLY): the quotes options-data.refreshQuotes ALREADY fetched (open / staged contracts), at most
// once per contract per MARK_EVERY_MS: bid / ask, the quote's own time and age, IV and Greeks with their source (alpaca | model | none),
// DTE and the feed. Indicative feed (not OPRA): labelled by `feed`. No extra request is ever made here.
const rec = require('./event-recorder');

const MARK_EVERY_MS = 60 * 1000;
let last = new Map(); // contract -> last recorded at

function observe(symbol, c, now = Date.now()) {
  try {
    if (!symbol || !c) return false;
    const prev = last.get(symbol);
    if (prev && now - prev < MARK_EVERY_MS) return false;
    let feed = null; try { feed = require('../connectors/options-data').feed(); } catch { feed = null; }
    const ok = rec.record('OPTION_MARK', { contract: symbol, underlying: c.underlying, type: c.type, strike: c.strike, expiration: c.expiration, dte: c.dte,
      bid: c.bid, ask: c.ask, quoteTime: c.quoteTime || null, quoteAgeMs: c.quoteTime ? now - c.quoteTime : null, iv: c.iv ?? null, delta: c.delta ?? null,
      gamma: c.gamma ?? null, theta: c.theta ?? null, vega: c.vega ?? null, greeksSource: c.greeksSource || null, feed });
    if (ok) { last.set(symbol, now); if (last.size > 5000) last.delete(last.keys().next().value); } // throttled only once recorded
    return ok;
  } catch { return false; }
}

module.exports = { observe, MARK_EVERY_MS, _test: { reset: () => { last = new Map(); } } };
