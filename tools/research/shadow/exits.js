// Phase 95 Task 5.3 (plan 6.4 / 6.5): research exits. Conditions are checked ONLY at observed quotes; the fill is at the BID of the
// first ELIGIBLE quote with provider time >= the trigger quote + L (the NEXT observation): never at the threshold, never between snapshots.
//   Q  net target / net stop ($, 1 contract, fees both sides) / time stop / flat at 15:50 ET (10 min before an early close)
//   H  stop at -stopPct % of the premium (bid), exit holdMin after entry or flat at 15:50
//   D / W  stop at -stopPct %, EXPIRY_EXIT from 10:00 ET once within 2 calendar or 2 trading days of expiry, else the trigger at
//          15:50 of session +N (holidays and early closes from the NYSE calendar)
// Labels: EXIT_DELAYED (the fill quote came later than 2 sampling intervals), GAP_EXIT (a Q / H fill on a later day), QUOTES_ENDED (no
// fill quote and the data has moved on: closed at the last observed bid; excluded from pass criteria), QUOTE_GAP (a D / W hold with a
// whole session without quotes). A trigger with no later quote yet stays OPEN (pending), completed when later data arrives.
const cal = require('../../../server/research/nyse-calendar');
const et = require('../../../server/services/et-time');
const { eligible, sessionsBetween } = require('./fills');

const MIN = 60000;
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const nextDay = (d) => new Date(Date.parse(`${d}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
function sessionAfter(day, n) { let d = day; let k = 0; while (k < n) { d = nextDay(d); if (cal.isSessionDay(d)) k += 1; } return d; }
const closeAt = (day) => { const m = cal.closeMinOf(day); return et.toEpoch(day, Math.floor(m / 60), m % 60); };
const flatAt = (day) => closeAt(day) - 10 * MIN;
const calDays = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
const valid = (q) => q && q.bid > 0 && q.ask >= q.bid;

function runExit(quotes, entry, o) {
  const day = entry.day || et.ymd(entry.t); const fees2 = 2 * (entry.fees ?? 0.05); const L = o.latencyMs ?? 5000;
  const netAt = (bid) => r6(bid * 100 - entry.price * 100 - fees2);
  const pctStop = o.stopPct ? entry.price * (1 - o.stopPct / 100) : null;
  const stopNet = o.family === 'Q' ? o.stop : pctStop !== null ? netAt(pctStop) : null;
  const sampleMs = o.family === 'Q' || o.family === 'H' ? MIN : 10 * MIN;
  const planned = o.family === 'D' || o.family === 'W' ? sessionAfter(day, o.sessions) : day;
  let mfe = -Infinity; let mae = Infinity; let trigger = null; let reason = null; let lastValid = null; const labels = [];
  const after = quotes.filter((q) => q.t_quote > entry.t);
  let prevDay = day;
  for (const q of after) {
    if (!valid(q)) continue;
    const qd = et.ymd(q.t_quote);
    if ((o.family === 'D' || o.family === 'W') && sessionsBetween(prevDay, qd) > 1 && !labels.includes('QUOTE_GAP')) labels.push('QUOTE_GAP');
    prevDay = qd; lastValid = q;
    const net = netAt(q.bid); mfe = Math.max(mfe, net); mae = Math.min(mae, net);
    if (o.family === 'Q') {
      if (net <= o.stop) reason = 'STOP'; else if (net >= o.target) reason = 'TARGET';
      else if (q.t_quote >= flatAt(day)) reason = 'FLAT_1550'; else if (q.t_quote >= entry.t + o.timeStopMin * MIN) reason = 'TIME';
    } else if (o.family === 'H') {
      if (q.bid <= pctStop) reason = 'STOP'; else if (q.t_quote >= flatAt(day)) reason = 'FLAT_1550'; else if (q.t_quote >= entry.t + (o.holdMin || 120) * MIN) reason = 'TIME';
    } else {
      const near = entry.expiry && (calDays(qd, entry.expiry) <= 2 || sessionsBetween(qd, entry.expiry) <= 2);
      if (q.bid <= pctStop) reason = 'STOP';
      else if (near && q.t_quote >= et.toEpoch(qd, 10, 0)) reason = 'EXPIRY_EXIT';
      else if (qd >= planned && q.t_quote >= flatAt(planned)) reason = 'SESSION_CLOSE';
    }
    if (reason) { trigger = q; break; }
  }
  const base = { family: o.family, plannedExitDay: planned, labels };
  const ended = (fromDay) => o.dataThrough >= closeAt(sessionAfter(fromDay, o.family === 'Q' || o.family === 'H' ? 1 : 3));
  const close = (rsn, fillQ, extra = {}) => {
    const net = netAt(fillQ.bid); mfe = Math.max(mfe, net); mae = Math.min(mae, net);
    const thr = rsn === 'TARGET' ? o.target : rsn === 'STOP' ? stopNet : null;
    return { ...base, status: 'CLOSED', reason: rsn, trigger, fill: fillQ, exitAt: fillQ.t_quote, net, gapMs: trigger ? fillQ.t_quote - trigger.t_quote : null,
      slippage: thr !== null ? r6(net - thr) : null, lossBeyondStop: rsn === 'STOP' ? r6(Math.max(0, stopNet - net)) : 0, mfe, mae, ...extra };
  };
  if (!trigger) {
    if (lastValid && ended(et.ymd(lastValid.t_quote)) && (o.family === 'Q' || o.family === 'H' || et.ymd(lastValid.t_quote) < planned)) { labels.push('QUOTES_ENDED'); return close('QUOTES_ENDED', lastValid); }
    return { ...base, status: 'OPEN', mark: lastValid ? netAt(lastValid.bid) : null, markAt: lastValid ? lastValid.t_quote : null, mfe, mae };
  }
  const fill = after.find((q) => q.t_quote >= trigger.t_quote + L && eligible(q));
  if (!fill) {
    if (ended(et.ymd(trigger.t_quote))) { labels.push('QUOTES_ENDED'); const last = after.filter(valid).pop(); return close(reason, last); }
    return { ...base, status: 'OPEN', pending: 'GAP_EXIT', pendingReason: reason, trigger, mark: netAt(trigger.bid), mfe, mae };
  }
  if (fill.t_quote - trigger.t_quote > 2 * sampleMs) labels.push('EXIT_DELAYED');
  if ((o.family === 'Q' || o.family === 'H') && et.ymd(fill.t_quote) !== et.ymd(trigger.t_quote)) labels.push('GAP_EXIT');
  return close(reason, fill);
}

// Fills 10% of the bid / ask spread worse on both sides (plan 6.7 stress).
function stressNet({ entryQuote, exitQuote, fees = 0.05 }) {
  const ein = entryQuote.ask + 0.1 * (entryQuote.ask - entryQuote.bid); const eout = exitQuote.bid - 0.1 * (exitQuote.ask - exitQuote.bid);
  return r6((eout - ein) * 100 - 2 * fees);
}

module.exports = { runExit, stressNet, sessionAfter, flatAt, closeAt };
