// Decision recorder serialization (Phase 93). pick() runs IN the trading path (a shallow copy of a setup's fields, no JSON);
// lines() runs only in the recorder's flush (time-sliced): it turns one queued entry into JSONL lines, writing each distinct
// bar series ONCE per day file and referencing it by key from the decision line (Phase 94: the key is a sha256 of the stored series).
// Series kinds: 'bars' (bar-like objects -> [t, o, h, l, c, v] rows; null slots kept, e.g. Quick Flips' minute slots) and
// 'raw' (anything else, e.g. Quick Flips' prior sessions { ymd, closes5m, vols5m }), each capped at MAX_SERIES_BYTES.
const MAX_ROWS_KEEP = 500; // a series line over the byte cap keeps its newest rows only (flagged truncated)
const MAX_SERIES_BYTES = 512 * 1024;
const MAX_WRITTEN = 20000;
const crypto = require('crypto');
// Phase 94 S0-1: a series is identified by its COMPLETE stored contents (b2: / r2: + sha256 of the stored body; flush only, never in
// the trading path). The Phase 93 endpoint-only keys (b: / r:) could give two different series one stored copy.
const digest = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);

const SETUP_FIELDS = ['id', 'asset', 'market', 'strategyId', 'setupType', 'direction', 'timeframe', 'tradeType', 'expectedDuration', 'entryPrice', 'invalidation',
  'initialStop', 'positionSize', 'dollarRisk', 'notional', 'riskPct', 'fillPrice', 'openedAt', 'timestamp', 'thesis', 'execution', 'venue', 'sizingBasis', 'broker',
  'exitPrice', 'exitReason', 'netPnl', 'grossPnl', 'fees', 'closedAt', 'rMultiple', 'stagedAt', 'expiresAt', 'fillEstimated', 'status'];
const OPTION_FIELDS = ['underlying', 'type', 'structure', 'label', 'contract', 'shortContract', 'strike', 'shortStrike', 'width', 'expiration', 'dte', 'feed', 'multiplier',
  'iv', 'delta', 'netDelta', 'theta', 'hv20', 'bid', 'ask', 'debit', 'netMid', 'combinedLegSpread', 'exitSpread', 'refSpot', 'refAt', 'quoteTime', 'riskPerShare',
  'valueAtStop', 'valueAtTarget', 'horizon', 'entryDeadlineAt', 'afterHours'];

const small = (o) => (o && typeof o === 'object' ? { ...o } : o);
// A shallow, bounded copy of a setup / order / position (the trading path: no serialization here).
function pick(c) {
  if (!c || typeof c !== 'object') return null;
  const out = {};
  for (const k of SETUP_FIELDS) if (c[k] !== undefined) out[k] = c[k];
  if (c.entryZone) out.entryZone = small(c.entryZone);
  if (Array.isArray(c.targets)) out.targets = c.targets.slice(0, 4).map((t) => ({ level: t.level, price: t.price, allocation: t.allocation }));
  if (Array.isArray(c.confirmationCriteria)) out.confirmationCriteria = c.confirmationCriteria.slice(0, 8);
  if (c.catalyst) out.catalyst = { type: c.catalyst.type, headline: c.catalyst.headline, sentimentScore: c.catalyst.sentimentScore };
  if (c.evidence) out.evidence = small(c.evidence);
  if (c.newsSentiment) out.newsSentiment = small(c.newsSentiment);
  const od = c.optionsData;
  if (od && typeof od === 'object') {
    const o = {};
    for (const k of OPTION_FIELDS) if (od[k] !== undefined) o[k] = od[k];
    if (od.exitRule) o.exitRule = small(od.exitRule);
    if (od.quickFlip) o.quickFlip = small(od.quickFlip);
    if (Array.isArray(od.legs)) o.legs = od.legs.slice(0, 4).map((l) => ({ side: l.side, type: l.type, strike: l.strike, contract: l.contract || l.symbol, bid: l.bid, ask: l.ask, iv: l.iv, delta: l.delta }));
    out.optionsData = o;
  }
  return out;
}

const num = (x) => (x === undefined || x === null || x === '' ? null : Number(x));
const timeOf = (b) => (b.time ?? b.t ?? b.start ?? b.min ?? b.minute ?? b.date ?? null);
const isBar = (b) => b && typeof b === 'object' && ('close' in b || 'c' in b) && ('high' in b || 'h' in b);
const rowOf = (b) => (b ? [timeOf(b), num(b.open ?? b.o), num(b.high ?? b.h), num(b.low ?? b.l), num(b.close ?? b.c), num(b.volume ?? b.v)] : null);

function seriesLine(s) {
  const bars = Array.isArray(s.bars) ? s.bars : [];
  const first = bars.find((b) => b != null);
  let truncated = !!s.truncated;
  let body; let key;
  if (isBar(first)) {
    let rows = bars.map(rowOf);
    let json = JSON.stringify(rows);
    if (json.length > MAX_SERIES_BYTES) { rows = rows.slice(-MAX_ROWS_KEEP); json = JSON.stringify(rows); truncated = true; }
    key = `b2:${s.symbol}|${s.tf}|${s.name}|${digest(`${truncated}|${json}`)}`;
    body = { kind: 'bars', cols: ['t', 'o', 'h', 'l', 'c', 'v'], rows: JSON.parse(json) };
  } else {
    let data = bars.length ? bars : (s.data ?? null);
    let json = JSON.stringify(data);
    if (json && json.length > MAX_SERIES_BYTES && Array.isArray(data)) { data = data.slice(-Math.max(1, Math.floor(data.length / 4))); json = JSON.stringify(data); truncated = true; }
    key = `r2:${s.symbol}|${s.tf}|${s.name}|${digest(`${truncated}|${json || ''}`)}`;
    body = { kind: 'raw', data: json ? JSON.parse(json) : null };
  }
  return { key, line: { type: 'series', key, name: s.name, symbol: s.symbol || null, tf: s.tf || null, truncated, ...body }, truncated };
}

// One queued entry -> { lines: [json...], truncated }. has(key) / add(key): the day file's written-series set.
function lines(e, has, add) {
  if (e.type !== 'decision') return { lines: [JSON.stringify(e)], truncated: false };
  const out = []; let truncated = false;
  let context = null;
  if (e.context) {
    const c = e.context;
    const refs = [];
    for (const s of c.series || []) {
      try {
        const sl = seriesLine(s);
        truncated = truncated || sl.truncated;
        if (!has(sl.key)) { out.push(JSON.stringify(sl.line)); add(sl.key); }
        refs.push({ name: s.name, symbol: s.symbol || null, tf: s.tf || null, key: sl.key, truncated: sl.line.truncated });
      } catch (err) { refs.push({ name: s.name, error: String(err.message || err).slice(0, 120) }); }
    }
    context = { strategyId: c.strategyId || null, capturedAt: c.at || null, values: c.values || null, series: refs };
  }
  out.push(JSON.stringify({ ...e, context }));
  return { lines: out, truncated };
}

const writtenSeries = new Set();
function markWritten(k) { if (writtenSeries.size >= MAX_WRITTEN) writtenSeries.clear(); writtenSeries.add(k); }

module.exports = { pick, lines, seriesLine, rowOf, writtenSeries, markWritten, MAX_SERIES_BYTES, MAX_ROWS_KEEP };
